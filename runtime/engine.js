/*
 * nsh-platform-tizen, the engine's side: loads the app's WebAssembly
 * module (cached compiled in IndexedDB), provides its imports, and turns
 * what the engine commits into messages for the page (`out(message,
 * transfer)`). It runs in the Worker (worker.js, the default) or, for the
 * benchmark only, on the page itself.
 *
 * Messages it sends: {t:'ops', batches:[JSON text...], seq?, engineMs?},
 * {t:'frame'}, {t:'host', m}, {t:'font', family, weight, italic, data},
 * {t:'imageBytes', uri, type, data}, {t:'keys', rows}, {t:'error', text,
 * dead?}, {t:'log', level, text}, {t:'metrics', m}.
 *
 * Failures stay contained: an exception thrown by any import (the
 * platform's or a host's) is caught and reported, never unwound through
 * the module's Rust frames, which would leave its state borrowed. A trap
 * in the module (a Rust panic aborts) marks the engine dead: one error is
 * reported with its stack and nothing calls into the module again.
 *
 * Plain ES2017 (Chromium 69). No 64-bit integer crosses into the module.
 */
'use strict';

/* The global object, Worker or page (Chromium 69 has no globalThis). */
var NSH_GLOBAL = this;

/* Host services a host's own scripts add (`NshTizenWorker.addImports`). */
var NshTizenWorker = (function () {
    var extra = {};
    var ready = [];
    return {
        /* Imports of module `name` the app's module links (host services:
         * fetch, storage, ...). */
        addImports: function (name, functions) {
            if (!extra[name]) extra[name] = {};
            for (var k in functions) extra[name][k] = functions[k];
        },
        /* `f(exports, engine)` once the module is instantiated, before the
         * app starts: for imports that read the module's memory. */
        onInstance: function (f) { ready.push(f); },
        extra: extra,
        ready: ready
    };
})();

function NshEngine(options) {
    this.options = options;
    this.out = options.out;
    this.measure = options.measure;
    this.ex = null;
    this.pending = [];
    this.pumpTimer = null;
    this.lastFont = '';
    this.fontsPending = 0;
    this.dead = false;
    this.wakeTimer = null;
    this.M = { moduleFromCache: null, stubbed: [], logs: [], importErrors: [] };
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
}

