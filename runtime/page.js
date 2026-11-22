/*
 * nsh-platform-tizen, the host page's entry: NshTizen.start(options) runs
 * the app's module in a Worker (the default) and draws what it commits
 * (renderer.js); keys, inputs, images and native components report back.
 *
 *   NshTizen.registerComponent('tv.player', NshTizen.avplay);
 *   NshTizen.start({
 *       container: document.getElementById('app'),
 *       module: 'app.wasm',              // the app's WebAssembly module
 *       version: '…',                    // the module's SHA-256 (cache key)
 *       worker: 'nsh-worker.js',         // engine.js + worker.js
 *       scripts: ['host-services.js'],   // run in the Worker first (imports)
 *       fonts: [{ family: 'Brand', url: 'fonts/brand.ttf', weight: 400 }],
 *       registerKeys: ['Tools'],         // more remote keys, by Tizen name
 *       backDebounceMs: 600,
 *       scale: 2,                        // page pixels per layout point
 *       onHost: function (message) {},   // nsh_platform_tizen::host(json)
 *       onExit: function () {},          // Command::ExitApp (default: exit)
 *       onError: function (text) {}
 *   });
 *
 * `thread: 'page'` runs the engine on the page instead (benchmark only;
 * the page then loads engine.js itself). Each start is a session: a second
 * start ends the first (its Worker, DOM, listeners and callbacks).
 *
 * The page records its own timings: window.__nsh, localStorage
 * 'nsh.metrics' (last 5 launches).
 *
 * Plain ES2017 (Chromium 69).
 */
'use strict';

