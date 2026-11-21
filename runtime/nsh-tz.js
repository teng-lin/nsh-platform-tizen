/*
 * nsh-platform-tizen's page runtime (spike): loads the app's WebAssembly
 * module, applies each committed batch of NSH mount operations to the DOM
 * (crates/nsh-platform-tizen/src/encode.rs lists them), measures text with
 * a canvas, sends the remote's keys to the view listening for them, and
 * plays streams with Samsung AVPlay under the page when the app asks.
 *
 * Plain ES2017: the oldest target is Tizen 5.5 (Chromium 69).
 * It also measures itself for the spike (window.__spike, localStorage).
 */
'use strict';

var ROOT_ID = 1;
var KEYS_BIT = 8;
var PREVIEW = [1184, 32, 704, 396];
var STREAMS = [
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    'https://test-streams.mux.dev/test_001/stream.m3u8'
];

var M = {
    mode: 'page', at: Date.now(), ua: navigator.userAgent, keys: [], keyEngineMs: [], gaps: [], unknown: {},
    batches: 0, ops: 0, applyMs: 0, measureCalls: 0, measureMs: 0
};
window.__spike = M;
function t() { return Math.round(performance.now()); }
function save() {
    try {
        var all = JSON.parse(localStorage.getItem('spike.metrics') || '[]');
        if (all.length && all[all.length - 1].at === M.at) all.pop();
        all.push(M);
        localStorage.setItem('spike.metrics', JSON.stringify(all.slice(-5)));
    } catch (e) { /* optional */ }
}
M.scriptStart = t();

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
    try { return f(ptrs); } finally {
        ptrs.forEach(function (p) { ex.nsh_tz_free(p[0], p[1]); });
    }
}

/* ---------- the view tree ---------- */
var nodes = {};
var keyListener = null;
function Node(id, kind) {
    this.id = id;
    this.kind = kind;
    this.el = document.createElement('div');
    this.frame = 'left:0;top:0;';
    this.css = '';
    this.anim = '';
    this.textEl = null;
    this.events = 0;
}
Node.prototype.restyle = function () {
    this.el.style.cssText = 'position:absolute;box-sizing:border-box;' + this.frame + this.css + this.anim;
};
function node(id) { return nodes[id]; }

(function makeRoot() {
    var root = new Node(ROOT_ID, 'view');
    root.frame = 'left:0;top:0;width:1920px;height:1080px;';
    root.restyle();
    nodes[ROOT_ID] = root;
    document.getElementById('app').appendChild(root.el);
})();

function applyText(n, spec) {
    if (n.textEl) n.el.removeChild(n.textEl);
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:' + spec.x + 'px;top:' + spec.y + 'px;white-space:pre;';
    for (var i = 0; i < spec.runs.length; i++) {
        var run = spec.runs[i];
        var span = document.createElement('span');
        span.style.cssText = 'position:absolute;left:' + run[1] + 'px;top:' + run[2] + 'px;line-height:' +
            run[3] + 'px;' + (spec.styles[run[4]] || '');
        span.textContent = run[0];
        box.appendChild(span);
    }
    n.textEl = box;
    n.el.appendChild(box);
}