(function () {
    var E = NshEngine.prototype;

    /*
     * Calls export `name` of the module: after a trap, never again (its
     * memory may hold a borrowed state). Returns undefined when dead.
     */
    E.call = function (name) {
        if (this.dead || !this.ex) return undefined;
        try {
            return this.ex[name].apply(null, Array.prototype.slice.call(arguments, 1));
        } catch (e) {
            this.dead = true;
            this.M.dead = name + ': ' + String(e && e.stack || e);
            this.out({ t: 'error', dead: true, text: 'the app stopped in ' + name + ': ' + String(e && e.stack || e) });
            this.out({ t: 'metrics', m: this.M });
            return undefined;
        }
    };

    /* An import's body, guarded: a throw is reported, the module gets 0. */
    E.guard = function (name, f) {
        var self = this;
        return function () {
            try {
                return f.apply(null, arguments);
            } catch (e) {
                var text = name + ': ' + String(e && e.stack || e);
                if (self.M.importErrors.length < 20) self.M.importErrors.push(text.slice(0, 500));
                self.out({ t: 'error', text: 'an import threw: ' + text });
                return 0;
            }
        };
    };

    E.str = function (ptr, len) { return this.decoder.decode(new Uint8Array(this.ex.memory.buffer, ptr, len)); };

    E.bytes = function (ptr, len) { return new Uint8Array(this.ex.memory.buffer, ptr, len).slice().buffer; };

    /* Calls `f` with each string of `list` in module memory ([ptr, len]). */
    E.withStrings = function (list, f) {
        var self = this, enc = this.encoder;
        var ptrs = [];
        for (var i = 0; i < list.length; i++) {
            var bytes = enc.encode(list[i]);
            var p = this.call('nsh_tz_alloc', bytes.length);
            if (p === undefined) return undefined;
            new Uint8Array(this.ex.memory.buffer, p, bytes.length).set(bytes);
            ptrs.push([p, bytes.length]);
        }
        try { return f(ptrs); } finally {
            ptrs.forEach(function (q) { self.call('nsh_tz_free', q[0], q[1]); });
        }
    };

    /* What the engine committed during this turn, to the page at once. */
    E.flush = function (extra) {
        if (!this.pending.length && !extra) return;
        var msg = { t: 'ops', batches: this.pending };
        if (extra) for (var k in extra) msg[k] = extra[k];
        this.pending = [];
        this.out(msg);
    };

    /* Runs what is due: from the engine's timer, a wake, or a host's
     * script after an async reply it gave the module. */
    E.pump = function () {
        this.pumpTimer = null;
        if (this.ex && !this.dead) { this.call('nsh_tz_pump'); this.flush(); }
    };

    E.imports = function () {
        var self = this;
        var imports = {
            nsh_tz: {
                submit: function (ptr, len) { self.pending.push(self.str(ptr, len)); },
                request_frame: function () { self.out({ t: 'frame' }); },
                schedule: function (ms) {
                    clearTimeout(self.pumpTimer);
                    self.pumpTimer = ms >= 0 ? setTimeout(function () { self.pump(); }, ms) : null;
                },
                /* Work arrived outside a pump (LocalEngine::set_wake): a
                 * timer of its own, which `schedule` does not cancel. */
                wake: function () {
                    if (self.wakeTimer !== null) return;
                    self.wakeTimer = setTimeout(function () { self.wakeTimer = null; self.pump(); }, 0);
                },
                report_error: function (ptr, len) {
                    var text = self.str(ptr, len);
                    self.out({ t: 'error', text: text });
                },
                measure_text: function (fptr, flen, tptr, tlen) {
                    var font = self.str(fptr, flen);
                    if (font !== self.lastFont) { self.measure.font = font; self.lastFont = font; }
                    return self.measure.measureText(self.str(tptr, tlen)).width;
                },
                log: function (level, ptr, len) {
                    /* log::Level: 1 error, 2 warn, 3 info. */
                    if (level <= 2) self.out({ t: 'log', level: level, text: self.str(ptr, len) });
                },
                host: function (ptr, len) { self.out({ t: 'host', m: self.str(ptr, len) }); },
                register_font: function (fp, fl, dp, dl, weight, italic) {
                    self.registerFont(self.str(fp, fl), self.bytes(dp, dl), weight, italic !== 0, true);
                },
                image_bytes: function (up, ul, tp, tl, dp, dl) {
                    var data = self.bytes(dp, dl);
                    self.out({ t: 'imageBytes', uri: self.str(up, ul), type: self.str(tp, tl), data: data }, [data]);
                },
                remote_keys: function (ptr, len) { self.out({ t: 'keys', rows: JSON.parse(self.str(ptr, len)) }); }
            },
            nsh: {
                now_ms: function () { return performance.now(); },
                date_now_ms: function () { return Date.now(); },
                local_offset: function (ms) { return -new Date(ms).getTimezoneOffset() * 60; }
            }
        };
        var extra = NshTizenWorker.extra;
        for (var m in extra) {
            if (!imports[m]) imports[m] = {};
            for (var k in extra[m]) imports[m][k] = extra[m][k];
        }
        for (var mod in imports) {
            for (var fn in imports[mod]) imports[mod][fn] = this.guard(mod + '.' + fn, imports[mod][fn]);
        }
        return imports;
    };

    /*
     * A font for measuring here and drawing on the page. `fromApp`: the
     * app registered it (Root::font): once it has loaded here and on the
     * page, text is measured again (`nsh_tz_fonts_loaded`).
     */
    E.registerFont = function (family, data, weight, italic, fromApp) {
        var self = this;
        var scope = typeof document !== 'undefined' ? document.fonts : NSH_GLOBAL.fonts;
        if (typeof FontFace === 'undefined' || !scope) return Promise.resolve();
        var face = new FontFace(family, data.slice ? data.slice(0) : data, { weight: String(weight), style: italic ? 'italic' : 'normal' });
        scope.add(face);
        if (fromApp && !this.options.samePage) {
            this.fontsPending++;
            this.out({ t: 'font', family: family, weight: weight, italic: italic, data: data }, [data]);
        }
        if (fromApp) this.fontsPending++;
        return face.load().then(function () { if (fromApp) self.fontDone(); },
            function (e) { self.M.fontErrors = (self.M.fontErrors || []).concat([family + ': ' + e]); if (fromApp) self.fontDone(); });
    };

    /* A font loaded here or on the page (message {t:'fontLoaded'}). */
    E.fontDone = function () {
        if (--this.fontsPending > 0 || !this.ex) return;
        this.call('nsh_tz_fonts_loaded');
        this.flush();
    };

    /* ---------- compiled-module cache ---------- */

    function idb() {
        return new Promise(function (ok, fail) {
            var req = indexedDB.open('nsh-tizen', 1);
            req.onupgradeneeded = function () { req.result.createObjectStore('modules'); };
            req.onsuccess = function () { ok(req.result); };
            req.onerror = function () { fail(req.error); };
        });
    }

    /*
     * The compiled module from IndexedDB, or compiled now and kept (only
     * this build's: older ones fill the quota). Keyed by `version`, the
     * build's SHA-256 of the module (build.sh), or without one a hash of
     * every byte: a rebuilt module of the same size must never run the
     * old compiled code.
     */
    E.compile = function (bytes, version, fresh) {
        var M = this.M, self = this;
        var key = 'app-' + (version || bytes.byteLength + '-' + fullHash(bytes));
        M.cacheKey = key;
        return idb().then(function (db) {
            return new Promise(function (ok) {
                if (fresh) { ok({ db: db, cached: null }); return; }
                var get = db.transaction('modules', 'readonly').objectStore('modules').get(key);
                get.onsuccess = function () { ok({ db: db, cached: get.result }); };
                get.onerror = function () { ok({ db: db, cached: null }); };
            });
        }).catch(function (e) { M.cacheError = String(e); return { db: null, cached: null }; }).then(function (r) {
            if (r.cached instanceof WebAssembly.Module) { M.moduleFromCache = true; return { module: r.cached, db: r.db, cached: true }; }
            M.moduleFromCache = false;
            return WebAssembly.compile(bytes).then(function (module) {
                if (r.db) self.store(r.db, key, module);
                return { module: module, db: r.db, cached: false };
            });
        });
    };

    /*
     * Keeps `module` under `key`. Older builds' modules go first, in a
     * transaction of their own: a compiled module takes about 2.6 times
     * its file's size, and the quota (88 MB on a 2020 set) counts them
     * until their deletion commits. The put waits for that commit.
     */
    E.store = function (db, key, module) {
        var M = this.M, self = this;
        var report = function () { self.out({ t: 'metrics', m: M }); };
        try {
            var clear = db.transaction('modules', 'readwrite');
            clear.objectStore('modules').clear();
            var done = false;
            var fail = function () {
                if (done) return;
                done = true;
                M.moduleCached = 'clear failed: ' + clear.error;
                report();
            };
            clear.onerror = fail;
            clear.onabort = fail;
            clear.oncomplete = function () {
                if (done) return;
                done = true;
                var tx = db.transaction('modules', 'readwrite');
                var w0 = performance.now();
                try { tx.objectStore('modules').put(module, key); } catch (err) { M.moduleCached = 'put: ' + err; report(); return; }
                tx.oncomplete = function () { M.moduleCached = true; M.cacheWriteMs = Math.round(performance.now() - w0); report(); };
                tx.onabort = function () { M.moduleCached = 'abort ' + tx.error; report(); };
            };
        } catch (e) { M.moduleCached = 'refused: ' + e; }
    };

    /* Evicts a cached module that would not instantiate. */
    E.evict = function (db) {
        try { db.transaction('modules', 'readwrite').objectStore('modules').clear(); } catch (e) { /* best effort */ }
    };

    /* FNV-1a over every byte (about 20 ms per MB on a 2020 set). */
    function fullHash(buffer) {
        var b = new Uint8Array(buffer), h = 2166136261;
        for (var i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16);
    }

    /*
     * Downloads, compiles (or takes from the cache), instantiates and
     * starts. A cached module that fails to instantiate (it no longer
     * links) is evicted and compiled again from the downloaded bytes, once.
     */
    E.start = function (url, device, version) {
        var self = this, M = this.M;
        var t0 = performance.now();
        if (!this.measure) return Promise.reject(new Error('no canvas to measure text with (OffscreenCanvas in the Worker)'));
        return new Promise(function (ok, fail) {
            /* XHR, not fetch(): Tizen serves the package's files with no
             * MIME type, which streaming compilation rejects. */
            var x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.responseType = 'arraybuffer';
            x.onload = function () { x.response ? ok(x.response) : fail(new Error('no module at ' + url)); };
            x.onerror = function () { fail(new Error('could not load ' + url)); };
            x.send();
        }).then(function (bytes) {
            M.wasmBytes = bytes.byteLength;
            M.downloadMs = Math.round(performance.now() - t0);
            var c0 = performance.now();
            var attempt = function (fresh) {
                return self.compile(bytes, version, fresh).then(function (r) {
                    M.compileMs = Math.round(performance.now() - c0);
                    return self.instantiate(r.module).catch(function (err) {
                        if (!r.cached) throw err;
                        M.cacheEvicted = String(err);
                        if (r.db) self.evict(r.db);
                        return attempt(true);
                    });
                });
            };
            return attempt(false);
        }).then(function (instance) {
            self.ex = instance.exports;
            NshTizenWorker.ready.forEach(function (f) {
                try { f(self.ex, self); } catch (e) { self.out({ t: 'error', text: 'onInstance threw: ' + (e && e.stack || e) }); }
            });
            self.call('nsh_tz_init');
            var s0 = performance.now();
            var started = self.call('nsh_tz_start', device.width, device.height, device.pixelRatio || 1, device.dark ? 1 : 0, 5);
            M.startMs = Math.round(performance.now() - s0);
            M.started = started === 1;
            self.flush({ first: true });
            if (!M.started) throw new Error(self.dead ? 'the app stopped while starting' : 'the app did not start (see its errors)');
            return M;
        });
    };

    E.instantiate = function (module) {
        var M = this.M;
        var imports = this.imports();
        /* Imports a host has not supplied: no-ops, listed. */
        M.stubbed = [];
        WebAssembly.Module.imports(module).forEach(function (imp) {
            if (imp.kind !== 'function') return;
            if (!imports[imp.module]) imports[imp.module] = {};
            if (!imports[imp.module][imp.name]) {
                M.stubbed.push(imp.module + '.' + imp.name);
                imports[imp.module][imp.name] = function () { return 0; };
            }
        });
        var i0 = performance.now();
        return WebAssembly.instantiate(module, imports).then(function (instance) {
            M.instantiateMs = Math.round(performance.now() - i0);
            return instance;
        });
    };

    /* ---------- input from the page ---------- */

    /* One message of the page's (see page.js), handled and flushed. */
    E.handle = function (m) {
        var self = this;
        if (!this.ex || this.dead) return;
        var call = function () { return self.call.apply(self, arguments); };
        var t0 = performance.now();
        switch (m.t) {
        case 'key':
            this.withStrings([m.key, m.code], function (p) {
                call('nsh_tz_key', m.id, m.keyCode, p[0][0], p[0][1], p[1][0], p[1][1], m.down ? 1 : 0, m.repeat ? 1 : 0);
            });
            break;
        case 'event':
            this.withStrings([m.name], function (p) { call('nsh_tz_event', m.id, p[0][0], p[0][1]); });
            break;
        case 'text':
            this.withStrings([m.name, m.text], function (p) { call('nsh_tz_text', m.id, p[0][0], p[0][1], p[1][0], p[1][1], m.count); });
            break;
        case 'native':
            this.withStrings([m.name, m.data], function (p) { call('nsh_tz_native', m.id, p[0][0], p[0][1], p[1][0], p[1][1]); });
            break;
        case 'focus': call('nsh_tz_focus', m.id, m.on); break;
        case 'states': call('nsh_tz_states', m.id, m.states); break;
        case 'scroll': call('nsh_tz_scroll', m.id, m.x, m.y); break;
        case 'image':
            this.withStrings([m.error || ''], function (p) { call('nsh_tz_image', m.id, m.ok, m.w || 0, m.h || 0, p[0][0], p[0][1]); });
            break;
        case 'frame': call('nsh_tz_frame'); break;
        case 'fontLoaded': this.fontDone(); return;
        case 'stats':
            this.out({ t: 'stats', s: { pump: call('nsh_tz_stat', 0), encode: call('nsh_tz_stat', 1), text: call('nsh_tz_stat', 3), deduped: call('nsh_tz_stat', 4) } });
            return;
        default:
            return;
        }
        var extra = m.seq !== undefined ? { seq: m.seq, engineMs: performance.now() - t0 } : null;
        self.flush(extra);
    };
})();
