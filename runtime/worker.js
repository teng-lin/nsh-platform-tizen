/*
 * nsh-platform-tizen's Worker: the engine and the app run here (engine.js);
 * the page only draws operations, hosts native components and forwards
 * input (page.js). Text is measured with an OffscreenCanvas. The page sends
 * {t:'init', module, scripts, fonts, device} first; every URL in it is
 * absolute (Tizen 5's Workers resolve relative URLs wrongly).
 *
 * Plain ES2017 (Chromium 69).
 */
'use strict';

var nshEngine = null;
var nshQueue = [];

/* Background work an app would do here, for the benchmark: busy slices of
 * 30 ms every 50 ms while the page asks for load. */
var nshLoadTimer = null;
function nshSetLoad(on) {
    clearInterval(nshLoadTimer);
    nshLoadTimer = on ? setInterval(function () { var end = performance.now() + 30; while (performance.now() < end) { /* work */ } }, 50) : null;
}

function nshPost(message, transfer) { postMessage(message, transfer || []); }

/* Fonts the host page asked for: loaded here before the app measures. */
function nshHostFonts(engine, fonts) {
    return Promise.all((fonts || []).map(function (f) {
        return new Promise(function (ok) {
            var x = new XMLHttpRequest();
            x.open('GET', f.url, true);
            x.responseType = 'arraybuffer';
            x.onload = function () {
                if (!x.response) { ok(); return; }
                engine.registerFont(f.family, x.response, f.weight || 400, f.style === 'italic', false).then(ok, ok);
            };
            x.onerror = function () { ok(); };
            x.send();
        });
    }));
}

onmessage = function (e) {
    var m = e.data;
    if (m.t === 'init') {
        var measure = null, M0 = {};
        try { measure = new OffscreenCanvas(1, 1).getContext('2d'); } catch (err) { M0.offscreen = 'error ' + err; }
        (m.scripts || []).forEach(function (s) { importScripts(s); });
        var engine = new NshEngine({ out: nshPost, measure: measure });
        for (var k in M0) engine.M[k] = M0[k];
        var f0 = performance.now();
        nshHostFonts(engine, m.fonts).then(function () {
            engine.M.hostFontsMs = Math.round(performance.now() - f0);
            return engine.start(m.module, m.device);
        }).then(function () {
            nshEngine = engine;
            nshQueue.forEach(function (q) { engine.handle(q); });
            nshQueue = [];
            nshPost({ t: 'metrics', m: engine.M });
        }).catch(function (err) {
            engine.M.fatal = String(err && err.stack || err);
            nshPost({ t: 'metrics', m: engine.M });
            nshPost({ t: 'error', text: 'could not start: ' + err });
        });
        return;
    }
    if (m.t === 'load') { nshSetLoad(m.on); return; }
    if (m.t === 'metrics') { if (nshEngine) nshPost({ t: 'metrics', m: nshEngine.M }); return; }
    if (!nshEngine) { if (m.t !== 'frame') nshQueue.push(m); return; }
    nshEngine.handle(m);
};
