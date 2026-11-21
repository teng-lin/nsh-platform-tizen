/*
 * An example native component: a video player on Samsung AVPlay, drawn by
 * the TV's video plane under the page in the component's rect. A host
 * registers it under the name its app mounts, or supplies its own:
 *
 *   NshTizen.registerComponent('tv.player', NshTizen.avplay);
 *
 * Props (a subset of a common player contract):
 *   source  {url, token} or null: a new url or token reopens; null stops
 *   paused  bool
 *   seek    {token, id, ms}: seeks once per id, for the current token
 *           (one asked before the stream is ready, or while a seek runs,
 *           waits; the latest wins)
 * Events:
 *   state       {state}: idle | buffering | ready | ended
 *   size        {width, height}: the video's, once known
 *   firstRender {token}: the first playing time after opening (AVPlay
 *               reports no frame presentation; this is the nearest)
 *   position    {ms}: about once a second
 *   timeline    {token, seekId, ms, durationMs, seekable}: after a seek
 *   error       {code}: AVPlay's error name; the player is closed after it
 * Not supported by AVPlay here (ignored): headers, volume, muted, tracks.
 *
 * AVPlay is one player per app. The component takes it only when it is
 * free: another instance's, or a stream the host page plays itself
 * (getState not NONE/IDLE), gives error `busy`, and nothing of theirs is
 * touched. A player whose close failed stays taken until a close succeeds
 * or AVPlay reports it closed. Each opening is a generation (`token`),
 * invalidated before anything is torn down, so a late callback of an older
 * one does nothing. Samsung's seekTo must complete before the next AVPlay
 * call: play and pause wait for a running seek and the state asked last is
 * applied when it completes. While the page is hidden the stream is closed
 * and its position kept; it reopens there when the page shows again, and
 * the app's last completed seek is not replayed.
 *
 * `NshTizen.avplay.api` is the player it drives (webapis.avplay); tests
 * replace it. Plain ES2017 (Chromium 69).
 */
'use strict';

NshTizen.avplay = (function () {
    /* null (free), an instance's ctx, or STUCK (a close failed). */
    var owner = null;
    var STUCK = { stuck: true };

    function state(p) {
        try { return p.getState(); } catch (e) { return 'NONE'; }
    }

    /* Whether AVPlay can be taken now: free, ours, or stuck but closed by
     * now. A host page's own stream keeps it. */
    function available(p, ctx) {
        if (owner === ctx) return true;
        if (owner === STUCK) {
            try { p.close(); } catch (e) { /* still stuck? */ }
            if (state(p) !== 'NONE') return false;
            owner = null;
        }
        if (owner) return false;
        var s = state(p);
        return s === 'NONE' || s === 'IDLE';
    }

    function factory(ctx) {
        var props = {};
        var rect = null;
        var token = 0;        /* the current generation */
        var opened = null;    /* the source this instance opened */
        var prepared = false;
        var seeking = false;  /* a seekTo runs: no other AVPlay call */
        var sizeSent = false, rendered = false, lastPosition = -1e9;
        var doneSeek = null;  /* the app's last completed seek {token, id} */
        var pendingSeek = null;
        var hidden = null;    /* {source, ms}: closed while the page is hidden */

        function av() { return factory.api(); }
        function emit(name, data) { ctx.emit(name, data); }

        /* The one teardown: invalidate callbacks, close, release (or keep
         * AVPlay marked taken when the close failed and it is not closed). */
        function teardown() {
            token++;
            prepared = false;
            seeking = false;
            if (owner !== ctx) { opened = null; return; }
            var p = av();
            var closed = true;
            if (p) {
                try { p.stop(); } catch (e) { /* idle */ }
                try { p.close(); } catch (e) { closed = state(p) === 'NONE'; }
            }
            opened = null;
            owner = closed ? null : STUCK;
        }

        function fail(code) {
            emit('error', { code: String(code) });
            teardown();
            emit('state', { state: 'idle' });
        }

        function applyRect() {
            if (owner !== ctx || !opened || seeking) return;
            var p = av();
            if (!p) return;
            /* AVPlay's coordinates are 1920 × 1080 whatever the page's size. */
            var k = 1920 / (window.innerWidth || 1920);
            var r = rect && rect.visible ? rect : { x: 0, y: 0, width: 1, height: 1 };
            try { p.setDisplayRect(Math.round(r.x * k), Math.round(r.y * k), Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k))); } catch (e) { /* not open */ }
        }

        /* The play/pause state the app asks for, once no seek runs. */
        function reconcile() {
            if (owner !== ctx || !prepared || seeking) return;
            try { if (props.paused) av().pause(); else av().play(); } catch (e) { fail(e && e.name || e); }
        }

        /* A seekTo, alone: nothing else calls AVPlay until it completes,
         * then `done` runs and the latest state and seek are applied. */
        function seekTo(ms, done) {
            var p = av(), my = token;
            seeking = true;
            var finish = function (ok) {
                if (my !== token) return;
                seeking = false;
                if (done) done(ok);
                if (my !== token) return;
                applyRect();
                reconcile();
                if (pendingSeek) seek(pendingSeek);
            };
            try {
                p.seekTo(ms, function () { finish(true); }, function () { finish(false); });
            } catch (e) {
                finish(false);
            }
        }

        /* Opens `source`, from `startMs` when reopening after the page was
         * hidden. */
        function open(source, startMs) {
            /* Never touch webapis before it is needed: the first
             * `webapis.avplay` costs about 0.7 s of the page's thread on a
             * 2020 set. */
            var p = av();
            if (!p) { emit('error', { code: 'unavailable' }); return; }
            if (!available(p, ctx)) { emit('error', { code: 'busy' }); return; }
            teardown();
            var my = token;
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

        function sendSize() {
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
         * stream is ready, or while a seek runs, the latest waits. */
        function seek(s) {
            if (!s || !opened || s.token !== opened.token) return;
            if (doneSeek && doneSeek.token === s.token && doneSeek.id === s.id) { pendingSeek = null; return; }
            if (!prepared || seeking) { pendingSeek = s; return; }
            pendingSeek = null;
            var p = av();
            seekTo(s.ms, function (ok) {
                if (!ok) return;
                doneSeek = { token: s.token, id: s.id };
                var duration = 0;
                try { duration = p.getDuration(); } catch (e) { /* live */ }
                emit('timeline', { token: s.token, seekId: s.id, ms: s.ms, durationMs: duration, seekable: duration > 0 });
            });
        }

        function visibility() {
            if (document.hidden) {
                if (opened && owner === ctx) {
                    var ms = 0;
                    try { ms = av().getCurrentTime(); } catch (e) { /* live */ }
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
            }
        };
    }

    factory.api = function () { return typeof webapis !== 'undefined' && webapis.avplay ? webapis.avplay : null; };
    return factory;
})();