function apply(ops) {
    var started = performance.now();
    for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        var n = node(op[1]);
        switch (op[0]) {
        case 'c':
            if (op[1] === ROOT_ID) break; /* the page made the root */
            nodes[op[1]] = new Node(op[1], op[2]);
            nodes[op[1]].restyle();
            if (op[2] === 'scroll') nodes[op[1]].css = 'overflow:hidden;';
            break;
        case 'i': {
            var child = node(op[2]);
            if (!n || !child) break;
            var before = op[3] == null ? null : node(op[3]);
            n.el.insertBefore(child.el, before ? before.el : null);
            break;
        }
        case 'r':
            if (n && n.el.parentNode) n.el.parentNode.removeChild(n.el);
            break;
        case 'd':
            if (n) {
                if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
                delete nodes[op[1]];
                if (keyListener === op[1]) keyListener = null;
            }
            break;
        case 'f':
            if (n) { n.frame = 'left:' + op[2] + 'px;top:' + op[3] + 'px;width:' + op[4] + 'px;height:' + op[5] + 'px;'; n.restyle(); }
            break;
        case 's':
            if (n) { n.css = op[2]; n.restyle(); }
            break;
        case 'a':
            if (n) { n.anim = op[2]; n.restyle(); }
            break;
        case 't':
            if (n) applyText(n, op[2]);
            break;
        case 'e':
            if (n) {
                n.events = op[2];
                if (op[2] & KEYS_BIT) keyListener = op[1];
                else if (keyListener === op[1]) keyListener = null;
            }
            break;
        case 'im':
            if (n) {
                var img = n.el.querySelector('img') || n.el.appendChild(document.createElement('img'));
                img.style.cssText = 'width:100%;height:100%;object-fit:' + (op[3] === 'aspectFill' ? 'cover' : 'contain');
                if (op[2]) img.src = op[2]; else img.removeAttribute('src');
            }
            break;
        default:
            M.unknown[op[0]] = (M.unknown[op[0]] || 0) + 1;
        }
    }
    M.batches++;
    M.ops += ops.length;
    M.applyMs += performance.now() - started;
}

/* ---------- the module's imports ---------- */
var canvas = document.createElement('canvas').getContext('2d');
var lastFont = '';
var pumpTimer = null;
var frameAsked = false;
function pump() { pumpTimer = null; if (ex) ex.nsh_tz_pump(); }

var imports = {
    nsh_tz: {
        submit: function (ptr, len) {
            var p0 = performance.now();
            var ops = JSON.parse(str(ptr, len));
            M.parseMs = (M.parseMs || 0) + performance.now() - p0;
            M.jsonBytes = (M.jsonBytes || 0) + len;
            apply(ops);
        },
        request_frame: function () {
            if (frameAsked) return;
            frameAsked = true;
            requestAnimationFrame(function () { frameAsked = false; if (ex) ex.nsh_tz_frame(); });
        },
        schedule: function (ms) {
            clearTimeout(pumpTimer);
            pumpTimer = ms >= 0 ? setTimeout(pump, ms) : null;
        },
        report_error: function (ptr, len) {
            var text = str(ptr, len);
            M.errors = (M.errors || []).concat([text.slice(0, 300)]);
            console.error(text);
        },
        measure_text: function (fptr, flen, tptr, tlen) {
            var s = performance.now();
            var font = str(fptr, flen);
            if (font !== lastFont) { canvas.font = font; lastFont = font; }
            var w = canvas.measureText(str(tptr, tlen)).width;
            M.measureCalls++;
            M.measureMs += performance.now() - s;
            return w;
        },
        log: function (level, ptr, len) { if (level <= 2) console.log(str(ptr, len)); },
        host: function (ptr, len) {
            var m = JSON.parse(str(ptr, len));
            if (m.play !== undefined) setTimeout(function () { play(m.play); }, 0);
            if (m.exit) setTimeout(exit, 0);
        }
    },
    nsh: {
        now_ms: function () { return performance.now(); },
        date_now_ms: function () { return Date.now(); }
    }
};

/* ---------- video ---------- */
var playToken = 0;
function play(channel) {
    var url = STREAMS[channel % STREAMS.length];
    var token = ++playToken;
    var asked = performance.now();
    if (typeof webapis === 'undefined' || !webapis.avplay) return;
    var av = webapis.avplay;
    try { av.stop(); } catch (e) { /* idle */ }
    try { av.close(); } catch (e) { /* closed */ }
    try {
        av.open(url);
        av.setDisplayRect(PREVIEW[0], PREVIEW[1], PREVIEW[2], PREVIEW[3]);
        var timed = false;
        av.setListener({
            oncurrentplaytime: function () {
                if (timed || token !== playToken) return;
                timed = true;
                M.zaps = (M.zaps || []).concat([Math.round(performance.now() - asked)]);
                save();
            },
            onerror: function (e) { M.playErrors = (M.playErrors || []).concat([String(e)]); }
        });
        av.prepareAsync(function () { if (token === playToken) av.play(); }, function () {});
    } catch (e) {
        M.playErrors = (M.playErrors || []).concat([String(e)]);
    }
}
function exit() {
    try { webapis.avplay.stop(); webapis.avplay.close(); } catch (e) { /* idle */ }
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not a TV */ }
}

