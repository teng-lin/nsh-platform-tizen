/*
 * nsh-platform-tizen, the engine's side: loads the app's WebAssembly
 * module (cached compiled in IndexedDB), provides its imports, and turns
 * what the engine commits into messages for the page (`out(message,
 * transfer)`). It runs in the Worker (worker.js, the default) or, for the
 * benchmark only, on the page itself.
 *
 * Messages it sends: {t:'ops', batches:[JSON text...], seq?, engineMs?},
 * {t:'frame'}, {t:'host', m}, {t:'font', family, weight, italic, data},
 * {t:'imageBytes', uri, data}, {t:'keys', rows}, {t:'error', text},
 * {t:'log', level, text}, {t:'metrics', m}.
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
    this.M = { moduleFromCache: null, stubbed: [], logs: [] };
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
}

(function () {
    var E = NshEngine.prototype;

    E.str = function (ptr, len) { return this.decoder.decode(new Uint8Array(this.ex.memory.buffer, ptr, len)); };

    E.bytes = function (ptr, len) { return new Uint8Array(this.ex.memory.buffer, ptr, len).slice().buffer; };

    /* Calls `f` with each string of `list` in module memory ([ptr, len]). */
    E.withStrings = function (list, f) {
        var ex = this.ex, enc = this.encoder;
        var ptrs = list.map(function (s) {
            var bytes = enc.encode(s);
            var p = ex.nsh_tz_alloc(bytes.length);
            new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
            return [p, bytes.length];
        });
        try { return f(ptrs); } finally {
            ptrs.forEach(function (p) { ex.nsh_tz_free(p[0], p[1]); });
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

    E.pump = function () {
        this.pumpTimer = null;
        if (this.ex) { this.ex.nsh_tz_pump(); this.flush(); }
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
                image_bytes: function (up, ul, dp, dl) {
                    var data = self.bytes(dp, dl);
                    self.out({ t: 'imageBytes', uri: self.str(up, ul), data: data }, [data]);
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
        this.ex.nsh_tz_fonts_loaded();
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
     * this build's: older ones fill the quota). Keyed by `key`, the
     * module's size and a hash of its bytes.
     */
    E.compile = function (bytes) {
        var M = this.M;
        var key = 'app-' + bytes.byteLength + '-' + quickHash(bytes);
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
                if (!r.db) return module;
                try {
                    var tx = r.db.transaction('modules', 'readwrite');
                    var store = tx.objectStore('modules');
                    store.openCursor().onsuccess = function (e) {
                        var c = e.target.result;
                        if (!c) { store.put(module, key); return; }
                        if (c.key !== key) c.delete();
                        c.continue();
                    };
                    var w0 = performance.now();
                    tx.oncomplete = function () { M.moduleCached = true; M.cacheWriteMs = Math.round(performance.now() - w0); };
                    tx.onerror = function () { M.moduleCached = 'error ' + tx.error; };
                    tx.onabort = function () { M.moduleCached = 'abort ' + tx.error; };
                } catch (e) { M.moduleCached = 'refused: ' + e; }
                return module;
            });
        });
    };

    /* A cheap fingerprint of the module (sampled bytes): a rebuilt module
     * of the same size is not taken for the cached one. */
    function quickHash(buffer) {
        var b = new Uint8Array(buffer), h = 2166136261, step = Math.max(1, Math.floor(b.length / 65536));
        for (var i = 0; i < b.length; i += step) { h ^= b[i]; h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16);
    }

    /* Downloads, compiles (or takes from the cache), instantiates and starts. */
    E.start = function (url, device) {
        var self = this, M = this.M;
        var t0 = performance.now();
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
            return self.compile(bytes).then(function (module) {
                M.compileMs = Math.round(performance.now() - c0);
                var imports = self.imports();
                /* Imports a host has not supplied: no-ops, listed. */
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
                    self.ex = instance.exports;
                    NshTizenWorker.ready.forEach(function (f) { f(self.ex, self); });
                    self.ex.nsh_tz_init();
                    var s0 = performance.now();
                    var started = self.ex.nsh_tz_start(device.width, device.height, device.pixelRatio || 1, device.dark ? 1 : 0, 5);
                    M.startMs = Math.round(performance.now() - s0);
                    M.started = started === 1;
                    self.flush({ first: true });
                    return M;
                });
            });
        });
    };

    /* ---------- input from the page ---------- */

    /* One message of the page's (see page.js), handled and flushed. */
    E.handle = function (m) {
        var ex = this.ex, self = this;
        if (!ex) return;
        var t0 = performance.now();
        switch (m.t) {
        case 'key':
            this.withStrings([m.key, m.code], function (p) {
                ex.nsh_tz_key(m.id, m.keyCode, p[0][0], p[0][1], p[1][0], p[1][1], m.down ? 1 : 0, m.repeat ? 1 : 0);
            });
            break;
        case 'event':
            this.withStrings([m.name], function (p) { ex.nsh_tz_event(m.id, p[0][0], p[0][1]); });
            break;
        case 'text':
            this.withStrings([m.name, m.text], function (p) { ex.nsh_tz_text(m.id, p[0][0], p[0][1], p[1][0], p[1][1], m.count); });
            break;
        case 'native':
            this.withStrings([m.name, m.data], function (p) { ex.nsh_tz_native(m.id, p[0][0], p[0][1], p[1][0], p[1][1]); });
            break;
        case 'focus': ex.nsh_tz_focus(m.id, m.on); break;
        case 'states': ex.nsh_tz_states(m.id, m.states); break;
        case 'scroll': ex.nsh_tz_scroll(m.id, m.x, m.y); break;
        case 'image':
            this.withStrings([m.error || ''], function (p) { ex.nsh_tz_image(m.id, m.ok, m.w || 0, m.h || 0, p[0][0], p[0][1]); });
            break;
        case 'frame': ex.nsh_tz_frame(); break;
        case 'fontLoaded': this.fontDone(); return;
        case 'stats':
            this.out({ t: 'stats', s: { pump: ex.nsh_tz_stat(0), encode: ex.nsh_tz_stat(1), serialize: ex.nsh_tz_stat(2), text: ex.nsh_tz_stat(3), deduped: ex.nsh_tz_stat(4) } });
            return;
        default:
            return;
        }
        var extra = m.seq !== undefined ? { seq: m.seq, engineMs: performance.now() - t0 } : null;
        self.flush(extra);
    };
})();
