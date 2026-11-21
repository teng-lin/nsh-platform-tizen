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
- Pass the module's SHA-256 as `version` (build.sh writes it into
  `app-config.js`): it keys the compiled-module cache, so an update never
  runs the old compiled code.
- `config.xml` privileges: `internet`, `tv.inputdevice`. A declared CSP
  switches Tizen from WARP to CSP mode. The one that works on the TV
  (the example app's): `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src * blob: data:; font-src 'self';
  media-src *; connect-src *; object-src 'self'; worker-src 'self'` (with
  `script-src 'unsafe-eval'` added only for a page-thread build). The
  renderer needs inline styles and `blob:` images; AVPlay needs
  `object-src`. Keep every script in a file: the policy allows
  no inline script.

## The host page

```html
<body>   <!-- transparent down to here: the video plane is under the page -->
<object type="application/avplayer" style="position:absolute;left:0;top:0;width:1920px;height:1080px"></object>
<div id="app"></div>
<script src="nsh-tizen.js"></script>
<script src="app-config.js"></script>   <!-- window.NSH_MODULE_VERSION -->
<script src="patina-host.js"></script>
```

`patina-host.js` registers the player and starts the app:

```js
NshTizen.registerComponent('tv.player', PatinaPlayer);   // or NshTizen.avplay to begin with
NshTizen.start({
    container: document.getElementById('app'),
    module: 'app.wasm',
    version: window.NSH_MODULE_VERSION,
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

- `props(changed, all, removed)`: the contract's props under their wire
  names, as JSON (`source` `{url, headers, token, live, reconnect}` or
  `null`, `paused`, `seek`, `pictureSize`, `videoTrack`, `audioTrack`,
  `textTrack`, `volume`, `muted`, `audioDelay`, `pip`). `changed` holds only
  what changed in this commit; a prop set to `null` is in it as `null`, a
  removed prop is named in `removed` and absent from `all`.
- A component's methods are isolated: a throw is reported in
  `__nsh.errors`, the page goes on, and `destroy` still removes the view.
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
  It runs the engine and sends what it committed to the page. Tasks the
  callback woke are pumped through the engine's wake as well.
- **Re-entry rule:** an import may call into the module (an export, or
  `engine.pump()`) while the module runs. The call is queued and runs when
  the outer call ends, never re-entering the runtime. Don't rely on its
  effect being visible before your import returns.
- Every import is wrapped: a throw is reported once (then counted,
  `__nsh.engine.importErrors`) and returns 0 to the module. A trap in the
  module (a panic) is fatal: `onError` gets the panic and the stack once,
  input and timers stop, and native components are destroyed (the player
  closes). The `exports` an `onInstance` hook gets are wrapped the same
  way: call the module only through them.
- AVPlay is a singleton. The example takes it only when it is free
  (getState NONE): if the host page opened or plays something itself, the
  component reports `busy` and touches nothing. Patina's own player should
  keep the same rule for seekTo: no AVPlay call until the seek's callback
  (the example queues them, with a watchdog).
- Storage: the Worker has IndexedDB but not `localStorage`. The platform
  provides no NSH storage service (`EngineConfig::storage`). Patina's own
  persistence (the chunked SQLite VFS) runs through its imports.
- Fetch: the platform provides no network service either. Patina's
  `HostFetch` imports serve the app. Workers can use `fetch` and XHR. Tizen
  can't set `User-Agent` or `Cookie`.

## Remote keys

Keys arrive as NSH `KeyEvent`s on the view the app focused
(`ElementRef::focus` on a `focusable` view) while it is attached, else on
the topmost open modal's root, else on the root (the core starts them at
the app's mount root), and bubble from there. The
engine decides this from its own tree, so OK right after a move goes to the
new focus; a release goes where its press went. `key` carries the UI Events
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
Tizen its window view hears keys without a focus, because a key reported at
the root starts at the app's mount root, so that works as is. Back reaches
the app only as the raw `GoBack` key: there is no NSH back handling
(`onBackRequest`, `onRequestClose`) behind it. OK on a focused pressable view
is delivered as a key first (so `captureKeys` can take it, and ancestors
hear it) and presses the view only when nothing captured it.

## Upstream requests (NSH)

- `LocalEngine::key_event` and `key_interest` are `#[doc(hidden)]`. This
  platform routes every key through `key_event`, because it is the only
  entry that applies the app's `captureKeys` rules and returns the
  decision; NSH's own web backend uses it the same way. They should become
  documented platform API (NSH's `docs/dev/platforms.md`, "Input").

## Inputs

`input()` is an `<input>` (`<textarea>` when multiline) over the TV keyboard.
`ElementRef::focus` and `blur` show and hide the keyboard, and edits arrive
as `on_change` / `on_submit`. The keyboard's Done (65376) submits; Cancel
(65385) and Back leave the input. While an input is being edited, the
arrows, OK and digits belong to the keyboard. Other keys still reach the
app through the input's ancestors.