/* ---------- keys ---------- */
function sendKey(key, down, repeat) {
    withStrings([key, key], function (p) {
        ex.nsh_tz_key(keyListener, p[0][0], p[0][1], p[1][0], p[1][1], down ? 1 : 0, repeat ? 1 : 0);
    });
}

/*
 * The spike's own benchmark (no debugger attached): moves like a viewer's,
 * one every 350 ms, then a held key (a move every 100 ms), recording key to
 * painted frame and the engine's stages. Results: localStorage
 * 'spike.bench' (last 5).
 */
function stages() {
    return { pump: ex.nsh_tz_stat(0), encode: ex.nsh_tz_stat(1), serialize: ex.nsh_tz_stat(2), text: ex.nsh_tz_stat(3) };
}
function bench(done) {
    var moves = [];
    var seq = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',
        'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight',
        'ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp',
        'ArrowUp', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft'];
    var held = []; for (var h = 0; h < 30; h++) held.push('ArrowDown');
    stages(); M.parseMs = 0; M.applyMs = 0; M.jsonBytes = 0; M.ops = 0;
    var results = { at: Date.now(), paced: null, held: null };
    function run(keys, gap, label, next) {
        var lat = [], eng = [], st = { pump: 0, encode: 0, serialize: 0, text: 0, parse: 0, apply: 0, bytes: 0, ops: 0 };
        var i = 0, gaps = 0, worst = 0, last = 0, ticking = true;
        (function tick(now) { if (!ticking) return; if (last && now - last > 50) { gaps++; worst = Math.max(worst, now - last); } last = now; requestAnimationFrame(tick); })(0);
        function one() {
            if (i >= keys.length) {
                ticking = false;
                var sorted = lat.slice().sort(function (a, b) { return a - b; });
                var es = eng.slice().sort(function (a, b) { return a - b; });
                var n = keys.length;
                results[label] = { n: n, p50: sorted[n >> 1], p90: sorted[Math.floor(n * 0.9)], max: sorted[n - 1],
                    handlerP50: es[n >> 1], gapsOver50: gaps, worstGap: Math.round(worst),
                    perKey: { pump: +(st.pump / n).toFixed(1), encode: +(st.encode / n).toFixed(1), serialize: +(st.serialize / n).toFixed(1),
                        text: +(st.text / n).toFixed(1), parse: +(st.parse / n).toFixed(1), apply: +(st.apply / n).toFixed(1),
                        bytes: Math.round(st.bytes / n), ops: Math.round(st.ops / n) } };
                return next();
            }
            var key = keys[i++];
            var t0 = performance.now();
            M.parseMs = 0; M.applyMs = 0; M.jsonBytes = 0; M.ops = 0;
            sendKey(key, true, false);
            sendKey(key, false, false);
            var handler = performance.now() - t0;
            var s = stages();
            st.pump += s.pump; st.encode += s.encode; st.serialize += s.serialize; st.text += s.text;
            st.parse += M.parseMs; st.apply += M.applyMs; st.bytes += M.jsonBytes; st.ops += M.ops;
            requestAnimationFrame(function () { requestAnimationFrame(function () {
                lat.push(Math.round(performance.now() - t0)); eng.push(Math.round(handler));
            }); });
            setTimeout(one, gap);
        }
        one();
    }
    run(seq, 350, 'paced', function () {
        setTimeout(function () {
            run(held, 100, 'held', function () {
                try {
                    var all = JSON.parse(localStorage.getItem('spike.bench') || '[]');
                    all.push(results);
                    localStorage.setItem('spike.bench', JSON.stringify(all.slice(-5)));
                } catch (e) { /* optional */ }
                window.__bench = results;
                if (done) done(results);
            });
        }, 1000);
    });
}
window.__runBench = bench;
var KEY_NAMES = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter',
    10009: 'GoBack', 427: 'ChannelUp', 428: 'ChannelDown' };