(function (api) {
    function metrics() {
        return {
            mode: 'worker', at: Date.now(), keys: [], slowOps: [], gaps: [], unknown: {}, unknownComponents: {}, errors: [], logs: [],
            batches: 0, ops: 0, applyMs: 0, parseMs: 0
        };
    }

    /*
     * What a launch's metrics keep in localStorage: the timings and
     * counts, the first 5 errors, logs and texts of each count list, cut
     * to 300 characters. An error storm must not write a megabyte every
     * 2 s.
     */
    function saved(M) {
        var out = {};
        var cut = function (list) { return (list || []).slice(0, 5).map(function (t) { return String(t).slice(0, 300); }); };
        var top = function (counts) {
            var o = {}, keys = Object.keys(counts || {});
            keys.slice(0, 5).forEach(function (k) { o[k.slice(0, 300)] = counts[k]; });
            if (keys.length > 5) o['(more)'] = keys.length - 5;
            return o;
        };
        for (var k in M) {
            if (k === 'errors' || k === 'logs' || k === 'slowOps') out[k] = cut(M[k]);
            else if (k === 'errorCounts') out[k] = top(M[k]);
            else if (k === 'keys' || k === 'gaps') out[k] = (M[k] || []).slice(-50);
            else if (k === 'engine' && M.engine) {
                var e = {};
                for (var j in M.engine) e[j] = M.engine[j];
                e.importErrors = cut(e.importErrors);
                e.importErrorCounts = top(e.importErrorCounts);
                e.logs = cut(e.logs);
                out.engine = e;
            } else out[k] = M[k];
        }
        return out;
    }

    function absolute(url) { return new URL(url, location.href).href; }

    var current = null;      /* the running session */

    /* A host callback, isolated: its throw is reported, not fatal. */
    function hostCall(session, name, f) {
        try { return f(); } catch (e) {
            session.note(name + ' threw: ' + String(e && e.stack || e));
            return undefined;
        }
    }

    function Session(options) {
        var self = this;
        this.options = options;
        this.M = metrics();
        this.keyCodes = {};    /* Samsung code -> [code, key, tizen, register, editing] */
        this.waiting = {};
        this.seq = 0;
        this.frameAsked = false;
        this.lastBack = -1e9;
        this.ended = false;
        this.halted = false;   /* the app stopped (a fatal error) */
        this.saveTimer = null;
        this.recorded = null;
        this.listeners = [];
        this.worker = null;
        this.engine = null;
        api.metrics = this.M;
        window.__nsh = this.M;
        this.container = options.container || document.getElementById('app');
        /* `scale` page pixels per layout point: an app laid out for a TV's
         * 960 x 540 points (as Android TV reports a 1080p screen) asks for
         * 2. The container is zoomed; the layout, the frames and the
         * device the app sees are in points. */
        this.scale = options.scale > 0 ? options.scale : 1;
        if (this.scale !== 1) this.container.style.zoom = String(this.scale);
        this.renderer = new api.Renderer(this.container, function (m) { self.send(m); }, this.M, this.scale);
        /* Its components' errors are the session's (noted once, onError). */
        this.renderer.report = function (text) { self.error(text); };
        /* Metrics are saved before the app leaves. */
        this.renderer.onExit = function () {
            self.saveNow();
            if (options.onExit) { options.onExit(); return; }
            try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not a TV */ }
        };
    }

    var S = Session.prototype;

    /* At most every 2 s: an error repeating every pump must not rewrite
     * localStorage each time. */
    S.saveMetrics = function () {
        var self = this;
        if (this.saveTimer !== null) return;
        this.saveTimer = setTimeout(function () { self.saveTimer = null; self.saveNow(); }, 2000);
    };

    S.saveNow = function () {
        var M = this.M;
        try {
            var all = JSON.parse(localStorage.getItem('nsh.metrics') || '[]');
            if (all.length && all[all.length - 1].at === M.at) all.pop();
            all.push(saved(M));
            localStorage.setItem('nsh.metrics', JSON.stringify(all.slice(-5)));
        } catch (e) { /* optional */ }
    };

    S.listen = function (target, type, f) {
        target.addEventListener(type, f);
        this.listeners.push([target, type, f]);
    };

    /* A message to the engine (dropped once the session ended). */
    S.send = function (m) {
        if (this.ended || this.halted || !this.engineSend) return;
        this.engineSend(m);
    };

    /*
     * Records `text` in __nsh.errors: the same text once, then counted
     * (__nsh.errorCounts; the Worker's import errors are in
     * __nsh.engine.importErrorCounts); at most 20 kept. True the first time.
     */
    S.note = function (text) {
        var M = this.M;
        text = String(text).slice(0, 500);
        M.errorCounts = M.errorCounts || {};
        if (M.errorCounts[text]) { M.errorCounts[text]++; this.saveMetrics(); return false; }
        /* Counts are kept past the list's 20 (up to 200 texts), so an error
         * that left the list is not reported again; past 200, one overflow
         * count and no report. */
        if (Object.keys(M.errorCounts).length >= 200) { M.errorOverflow = (M.errorOverflow || 0) + 1; this.saveMetrics(); return false; }
        M.errorCounts[text] = 1;
        M.errors.push(text);
        if (M.errors.length > 20) M.errors.shift();
        this.saveMetrics();
        return true;
    };

    /* An error for the host: noted, and told to onError the first time. */
    S.error = function (text) {
        if (!this.note(text)) return;
        if (typeof console !== 'undefined') console.error(text);
        if (this.options.onError) {
            try { this.options.onError(text); } catch (e) { this.note('onError threw: ' + String(e && e.stack || e)); }
        }
    };

    /*
     * The app stopped (a trap, or a start that failed): one report, then
     * nothing of it runs on: its native components are destroyed (a player
     * closes), input stops, frames stop, waiting callbacks go. The last
     * frame stays on screen.
     */
    S.fatal = function (text) {
        if (this.halted) return;
        this.halted = true;
        this.M.dead = true;
        this.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        this.listeners = [];
        this.waiting = {};
        if (this.engine) this.engine.halt();
        if (this.worker) this.worker.terminate();
        this.renderer.haltComponents();
        /* Its own one-shot path: told to the host and saved even when
         * the error list is full. */
        text = String(text);
        this.M.fatal = text.slice(0, 2000);
        if (typeof console !== 'undefined') console.error(text);
        this.note(text);
        if (this.options.onError) {
            try { this.options.onError(text); } catch (e) { this.note('onError threw: ' + String(e && e.stack || e)); }
        }
        this.saveNow();
    };

    S.registerKeys = function () {
        var names = [], M = this.M;
        for (var c in this.keyCodes) if (this.keyCodes[c][3]) names.push(this.keyCodes[c][2]);
        (this.options.registerKeys || []).forEach(function (n) { names.push(n); });
        M.registeredKeys = [];
        /* One at a time: a key this set lacks must not stop the others. */
        names.forEach(function (name) {
            try { tizen.tvinputdevice.registerKey(name); M.registeredKeys.push(name); } catch (e) { /* not on this set */ }
        });
    };

    /* What the engine sent. */
    S.receive = function (m) {
        if (this.ended || this.halted) return;
        var self = this, M = this.M, renderer = this.renderer;
        switch (m.t) {
        case 'ops': {
            var p0 = performance.now();
            var parsed = [];
            for (var i = 0; i < m.batches.length; i++) parsed.push(JSON.parse(m.batches[i]));
            M.parseMs += performance.now() - p0;
            if (this.recorded && this.recorded.length < 50) this.recorded.push.apply(this.recorded, parsed);
            for (var j = 0; j < parsed.length; j++) renderer.apply(parsed[j]);
            if (m.first) this.firstPaint();
            if (m.seq !== undefined && this.waiting[m.seq]) { this.waiting[m.seq](m); delete this.waiting[m.seq]; }
            break;
        }
        case 'frame':
            if (this.frameAsked) return;
            this.frameAsked = true;
            requestAnimationFrame(function () {
                self.frameAsked = false;
                self.send({ t: 'frame' });
            });
            break;
        case 'keys':
            m.rows.forEach(function (r) { self.keyCodes[r[0]] = r; });
            this.registerKeys();
            break;
        case 'imageBytes': renderer.imageBytes(m.uri, m.type, m.data); break;
        case 'font': {
            var done = function () { self.send({ t: 'fontLoaded' }); };
            try {
                var face = new FontFace(m.family, m.data, { weight: String(m.weight), style: m.italic ? 'italic' : 'normal' });
                document.fonts.add(face);
                face.load().then(done, done);
            } catch (e) { done(); }
            break;
        }
        case 'host':
            if (this.options.onHost) {
                var message;
                try { message = JSON.parse(m.m); } catch (e) { message = m.m; }
                hostCall(this, 'onHost', function () { self.options.onHost(message); });
            }
            break;
        case 'error': this.error(m.text); break;
        case 'fatal': this.fatal(m.text); break;
        case 'log':
            M.logs.push(m.text.slice(0, 300));
            if (M.logs.length > 50) M.logs.shift();
            break;
        case 'metrics': M.engine = m.m; this.saveMetrics(); break;
        case 'stats': if (this.waiting.stats) { this.waiting.stats(m.s); delete this.waiting.stats; } break;
        default: break;
        }
    };

    S.firstPaint = function () {
        var self = this, M = this.M;
        M.firstOpsAt = Math.round(performance.now());
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (self.ended) return;
                M.firstPaintAt = Math.round(performance.now());
                M.views = Object.keys(self.renderer.nodes).length;
                M.domNodes = document.getElementsByTagName('*').length;
                if (performance.memory) M.jsHeapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
                self.saveMetrics();
                if (api.onFirstPaint) api.onFirstPaint();
            });
        });
    };

    /* ---------- keys ---------- */

    /*
     * A key transition from the document. The engine decides where it
     * goes (id 0) from its own tree; the page names only the input being
     * edited. A key an input consumed, the editor's Back, and a bounced
     * Back are dropped on the way down and on the way up, so a release
     * never reaches the app without its press.
     */
    S.key = function (e, down) {
        var code = e.keyCode;
        var keys = this.renderer.keys;
        var known = this.keyCodes[code];
        var held = keys[code];
        if (!down) {
            /* A release follows its press; one without a press (it went
             * down before the app, or in another page) is nobody's. */
            delete keys[code];
            if (held === 'app') return this.sendKey(e, false, code);
            /* The TV keyboard's keys keep their default (typing, the
             * caret); an unknown release is left alone too. */
            if (held === 'swallowed') e.preventDefault();
            return;
        }
        if (e.repeat && held) {
            if (held === 'app') return this.sendKey(e, true, code);
            if (held === 'swallowed') e.preventDefault();
            return;
        }
        /* A fresh press decides its disposition (a stale one is gone). */
        var disposition = this.dispose(e, code, known);
        keys[code] = disposition;
        if (disposition === 'app') this.sendKey(e, true, code);
        else if (disposition === 'swallowed') e.preventDefault();
    };

    /* What a fresh press is: the app's, the TV keyboard's, or swallowed
     * (a bounced Back; Back leaving the input). */
    S.dispose = function (e, code, known) {
        if (code === 10009) {
            var now = performance.now();
            var bounced = now - this.lastBack < (this.options.backDebounceMs || 0);
            this.lastBack = now;
            if (bounced) return 'swallowed';
        }
        var editing = this.renderer.editing;
        if (editing) {
            if (code === 10009) { editing.input.el.blur(); return 'swallowed'; }
            if ((known && known[4]) || code === api.IME_DONE || code === api.IME_CANCEL) return 'browser';
        }
        return 'app';
    };

    S.sendKey = function (e, down, code) {
        var known = this.keyCodes[code];
        if (known) e.preventDefault();
        var editing = this.renderer.editing;
        var self = this, M = this.M;
        var t0 = performance.now();
        var s = ++this.seq;
        if (down) {
            this.waiting[s] = function () {
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        M.keys.push(Math.round(performance.now() - t0));
                        if (M.keys.length > 300) M.keys.shift();
                    });
                });
            };
        }
        this.send({ t: 'key', id: editing ? editing.id : 0, keyCode: code, key: typeof e.key === 'string' ? e.key : '',
            code: typeof e.code === 'string' ? e.code : '', down: down ? 1 : 0, repeat: e.repeat ? 1 : 0, seq: down ? s : undefined });
    };

    /* Frame gaps over 50 ms while the app runs. */
    S.watchFrames = function () {
        var self = this, M = this.M;
        (function watch(last) {
            requestAnimationFrame(function (now) {
                if (self.ended || self.halted) return;
                if (last && now - last > 50) { M.gaps.push(Math.round(now - last)); if (M.gaps.length > 300) M.gaps.shift(); }
                watch(now);
            });
        })(0);
    };

    S.start = function () {
        var self = this, options = this.options, M = this.M;
        var device = options.device ||
            { width: 1920 / this.scale, height: 1080 / this.scale, pixelRatio: this.scale, dark: true };
        M.scriptStart = Math.round(performance.now());
        M.ua = navigator.userAgent;
        var module = absolute(options.module || 'app.wasm');
        if (options.thread === 'page') {
            M.mode = 'page';
            var engine = this.engine = new NshEngine({
                out: function (m) { self.receive(m); },
                measure: document.createElement('canvas').getContext('2d'),
                samePage: true
            });
            /* Never into the module while it runs: a component's event
             * during a batch waits for the batch to end. */
            var queue = [];
            this.engineSend = function (m) {
                queue.push(m);
                if (queue.length === 1) Promise.resolve().then(function () {
                    while (queue.length && !self.ended) engine.handle(queue.shift());
                    queue.length = 0;
                });
            };
            engine.start(module, device, options.version).then(function () {
                if (self.ended) return;
                M.engine = engine.M;
                self.saveMetrics();
            }, function (err) {
                /* An ended session tells its host nothing more; a trap was
                 * reported as fatal already. */
                if (self.ended || (err && err.reported)) return;
                M.fatal = String(err);
                self.fatal('could not start: ' + err);
            });
        } else {
            var worker = this.worker = new Worker(absolute(options.worker || 'nsh-worker.js'));
            worker.onmessage = function (e) { self.receive(e.data); };
            worker.onerror = function (e) {
                if (self.ended) return;
                M.fatal = String(e.message || e);
                self.error('the Worker failed: ' + M.fatal);
            };
            this.engineSend = function (m) { worker.postMessage(m); };
            worker.postMessage({
                t: 'init', module: module, version: options.version, device: device, bench: !!api.benchBuild,
                scripts: (options.scripts || []).map(absolute),
                fonts: (options.fonts || []).map(function (f) { return { family: f.family, url: absolute(f.url), weight: f.weight, style: f.style }; })
            });
        }
        /* Host fonts draw on the page too. */
        (options.fonts || []).forEach(function (f) {
            try {
                var face = new FontFace(f.family, NshTizen.cssUrl(absolute(f.url)), { weight: String(f.weight || 400), style: f.style || 'normal' });
                document.fonts.add(face);
                face.load().catch(function () { /* reported by the Worker */ });
            } catch (e) { /* no FontFace */ }
        });
        this.listen(document, 'keydown', function (e) { self.key(e, true); });
        this.listen(document, 'keyup', function (e) { self.key(e, false); });
        this.listen(document, 'visibilitychange', function () {
            if (!document.hidden && Object.keys(self.keyCodes).length) self.registerKeys();
        });
        this.watchFrames();
    };

    /* Ends the session: nothing it started acts on the page again. */
    S.end = function () {
        if (this.ended) return;
        this.ended = true;
        this.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        this.listeners = [];
        if (this.worker) this.worker.terminate();
        if (this.engine) this.engine.halt();
        clearTimeout(this.saveTimer);
        this.saveNow();
        this.renderer.dispose();
        this.waiting = {};
    };

    api.start = function (opts) {
        if (current) current.end();
        current = new Session(opts || {});
        if (current.options.backDebounceMs === undefined) current.options.backDebounceMs = 600;
        api.renderer = current.renderer;
        current.start();
        return current;
    };

    /* Ends the running app, if any. */
    api.stop = function () {
        if (current) current.end();
        current = null;
    };

    /* Debugging: keep the next batches (at most 50): NshTizen.recorded(). */
    api.record = function () { if (current) current.recorded = []; };
    api.recorded = function () { return current ? current.recorded : null; };

    /* The running session, for nsh-bench.js (benchmark builds only). */
    api.session = function () { return current; };
})(NshTizen);
