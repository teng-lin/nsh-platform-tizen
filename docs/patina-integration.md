# What Patina's `hosts/tizen` needs from this platform (PR C)

This page lists what a host must supply and what it can rely on. Patina is
the first consumer, but the platform knows nothing about it: every name below
is either NSH's own or one the host chooses.

## Build

- Target `wasm32-unknown-unknown` with `RUSTFLAGS="-C target-cpu=mvp -C
  target-feature=+sign-ext,+mutable-globals"`, `-Zbuild-std=std,panic_abort`
  on the pinned nightly (`build.sh` shows the command). Tizen 5.5 rejects
  anything newer than MVP plus those two features.
- The runner is a `cdylib` with one line:
  `nsh_platform_tizen::app!(nsh_rust_app::app_ui_sets(), nsh_rust_app::root());`
  Patina builds its own runner from `iptv-app` the same way. Use
  `app_ui_sets()` rather than `ui_sets()`, so only the base components the app
  uses are linked. Module size is launch time: about 3 s per MB to compile
  on a 2020 set, and the IndexedDB cache stops working above roughly 6–12 MB.
- `runtime/bundle.sh DIR` writes the page scripts (`nsh-tizen.js`,
  `nsh-worker.js`, `nsh-engine.js`). The package needs these, the module
  (`app.wasm`), the host's page and scripts, and `assets/` for `asset:/` images.
- `config.xml` privileges: `internet`, `tv.inputdevice`. If it declares a CSP,
  it needs `object-src 'self'` for AVPlay and `worker-src`/`script-src 'self'`.

## The host page

```html
<body>   <!-- transparent down to here: the video plane is under the page -->
<object type="application/avplayer" style="position:absolute;left:0;top:0;width:1920px;height:1080px"></object>
<div id="app"></div>
<script src="nsh-tizen.js"></script>
<script src="patina-host.js"></script>
```

`patina-host.js` registers the player and starts the app:

```js
NshTizen.registerComponent('tv.player', PatinaPlayer);   // or NshTizen.avplay to begin with
NshTizen.start({
    container: document.getElementById('app'),
    module: 'app.wasm',
    worker: 'nsh-worker.js',
    scripts: ['patina-worker.js'],         // host services, run in the Worker
    fonts: [],                             // optional: [{ family, url, weight, style }]
    registerKeys: [],                      // extra keys by Tizen name (e.g. 'Tools')
    onHost: function (message) {},         // nsh_platform_tizen::host(json) from Rust
    onExit: function () { /* lifecycle */ tizen.application.getCurrentApplication().exit(); }
});
```

## `tv.player`

`native("tv.player")` mounts the component the host registered under that
name. The platform passes the wire contract through unchanged:

- `props(changed, all)`: the contract's props under their wire names, as
  JSON (`source` `{url, headers, token, live, reconnect}` or `null`,
  `paused`, `seek`, `pictureSize`, `videoTrack`, `audioTrack`, `textTrack`,
  `volume`, `muted`, `audioDelay`, `pip`). `changed` holds only what changed
  in this commit; a removed prop is absent from `all`.
- `frame(rect)`: the view's rect on the 1920 × 1080 page whenever it moves
  (`visible: false` when it is detached or empty). AVPlay's
  `setDisplayRect` takes these coordinates.
- `ctx.emit(name, data)`: the contract's events (`state`, `size`,
  `firstRender`, `error`, `position`, `timeline`, `tracks`, `format`, ...)
  reach `on_native_event` as `NativeEvent { name, data }`, which
  `PlayerEvent::decode` reads.
- `command(name, args)`: `ElementRef::command`; the contract has none today.
- Tokens are JSON numbers: the contract's `u64` tokens must stay below 2^53.