document.addEventListener('keydown', function (e) {
    var key = KEY_NAMES[e.keyCode];
    if (!key || !ex || keyListener == null) return;
    e.preventDefault();
    var down = performance.now();
    withStrings([key, key], function (p) {
        ex.nsh_tz_key(keyListener, p[0][0], p[0][1], p[1][0], p[1][1], 1, e.repeat ? 1 : 0);
    });
    var engine = performance.now() - down;
    /* Key to the frame after the DOM changed: what the viewer sees. */
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            M.keys.push(Math.round(performance.now() - down));
            M.keyEngineMs.push(Math.round(engine));
            if (M.keys.length > 300) { M.keys.shift(); M.keyEngineMs.shift(); }
            save();
        });
    });
});
document.addEventListener('keyup', function (e) {
    var key = KEY_NAMES[e.keyCode];
    if (!key || !ex || keyListener == null) return;
    withStrings([key, key], function (p) {
        ex.nsh_tz_key(keyListener, p[0][0], p[0][1], p[1][0], p[1][1], 0, 0);
    });
});

/* Frame gaps over 50 ms while the app runs. */
(function watch(last) {
    requestAnimationFrame(function (now) {
        if (last && now - last > 50) { M.gaps.push(Math.round(now - last)); if (M.gaps.length > 300) M.gaps.shift(); }
        watch(now);
    });
})(0);

/* ---------- compiled-module cache (spike: does this engine keep one?) ---------- */
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
    try {
        ['ChannelUp', 'ChannelDown'].forEach(function (k) { tizen.tvinputdevice.registerKey(k); });
    } catch (e) { /* not a TV */ }
    var x = new XMLHttpRequest();
    x.open('GET', 'app.wasm', true);
    x.responseType = 'arraybuffer';
    x.onload = function () {
        M.downloaded = t();
        M.wasmBytes = x.response.byteLength;
        var c0 = performance.now();
        loadModule(x.response).then(function (module) {
            M.compileMs = Math.round(performance.now() - c0);
            var i0 = performance.now();
            /* Imports of linked code the page does not drive (ballast): no-ops. */
            WebAssembly.Module.imports(module).forEach(function (imp) {
                if (!imports[imp.module]) imports[imp.module] = {};
                if (!imports[imp.module][imp.name]) imports[imp.module][imp.name] = function () { return 0; };
            });
            return WebAssembly.instantiate(module, imports).then(function (instance) {
                M.instantiateMs = Math.round(performance.now() - i0);
                ex = instance.exports;
                ex.nsh_tz_init();
                var s0 = performance.now();
                var ok = ex.nsh_tz_start(1920, 1080, 1, 1, 5);
                M.startMs = Math.round(performance.now() - s0);
                M.started = ok === 1;
                M.firstRenderAt = t();
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        M.firstPaintAt = t();
                        M.wasmMemoryMB = Math.round(ex.memory.buffer.byteLength / 1048576);
                        M.views = Object.keys(nodes).length;
                        M.domNodes = document.getElementsByTagName('*').length;
                        if (performance.memory) M.jsHeapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
                        save();
                        /* Benchmark once per normal launch when asked (set from a debug session). */
                        if (localStorage.getItem('spike.autobench') === '1') setTimeout(function () { bench(); }, 4000);
                    });
                });
            });
        }).catch(function (err) {
            M.fatal = String(err);
            save();
            document.getElementById('app').textContent = 'Could not start: ' + err;
        });
    };
    x.send();
})();

/* Hooks for the shared benchmark (bench-common.js). */
function benchKey(key, applied) { sendKey(key, true, false); sendKey(key, false, false); applied(); }
var pageLoad = null;
function setBenchLoad(on) {
    clearInterval(pageLoad);
    pageLoad = on ? setInterval(function () { var end = performance.now() + 30; while (performance.now() < end) { /* work */ } }, 50) : null;
}
function playPreview() { play(0); }
