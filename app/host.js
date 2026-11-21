/*
 * The guide app's host page: what a host supplies to nsh-platform-tizen.
 * Here the example AVPlay component plays `tv.player`, and the app's
 * `host` messages ask to leave.
 */
'use strict';
NshTizen.registerComponent('tv.player', NshTizen.avplay);
NshTizen.start({
    container: document.getElementById('app'),
    module: 'app.wasm',
    worker: 'nsh-worker.js',
    thread: window.NSH_THREAD || 'worker',
    fonts: window.NSH_FONTS || [],
    onHost: function (m) {
        if (m && m.exit) {
            try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* not a TV */ }
        }
    }
});
