/*
 * Spike, Worker variant: the NSH engine and the app run here; the page only
 * draws operations, plays video and forwards keys (page-worker.js). Text is
 * measured with an OffscreenCanvas. Plain ES2017 (Chromium 69).
 */
'use strict';

var M = { moduleFromCache: null };
function save() { postMessage({ t: 'metrics', m: M }); }
var ex = null;
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function str(ptr, len) { return decoder.decode(new Uint8Array(ex.memory.buffer, ptr, len)); }
function withStrings(list, f) {
    var ptrs = list.map(function (s) {
        var bytes = encoder.encode(s);
        var p = ex.nsh_tz_alloc(bytes.length);
        new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
        return [p, bytes.length];
    });
    try { return f(ptrs); } finally { ptrs.forEach(function (p) { ex.nsh_tz_free(p[0], p[1]); }); }
}

var measureCtx = null;
try { measureCtx = new OffscreenCanvas(1, 1).getContext('2d'); M.offscreen = !!measureCtx; } catch (e) { M.offscreen = 'error ' + e; }
var lastFont = '';
var pending = [];          /* operations of the current turn, posted together */
var pumpTimer = null;
function flush(extra) {
    if (pending.length || extra) {
        var msg = { t: 'ops', batches: pending };
        if (extra) for (var k in extra) msg[k] = extra[k];
        postMessage(msg);
        pending = [];
    }
}
function pump() { pumpTimer = null; if (ex) { ex.nsh_tz_pump(); flush(); } }

var imports = {
    nsh_tz: {
        submit: function (ptr, len) { pending.push(str(ptr, len)); },
        request_frame: function () { postMessage({ t: 'frame' }); },
        schedule: function (ms) { clearTimeout(pumpTimer); pumpTimer = ms >= 0 ? setTimeout(pump, ms) : null; },
        report_error: function (ptr, len) { M.errors = (M.errors || []).concat([str(ptr, len).slice(0, 300)]); save(); },
        measure_text: function (fptr, flen, tptr, tlen) {
            var font = str(fptr, flen);
            if (font !== lastFont) { measureCtx.font = font; lastFont = font; }
            return measureCtx.measureText(str(tptr, tlen)).width;
        },
        log: function () {},
        host: function (ptr, len) { postMessage({ t: 'host', m: str(ptr, len) }); }
    },
    nsh: {
        now_ms: function () { return performance.now(); },
        date_now_ms: function () { return Date.now(); }
    }
};

/* Background work the app would do here (imports, store writes): busy
 * slices of 30 ms every 50 ms while the page asks for load. */
var loadTimer = null;
function setLoad(on) {
    clearInterval(loadTimer);
    loadTimer = on ? setInterval(function () { var end = performance.now() + 30; while (performance.now() < end) { /* work */ } }, 50) : null;
}

onmessage = function (e) {
    var m = e.data;
    if (!ex) return;
    if (m.t === 'key') {
        var t0 = performance.now();
        withStrings([m.key, m.key], function (p) {
            ex.nsh_tz_key(m.listener, p[0][0], p[0][1], p[1][0], p[1][1], m.down ? 1 : 0, 0);
        });
        flush({ seq: m.seq, engineMs: performance.now() - t0, queuedMs: Date.now() - m.sentAt });
    } else if (m.t === 'frame') {
        ex.nsh_tz_frame();
        flush();
    } else if (m.t === 'load') {
        setLoad(m.on);
    } else if (m.t === 'stats') {
        postMessage({ t: 'stats', s: { pump: ex.nsh_tz_stat(0), encode: ex.nsh_tz_stat(1), serialize: ex.nsh_tz_stat(2), text: ex.nsh_tz_stat(3) } });
    }
};

function idb() {
    return new Promise(function (ok, fail) {
        var req = indexedDB.open('nsh-spike', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('modules'); };
        req.onsuccess = function () { ok(req.result); };
        req.onerror = function () { fail(req.error); };
    });
}
function loadModule(bytes) {
    var key = 'app-' + bytes.byteLength;
    return idb().then(function (db) {
        return new Promise(function (ok) {
            var get = db.transaction('modules', 'readonly').objectStore('modules').get(key);
            get.onsuccess = function () { ok({ db: db, cached: get.result }); };
            get.onerror = function () { ok({ db: db, cached: null }); };
        });
    }).catch(function (e) { M.cacheError = String(e); return { db: null, cached: null }; }).then(function (r) {
        if (r.cached instanceof WebAssembly.Module) { M.moduleFromCache = true; return r.cached; }
        M.moduleFromCache = false;
        return WebAssembly.compile(bytes).then(function (module) {
            if (r.db) {
                /* Only this build's module is kept: older ones fill the quota. */
                try {
                    var clean = r.db.transaction('modules', 'readwrite').objectStore('modules');
                    clean.openCursor().onsuccess = function (e) {
                        var c = e.target.result;
                        if (!c) return;
                        if (c.key !== key) c.delete();
                        c.continue();
                    };
                } catch (e) { /* best effort */ }
                try {
                    var tx = r.db.transaction('modules', 'readwrite');
                    tx.objectStore('modules').put(module, key);
                    tx.oncomplete = function () { M.moduleCached = true; save(); };
                    var p0 = performance.now();
                    tx.onerror = function () { M.moduleCached = 'error ' + tx.error; save(); };
                    tx.onabort = function () { M.moduleCached = 'abort ' + tx.error; save(); };
                    tx.oncomplete = function () { M.moduleCached = true; M.cacheWriteMs = Math.round(performance.now() - p0); save(); };
                } catch (e) { M.moduleCached = 'refused: ' + e; }
            }
            return module;
        });
    });
}

/* ---------- start ---------- */

(function start() {
    var x = new XMLHttpRequest();
    x.open('GET', 'app.wasm', true);
    x.responseType = 'arraybuffer';
    x.onload = function () {
        M.wasmBytes = x.response.byteLength;
        var c0 = performance.now();
        loadModule(x.response).then(function (module) {
            M.compileMs = Math.round(performance.now() - c0);
            WebAssembly.Module.imports(module).forEach(function (imp) {
                if (!imports[imp.module]) imports[imp.module] = {};
                if (!imports[imp.module][imp.name]) imports[imp.module][imp.name] = function () { return 0; };
            });
            return WebAssembly.instantiate(module, imports);
        }).then(function (instance) {
            ex = instance.exports;
            ex.nsh_tz_init();
            var s0 = performance.now();
            ex.nsh_tz_start(1920, 1080, 1, 1, 5);
            M.startMs = Math.round(performance.now() - s0);
            flush({ first: true });
            save();
        }).catch(function (err) { M.fatal = String(err); save(); });
    };
    x.send();
})();
