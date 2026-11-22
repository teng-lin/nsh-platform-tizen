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
 *   timeline    {token, seekId, ms, durationMs, seekable, failed?, stale?}:
 *               after a seek; `failed: true` when it did not happen,
 *               `stale: true` when the duration is the last known one (the
 *               player was closed, or the answer came from the watchdog)
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
 * when the seek's callback comes. Samsung: "During this async operation,
 * the other API would not be allowed ... wait for one of both callbacks
 * (SuccessCallback, errorCallback) before any other API call" (AVPlay API
 * reference, seekTo); getState is not exempted, so nothing polls it. A
 * seek with no callback after `seekTimeoutMs` is reported to the app as
 * failed while the queue keeps waiting; after `seekGiveUpMs` the queue
 * runs anyway (a player that refuses its close then is retried, STUCK). Play and
 * pause follow the state asked last; pause is called only on a stream
 * that has played. While the page is hidden the stream is closed and its
 * position kept; it reopens there when the page shows again, and the
 * app's last completed seek is not replayed.
 *
 * Settings tests replace: `NshTizen.avplay.api` (the player it drives,
 * webapis.avplay), `seekTimeoutMs` (the watchdog, 5 s), `seekGiveUpMs`
 * (when waiting calls run anyway, 30 s), `stuckRetryMs` and `stuckTries`
 * (the STUCK close retries, every second, ten times).
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
    /* Opens that found AVPlay STUCK (by one of ours): tried again once a
     * close succeeds, or told busy once the retries are spent. One retry
     * loop runs at a time. */
    var stuckWaiters = [];
    var stuckTries = 0;
    var stuckLoop = false;

    /* AVPlay is ours no more: STUCK cleared (wherever that happened), the
     * waiting opens run. */
    function unstuck() {
        owner = null;
        stuckTries = 0;
        drainStuck();
    }

    function drainStuck() {
        var waiting = stuckWaiters;
        stuckWaiters = [];
        waiting.forEach(function (f) { setTimeout(f, 0); });
    }

    /* Starts the retry loop if none runs (with a fresh budget). */
    function startStuckRetry() {
        if (stuckLoop) return;
        stuckLoop = true;
        stuckTries = 0;
        setTimeout(retryStuck, factory.stuckRetryMs);
    }

    /* Retries the close of a STUCK player, a few times, then lets the
     * waiting opens report busy. */
    function retryStuck() {
        if (owner !== STUCK) { stuckLoop = false; drainStuck(); return; }
        whenIdle(function () {
            if (owner !== STUCK) { stuckLoop = false; drainStuck(); return; }
            var p = factory.api();
            try { p.close(); } catch (e) { /* still refused */ }
            if (state(p) === 'NONE') {
                stuckLoop = false;
                unstuck();
            } else if (++stuckTries < factory.stuckTries) {
                setTimeout(retryStuck, factory.stuckRetryMs);
            } else {
                stuckLoop = false;
                drainStuck();
            }
        });
    }

    /* AVPlay's state; 'UNKNOWN' when it cannot say (then it is not free). */
    function state(p) {
        try { return p.getState(); } catch (e) { return 'UNKNOWN'; }
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
            unstuck();
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
        var lastDuration = 0;  /* the source's duration, as last read */
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
                if (closed) owner = null;
                else { owner = STUCK; startStuckRetry(); }
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
            /* AVPlay's coordinates are 1920 × 1080 whatever the page's
             * size; the rect is in points (ctx.scale page pixels each). */
            var k = 1920 / (window.innerWidth || 1920) * (ctx.scale || 1);
            var r = rect && rect.visible ? rect : { x: 0, y: 0, width: 1, height: 1 };
            var x = Math.round(r.x * k), y = Math.round(r.y * k);
            var w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
            /* The method first. The whole screen keeps LETTER_BOX (a 4:3
             * stream is not stretched); a smaller rect takes FULL_SCREEN,
             * which fills the rect: on a 2020 TV (UN55TU7000, Tizen 5.5)
             * LETTER_BOX there shows no picture while the sound plays. */
            var method = x <= 0 && y <= 0 && w >= 1920 && h >= 1080 ?
                'PLAYER_DISPLAY_MODE_LETTER_BOX' : 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
            try { p.setDisplayMethod(method); } catch (e) { /* not open, or a firmware without it */ }
            try { p.setDisplayRect(x, y, w, h); } catch (e) { /* not open */ }
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

        /* A seekTo, alone on the singleton: nothing calls AVPlay until its
         * callback comes (or, without one, `seekGiveUpMs`); `done(ok)` is
         * told once, at the callback or as a failure at `seekTimeoutMs`,
         * whatever the generation by then (an app's seek is the source's,
         * not the player's). Then what waited runs, and the latest state
         * and seek are applied. */
        function seekTo(ms, done) {
            var p = av(), my = token;
            var flight = { ms: ms, answered: false };
            seekInFlight = flight;
            var answer = function (ok) {
                if (flight.answered) return;
                flight.answered = true;
                if (done) done(ok, my === token);
            };
            var release = function (ok) {
                if (seekInFlight !== flight) return;
                clearTimeout(flight.timer);
                clearTimeout(flight.giveUp);
                seekInFlight = null;
                answer(ok);
                var waiting = afterSeek;
                afterSeek = [];
                waiting.forEach(function (f) { f(); });
                if (my !== token || seekInFlight) return;
                applyRect();
                reconcile();
                if (pendingSeek) seek(pendingSeek);
            };
            /* No callback yet: the app hears it failed, the gate stays. */
            flight.timer = setTimeout(function () { if (seekInFlight === flight) answer(false); }, factory.seekTimeoutMs);
            flight.giveUp = setTimeout(function () { release(false); }, factory.seekGiveUpMs);
            try {
                p.seekTo(ms, function () { release(true); }, function () { release(false); });
            } catch (e) {
                release(false);
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
            var attempt = function () {
                if (my !== token || gone) return;
                /* Hidden meanwhile (a zap queued behind a seek, then a
                 * hide): opened when the page shows again. */
                var ms = typeof startMs === 'function' ? startMs() : startMs;
                if (document.hidden) { hidden = { source: source, ms: ms }; return; }
                if (!available(p, ctx)) {
                    /* Our own stuck player: tried again once it closes. */
                    if (owner === STUCK && !tried) {
                        /* A loop that spent its budget is started again. */
                        stuckWaiters.push(retry);
                        startStuckRetry();
                        return;
                    }
                    emit('error', { code: 'busy' });
                    return;
                }
                openNow(p, source, ms, my);
            };
            var tried = false;
            var retry = function () { if (tried) { emit('error', { code: 'busy' }); return; } tried = true; attempt(); };
            whenIdle(attempt);
        }

        function openNow(p, source, startMs, my) {
            sizeSent = false; rendered = false; lastPosition = -1e9;
            /* The same source reopened keeps its completed seek. */
            if (!(doneSeek && doneSeek.token === source.token)) {
                doneSeek = null;
                lastDuration = 0;
            }
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
                            seekTo(startMs, function (ok, current) { if (current) ready(); });
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
            seekTo(s.ms, function (ok, current) {
                /* Answered for this source, whatever player generation runs
                 * now (a hide closed it meanwhile): not asked again. */
                if (!props.source || props.source.token !== s.token) return;
                doneSeek = { token: s.token, id: s.id };
                /* The duration now when the player can say (open, no seek
                 * running), else the last known one, marked stale. */
                var fresh = ok && current && !seekInFlight && owner === ctx;
                if (fresh) {
                    try { lastDuration = p.getDuration(); } catch (e) { /* live */ }
                }
                var timeline = { token: s.token, seekId: s.id, ms: s.ms, durationMs: lastDuration, seekable: lastDuration > 0 };
                if (!fresh) timeline.stale = true;
                if (!ok) timeline.failed = true;
                emit('timeline', timeline);
            });
        }

        function visibility() {
            if (document.hidden) {
                if (opened && owner === ctx) {
                    /* The position as the player has it once no seek runs
                     * (where a running one actually took it), read before
                     * the close. */
                    var h = hidden = { source: opened, ms: 0 };
                    whenIdle(function () {
                        if (owner !== ctx) return;
                        try { h.ms = av().getCurrentTime(); } catch (e) { /* live */ }
                    });
                    teardown();
                }
            } else if (hidden) {
                var h = hidden;
                hidden = null;
                /* The position as read when the queued close ran (a show
                 * before the seek's callback still opens there). */
                if (same(h.source, props.source)) open(h.source, function () { return h.ms; });
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
    factory.seekGiveUpMs = 30000;
    factory.stuckRetryMs = 1000;
    factory.stuckTries = 10;
    return factory;
})();
