# nsh-platform-tizen

An NSH platform for Samsung Tizen TVs, built outside NSH on its public
engine API (NSH's `docs/dev/platforms.md`), with no change to NSH. The
oldest target is Tizen 5.5 (2020 sets: Chromium 69, ES2017, MVP WebAssembly
with sign-extension and mutable globals, ARMv7). It started as a spike (the
measurements are at the end) and from
[nsh-platform-miniprogram](https://github.com/huacnlee/nsh-platform-miniprogram)
(Apache-2.0, see NOTICE).

- `crates/nsh-platform-tizen`: the backend. The engine (`LocalEngine`) runs
  in WebAssembly, and each commit is encoded as JSON operations
  (`encode.rs` lists them). The text engine measures on the host
  (`text.rs`), the remote's key table lives in `keys.rs`, font files are read
  in `font.rs`, and the module's interface with the runtime is `ffi.rs`.
- `runtime/`: the page and Worker scripts (plain ES2017):
  - `engine.js` loads the module (compiled-module cache in IndexedDB) and
    provides its imports.
  - `worker.js` runs it in a Worker, with an `OffscreenCanvas` to measure
    text.
  - `renderer.js` applies operations to the DOM and hosts native
    components, inputs and images.
  - `page.js` holds `NshTizen.start`, key routing and the timing recorder.
  - `avplay.js` is an example AVPlay player component.
  - `bench-common.js` is the shared benchmark.
  - `bundle.sh` concatenates them into `nsh-tizen.js` (page), `nsh-worker.js`
    (Worker) and `nsh-engine.js` (the page-thread benchmark).
- `crates/guide-spike`: the test app. It shows a guide over video like
  Patina's, on `iptv-core`'s guide model as a test app only. The platform
  crate depends on NSH alone.
- `app/`: the test app's host page (`index.html`, `host.js`), the
  page-thread benchmark page and `config.xml` (app id `NshSpike01.Guide`).

## Architecture

The engine and the app run in a **Web Worker**, and the page only draws.
Each turn's batches go to the page in one message as JSON text. The page
parses them and applies each operation to an absolutely positioned
`<div>` per view, at the frame the engine laid out. Text is measured in the
Worker with `OffscreenCanvas` and broken into runs in Rust, and the page
draws each run where it was placed (`white-space: pre`). Input goes back as
messages: keys, presses, text edits, focus, scroll offsets, image loads and
native component events.

The page-thread variant (`app/page-thread.html`,
`NshTizen.start({thread: 'page'})`) is kept only so the benchmark can
compare the two.

## Host API

A host page provides the `<object type="application/avplayer">` (first in
`body`, if it plays video) and a container. Everything over the video stays
transparent, down to `body`. Load `nsh-tizen.js`, then:

```js
NshTizen.registerComponent('tv.player', NshTizen.avplay);  // name → factory
NshTizen.start({
    container: document.getElementById('app'),
    module: 'app.wasm',                // the app's module (built as below)
    worker: 'nsh-worker.js',
    scripts: [],                       // Worker scripts with host imports
    fonts: [],                         // [{ family, url, weight, style }]
    registerKeys: [],                  // more remote keys, by Tizen name
    backDebounceMs: 600,               // Back presses closer than this are one
    onHost: function (message) {},     // nsh_platform_tizen::host(json) from the app
    onExit: function () {},            // Command::ExitApp (default: the app exits)
    onError: function (text) {}
});
```

**Native components.** `native("name")` in the app mounts the factory
registered under `name`. It gets `ctx`: `id`, `name`, `element` (the
container `<div>`), `emit(event, data)` (to `on_native_event`) and `rect()`.
It returns any of these methods:

- `props(changed, all)`: JSON props by name, after every commit that
  changes them.
- `frame(rect)`: `{x, y, width, height, visible}` on the page, whenever it
  moves. It sums the frames and subtracts scroll offsets, and reads no
  layout from the DOM.
- `command(name, args)`: `ElementRef::command`.
- `destroy()`.

An unknown name leaves the container empty and is counted in
`__nsh.unknownComponents`.

**The example player** (`NshTizen.avplay`) takes the props `source`
`{url, token}` or `null`, `paused` and `seek` `{token, id, ms}`. It emits
`state` (`idle`, `buffering`, `ready`, `ended`), `size`, `firstRender`,
`position`, `timeline` and `error`. It calls AVPlay in the documented order
(`open`, buffering timeout, rect, listener, `prepareAsync`, rect again,
`play`). It closes the player after every error, drops stale callbacks by
token, stops while the page is hidden and reopens when it is shown, and
never touches a player it didn't open. AVPlay is one player per app: a
second instance reports `busy`. It doesn't support headers, volume, mute or
tracks.

**Host services** (storage, fetch, entropy) aren't the platform's. The
app's imports for them run in the Worker: a script in `options.scripts`
calls `NshTizenWorker.addImports(module, functions)` and
`NshTizenWorker.onInstance(function (exports, engine) {...})`. After an
async reply, the script calls `engine.pump()`. Imports nobody provides
become no-ops, listed in `__nsh.engine.stubbed`. The platform provides no
NSH `storage`, `network` or `assets` service.

**Fonts.** The app registers fonts with `Root::font` or `register_font`:
the text engine reads the file's family, weight and style, and the Worker
and the page each load it as a `FontFace`. Text is measured again once both
have loaded. Host fonts (`options.fonts`) are loaded in the Worker before
the app starts. Without either, text uses the system font: a 2020 set
resolves every family name, `serif` and `monospace` included, to one font.

**Keys.** The remote's keys arrive as NSH `KeyEvent`s with UI Events names
(`keys.rs`: `GoBack` 10009, `ColorF0Red`…`ColorF3Blue` 403–406,
`ChannelUp`/`ChannelDown` 427/428, `MediaPlayPause` 10252, the other media
keys, `Info`, `Guide`, `ChannelList`, `MediaLast`, digits). A key goes to
the input being edited, else to the view the app focused
(`ElementRef::focus` on a focusable view), else to the newest view listening
for keys. The core bubbles it from there. OK on a focused view that takes
presses presses it.

At start the page registers the table's keys one at a time with
`tvinputdevice.registerKey`, and again when it becomes visible. Exit,
Volume, Menu and Source stay the TV's. `code` is the browser's
`KeyboardEvent.code`. No `default_prevented`: the page can't wait for the
Worker, so it prevents the default of every key in the table.

**Inputs.** An NSH input is an `<input>` (or `<textarea>`) over the TV
keyboard. It handles value (dropped if the user typed since), placeholder
and its color, type (`password`, `number`, `email`, `tel`, `url`), max
length, read only and auto focus. Focus and blur commands, change and submit
events, and Focus/Blur all work. Done (65376) submits, and blurs unless the
input keeps focus. Cancel (65385) and Back leave the input. While an input
is edited, the arrows, OK and digits belong to the keyboard.

**Images.** `<img>` with `object-fit`, `object-position`, blur, a
placeholder, the `onLoad`/`onError`/`onLoadStart`/`onLoadEnd` events, and
`asset:/x` served from the package's `assets/`. In-memory images (`data:`)
come as bytes and are shown through blob URLs. `svg()` with a text color is
drawn as a mask of that color.

**Diagnostics.**

- `window.__nsh` holds the timings, unknown operations, slow operations,
  logs and errors. `__nsh.engine` holds module size, compile, cache, start
  and stubbed imports.
- `localStorage['nsh.metrics']` keeps the last five launches.
- `localStorage['nsh.autobench'] = '1'` runs the benchmark on the next
  launch, with results in `nsh.bench`.

## Build and test

```sh
TIZEN_SIGNING_PROFILE=<profile> ./build.sh [--install <tv-ip>:26101]
#   NSH_PAGE=page-thread.html  the page-thread benchmark variant
#   NSH_OPT=s|z|3  NSH_FEATURES=ballast  NSH_FONT=x.ttf  NSH_APP_FONT=x.ttf NSH_APP_FONT_FAMILY=name
cargo test                               # encoding, keys, fonts, components, inputs, images
node tools/page-test.mjs                 # the built package in headless Chromium (after build.sh)
tools/tv.sh install|debug|eval|bench     # on the TV (TV=host:port, APP=id)
```

The build uses Patina's pinned nightly (`../patina-iptv/tools/ci/fuzz-imports.sh
--toolchain`), with a rebuilt std, `-C target-cpu=mvp -C
target-feature=+sign-ext,+mutable-globals`, through rustup's `cargo`. An app
links the platform through a runner:
`nsh_platform_tizen::app!(nsh_rust_app::app_ui_sets(), nsh_rust_app::root());`.
`docs/patina-integration.md` lists what Patina's `hosts/tizen` needs.

## Measurements on the TV (UN55TU7000, Tizen 5.5, 2026-11-21)

The guide app runs at 4.6 MB (`opt-level=3`, LTO), with 203 views and
about 380 DOM nodes.

| Launch | Result |
|---|---|
| After an install: compile | 15.4–16.7 s; first paint 17.8–19.3 s |
| Cache write (compiled module: 11.9 MB in IndexedDB) | 2.9 s, once the quota was freed (see below) |
| Later launches, module from the IndexedDB cache | 2.4–5.1 s; first paint 4.9–7.7 s |
| Later launches, Chromium's own cache hit (no IndexedDB entry) | compile 1.1–2.1 s; first paint 3.8–4.9 s |
| First render: start (engine), DOM apply | 0.36–0.49 s, 0.18–0.20 s (0.14–0.20 s for the spike's renderer) |
| Memory | 10 MB JavaScript heap on the page |

The shared benchmark ran in normal launches, video playing, 32 moves 350 ms
apart. "Under load" means the app's thread works 30 ms of every 50 ms. Two
runs per row. The "before" row is the spike's Worker variant, measured the
same day.

| | Key to frame idle (p50 / p90) | Under load (p50 / p90) | Page frames over 50 ms (idle / load) |
|---|---|---|---|
| Worker, spike renderer (before) | 73–75 / 110–112 ms | 95–112 / 142–164 ms | 3–7 / 7–10 |
| Worker, this renderer (after) | 61–72 / 98–133 ms | 101–107 / 131–166 ms | 1–4 / 2–7 |
| Page thread, this renderer | 70–72 / 123–126 ms | 93–97 / 114–117 ms | 13–17 / 20 |

Per key on the page, with DevTools attached in both cases:

| | Before | After |
|---|---|---|
| DOM apply | 11.6 ms | 4.5–6.3 ms |
| JSON parse | 1.6 ms | 1.2–1.8 ms |
| Operations | 81 | 67–93 (idle–load scenario; about 2 per key are left out by the sink's deduplication) |

Engine per key (normal launches): 25–27 ms in the pump, of which about
8 ms is text layout. Encoding and serializing take another 2–3 ms. The
Worker's per-key cost stays in the engine; the renderer halved its share.

### Checked on the TV

- Worker by default; no unknown operations, no errors.
- The guide renders and the arrows move the focus.
- OK opens a stream through `tv.player` (the AVPlay example). Its `state`
  (`ready`) and `size` events reach the app, Play/Pause pauses, CH+ zaps
  with a new token, and Stop stops.
- Red focuses the search input. Typed characters reach the app, its value
  comes back, Done (65376) submits and blurs, and Back leaves the input.
  These were synthetic key events over DevTools; the TV keyboard's own
  appearance wasn't seen, because DevTools screenshots hang on this set in
  this session.
- The logo image loads from `assets/` and its load event reaches the app.
- Fonts: a host page font and an app font (`Root::font`) both load in the
  Worker and on the page (`FontFace` status `loaded`). For the host font,
  the engine's measured width equals the DOM's.
- 30 remote keys register one at a time, from `getSupportedKeys` on this
  set.

### Findings from other Tizen apps (from the coordinator), checked or not

| Finding | Here |
|---|---|
| `<script type="module">` and streaming compilation fail (package files have no MIME type) | Avoided: classic scripts, XHR, `WebAssembly.compile` from bytes. Not tested. |
| Workers resolve relative URLs wrongly | Avoided: every Worker URL is absolute. Not tested. |
| An opaque background hides AVPlay's video | Followed: transparent down to `body`, the `<object>` first in `body`. The picture couldn't be checked (no screenshots); the player reached `ready` with its size. |
| AVPlay call order, close after errors, tokens, stop while hidden | Implemented. Open, prepare, play, pause and zap worked. The error and hidden paths weren't exercised. |
| Register keys one by one, again when visible; not Exit or Volume | Implemented. The registration worked; re-registration wasn't exercised. |
| Back debounce (about 600 ms) | Implemented (`backDebounceMs`). Not exercised with a real remote. |
| IME Done/Cancel are 65376 / 65385; blur when focus leaves | Done verified with a synthetic key; Back blurs. |
| About 120 MB JS heap budget | The page uses 10 MB (the Worker's heap isn't measured). |

Found here: the first access to `webapis.avplay` costs the page about
0.7 s (DevTools profile: `get hybridchannelinfo`), so the example player
doesn't touch `webapis` before it opens a stream. The module cache write
failed with `QuotaExceededError` while the spike's old database
(`nsh-spike`) was still there. A compiled module takes about 2.6 times its
file size, so a 12 MB module would need about 31 MB of the 88 MB quota.

## Not done

- Mount items not shown (each is logged once, in `__nsh.logs`):
  - `Canvas`: encoded, but the page doesn't draw `cv`.
  - `Shader`, `ShaderTransition`, `NavShader`, `ShaderInput`.
  - `LayoutAnimation`: frames jump instead of animating.
  - `ScreenConfig` and `ModalConfig`: stacks, screens and modals are plain
    views, with no transitions and no system back handling.
  - `NativeProps`: NSH's own `web_view` and `video` (use a native component
    for video).
  - `Keymap` (shortcut tables), `ScrollBehavior` (snapping and paging) and
    `Refreshing`.
  - `ComponentPropSlots`: animated props of native components.
  - `AccessibilityLabel` and `ViewProps` accessibility: no screen reader
    support.
  - `Overflow`, `TreeOrder`, `ProjectStates`, `LayoutDirection` (no RTL)
    and `Appearance`.
  - Commands other than focus, blur, scroll to, native commands and exit.
- `key_scrolled` isn't sent: scroll views move only by the app's commands.
  There is no directional focus navigation of its own; the app owns focus,
  as Patina's input layer does.
- `default_prevented` / `captureKeys`: the page prevents every key in the
  table; the app's capture rules aren't consulted.
- NSH services `storage`, `network`, `assets`, `clipboard`. UI-set font
  files (`Registry::asset_files`) need an `Assets` service, so only
  `Root::font` and host fonts register today.
- Lifecycle beyond the player (`visibilitychange` to the app), and TV
  screensaver control.
- The `nsh-platform-tizen` command for `nsh run/package --target tizen`:
  `build.sh` is the build today.
- Measured on one 2020 set only.

## Spike measurements (before this platform)

### Round 1: the engine through a DOM renderer

Module: NSH engine, core and the spike app, 4.55 MB (`opt-level=3`, LTO),
built for MVP WebAssembly with sign-extension (rebuilt std, pinned nightly).

| Measure | Result |
|---|---|
| First launch: compile the module | 13.1–16.6 s (3.6 MB `opt-level="z"`: 10.9 s; 4.0 MB `"s"`: 11.1 s) |
| Later launches: compiled module from IndexedDB | 1.2–5.5 s; first paint 2.3–6.6 s (normal launches) |
| First render: start, 199 views, 782 operations | 0.2–0.5 s; DOM apply 30 ms; 377 DOM nodes |
| Memory | 3 MB WebAssembly, 10 MB JavaScript heap |
| Key to painted frame, warm (40 moves, DevTools attached) | median 88–90 ms, p90 124–128 ms, worst 175 ms |
| Per key: engine (reactive, layout, text layout, encoding) | about 43 ms |
| Per key: DOM apply / text measuring | about 11 ms / 2 ms (from 26 ms before the width cache) |
| Operations per focus move | about 106 |

For comparison, the plain-JavaScript Patina Live host showed its list after a
key in a median of 18 ms (render completion, not paint; a simpler list).

### Round 2: where the time goes, and how size scales

Per focus move, from a benchmark the page runs itself in a normal launch
(no debugger; 32 moves 350 ms apart):

| Stage | ms per key |
|---|---|
| Engine: reactive graph and layout | ~19 |
| Engine: text layout (Rust, `TizenTextEngine`) | ~10 |
| DOM apply (JS) | ~12 |
| JSON: encode + serialize + parse | ~4 |
| Key to painted frame | median 62, p90 231 |
| Held key (a move every 100 ms) | median 108, p90 138; frames drop |

JSON is not the bottleneck. The reference sink encoded every item twice;
it now encodes once.

Module size against launch time (normal launches; "ballast" links real code
a Patina module would carry: `iptv-web`'s core, and NSH's base components
through `nsh_base::registry()`):

| Module | First launch: compile | Cache write | Cached launch: first paint |
|---|---|---|---|
| 3.6 MB (`opt-level="z"`) | 10.9 s | ok | 6.6 s |
| 4.0 MB (`"s"`) | 11.1 s | ok | 5.4 s |
| 4.55 MB (`3`) | 13.1–16.6 s | ok | 2.3–5.8 s |
| 6.2 MB (+ `iptv-web`) | 19.2 s | 6.0 s | 4.6–7.9 s |
| 12.5 MB (+ all base components) | 34–38 s | **fails**: IndexedDB "transaction timed out due to inactivity", then `QuotaExceededError` | 7–38 s, unpredictable |

Compiling costs about 3 s per MB (Chromium 69 has no baseline compiler or
Wasm code cache on this ARMv7 TV). Some relaunches of the 12.5 MB module
compiled in about 7 s without our cache, so the runtime caches something
itself, but not reliably.

Estimated size of Patina's UI as a TV module, scaled from native release
code per crate: 12–19 MB (NSH engine/core/base 6.6 MB, UI 2.2 MB, runtime
1.5 MB, portable crates 1.2 MB native, plus shared std/dependency code);
linking only the base components it uses would reduce it.

### What the spike concluded

- On a 2020 TV (Tizen 5.5), Patina's whole NSH UI would launch in about
  35–55 s after every install or update, and later launches would not be
  reliably cached at that size. That rules it out for this TV generation
  unless the module shrinks to the cacheable range (about 6 MB or less).
- Interaction is workable: a 62 ms median key-to-frame on a guide-like
  screen, with headroom in text layout and DOM apply (both in this
  platform's code), and about 19 ms of engine work that needs NSH-side or
  app-side reductions.
- Newer TVs may differ: upstream Chromium added a baseline Wasm compiler
  and Wasm code caching after version 69 (from general knowledge of
  Chromium's history, not checked against Samsung's builds). Tizen 6.5+
  (2022, Chromium 85+) could remove the compile wall. Not measured: one
  2020 TV only.

### Round 3: page thread or Worker

`worker.html` runs the engine and app in a Web Worker (`runtime/worker.js`,
text measured with `OffscreenCanvas`); the page (`runtime/page-worker.js`)
draws operations, plays video and forwards keys. Both variants run the same
benchmark (`runtime/bench-common.js`, appended by `build.sh`; select with
`SPIKE_PAGE=worker.html`): 32 paced moves idle, then 32 while the app's
thread works 30 ms of every 50, with video playing.

| | Key to frame idle (p50 / p90) | Under load | Page frames over 50 ms (idle / load) |
|---|---|---|---|
| Page thread | 70 / 112 ms | 108 / 146 ms | 18 / 32 |
| Worker | 81 / 109–184 ms | 93–94 / 130–155 ms | 5–12 / 3–10 |

The Worker costs about 11 ms per key idle and wins under load; the page
stays smooth. Patina's plan (`docs/plans/2026-11-21-browser-tv-architecture.md`)
adopts it.
