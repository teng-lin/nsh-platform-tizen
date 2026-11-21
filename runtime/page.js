/*
 * nsh-platform-tizen, the host page's entry: NshTizen.start(options) runs
 * the app's module in a Worker (the default) and draws what it commits
 * (renderer.js); keys, inputs, images and native components report back.
 *
 *   NshTizen.registerComponent('tv.player', NshTizen.avplay);
 *   NshTizen.start({
 *       container: document.getElementById('app'),
 *       module: 'app.wasm',              // the app's WebAssembly module
 *       worker: 'nsh-worker.js',         // engine.js + worker.js
 *       scripts: ['host-services.js'],   // run in the Worker first (imports)
 *       fonts: [{ family: 'Brand', url: 'fonts/brand.ttf', weight: 400 }],
 *       registerKeys: ['Tools'],         // more remote keys, by Tizen name
 *       onHost: function (message) {},   // nsh_platform_tizen::host(json)
 *       onExit: function () {},          // Command::ExitApp (default: exit)
 *       onError: function (text) {}
 *   });
 *
 * `thread: 'page'` runs the engine on the page instead (benchmark only;
 * the page then loads engine.js itself).
 *
 * The page records its own timings: window.__nsh, localStorage
 * 'nsh.metrics' (last 5 launches).
 *
 * Plain ES2017 (Chromium 69).
 */
'use strict';

