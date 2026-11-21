/*
 * An example native component: a video player on Samsung AVPlay, drawn by
 * the TV's video plane under the page in the component's rect. A host
 * registers it under the name its app mounts, or supplies its own:
 *
 *   NshTizen.registerComponent('tv.player', NshTizen.avplay);
 *
 * Props (a subset of a common player contract):
 *   source  {url, token} or null: a new url or token reopens; null stops
 *   paused  bool (a stream opened paused stays prepared until unpaused)
 *   seek    {token, id, ms}: seeks once per id, for the current token
 *           (one asked before the stream is ready, or while a seek runs,
 *           waits; the latest wins)
 * Events:
 *   state       {state}: idle | buffering | ready | ended
 *   size        {width, height}: the video's, once known
 *   firstRender {token}: the first playing time after opening (AVPlay
 *               reports no frame presentation; this is the nearest)
 *   position    {ms}: about once a second
 *   timeline    {token, seekId, ms, durationMs, seekable, failed?}: after
 *               a seek; `failed: true` when it did not happen
 *   error       {code}: AVPlay's error name; the player is closed after it
 * Not supported by AVPlay here (ignored): headers, volume, muted, tracks.
 *
 * AVPlay is one player per app. The component takes it only when it is
 * free (getState NONE): another instance's, or anything the host page
 * opened itself (IDLE, READY, PLAYING, PAUSED), gives error `busy`, and
 * nothing of theirs is touched. A player whose close failed stays taken
 * until a close succeeds or AVPlay reports it closed.
 *
 * Each opening is a generation (`token`), invalidated before anything is
 * torn down, so a late callback of an older one does nothing. Samsung's
 * seekTo must complete before any other AVPlay call: while a seek runs,
 * every call waits (play, pause, the rect, metadata reads, and a stop,
 * close or reopen from a zap, a hide or the view's removal), and runs
 * when the seek completes, fails, or a watchdog gives up on it. Play and
 * pause follow the state asked last; pause is called only on a stream
 * that has played. While the page is hidden the stream is closed and its
 * position kept; it reopens there when the page shows again, and the
 * app's last completed seek is not replayed.
 *
 * `NshTizen.avplay.api` is the player it drives (webapis.avplay) and
 * `NshTizen.avplay.seekTimeoutMs` the watchdog; tests replace them.
 * Plain ES2017 (Chromium 69).
 */
'use strict';

