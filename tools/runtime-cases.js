/*
 * Cases of the page runtime run inside the page by tools/page-test.mjs, on
 * renderers of their own (detached from the app): host components that
 * throw, and the AVPlay example against a fake AVPlay that records its
 * calls and lets the test fire its callbacks late. Returns [[ok, what], ...].
 * Plain ES2017.
 */
(function () {
    var results = [];
    var later = [];   /* asynchronous cases, run in order */
    function check(ok, what) { results.push([!!ok, what]); }
    function metrics() { return { unknown: {}, unknownComponents: {}, errors: [], batches: 0, ops: 0, applyMs: 0 }; }
    function renderer(sent, scale) {
        var box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;visibility:hidden';
        document.body.appendChild(box);
        return new NshTizen.Renderer(box, function (m) { sent.push(m); }, metrics(), scale);
    }
    var mount = [['c', 50, 'native'], ['i', 1, 50, null], ['f', 50, 10, 20, 300, 200]];

    /* A component that throws everywhere leaves the page working. */
    (function () {
        var sent = [];
        var r = renderer(sent);
        NshTizen.registerComponent('test.throws', function () {
            return {
                props: function () { throw new Error('props'); },
                frame: function () { throw new Error('frame'); },
                command: function () { throw new Error('command'); },
                destroy: function () { throw new Error('destroy'); }
            };
        });
        r.apply(mount.concat([['n', 50, 'test.throws'], ['np', 50, { a: 1 }, []], ['nc', 50, 'go', null], ['c', 51, 'view']]));
        check(r.nodes[51], 'a batch goes on after a component throws');
        check(r.M.errors.length === 3, 'props, frame and command throws are reported (' + r.M.errors.length + ')');
        r.apply([['d', 50]]);
        check(!r.nodes[50] && r.componentNodes.length === 0, 'a throwing destroy still removes the view');
        NshTizen.registerComponent('test.factory', function () { throw new Error('factory'); });
        r.apply(mount.concat([['n', 50, 'test.factory'], ['np', 50, { a: 1 }, []]]));
        check(r.M.errors.length === 5, 'a throwing factory is reported and the view stays (' + r.M.errors.length + ')');
        r.dispose();
    })();

    /* Removed props and null props are told apart. */
    (function () {
        var seen = [];
        var r = renderer([]);
        NshTizen.registerComponent('test.props', function () {
            return { props: function (changed, all, removed) { seen.push([JSON.stringify(changed), JSON.stringify(all), removed.join()]); } };
        });
        r.apply(mount.concat([['n', 50, 'test.props'], ['np', 50, { a: 1, b: 2 }, []], ['np', 50, { a: null }, ['b']]]));
        check(seen[1][0] === '{"a":null}' && seen[1][1] === '{"a":null}' && seen[1][2] === 'b', 'null kept, removal named: ' + JSON.stringify(seen[1]));
        r.dispose();
    })();

    /* Image URIs: no CSS injection, no foreign schemes, an error event for
     * a blocked one; in-memory images by their key. */
    (function () {
        var sent = [];
        var r = renderer(sent);
        r.apply([['c', 60, 'image'], ['i', 1, 60, null], ['e', 60, 32 | 64],
            ['im', 60, 'x.png");background:red;x:url("y', 'cover', 'p.png") red', 0, '', 'rgb(1,2,3)']]);
        var mask = r.nodes[60].img.mask.style;
        check(mask.backgroundColor === 'rgb(1, 2, 3)', 'a quote in a URI does not end the url(): ' + mask.backgroundColor);
        ['javascript:alert(1)', ' \tjavascript:alert(1)', 'file:///etc/passwd', '\tfile:///opt/x.png', 'data:,'].forEach(function (uri) {
            sent.length = 0;
            r.apply([['im', 60, uri, 'cover', null, 0, '', null]]);
            check(!r.nodes[60].img.el.getAttribute('src'), JSON.stringify(uri) + ' is not loaded');
            check(sent.some(function (m) { return m.t === 'image' && m.ok === 0; }), JSON.stringify(uri) + ' reports an error');
        });
        r.imageBytes('data:text/plain;nsh-key=1', 'text/plain', new Uint8Array([1]).buffer);
        r.apply([['im', 60, 'data:text/plain;nsh-key=1', 'cover', null, 0, '', null]]);
        check(/^blob:/.test(r.nodes[60].img.el.getAttribute('src') || ''), 'an in-memory image of any type shows by its key');
        r.apply([['im', 60, 'https://x.test/a.png', 'cover', null, 0, '', null], ['im', 60, 'logo.png', 'cover', null, 0, '', null]]);
        check(/logo\.png$/.test(r.nodes[60].img.el.src), 'relative package images load');
        r.dispose();
        /* On a file: page (the TV's package), paths out of the package are
         * refused however they are written. */
        var base = 'file:///opt/usr/apps/X/res/wgt/index.html';
        ['/etc/x', '../../../../etc/x', '//host/x', '\\etc\\x', 'assets/../../x', ' /etc/x'].forEach(function (u) {
            check(!NshTizen.imageAllowed(u, base), JSON.stringify(u) + ' is refused on a file: page');
        });
        ['assets/logo.png', 'logo.png', './assets/a.png', 'https://x.test/a.png'].forEach(function (u) {
            check(NshTizen.imageAllowed(u, base), JSON.stringify(u) + ' is allowed on a file: page');
        });
    })();

    /* ---------- the engine host (page-thread pages load it) ---------- */

    if (typeof NshEngine !== 'undefined') (function () {
        var out = [];
        var engine = new NshEngine({ out: function (m) { out.push(m); }, measure: null });
        var log = [];
        engine.ex = {
            memory: null,
            inner: function () { throw new WebAssembly.RuntimeError('unreachable'); },
            outer: function () { var r = hostImport(); log.push('after import ' + r); return r; }
        };
        var exports = engine.wrapped();
        /* A host import that calls an export which traps, catching it. */
        var hostImport = engine.guard('host.f', function () {
            try { exports.inner(); } catch (e) { log.push('host caught'); }
            return 5;
        });
        engine.call('outer');
        check(log.indexOf('after import 5') < 0, 'a nested trap stops the outer module call: ' + log.join(','));
        check(out.filter(function (m) { return m.t === 'fatal'; }).length === 1, 'reported once as fatal');
        var threw = false;
        try { hostImport(); } catch (e) { threw = true; }
        check(threw, 'an import called after the trap throws');

        /* Import errors: long ones dedupe, past 20 distinct each once. */
        var out2 = [];
        var e2 = new NshEngine({ out: function (m) { out2.push(m); }, measure: null });
        var long = new Array(700).join('x');
        var bad = e2.guard('host.g', function (k) { throw new Error(k + long); });
        for (var i = 0; i < 3; i++) bad('same');
        for (var k = 0; k < 25; k++) { bad('k' + k); bad('k' + k); }
        var posted = out2.filter(function (m) { return m.t === 'error'; }).length;
        check(posted === 26, 'each distinct import error posted once (' + posted + ')');
        var counted = e2.M.importErrorCounts[('host.g: Error: same' + long).slice(0, 500)];
        check(counted === 3, 'and counted in the metrics the page gets (' + counted + ')');
        for (var o = 0; o < 210; o++) bad('o' + o);
        var after = out2.filter(function (m) { return m.t === 'error'; }).length;
        check(after === 200 && e2.M.importErrorOverflow === 36, 'past 200 texts: one overflow count, no report (' + after + ', ' + e2.M.importErrorOverflow + ')');
        /* Wrapped exports pass every argument. */
        var got = null;
        var e3 = new NshEngine({ out: function () {}, measure: null });
        e3.ex = { memory: null, many: function () { got = Array.prototype.slice.call(arguments); } };
        e3.wrapped().many(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
        check(got && got.length === 10 && got[9] === 10, 'wrapped exports pass more than 8 arguments: ' + JSON.stringify(got));
    })();

    /* ---------- AVPlay ---------- */

    /*
     * A fake AVPlay with Samsung's rules: every call during a seek is
     * refused (recorded in `misuse` and thrown), pause only from PLAYING or
     * PAUSED, play only from READY or PAUSED or PLAYING. Seeks complete
     * asynchronously, or fail (`seekFails`), or never answer (`seekHangs`).
     */
    function fakeAvplay() {
        var f = { calls: [], listener: null, prepared: null, failPlay: false, time: 0, state: 'NONE', seeking: false,
            misuse: [], seekFails: false, seekHangs: false };
        function refuse(name) {
            if (!f.seeking) return;
            f.misuse.push(name);
            throw new Error('AVPlay refuses ' + name + ' during a seek');
        }
        function rec(name, then) {
            return function () {
                f.calls.push(name);
                refuse(name);
                if (then) then();
            };
        }
        f.api = {
            open: rec('open', function () { f.state = 'IDLE'; }),
            close: rec('close', function () {
                if (f.closeFails > 0) { f.closeFails--; throw new Error('close refused'); }
                f.state = 'NONE';
            }),
            stop: rec('stop', function () { if (f.state !== 'NONE') f.state = 'IDLE'; }),
            pause: rec('pause', function () {
                if (f.state !== 'PLAYING' && f.state !== 'PAUSED') { f.misuse.push('pause in ' + f.state); throw new Error('pause in ' + f.state); }
                f.state = 'PAUSED';
            }),
            setTimeoutForBuffering: rec('setTimeoutForBuffering'),
            setDisplayMethod: function (m) { f.calls.push('setDisplayMethod'); refuse('setDisplayMethod'); f.method = m; },
            setDisplayRect: function (x, y, w, h) { f.calls.push('setDisplayRect'); refuse('setDisplayRect'); f.rect = [x, y, w, h]; },
            setListener: function (l) { f.calls.push('setListener'); refuse('setListener'); f.listener = l; },
            prepareAsync: function (ok, fail) { f.calls.push('prepareAsync'); refuse('prepareAsync'); f.prepared = { ok: function () { f.state = 'READY'; ok(); }, fail: fail }; },
            play: function () {
                f.calls.push('play');
                refuse('play');
                if (f.failPlay) throw new Error('play failed');
                f.state = 'PLAYING';
            },
            seekTo: function (ms, ok, fail) {
                f.calls.push('seekTo ' + ms);
                refuse('seekTo');
                f.seeking = true;
                if (f.seekHangs) { f.hanging = { ok: function () { f.seeking = false; ok(); }, fail: function () { f.seeking = false; fail(); } }; return; }
                setTimeout(function () { f.seeking = false; if (f.seekFails) fail(); else ok(); }, 20);
            },
            getState: function () { return f.state; },
            getCurrentTime: function () { f.calls.push('getCurrentTime'); refuse('getCurrentTime'); return f.time; },
            getDuration: function () { return 0; },
            getCurrentStreamInfo: function () { f.calls.push('getCurrentStreamInfo'); refuse('getCurrentStreamInfo'); return []; }
        };
        return f;
    }

    var realApi = NshTizen.avplay.api;
    function withFake(test, scale) {
        var f = fakeAvplay();
        NshTizen.avplay.api = function () { return f.api; };
        NshTizen.registerComponent('test.avplay', NshTizen.avplay);
        var sent = [];
        var r = renderer(sent, scale);
        r.apply(mount.concat([['n', 50, 'test.avplay']]));
        var events = function () {
            return sent.filter(function (m) { return m.t === 'native'; }).map(function (m) { return m.name + ' ' + m.data; });
        };
        try { test(f, r, events, sent); } finally {
            r.dispose();
            NshTizen.avplay.api = realApi;
        }
    }

    var rectAt1 = null;
    withFake(function (f, r, events) {
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 1 }, paused: false }, []]]);
        f.prepared.ok();
        var order = f.calls.filter(function (c) { return c !== 'getCurrentStreamInfo'; }).join(',');
        check(order === 'open,setTimeoutForBuffering,setDisplayMethod,setDisplayRect,setListener,prepareAsync,setDisplayMethod,setDisplayRect,play',
            'AVPlay calls in order: ' + order);
        check(f.method === 'PLAYER_DISPLAY_MODE_FULL_SCREEN', 'a rect smaller than the screen takes FULL_SCREEN: ' + f.method);
        rectAt1 = f.rect;
        check(events().indexOf('state {"state":"ready"}') >= 0, 'ready is reported');
        /* A new source: the old one's late callbacks do nothing. */
        var oldListener = f.listener, oldPrepared = f.prepared;
        f.calls = [];
        r.apply([['np', 50, { source: { url: 'https://x.test/b.m3u8', token: 2 } }, []]]);
        check(f.calls.slice(0, 3).join(',') === 'stop,close,open', 'a new source closes the old one first: ' + f.calls.join(','));
        var before = events().length;
        oldListener.onbufferingcomplete();
        oldListener.oncurrentplaytime(5000);
        oldListener.onerror('PLAYER_ERROR_OLD');
        oldPrepared.ok();
        check(events().length === before, 'late callbacks of the old stream are dropped');
    });

    /* A page zoomed 2x (frames in points): the video plane's rect doubles. */
    withFake(function (f, r) {
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 1 }, paused: false }, []]]);
        f.prepared.ok();
        var doubled = rectAt1 && f.rect && f.rect.every(function (v, i) { return v === rectAt1[i] * 2; });
        check(doubled, 'at scale 2 the rect is twice the scale-1 one: ' + JSON.stringify([rectAt1, f.rect]));
        /* The whole screen (960 x 540 points at scale 2) keeps LETTER_BOX. */
        r.apply([['f', 50, 0, 0, 960, 540]]);
        check(f.method === 'PLAYER_DISPLAY_MODE_LETTER_BOX' && f.rect.join() === '0,0,1920,1080',
            'the whole screen takes LETTER_BOX: ' + f.method + ' ' + f.rect);
        /* A method the firmware refuses does not lose the rect. */
        f.api.setDisplayMethod = function () { throw new Error('no method'); };
        r.apply([['f', 50, 10, 10, 100, 100]]);
        check(f.rect.join() === '20,20,200,200', 'a refused method still places the rect: ' + f.rect);
    }, 2);

    withFake(function (f, r, events) {
        /* play() throwing in prepareAsync's success: one failure path. */
        f.failPlay = true;
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 1 } }, []]]);
        f.prepared.ok();
        var last = f.calls.slice(-2).join(',');
        check(last === 'stop,close', 'a throwing play() closes the player: ' + f.calls.join(','));
        check(events().indexOf('state {"state":"idle"}') >= 0 && events().some(function (e) { return e.indexOf('error') === 0; }), 'and reports error then idle');
        var n = events().length;
        f.listener.onbufferingcomplete();
        check(events().length === n, 'no ready after the failure');
    });

    withFake(function (f, r, events) {
        /* An error releases AVPlay: a second player may open. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 1 } }, []]]);
        f.listener.onerror('PLAYER_ERROR_CONNECTION_FAILED');
        check(f.calls.slice(-2).join(',') === 'stop,close', 'an error closes');
        var sent2 = [];
        var r2 = renderer(sent2);
        r2.apply(mount.concat([['n', 50, 'test.avplay'], ['np', 50, { source: { url: 'https://x.test/b.m3u8', token: 1 } }, []]]));
        check(!sent2.some(function (m) { return m.t === 'native' && m.data.indexOf('busy') >= 0; }), 'the next player is not busy');
        r2.dispose();
    });

    /* The cases below wait for the fake's asynchronous seeks. */
    function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
    function withFakeAsync(test) {
        later.push(function () {
            var f = fakeAvplay();
            NshTizen.avplay.api = function () { return f.api; };
            NshTizen.registerComponent('test.avplay', NshTizen.avplay);
            var sent = [];
            var r = renderer(sent);
            r.apply(mount.concat([['n', 50, 'test.avplay']]));
            var events = function () {
                return sent.filter(function (m) { return m.t === 'native'; }).map(function (m) { return m.name + ' ' + m.data; });
            };
            var done = function () { r.dispose(); NshTizen.avplay.api = realApi; };
            return test(f, r, events, sent).then(done, function (e) { done(); check(false, 'case threw: ' + e); });
        });
    }

    withFakeAsync(function (f, r, events) {
        /* A seek before ready waits for it; one asked while it runs waits
         * too, and the latest wins; nothing calls AVPlay meanwhile. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 3 }, seek: { token: 3, id: 1, ms: 9000 } }, []]]);
        check(f.calls.indexOf('seekTo 9000') < 0, 'no seek before prepare');
        f.prepared.ok();
        check(f.calls.indexOf('seekTo 9000') >= 0, 'the seek runs once prepared');
        r.apply([['np', 50, { seek: { token: 3, id: 2, ms: 1000 } }, []], ['np', 50, { seek: { token: 3, id: 3, ms: 2000 } }, []], ['np', 50, { paused: true }, []]]);
        return wait(80).then(function () {
            check(f.misuse.length === 0, 'no AVPlay call during a seek: ' + f.misuse.join(','));
            var seeks = f.calls.filter(function (c) { return c.indexOf('seekTo') === 0; });
            check(seeks.join(',') === 'seekTo 9000,seekTo 2000', 'a seek in flight holds the next, the latest wins: ' + seeks.join(','));
            check(f.state === 'PAUSED', 'the pause asked during the seek is applied after it: ' + f.state);
            check(events().filter(function (e) { return e.indexOf('timeline') === 0; }).length === 2, 'each completed seek reports its timeline');
        });
    });

    withFakeAsync(function (f, r, events) {
        /* Hidden then shown: closed, then reopened where it was, play
         * after the seek back, and the app's last seek not replayed. */
        var hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
        var restore = function () { delete document.hidden; };
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 4 }, seek: { token: 4, id: 7, ms: 3000 } }, []]]);
        f.prepared.ok();
        return wait(60).then(function () {
            f.time = 42000;
            f.calls = [];
            hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            check(f.calls.join(',') === 'getCurrentTime,stop,close', 'hidden: its position read, then closed (' + f.calls.join(',') + ')');
            f.calls = [];
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            f.prepared.ok();
            return wait(60);
        }).then(function () {
            restore();
            var calls = f.calls.filter(function (c) { return c !== 'getCurrentStreamInfo'; }).join(',');
            check(/^open,.*prepareAsync,.*seekTo 42000,.*play/.test(calls), 'shown: reopened at its position, play after the seek (' + calls + ')');
            check(f.calls.indexOf('seekTo 3000') < 0, 'the app\'s completed seek is not replayed');
            check(f.misuse.length === 0, 'no AVPlay call during the seek back: ' + f.misuse.join(','));
        }, function (e) { restore(); throw e; });
    });

    withFakeAsync(function (f, r, events) {
        /* Opened paused: it stays READY (no pause there), and plays when
         * unpaused; a pause then works. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 5 }, paused: true }, []]]);
        f.prepared.ok();
        check(f.state === 'READY' && f.misuse.length === 0, 'opened paused stays READY: ' + f.state + ' ' + f.misuse.join(','));
        check(events().indexOf('state {"state":"ready"}') >= 0 && !events().some(function (e) { return e.indexOf('error') === 0; }), 'and is ready, not failed');
        r.apply([['np', 50, { paused: false }, []]]);
        r.apply([['np', 50, { paused: true }, []]]);
        check(f.state === 'PAUSED' && f.misuse.length === 0, 'played, then paused: ' + f.state);
        return Promise.resolve();
    });

    withFakeAsync(function (f, r, events) {
        /* A zap during a seek: the close and the reopen wait for it. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 6 } }, []]]);
        f.prepared.ok();
        r.apply([['np', 50, { seek: { token: 6, id: 1, ms: 5000 } }, []]]);
        f.calls = [];
        r.apply([['np', 50, { source: { url: 'https://x.test/b.m3u8', token: 7 } }, []]]);
        check(f.calls.length === 0, 'nothing during the seek: ' + f.calls.join(','));
        return wait(60).then(function () {
            check(f.misuse.length === 0, 'no refused call: ' + f.misuse.join(','));
            check(f.calls.slice(0, 3).join(',') === 'stop,close,open', 'after it: close, then the new stream: ' + f.calls.join(','));
        });
    });

    withFakeAsync(function (f, r, events) {
        /* Hidden during a seek: closed after it, at the seek's position. */
        var hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
        var restore = function () { delete document.hidden; };
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 8 } }, []]]);
        f.prepared.ok();
        r.apply([['np', 50, { seek: { token: 8, id: 1, ms: 7000 } }, []]]);
        /* Where the fake's seek takes it. */
        f.time = 7000;
        f.calls = [];
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        check(f.calls.length === 0, 'hidden mid-seek: nothing yet (' + f.calls.join(',') + ')');
        return wait(60).then(function () {
            check(f.calls.join(',') === 'getCurrentTime,stop,close', 'its position read and closed once the seek ended: ' + f.calls.join(','));
            f.calls = [];
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            f.prepared.ok();
            return wait(60);
        }).then(function () {
            restore();
            check(f.calls.indexOf('seekTo 7000') >= 0, 'reopened at the seek\'s position: ' + f.calls.join(','));
            check(f.misuse.length === 0, 'no refused call: ' + f.misuse.join(','));
        }, function (e) { restore(); throw e; });
    });

    withFakeAsync(function (f, r, events, sent) {
        /* The view removed during a seek: the player is still closed. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 9 } }, []]]);
        f.prepared.ok();
        r.apply([['np', 50, { seek: { token: 9, id: 1, ms: 1000 } }, []]]);
        f.calls = [];
        r.apply([['d', 50]]);
        check(f.calls.length === 0, 'removed mid-seek: nothing yet');
        return wait(60).then(function () {
            check(f.calls.join(',') === 'stop,close' && f.state === 'NONE', 'closed after the seek: ' + f.calls.join(','));
            check(f.misuse.length === 0, 'no refused call: ' + f.misuse.join(','));
        });
    });

    withFakeAsync(function (f, r, events) {
        /* A failed seek tells the app. A seek that never answers is
         * reported failed by the watchdog, but nothing calls AVPlay until
         * its late callback: then what waited runs. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 10 } }, []]]);
        f.prepared.ok();
        f.seekFails = true;
        r.apply([['np', 50, { seek: { token: 10, id: 1, ms: 1000 } }, []]]);
        return wait(60).then(function () {
            check(events().some(function (e) { return e.indexOf('timeline') === 0 && e.indexOf('"failed":true') >= 0; }), 'a failed seek reports failed: ' + events().join(' | '));
            f.seekFails = false;
            f.seekHangs = true;
            NshTizen.avplay.seekTimeoutMs = 50;
            r.apply([['np', 50, { seek: { token: 10, id: 2, ms: 2000 } }, []]]);
            return wait(120);
        }).then(function () {
            NshTizen.avplay.seekTimeoutMs = 5000;
            var n = events().filter(function (e) { return e.indexOf('"failed":true') >= 0; }).length;
            check(n === 2, 'the watchdog reports a seek that never answers (' + n + ' failed)');
            f.calls = [];
            r.apply([['np', 50, { paused: true }, []], ['np', 50, { source: { url: 'https://x.test/z.m3u8', token: 11 } }, []]]);
            check(f.calls.length === 0 && f.misuse.length === 0, 'after the watchdog AVPlay still waits for the seek: ' + f.calls.join(',') + ' / ' + f.misuse.join(','));
            f.seekHangs = false;
            f.hanging.ok();
            check(f.calls.slice(0, 3).join(',') === 'stop,close,open' && f.misuse.length === 0, 'the late callback lets the zap run: ' + f.calls.join(','));
            return Promise.resolve();
        });
    });

    withFakeAsync(function (f, r, events) {
        /* A zap queued behind a seek, then a hide: opened only on show. */
        var hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
        var restore = function () { delete document.hidden; };
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 12 } }, []]]);
        f.prepared.ok();
        r.apply([['np', 50, { seek: { token: 12, id: 1, ms: 1000 } }, []]]);
        r.apply([['np', 50, { source: { url: 'https://x.test/b.m3u8', token: 13 } }, []]]);
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        f.calls = [];
        return wait(60).then(function () {
            check(f.calls.indexOf('open') < 0, 'nothing opened while hidden: ' + f.calls.join(','));
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            check(f.calls.indexOf('open') >= 0, 'opened on show: ' + f.calls.join(','));
            restore();
        }, function (e) { restore(); throw e; });
    });

    withFakeAsync(function (f, r, events) {
        /* Hidden during the app's seek: the seek is answered (not asked
         * again on show), and the stream reopens where the player was
         * after it. */
        var hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
        var restore = function () { delete document.hidden; };
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 14 }, seek: { token: 14, id: 5, ms: 8000 } }, []]]);
        f.prepared.ok();
        hidden = true;
        f.time = 8100;
        document.dispatchEvent(new Event('visibilitychange'));
        return wait(60).then(function () {
            check(events().some(function (e) { return e.indexOf('timeline') === 0 && e.indexOf('"seekId":5') >= 0; }), 'the seek is answered though hidden');
            f.calls = [];
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            f.prepared.ok();
            return wait(60);
        }).then(function () {
            restore();
            var seeks = f.calls.filter(function (c) { return c.indexOf('seekTo') === 0; });
            check(seeks.join(',') === 'seekTo 8100', 'reopened at the player\'s position, the seek not repeated: ' + seeks.join(','));
            check(f.misuse.length === 0, 'no refused call: ' + f.misuse.join(','));
        }, function (e) { restore(); throw e; });
    });

    withFakeAsync(function (f, r, events, sent) {
        /* A close AVPlay refuses: the player is retried, and a zap that
         * found it stuck opens once it closes. */
        NshTizen.avplay.stuckRetryMs = 20;
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 15 } }, []]]);
        f.prepared.ok();
        f.closeFails = 1;
        r.apply([['np', 50, { source: null }, []]]);
        f.calls = [];
        var sent2 = [];
        var r2 = renderer(sent2);
        r2.apply(mount.concat([['n', 50, 'test.avplay'], ['np', 50, { source: { url: 'https://x.test/b.m3u8', token: 1 } }, []]]));
        return wait(100).then(function () {
            NshTizen.avplay.stuckRetryMs = 1000;
            check(f.calls.indexOf('open') >= 0, 'opened once the stuck player closed: ' + f.calls.join(','));
            check(!sent2.some(function (m) { return m.t === 'native' && m.data.indexOf('busy') >= 0; }), 'without busy');
            r2.dispose();
        });
    });

    withFakeAsync(function (f, r, events) {
        /* Hidden and shown again before the app's seek answers: reopened
         * where the player was once the seek ended, not at 0. */
        var hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
        var restore = function () { delete document.hidden; };
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 16 } }, []]]);
        f.prepared.ok();
        f.seekHangs = true;
        r.apply([['np', 50, { seek: { token: 16, id: 1, ms: 9000 } }, []]]);
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        f.seekHangs = false;
        f.time = 9000;
        f.calls = [];
        f.hanging.ok();
        return wait(20).then(function () {
            f.prepared.ok();
            return wait(60);
        }).then(function () {
            restore();
            var seeks = f.calls.filter(function (c) { return c.indexOf('seekTo') === 0; });
            check(seeks.join(',') === 'seekTo 9000', 'a quick hide and show reopens at the position after the seek: ' + f.calls.join(','));
            check(f.misuse.length === 0, 'no refused call: ' + f.misuse.join(','));
        }, function (e) { restore(); throw e; });
    });

    withFakeAsync(function (f, r, events, sent) {
        /* A STUCK player whose retries are spent: a later open restarts
         * the retries (one loop) and opens once the close succeeds; with a
         * player that never closes it is told busy. */
        NshTizen.avplay.stuckRetryMs = 10;
        NshTizen.avplay.stuckTries = 2;
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 17 } }, []]]);
        f.prepared.ok();
        f.closeFails = 100;
        r.apply([['np', 50, { source: null }, []]]);
        return wait(80).then(function () {
            /* Still refusing when the new open comes: it waits, and the
             * restarted retries let it open once the close goes through. */
            f.calls = [];
            var sent2 = [];
            var r2 = renderer(sent2);
            r2.apply(mount.concat([['n', 50, 'test.avplay'], ['np', 50, { source: { url: 'https://x.test/b.m3u8', token: 1 } }, []]]));
            return wait(5).then(function () {
                f.closeFails = 0;
                return wait(80);
            }).then(function () {
                check(f.calls.indexOf('open') >= 0, 'after the spent retries a new open restarts them and opens: ' + f.calls.join(','));
                r2.dispose();
                /* A player another page holds: busy at once, not silence. */
                f.state = 'PLAYING';
                var sent3 = [];
                var r3 = renderer(sent3);
                r3.apply(mount.concat([['n', 50, 'test.avplay'], ['np', 50, { source: { url: 'https://x.test/c.m3u8', token: 1 } }, []]]));
                check(sent3.some(function (m) { return m.t === 'native' && m.data.indexOf('busy') >= 0; }), 'a player that stays taken is reported busy');
                r3.dispose();
                NshTizen.avplay.stuckRetryMs = 1000;
                NshTizen.avplay.stuckTries = 10;
            });
        });
    });

    /* `autoFocus`, as Android's InputBox: armed by an input's first
     * configuration (after its insert in the batch that mounts it), it
     * takes the DOM focus (the TV keyboard) at the batch's end, unless an
     * input is edited or the batch focused something; a hidden or unsized
     * input waits until it is shown; a blur, a removal or a newer focus
     * ends the wait. At the page's scales 1 and 2 (a zoomed container). */
    [1, 2].forEach(function (scale) {
        later.push(function () {
            var box = document.createElement('div');
            /* Focusable: not `visibility: hidden`. */
            box.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;opacity:0;zoom:' + scale;
            document.body.appendChild(box);
            var sent = [];
            var r = new NshTizen.Renderer(box, function (m) { sent.push(m); }, metrics(), scale);
            var at = ' (scale ' + scale + ')';
            var config = function (auto, ph) { return { css: '', ph: ph || '', type: 'text', ml: false, max: -1, off: false, submit: 'keep', auto: auto }; };
            var el = function (id) { return r.nodes[id].input.el; };
            var active = function () { return document.activeElement && document.activeElement.id; };
            var blur = function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); };
            /* An input mounted as the core mounts it: create, insert,
             * frame, then its configuration. */
            var input = function (id, parent, auto, w) {
                return [['c', id, 'input'], ['i', parent, id, null], ['f', id, 0, 0, w === undefined ? 200 : w, 40], ['in', id, config(auto)]];
            };

            r.apply([['c', 72, 'view'], ['f', 72, 0, 0, 400, 400]].concat(input(73, 72, true), input(74, 72, false), [['i', 1, 72, null]]));
            check(document.activeElement === el(73), 'the auto-focused input has the DOM focus' + at + ': ' + active());
            check(r.editing === r.nodes[73] && sent.some(function (m) { return m.t === 'focus' && m.id === 73 && m.on === 1; }),
                'and the app hears it is edited' + at);

            blur();
            r.apply([['i', 1, 73, null]]);
            r.apply([['in', 73, config(true, 'again')]]);
            check(document.activeElement !== el(73), 'a moved or reconfigured auto-focus input does not take the focus again' + at + ': ' + active());

            el(74).focus();
            r.apply(input(75, 72, true));
            check(document.activeElement === el(74), 'an input being edited keeps the focus' + at + ': ' + active());
            blur();
            r.apply([['f', 75, 0, 0, 210, 40]]);
            check(document.activeElement !== el(75), 'and the auto focus it kept from does not come later' + at + ': ' + active());

            r.apply(input(76, 72, true).concat(input(77, 72, false), [['fo', 77, true]]));
            check(document.activeElement === el(77), 'an explicit focus in the same batch wins' + at + ': ' + active());
            blur();

            r.apply(input(78, 72, true, 0));
            check(document.activeElement !== el(78), 'an unsized (display: none) auto-focus input waits' + at + ': ' + active());
            r.apply([['f', 78, 0, 0, 200, 40]]);
            check(document.activeElement === el(78), 'and takes the focus once it is shown' + at + ': ' + active());
            blur();

            r.apply([['c', 79, 'view'], ['f', 79, 0, 0, 400, 400], ['s', 79, 'visibility:hidden;'], ['i', 1, 79, null]].concat(input(80, 79, true)));
            check(document.activeElement !== el(80), 'a visibility: hidden auto-focus input waits' + at + ': ' + active());
            r.apply([['s', 79, '']]);
            check(document.activeElement === el(80), 'and takes the focus once visible' + at + ': ' + active());
            blur();

            r.apply([['c', 81, 'input'], ['in', 81, config(true)]]);
            check(document.activeElement !== el(81), 'an input not inserted takes no focus' + at);
            r.apply([['i', 72, 81, null], ['f', 81, 0, 0, 200, 40]]);
            check(document.activeElement === el(81), 'until it is' + at + ': ' + active());
            blur();

            r.apply(input(82, 72, true, 0));
            r.apply([['fo', 82, false], ['f', 82, 0, 0, 200, 40]]);
            check(document.activeElement !== el(82), 'a blur ends the wait' + at + ': ' + active());
            r.apply(input(83, 72, true, 0));
            r.apply([['r', 83]]);
            r.apply([['i', 72, 83, null], ['f', 83, 0, 0, 200, 40]]);
            check(document.activeElement !== el(83), 'so does a removal' + at + ': ' + active());
            r.apply(input(84, 72, true, 0));
            r.apply([['c', 85, 'view'], ['i', 72, 85, null], ['fo', 85, true]]);
            r.apply([['f', 84, 0, 0, 200, 40]]);
            check(document.activeElement !== el(84), 'and a newer focus request' + at + ': ' + active());
            check(r.autoFocus.length === 0, 'nothing is left waiting' + at + ': ' + r.autoFocus.length);
            r.dispose();
            box.parentNode.removeChild(box);
            return Promise.resolve();
        });
    });

    /* An app OK whose press focused an input: its repeats reach the page's
     * handler (still the app's), and its release is sent. */
    later.push(function () {
        var sentIn = [];
        var r = renderer(sentIn);
        r.apply([['c', 71, 'input'], ['i', 1, 71, null], ['in', 71, { css: '', ph: '', type: 'text', ml: false, max: -1, off: false, submit: 'blur', auto: false }]]);
        r.keys[13] = 'app';
        var el = r.nodes[71].input.el;
        el.focus();
        var reached = false;
        var spy = function () { reached = true; };
        document.addEventListener('keydown', spy);
        var e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, repeat: true });
        Object.defineProperty(e, 'keyCode', { get: function () { return 13; } });
        el.dispatchEvent(e);
        document.removeEventListener('keydown', spy);
        check(reached, 'the repeat reaches the page\'s handler');
        check(!sentIn.some(function (m) { return m.name === 'onSubmitEditing'; }), 'and the input does not take it as a submit');
        r.dispose();
        return Promise.resolve();
    });

    /* A held OK that focused an input stays the app's: its repeats in the
     * input do not turn it into a swallowed key, so its release is sent. */
    later.push(function () {
        var r = renderer([]);
        r.apply([['c', 70, 'input'], ['i', 1, 70, null], ['in', 70, { css: '', ph: '', type: 'text', ml: false, max: -1, off: false, submit: 'blur', auto: false }]]);
        r.keys[13] = 'app';
        var el = r.nodes[70].input.el;
        el.focus();
        var e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, repeat: true });
        Object.defineProperty(e, 'keyCode', { get: function () { return 13; } });
        el.dispatchEvent(e);
        check(r.keys[13] === 'app', 'a repeat in the input keeps the press\'s disposition: ' + r.keys[13]);
        r.dispose();
        return Promise.resolve();
    });

    later.push(function () {
        /* A stream the host page plays itself is not taken or stopped. */
        var f = fakeAvplay();
        /* Opened and preparing (IDLE) counts as the host's too. */
        f.state = 'IDLE';
        NshTizen.avplay.api = function () { return f.api; };
        NshTizen.registerComponent('test.avplay', NshTizen.avplay);
        var sent = [];
        var r = renderer(sent);
        r.apply(mount.concat([['n', 50, 'test.avplay'], ['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 1 } }, []]]));
        check(f.calls.length === 0, 'the host\'s stream is left alone: ' + f.calls.join(','));
        check(sent.some(function (m) { return m.t === 'native' && m.data.indexOf('busy') >= 0; }), 'and the component reports busy');
        r.dispose();
        NshTizen.avplay.api = realApi;
        return Promise.resolve();
    });

    return later.reduce(function (p, f) { return p.then(f); }, Promise.resolve()).then(function () { return results; });
})()