(function (api) {
    var M = {
        mode: 'worker', at: Date.now(), keys: [], slowOps: [], gaps: [], unknown: {}, unknownComponents: {}, errors: [], logs: [],
        batches: 0, ops: 0, applyMs: 0, parseMs: 0
    };
    api.metrics = M;
    window.__nsh = M;

    function saveMetrics() {
        try {
            var all = JSON.parse(localStorage.getItem('nsh.metrics') || '[]');
            if (all.length && all[all.length - 1].at === M.at) all.pop();
            all.push(M);
            localStorage.setItem('nsh.metrics', JSON.stringify(all.slice(-5)));
        } catch (e) { /* optional */ }
    }
    api.saveMetrics = saveMetrics;

    function absolute(url) { return new URL(url, location.href).href; }

    var renderer = null;
    var engineSend = null;   /* a message to the engine */
    var options = null;
    var keyCodes = {};       /* Samsung code -> [code, key, tizen, register] */
    var waiting = {};
    var seq = 0;
    var frameAsked = false;

    function registerKeys() {
        var names = [];
        for (var c in keyCodes) if (keyCodes[c][3]) names.push(keyCodes[c][2]);
        (options.registerKeys || []).forEach(function (n) { names.push(n); });
        M.registeredKeys = [];
        /* One at a time: a key this set lacks must not stop the others. */
        names.forEach(function (name) {
            try { tizen.tvinputdevice.registerKey(name); M.registeredKeys.push(name); } catch (e) { /* not on this set */ }
        });
    }

    /* What the engine sent. */
    function receive(m) {
        switch (m.t) {
        case 'ops': {
            var p0 = performance.now();
            var parsed = [];
            for (var i = 0; i < m.batches.length; i++) parsed.push(JSON.parse(m.batches[i]));
            M.parseMs += performance.now() - p0;
            if (api.recorded) api.recorded.push.apply(api.recorded, parsed);
            for (var j = 0; j < parsed.length; j++) renderer.apply(parsed[j]);
            if (m.first) firstPaint();
            if (m.seq !== undefined && waiting[m.seq]) { waiting[m.seq](m); delete waiting[m.seq]; }
            break;
        }
        case 'frame':
            if (frameAsked) return;
            frameAsked = true;
            requestAnimationFrame(function () { frameAsked = false; engineSend({ t: 'frame' }); });
            break;
        case 'keys':
            m.rows.forEach(function (r) { keyCodes[r[0]] = r; });
            registerKeys();
            break;
        case 'imageBytes': renderer.imageBytes(m.uri, m.data); break;
        case 'font': {
            var face = new FontFace(m.family, m.data, { weight: String(m.weight), style: m.italic ? 'italic' : 'normal' });
            document.fonts.add(face);
            face.load().then(function () { engineSend({ t: 'fontLoaded' }); }, function () { engineSend({ t: 'fontLoaded' }); });
            break;
        }
        case 'host':
            if (options.onHost) {
                var message;
                try { message = JSON.parse(m.m); } catch (e) { message = m.m; }
                options.onHost(message);
            }
            break;
        case 'error':
            M.errors.push(String(m.text).slice(0, 500));
            if (M.errors.length > 20) M.errors.shift();
            console.error(m.text);
            if (options.onError) options.onError(m.text);
            saveMetrics();
            break;
        case 'log':
            M.logs.push(m.text.slice(0, 300));
            if (M.logs.length > 50) M.logs.shift();
            break;
        case 'metrics': M.engine = m.m; saveMetrics(); break;
        case 'stats': if (waiting.stats) { waiting.stats(m.s); delete waiting.stats; } break;
        default: break;
        }
    }

    function firstPaint() {
        M.firstOpsAt = Math.round(performance.now());
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                M.firstPaintAt = Math.round(performance.now());
                M.views = Object.keys(renderer.nodes).length;
                M.domNodes = document.getElementsByTagName('*').length;
                if (performance.memory) M.jsHeapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
                saveMetrics();
                if (api.onFirstPaint) api.onFirstPaint();
            });
        });
    }

    /* ---------- keys ---------- */

    var lastBack = 0;
    function sendKey(e, down) {
        var code = e.keyCode;
        var known = keyCodes[code];
        var target = renderer.keyTarget();
        if (renderer.editing) {
            /* The TV keyboard keeps its own keys; Back leaves the input. */
            if (code === 10009) {
                if (down) renderer.editing.input.el.blur();
                e.preventDefault();
                return;
            }
            if (code === 13 || (code >= 37 && code <= 40) || (code >= 48 && code <= 57) || code === 65376 || code === 65385) return;
        }
        if (!known && !target) return;
        if (known) e.preventDefault();
        if (code === 10009 && down) {
            /* The remote's Back bounces on some sets. */
            var now = performance.now();
            if (now - lastBack < (options.backDebounceMs || 0)) return;
            lastBack = now;
        }
        /* OK on a focused view that takes presses presses it. */
        if (code === 13 && renderer.focused === target && target.events & api.PRESS) {
            if (down && !e.repeat) engineSend({ t: 'event', id: target.id, name: 'onPress' });
            return;
        }
        var t0 = performance.now();
        var s = ++seq;
        if (down) {
            waiting[s] = function () {
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        M.keys.push(Math.round(performance.now() - t0));
                        if (M.keys.length > 300) M.keys.shift();
                    });
                });
            };
        }
        engineSend({ t: 'key', id: target.id, keyCode: code, key: typeof e.key === 'string' ? e.key : '', code: typeof e.code === 'string' ? e.code : '',
            down: down ? 1 : 0, repeat: e.repeat ? 1 : 0, seq: s });
    }

    /* Frame gaps over 50 ms while the app runs. */
    function watchFrames() {
        (function watch(last) {
            requestAnimationFrame(function (now) {
                if (last && now - last > 50) { M.gaps.push(Math.round(now - last)); if (M.gaps.length > 300) M.gaps.shift(); }
                watch(now);
            });
        })(0);
    }

    /* ---------- start ---------- */

    api.start = function (opts) {
        options = opts || {};
        /* Debugging: keep every batch (localStorage 'nsh.record' = '1'). */
        try { if (localStorage.getItem('nsh.record') === '1') api.recorded = []; } catch (e) { /* none */ }
        if (options.backDebounceMs === undefined) options.backDebounceMs = 600;
        var container = options.container || document.getElementById('app');
        var device = options.device || { width: 1920, height: 1080, pixelRatio: 1, dark: true };
        M.scriptStart = Math.round(performance.now());
        M.ua = navigator.userAgent;
        renderer = new api.Renderer(container, function (m) { engineSend(m); }, M);
        renderer.onExit = options.onExit || null;
        api.renderer = renderer;
        var module = absolute(options.module || 'app.wasm');
        if (options.thread === 'page') {
            M.mode = 'page';
            var engine = new NshEngine({ out: function (m) { receive(m); }, measure: document.createElement('canvas').getContext('2d'), samePage: true });
            /* Never into the module while it runs: a component's event
             * during a batch waits for the batch to end. */
            var queue = [];
            engineSend = function (m) {
                queue.push(m);
                if (queue.length === 1) Promise.resolve().then(function () {
                    while (queue.length) engine.handle(queue.shift());
                });
            };
            api.engine = engine;
            engine.start(module, device).then(function () { M.engine = engine.M; saveMetrics(); }, function (err) {
                M.fatal = String(err); saveMetrics();
                container.textContent = 'Could not start: ' + err;
            });
        } else {
            var worker = new Worker(absolute(options.worker || 'nsh-worker.js'));
            worker.onmessage = function (e) { receive(e.data); };
            worker.onerror = function (e) { M.fatal = String(e.message || e); saveMetrics(); };
            engineSend = function (m) { worker.postMessage(m); };
            api.worker = worker;
            worker.postMessage({
                t: 'init', module: module, device: device,
                scripts: (options.scripts || []).map(absolute),
                fonts: (options.fonts || []).map(function (f) { return { family: f.family, url: absolute(f.url), weight: f.weight, style: f.style }; })
            });
        }
        /* Host fonts draw on the page too. */
        (options.fonts || []).forEach(function (f) {
            try {
                var face = new FontFace(f.family, 'url("' + absolute(f.url) + '")', { weight: String(f.weight || 400), style: f.style || 'normal' });
                document.fonts.add(face);
                face.load().catch(function () { /* reported by the Worker */ });
            } catch (e) { /* no FontFace */ }
        });
        document.addEventListener('keydown', function (e) { sendKey(e, true); });
        document.addEventListener('keyup', function (e) { sendKey(e, false); });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && Object.keys(keyCodes).length) registerKeys();
        });
        watchFrames();
    };

    /* ---------- hooks for the shared benchmark (bench-common.js) ---------- */

    var BENCH_CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13 };
    api.benchKey = function (key, applied) {
        var target = renderer.keyTarget();
        var code = BENCH_CODES[key];
        var s = ++seq;
        waiting[s] = function () { applied(); };
        engineSend({ t: 'key', id: target.id, keyCode: code, key: key, code: key, down: 1, repeat: 0, seq: s });
        engineSend({ t: 'key', id: target.id, keyCode: code, key: key, code: key, down: 0, repeat: 0 });
    };
    api.setBenchLoad = function (on) {
        if (M.mode === 'worker') { api.worker.postMessage({ t: 'load', on: on }); return; }
        clearInterval(api.pageLoad);
        api.pageLoad = on ? setInterval(function () { var end = performance.now() + 30; while (performance.now() < end) { /* work */ } }, 50) : null;
    };
    api.stats = function (done) { waiting.stats = done; engineSend({ t: 'stats' }); };
    api.ready = function () { return renderer && renderer.keyListeners.length > 0; };
})(NshTizen);
