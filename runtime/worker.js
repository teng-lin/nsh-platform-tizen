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
var nshBench = false;
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
                try {
                    engine.registerFont(f.family, x.response, f.weight || 400, f.style === 'italic', false).then(ok, ok);
                } catch (e) {
                    engine.M.fontErrors = (engine.M.fontErrors || []).concat([f.family + ': ' + e]);
                    ok();
                }
            };
            x.onerror = function () { ok(); };
            x.send();
        });
    }));
}

/* The start failed: messages are dropped from now on, not queued. */
var nshFailed = false;

function nshFail(engine, err) {
    nshFailed = true;
    nshQueue = [];
    nshSetLoad(false);
    /* A trap while starting was reported as the engine's fatal error. */
    if (engine && engine.dead) return;
    var text = String(err && err.stack || err);
    if (engine) { engine.M.fatal = text; engine.halt(); nshPost({ t: 'metrics', m: engine.M }); }
    nshPost({ t: 'fatal', text: 'could not start: ' + text });
}

onmessage = function (e) {
    var m = e.data;
    if (m.t === 'init') {
        nshBench = !!m.bench;
        var measure = null, engine = null;
        try {
            try { measure = new OffscreenCanvas(1, 1).getContext('2d'); } catch (err) { measure = null; }
            /* Host scripts first: their imports are needed to link. */
            (m.scripts || []).forEach(function (s) { importScripts(s); });
            engine = new NshEngine({ out: nshPost, measure: measure });
        } catch (err) {
            nshFail(engine, err);
            return;
        }
        var f0 = performance.now();
        nshHostFonts(engine, m.fonts).then(function () {
            engine.M.hostFontsMs = Math.round(performance.now() - f0);
            return engine.start(m.module, m.device, m.version);
        }).then(function () {
            nshEngine = engine;
            nshQueue.forEach(function (q) { engine.handle(q); });
            nshQueue = [];
            nshPost({ t: 'metrics', m: engine.M });
        }).catch(function (err) { nshFail(engine, err); });
        return;
    }
    if (nshFailed || (nshEngine && nshEngine.dead)) { nshSetLoad(false); return; }
    /* Benchmark builds only: the app's thread made busy on purpose. */
    if (m.t === 'load') { if (nshBench) nshSetLoad(m.on); return; }
    if (m.t === 'metrics') { if (nshEngine) nshPost({ t: 'metrics', m: nshEngine.M }); return; }
    if (!nshEngine) {
        /* Input before the app started; bounded (a start takes seconds). */
        if (m.t !== 'frame' && nshQueue.length < 256) nshQueue.push(m);
        return;
    }
    nshEngine.handle(m);
};
