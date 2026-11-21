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
 * AVPlay is one player per app: a second instance reports error `busy`.
 * Everything a view draws over the video must be transparent, up to the
 * page's body. Plain ES2017 (Chromium 69).
 */
'use strict';

NshTizen.avplay = (function () {
    var owner = null;

    function av() { return typeof webapis !== 'undefined' && webapis.avplay ? webapis.avplay : null; }

    /* The page's one <object type="application/avplayer">, first in body. */
    function surface() {
        var o = document.querySelector('object[type="application/avplayer"]');
        if (!o) {
            o = document.createElement('object');
            o.setAttribute('type', 'application/avplayer');
            o.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;';
            document.body.insertBefore(o, document.body.firstChild);
        }
        return o;
    }

    return function (ctx) {
        var props = {};
        var rect = null;
        var token = 0;        /* a generation: stale callbacks are dropped */
        var opened = null;    /* the source this instance opened */
        var sizeSent = false, rendered = false, lastPosition = -1e9;
        var lastSeek = null;
        var hiddenSource = null;

        function emit(name, data) { ctx.emit(name, data); }

        function close() {
            /* Never touch a player this instance did not open (and not
             * webapis before it is needed: the first `webapis.avplay` costs
             * about 0.7 s of the page's thread on a 2020 set). */
            if (owner !== ctx) return;
            var p = av();
            if (!p) return;
            try { p.stop(); } catch (e) { /* idle */ }
            try { p.close(); } catch (e) { /* closed */ }
            opened = null;
        }

        function applyRect() {
            if (owner !== ctx || !opened) return;
            var p = av();
            if (!p) return;
            /* AVPlay's coordinates are 1920 × 1080 whatever the page's size. */
            var k = 1920 / (window.innerWidth || 1920);
            var r = rect && rect.visible ? rect : { x: 0, y: 0, width: 1, height: 1 };
            try { p.setDisplayRect(Math.round(r.x * k), Math.round(r.y * k), Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k))); } catch (e) { /* not open */ }
        }

        function open(source) {
            var p = av();
            if (!p) { emit('error', { code: 'unavailable' }); return; }
            if (owner && owner !== ctx) { emit('error', { code: 'busy' }); return; }
            owner = ctx;
            surface();
            close();
            var my = ++token;
            sizeSent = false; rendered = false; lastPosition = -1e9;
            try {
                p.open(source.url);
                opened = source;
                try { p.setTimeoutForBuffering(15); } catch (e) { /* older firmware */ }
                applyRect();
                p.setListener({
                    onbufferingstart: function () { if (my === token) emit('state', { state: 'buffering' }); },
                    onbufferingcomplete: function () { if (my === token) emit('state', { state: 'ready' }); },
                    oncurrentplaytime: function (ms) {
                        if (my !== token) return;
                        if (!rendered) { rendered = true; emit('firstRender', { token: source.token || 0 }); }
                        if (!sizeSent) sendSize();
                        if (ms - lastPosition >= 1000 || ms < lastPosition) { lastPosition = ms; emit('position', { ms: ms }); }
                    },
                    onstreamcompleted: function () { if (my === token) emit('state', { state: 'ended' }); },
                    onerror: function (type) {
                        if (my !== token) return;
                        emit('error', { code: String(type) });
                        /* A player left in error blocks AVPlay until a reboot. */
                        close();
                        emit('state', { state: 'idle' });
                    },
                    onevent: function () {}
                });
                emit('state', { state: 'buffering' });
                p.prepareAsync(function () {
                    if (my !== token) return;
                    applyRect();
                    if (!props.paused) p.play();
                    emit('state', { state: 'ready' });
                    sendSize();
                }, function (e) {
                    if (my !== token) return;
                    emit('error', { code: String(e && e.name || e) });
                    close();
                    emit('state', { state: 'idle' });
                });
            } catch (e) {
                emit('error', { code: String(e && e.name || e) });
                close();
                emit('state', { state: 'idle' });
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
            token++;
            var was = owner === ctx;
            close();
            if (was) { owner = null; emit('state', { state: 'idle' }); }
        }

        function same(a, b) { return a && b && a.url === b.url && a.token === b.token; }

        function seek(s) {
            var p = av();
            if (!s || !opened || (lastSeek && lastSeek.id === s.id) || s.token !== opened.token) return;
            lastSeek = s;
            var my = token;
            try {
                p.seekTo(s.ms, function () {
                    if (my !== token) return;
                    var duration = 0;
                    try { duration = p.getDuration(); } catch (e) { /* live */ }
                    emit('timeline', { token: s.token, seekId: s.id, ms: s.ms, durationMs: duration, seekable: duration > 0 });
                }, function () {});
            } catch (e) { /* not seekable */ }
        }

        function visibility() {
            if (document.hidden) {
                if (opened) { hiddenSource = opened; token++; close(); }
            } else if (hiddenSource) {
                var s = hiddenSource;
                hiddenSource = null;
                if (same(s, props.source)) open(s);
            }
        }
        document.addEventListener('visibilitychange', visibility);

        return {
            props: function (changed, all) {
                props = all;
                if ('source' in changed) {
                    var s = all.source;
                    if (!s || !s.url) stop();
                    else if (!same(s, opened)) open(s);
                }
                if ('paused' in changed && opened && owner === ctx) {
                    try { if (all.paused) av().pause(); else av().play(); } catch (e) { /* not ready */ }
                }
                if ('seek' in changed) seek(all.seek);
            },
            frame: function (r) { rect = r; applyRect(); },
            command: function () {},
            destroy: function () {
                document.removeEventListener('visibilitychange', visibility);
                token++;
                close();
                if (owner === ctx) owner = null;
            }
        };
    };
})();
