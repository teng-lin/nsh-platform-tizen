/*
 * Cases of the page runtime run inside the page by tools/page-test.mjs, on
 * renderers of their own (detached from the app): host components that
 * throw, and the AVPlay example against a fake AVPlay that records its
 * calls and lets the test fire its callbacks late. Returns [[ok, what], ...].
 * Plain ES2017.
 */
(function () {
    var results = [];
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

    /* Image URIs: no CSS injection, no foreign schemes. */
    (function () {
        var r = renderer([]);
        r.apply([['c', 60, 'image'], ['i', 1, 60, null], ['im', 60, 'x.png");background:red;x:url("y', 'cover', 'p.png") red', 0, '', 'rgb(1,2,3)']]);
        var mask = r.nodes[60].img.mask.style;
        check(mask.backgroundColor === 'rgb(1, 2, 3)', 'a quote in a URI does not end the url(): ' + mask.backgroundColor);
        r.apply([['im', 60, 'javascript:alert(1)', 'cover', null, 0, '', null]]);
        check(!r.nodes[60].img.el.getAttribute('src'), 'a javascript: image is not loaded');
        r.dispose();
    })();

    /* ---------- AVPlay ---------- */

    function fakeAvplay() {
        var f = { calls: [], listener: null, prepared: null, failPlay: false, time: 0 };
        function rec(name) { return function () { f.calls.push(name); }; }
        f.api = {
            open: rec('open'), close: rec('close'), stop: rec('stop'), pause: rec('pause'),
            setTimeoutForBuffering: rec('setTimeoutForBuffering'), setDisplayRect: rec('setDisplayRect'),
            setListener: function (l) { f.calls.push('setListener'); f.listener = l; },
            prepareAsync: function (ok, fail) { f.calls.push('prepareAsync'); f.prepared = { ok: ok, fail: fail }; },
            play: function () { f.calls.push('play'); if (f.failPlay) throw new Error('play failed'); },
            seekTo: function (ms, ok) { f.calls.push('seekTo ' + ms); ok(); },
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

    withFake(function (f, r, events) {
        /* A seek before ready waits for it. */
        r.apply([['np', 50, { source: { url: 'https://x.test/a.m3u8', token: 3 }, seek: { token: 3, id: 1, ms: 9000 } }, []]]);
        check(f.calls.indexOf('seekTo 9000') < 0, 'no seek before prepare');
        f.prepared.ok();
        check(f.calls.indexOf('seekTo 9000') >= 0, 'the seek runs once prepared');
        check(events().some(function (e) { return e.indexOf('timeline') === 0; }), 'and reports its timeline');
    });

    return results;
})()
