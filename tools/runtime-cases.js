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
    function renderer(sent) {
        var box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;visibility:hidden';
        document.body.appendChild(box);
        return new NshTizen.Renderer(box, function (m) { sent.push(m); }, metrics());
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
    })();

    /* ---------- AVPlay ---------- */

    function fakeAvplay() {
        var f = { calls: [], listener: null, prepared: null, failPlay: false, time: 0, state: 'NONE', seeking: false, misuse: [] };
        /* Samsung's rule: no AVPlay call while a seek runs. */
        function rec(name, then) {
            return function () {
                f.calls.push(name);
                if (f.seeking) f.misuse.push(name);
                if (then) then();
            };
        }
        f.api = {
            open: rec('open', function () { f.state = 'IDLE'; }),
            close: rec('close', function () { f.state = 'NONE'; }),
            stop: rec('stop', function () { if (f.state !== 'NONE') f.state = 'IDLE'; }),
            pause: rec('pause', function () { f.state = 'PAUSED'; }),
            setTimeoutForBuffering: rec('setTimeoutForBuffering'), setDisplayRect: rec('setDisplayRect'),
            setListener: function (l) { f.calls.push('setListener'); f.listener = l; },
            prepareAsync: function (ok, fail) { f.calls.push('prepareAsync'); f.prepared = { ok: function () { f.state = 'READY'; ok(); }, fail: fail }; },
            play: function () {
                f.calls.push('play');
                if (f.seeking) f.misuse.push('play');
                if (f.failPlay) throw new Error('play failed');
                f.state = 'PLAYING';
            },
            seekTo: function (ms, ok) {
                f.calls.push('seekTo ' + ms);
                if (f.seeking) f.misuse.push('seekTo');
                f.seeking = true;
                setTimeout(function () { f.seeking = false; ok(); }, 20);
            },
            getState: function () { return f.state; },
            getCurrentTime: function () { return f.time; },
            getDuration: function () { return 0; },
            getCurrentStreamInfo: function () { return []; }
        };
        return f;
    }

    var realApi = NshTizen.avplay.api;
    function withFake(test) {
        var f = fakeAvplay();
        NshTizen.avplay.api = function () { return f.api; };
        NshTizen.registerComponent('test.avplay', NshTizen.avplay);
        var sent = [];
        var r = renderer(sent);
        r.apply(mount.concat([['n', 50, 'test.avplay']]));
        var events = function () {
            return sent.filter(function (m) { return m.t === 'native'; }).map(function (m) { return m.name + ' ' + m.data; });
        };
        try { test(f, r, events, sent); } finally {
            r.dispose();
            NshTizen.avplay.api = realApi;
        }
    }

    withFake(function (f, r, events) {
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 1 }, paused: false }, []]]);
        f.prepared.ok();
        var order = f.calls.join(',');
        check(order === 'open,setTimeoutForBuffering,setDisplayRect,setListener,prepareAsync,setDisplayRect,play',
            'AVPlay calls in order: ' + order);
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
            return test(f, r, events).then(done, function (e) { done(); check(false, 'case threw: ' + e); });
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
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 4 }, seek: { token: 4, id: 7, ms: 3000 } }, []]]);
        f.prepared.ok();
        return wait(60).then(function () {
            f.time = 42000;
            f.calls = [];
            hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            check(f.calls.join(',') === 'stop,close', 'hidden: closed (' + f.calls.join(',') + ')');
            f.calls = [];
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            f.prepared.ok();
            return wait(60);
        }).then(function () {
            delete document.hidden;
            var calls = f.calls.join(',');
            check(/^open,.*prepareAsync,.*seekTo 42000,.*play/.test(calls), 'shown: reopened at its position, play after the seek (' + calls + ')');
            check(f.calls.indexOf('seekTo 3000') < 0, 'the app\'s completed seek is not replayed');
            check(f.misuse.length === 0, 'no AVPlay call during the seek back: ' + f.misuse.join(','));
        });
    });

    later.push(function () {
        /* A stream the host page plays itself is not taken or stopped. */
        var f = fakeAvplay();
        f.state = 'PLAYING';
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