NshTizen.avplay = (function () {
    /* null (free), an instance's ctx, or STUCK (a close failed). */
    var owner = null;
    var STUCK = { stuck: true };
    /* The seek running on the singleton, and what waits for it. */
    var seekInFlight = null;
    var afterSeek = [];

    function state(p) {
        try { return p.getState(); } catch (e) { return 'NONE'; }
    }

    /* Runs `f` now, or when the running seek ends (whatever instance or
     * generation started it: a teardown must still happen). */
    function whenIdle(f) {
        if (seekInFlight) afterSeek.push(f); else f();
    }

    /* Whether AVPlay can be taken now: ours, or free (NONE). A stuck
     * player is tried again. */
    function available(p, ctx) {
        if (owner === ctx) return true;
        if (owner === STUCK) {
            try { p.close(); } catch (e) { /* still stuck? */ }
            if (state(p) !== 'NONE') return false;
            owner = null;
        }
        return !owner && state(p) === 'NONE';
    }

    function factory(ctx) {
        var props = {};
        var rect = null;
        var token = 0;        /* the current generation */
        var opened = null;    /* the source this instance opened */
        var prepared = false;
        var started = false;  /* it played since it was prepared */
        var sizeSent = false, rendered = false, lastPosition = -1e9;
        var doneSeek = null;  /* the app's last completed seek {token, id} */
        var pendingSeek = null;
        var hidden = null;    /* {source, ms}: closed while the page is hidden */
        var gone = false;

        function av() { return factory.api(); }
        function emit(name, data) { if (!gone) ctx.emit(name, data); }

        /* Closes this instance's player (now, or after the running seek). */
        function closePlayer() {
            whenIdle(function () {
                if (owner !== ctx) return;
                var p = av();
                var closed = true;
                if (p) {
                    try { p.stop(); } catch (e) { /* idle */ }
                    try { p.close(); } catch (e) { closed = state(p) === 'NONE'; }
                }
                owner = closed ? null : STUCK;
            });
        }

        /* The one teardown: invalidate callbacks, then close and release. */
        function teardown() {
            token++;
            prepared = false;
            started = false;
            opened = null;
            closePlayer();
        }

        function fail(code) {
            emit('error', { code: String(code) });
            teardown();
            emit('state', { state: 'idle' });
        }

        function applyRect() {
            if (owner !== ctx || !opened || seekInFlight) return;
            var p = av();
            if (!p) return;
            /* AVPlay's coordinates are 1920 × 1080 whatever the page's size. */
            var k = 1920 / (window.innerWidth || 1920);
            var r = rect && rect.visible ? rect : { x: 0, y: 0, width: 1, height: 1 };
            try { p.setDisplayRect(Math.round(r.x * k), Math.round(r.y * k), Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k))); } catch (e) { /* not open */ }
        }

        /* The play/pause state the app asks for, once no seek runs: play
         * from READY or PAUSED, pause only what played (Samsung refuses a
         * pause in READY); a paused stream not yet played stays READY. */
        function reconcile() {
            if (owner !== ctx || !prepared || seekInFlight) return;
            try {
                if (!props.paused) {
                    if (state(av()) !== 'PLAYING') av().play();
                    started = true;
                } else if (started && state(av()) === 'PLAYING') {
                    av().pause();
                }
            } catch (e) {
                fail(e && e.name || e);
            }
        }

        /* A seekTo, alone on the singleton: nothing calls AVPlay until it
         * completes, fails or the watchdog ends it; then what waited runs,
         * `done(ok)`, and the latest state and seek are applied. */
        function seekTo(ms, done) {
            var p = av(), my = token;
            var flight = { ms: ms };
            seekInFlight = flight;
            var finish = function (ok) {
                if (seekInFlight !== flight) return;
                clearTimeout(flight.timer);
                seekInFlight = null;
                /* What waited (a teardown, a reopen) runs whatever the
                 * generation: the player must still be closed. */
                var waiting = afterSeek;
                afterSeek = [];
                if (my === token && done) done(ok);
                waiting.forEach(function (f) { f(); });
                if (my !== token || seekInFlight) return;
                applyRect();
                reconcile();
                if (pendingSeek) seek(pendingSeek);
            };
            flight.timer = setTimeout(function () { finish(false); }, factory.seekTimeoutMs);
            try {
                p.seekTo(ms, function () { finish(true); }, function () { finish(false); });
            } catch (e) {
                finish(false);
            }
        }

        /* Opens `source`, from `startMs` when reopening after the page was
         * hidden; after a running seek, when one runs. */
        function open(source, startMs) {
            /* Never touch webapis before it is needed: the first
             * `webapis.avplay` costs about 0.7 s of the page's thread on a
             * 2020 set. */
            var p = av();
            if (!p) { emit('error', { code: 'unavailable' }); return; }
            if (owner === ctx) teardown(); else token++;
            var my = token;
            whenIdle(function () {
                if (my !== token || gone) return;
                if (!available(p, ctx)) { emit('error', { code: 'busy' }); return; }
                openNow(p, source, startMs, my);
            });
        }

        function openNow(p, source, startMs, my) {
            sizeSent = false; rendered = false; lastPosition = -1e9;
            /* The same source reopened keeps its completed seek. */
            if (!(doneSeek && doneSeek.token === source.token)) doneSeek = null;
            pendingSeek = props.seek || null;
            var live = function () { return my === token && owner === ctx; };
            try {
                p.open(source.url);
            } catch (e) {
                /* Not taken: nothing of ours to close. */
                emit('error', { code: String(e && e.name || e) });
                emit('state', { state: 'idle' });
                return;
            }
            owner = ctx;
            opened = source;
            try {
                try { p.setTimeoutForBuffering(15); } catch (e) { /* older firmware */ }
                applyRect();
                p.setListener({
                    onbufferingstart: function () { if (live()) emit('state', { state: 'buffering' }); },
                    onbufferingcomplete: function () { if (live()) emit('state', { state: 'ready' }); },
                    oncurrentplaytime: function (ms) {
                        if (!live()) return;
                        if (!rendered) { rendered = true; emit('firstRender', { token: source.token || 0 }); }
                        if (!sizeSent) sendSize();
                        if (ms - lastPosition >= 1000 || ms < lastPosition) { lastPosition = ms; emit('position', { ms: ms }); }
                    },
                    onstreamcompleted: function () { if (live()) emit('state', { state: 'ended' }); },
                    onerror: function (type) { if (live()) fail(type); },
                    onevent: function () {}
                });
                emit('state', { state: 'buffering' });
                p.prepareAsync(function () {
                    if (!live()) return;
                    try {
                        prepared = true;
                        applyRect();
                        var ready = function () {
                            emit('state', { state: 'ready' });
                            sendSize();
                        };
                        if (startMs > 0) {
                            /* Back where it was hidden; play waits for it. */
                            seekTo(startMs, ready);
                        } else {
                            reconcile();
                            /* A play that failed closed it. */
                            if (!live()) return;
                            ready();
                            if (pendingSeek) seek(pendingSeek);
                        }
                    } catch (e) {
                        fail(e && e.name || e);
                    }
                }, function (e) {
                    if (live()) fail(e && e.name || e);
                });
            } catch (e) {
                fail(e && e.name || e);
            }
        }

        /* Metadata, never during a seek (tried again at the next play time). */
        function sendSize() {
            if (seekInFlight) return;
            var p = av();
            try {
                var info = p.getCurrentStreamInfo();
                for (var i = 0; i < info.length; i++) {
                    if (info[i].type !== 'VIDEO') continue;
                    var x = JSON.parse(info[i].extra_info);
                    if (x.Width && x.Height) { sizeSent = true; emit('size', { width: +x.Width, height: +x.Height }); }
                }
            } catch (e) { /* not known yet */ }
        }

        function stop() {
            var was = owner === ctx;
            teardown();
            hidden = null;
            if (was) emit('state', { state: 'idle' });
        }

        function same(a, b) { return !!(a && b && a.url === b.url && a.token === b.token); }

        /* The app's seek, once per id for the current token; before the
         * stream is ready, or while a seek runs, the latest waits. A seek
         * that does not happen says so (timeline `failed`). */
        function seek(s) {
            if (!s || !opened || s.token !== opened.token) return;
            if (doneSeek && doneSeek.token === s.token && doneSeek.id === s.id) { pendingSeek = null; return; }
            if (!prepared || seekInFlight) { pendingSeek = s; return; }
            pendingSeek = null;
            var p = av();
            seekTo(s.ms, function (ok) {
                var duration = 0;
                if (ok) {
                    doneSeek = { token: s.token, id: s.id };
                    try { duration = p.getDuration(); } catch (e) { /* live */ }
                }
                var timeline = { token: s.token, seekId: s.id, ms: s.ms, durationMs: duration, seekable: duration > 0 };
                if (!ok) timeline.failed = true;
                emit('timeline', timeline);
            });
        }

        function visibility() {
            if (document.hidden) {
                if (opened && owner === ctx) {
                    /* During a seek the position is where it goes. */
                    var ms = seekInFlight ? seekInFlight.ms : 0;
                    if (!seekInFlight) {
                        try { ms = av().getCurrentTime(); } catch (e) { /* live */ }
                    }
                    hidden = { source: opened, ms: ms };
                    teardown();
                }
            } else if (hidden) {
                var h = hidden;
                hidden = null;
                if (same(h.source, props.source)) open(h.source, h.ms);
                else if (props.source && props.source.url) open(props.source, 0);
            }
        }
        document.addEventListener('visibilitychange', visibility);

        return {
            props: function (changed, all) {
                props = all;
                if ('source' in changed) {
                    var s = all.source;
                    if (!s || !s.url) stop();
                    /* Hidden: opened when the page shows again. */
                    else if (document.hidden) hidden = { source: s, ms: 0 };
                    else if (!same(s, opened)) open(s, 0);
                }
                if ('paused' in changed) reconcile();
                if ('seek' in changed) seek(all.seek);
            },
            frame: function (r) { rect = r; applyRect(); },
            command: function () {},
            destroy: function () {
                document.removeEventListener('visibilitychange', visibility);
                teardown();
                hidden = null;
                gone = true;
            }
        };
    }

    factory.api = function () { return typeof webapis !== 'undefined' && webapis.avplay ? webapis.avplay : null; };
    factory.seekTimeoutMs = 5000;
    return factory;
})();