`runtime/avplay.js` is a working starting point for Patina's implementation.
It covers `source`, `paused` and `seek`, and emits `state`
(`idle`/`buffering`/`ready`/`ended`), `size`, `firstRender`, `position`,
`timeline` and `error`. What Patina's implementation adds: `headers`
(AVPlay can't set arbitrary headers, so `publicOnly` sources only, or a
relay), `reconnect`/`live` semantics (keep the last frame), `tracks` and
`format` from `getTotalTrackInfo`, track selection, and multiview, which
needs a second decoder that this set lacks.

## Host services in the Worker

The app's module runs in the Worker, so its host imports must be provided
there. A script in `options.scripts` (loaded with `importScripts` before the
module is instantiated) adds them:

```js
NshTizenWorker.addImports('iptv_web', { fetch_start: function (...) {...}, ... });
NshTizenWorker.onInstance(function (exports, engine) {
    // exports.memory, engine.str(ptr, len), engine.withStrings([...], f),
    // engine.flush(): deliver what the app committed after an async reply
});
```

- Imports the module asks for that nobody supplies become no-ops returning
  0. They are listed in `window.__nsh.engine.stubbed`, so a missing host
  service shows up there instead of as a link error.
- After an async host callback calls into the module, call `engine.pump()`.
  It runs the engine and sends what it committed to the page.
- Storage: the Worker has IndexedDB but not `localStorage`. The platform
  provides no NSH storage service (`EngineConfig::storage`). Patina's own
  persistence (the chunked SQLite VFS) runs through its imports.
- Fetch: the platform provides no network service either. Patina's
  `HostFetch` imports serve the app. Workers can use `fetch` and XHR. Tizen
  can't set `User-Agent` or `Cookie`.

## Remote keys

Keys arrive as NSH `KeyEvent`s on the view the app focused
(`ElementRef::focus` on a `focusable` view), else on the newest view
listening for keys, and bubble from there. `key` carries the UI Events
name (`keys.rs`). `code` carries the browser's `KeyboardEvent.code`, which
is often empty for remote keys.

| Remote | `key` | Samsung code |
|---|---|---|
| D-pad, OK | `ArrowUp`… `Enter` | 37–40, 13 |
| Back | `GoBack` | 10009 |
| CH+ / CH− | `ChannelUp` / `ChannelDown` | 427 / 428 |
| Red, Green, Yellow, Blue | `ColorF0Red`, `ColorF1Green`, `ColorF2Yellow`, `ColorF3Blue` | 403–406 |
| Play/Pause, Play, Pause, Stop, Rewind, FF, Record | `MediaPlayPause`, `MediaPlay`, `MediaPause`, `MediaStop`, `MediaRewind`, `MediaFastForward`, `MediaRecord` | 10252, 415, 19, 413, 412, 417, 416 |
| Info, Guide, Channel list, Previous channel | `Info`, `Guide`, `ChannelList`, `MediaLast` | 457, 458, 10073, 10190 |
| Digits | `0`–`9` | 48–57 |

**Patina change needed**: `vendor/nsh-tv`'s `RemoteKey::from_parts` knows
`PageUp`/`PageDown` and `F1`–`F4` for channels and colors, and doesn't
recognize `ChannelUp`/`ChannelDown`, `ColorF0Red`…`ColorF3Blue`, `Info`,
`Guide` or `MediaLast`. These are the UI Events names a browser platform
delivers, so the decoder should accept them; the platform won't remap them.
Patina's `input::window` focuses its root only on long-press platforms. On
Tizen the root receives keys without a focus, because it is the newest key
listener, so that works as is. OK on a focused pressable view presses it
and isn't also delivered as a raw key.

## Inputs

`input()` is an `<input>` (`<textarea>` when multiline) over the TV keyboard.
`ElementRef::focus` and `blur` show and hide the keyboard, and edits arrive
as `on_change` / `on_submit`. The keyboard's Done (65376) submits; Cancel
(65385) and Back leave the input. While an input is being edited, the
arrows, OK and digits belong to the keyboard. Other keys still reach the
app through the input's ancestors.
