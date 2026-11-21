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
  - `bench.js` is the shared benchmark (`nsh-bench.js`, benchmark builds only).
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
    version: '…',                      // the module's SHA-256: the compiled-module cache key
    worker: 'nsh-worker.js',
    scripts: [],                       // Worker scripts with host imports
    fonts: [],                         // [{ family, url, weight, style }]
    registerKeys: [],                  // more remote keys, by Tizen name
    backDebounceMs: 600,               // Back presses closer than this are one
    onHost: function (message) {},     // nsh_platform_tizen::host(json) from the app
    onExit: function () {},            // Command::ExitApp (default: the app exits)
    onError: function (text) {}        // errors, a Worker that failed, an app that stopped
});
NshTizen.stop();                       // ends the session (a second start does too)
```

Each `start` is a session: a second one ends the first, with its Worker,
DOM, listeners and callbacks. Every host callback (`onHost`, `onError`,
components) is isolated: a throw is reported in `__nsh.errors` and does not
stop the page. Inline scripts are avoided (the example app declares a CSP,
below); `build.sh` writes the module's version into `app-config.js`.

**Native components.** `native("name")` in the app mounts the factory
registered under `name`. It gets `ctx`: `id`, `name`, `element` (the
container `<div>`), `emit(event, data)` (to `on_native_event`) and `rect()`.
It returns any of these methods:

- `props(changed, all, removed)`: JSON props by name, after every commit
  that changes them. A prop set to `null` is in `changed` as `null`; a prop
  removed is named in `removed` and absent from `all`.
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
never touches a player it didn't open. AVPlay is one player per app: it is
taken only when free (getState NONE), so a second instance, or anything the
host page opened itself, reports `busy`.

Samsung's `seekTo` must complete before any other AVPlay call ("During this
async operation, the other API would not be allowed ... wait for one of both
callbacks", AVPlay API reference; `getState` is not exempted, so nothing
polls it). While a seek runs, every other call waits: play, pause, the rect,
metadata reads, and the close or reopen that a zap, hide or removal asks
for. They run when the seek's callback comes. A seek without a callback
after 5 s is reported to the app as failed (a timeline with `failed: true`)
while the calls keep waiting; only after 30 s do they run anyway. A close
AVPlay refuses leaves the player STUCK: it is retried every second, and an
open that found it stuck runs once it closes. An app's seek is answered for
its source even if a hide closed the player meanwhile, so it is not asked
again on show, and the stream reopens where the player actually was. A zap
queued behind a seek while the page was hidden opens on show. A stream opened paused stays
prepared (READY) until it is unpaused; pause is only called on a stream
that has played. It doesn't support headers, volume, mute or tracks.

**Host services** (storage, fetch, entropy) aren't the platform's. The
app's imports for them run in the Worker: a script in `options.scripts`
calls `NshTizenWorker.addImports(module, functions)` and
`NshTizenWorker.onInstance(function (exports, engine) {...})`. After an
async reply, the script calls `engine.pump()`; tasks the reply woke are
also pumped through the engine's wake (`LocalEngine::set_wake`). Imports
nobody provides become no-ops, listed in `__nsh.engine.stubbed`.

Failures are contained. An import that throws (the platform's or a host's)
is caught, reported, and returns 0, never unwinding through the module. An
import that calls back into the module during a pump is queued and runs
when the outer call ends, as do calls made while it delivers its output or
while the app starts. A trap in the module (a Rust panic aborts) is one
fatal transition: the panic's message and the trap's stack reach `onError`
once, output not yet sent is dropped, the engine's timers stop, the page's
key listeners go, native components are destroyed (the player closes), and
nothing calls into the module again; the last frame stays on screen. Hooks
get the exports wrapped the same way, so a host's own call that traps is
fatal too, never a silent freeze. Errors are reported once each and then
counted (`__nsh.errorCounts`), and metrics are saved at most every 2 s. A
cached module that no longer links is evicted and compiled again once. The
platform provides no NSH `storage`, `network` or `assets` service.
Clipboard reads, `OpenUrl` and `PickScreenColor` are answered at once
(nothing on the clipboard, not opened, none picked), so an app awaiting
one goes on.

**Fonts.** The app registers fonts with `Root::font` or `register_font`:
the text engine reads the file's family, weight and style, and the Worker
and the page each load it as a `FontFace`. Text is measured again once both
have loaded. Host fonts (`options.fonts`) are loaded in the Worker before
the app starts. Without either, text uses the system font: a 2020 set
resolves every family name, `serif` and `monospace` included, to one font.

**Keys.** The remote's keys arrive as NSH `KeyEvent`s with UI Events names
(`keys.rs`: `GoBack` 10009, `ColorF0Red`…`ColorF3Blue` 403–406,
`ChannelUp`/`ChannelDown` 427/428, `MediaPlayPause` 10252, the other media
keys, `Info`, `Guide`, `ChannelList`, `MediaLast`, digits). The engine
decides where a key goes, from the tree it just committed (the page's copy
lags a message behind): the view the app focused (`ElementRef::focus` on a
focusable view) while it is attached. Else, with a modal open, the topmost
attached modal's content: its first child that is not a modal, in drawing
order. That is this platform's own choice: NSH's web backend reports at the
newest modal itself and macOS at the root's content, and neither reaches a
plain modal's content without a focus. Else the root, where the core starts
the key at the view mounted there, as NSH's own backends report a key with
nothing focused. The page
names only the input being edited. The core then bubbles the key through
its logical ancestors up to its window, so a plain modal's background hears
what the modal's content doesn't take. That's NSH's behaviour on every
backend, kept here; `captureKeys`, or a focus inside the modal, keeps keys
there. OK on a focused view that takes presses is a key there first; when
the app's `captureKeys` didn't take it, it also presses the view, as NSH's
web backend does. A key's auto-repeats go where keys go now (holding Down
walks a list whose items move the focus), as NSH's web and macOS backends
pick the view per event. A held OK on the view it pressed stays there. The
release goes to the view its last down reached or, if that view left the
tree, to the nearest view that heard the down and is still there, never to
a view that heard no down. A release without a press is dropped. Keys go
through the engine's own entry, `LocalEngine::key_event`, so
`default_prevented` carries the app's `captureKeys` decision. That entry is
`#[doc(hidden)]` in NSH (its web backend uses it too): this platform
depends on a hidden entry point, listed as an upstream request in
`docs/patina-integration.md`.

The engine also reports the views' own `Focus` and `Blur`, each with the
focused state (always: the core tracks it for every view). An input taking
the DOM focus takes it from the focused view (the view's Blur first). A
view taking the focus closes the TV keyboard, and the input's Blur is
reported before the view's Focus. A Blur on the root blurs the input being
edited, and a focused view that leaves the tree is blurred.

On the page each physical key's press decides what it is: the app's, the
TV keyboard's (while editing), or swallowed (keys an input handled: Done,
Cancel, Enter for a submit; Back while editing, which leaves the input; a
Back within `backDebounceMs` of the last). Its repeats and release follow
that decision, so a release never reaches the app without its press. The
TV keyboard's keys keep their default (typing, moving the caret).

At start the page registers the table's keys one at a time with
`tvinputdevice.registerKey`, and again when it becomes visible. Exit,
Volume, Menu and Source stay the TV's. `code` is the browser's
`KeyboardEvent.code`. No `default_prevented`: the page can't wait for the
Worker, so it prevents the default of every key in the table.

Not done: Back reaches the app only as the raw `GoBack` key; there is no
NSH back handling (`onBackRequest`, `onRequestClose`, `popOnBack`) behind
it yet.

**Inputs.** An NSH input is an `<input>` (or `<textarea>`) over the TV
keyboard. It handles value (dropped if the user typed since), placeholder
and its color, type (`password`, `number`, `email`, `tel`, `url`), max
length, read only and auto focus. A masked input is always one line (a
`<textarea>` cannot hide its text). Changing `multiline` while typing keeps
the text, the focus and the selection. Focus and blur commands, change and submit
events, and Focus/Blur all work. Done (65376) submits, and blurs unless the
input keeps focus; held, it submits once. Cancel (65385) and Back leave
the input. The input type is set before a multiline swap copies the value
and selection. While an input
is edited, the arrows, OK and digits belong to the keyboard.

**Images.** `<img>` with `object-fit`, `object-position`, blur, a
placeholder, the `onLoad`/`onError`/`onLoadStart`/`onLoadEnd` events, and
`asset:/x` served from the package's `assets/`. In-memory images (`data:`)
come as bytes, placeholders included, and are shown through blob URLs of
their type; a blob is released when no view shows it. `svg()` with a text
color is drawn as a mask of that color. URIs are escaped in CSS. An
`<img>` loads only `http(s)` URLs, the package's files by relative URL, and
in-memory images by their key (any media type); `file:` and other schemes
are refused, parsed as the browser parses them, and a refused source
reports an image error. Each batch's in-memory images reach the page right
before it, and a blob is released only when no view shows it at the end of
a batch.

**Diagnostics.**

- `window.__nsh` holds the timings, unknown operations, slow operations,
  logs and errors. `__nsh.engine` holds module size, compile, cache, start
  and stubbed imports.
- `localStorage['nsh.metrics']` keeps the last five launches.
- `NshTizen.record()` keeps the next 50 batches (`NshTizen.recorded()`).
- Benchmark builds only (`NSH_BENCH=1`, which adds `nsh-bench.js` with the
  benchmark's hooks): `localStorage['nsh.autobench'] = '1'` runs the
  benchmark on the next launch, with results in `nsh.bench`. The Worker
  makes itself busy for the load scenario only in such builds.

**CSP.** The example app declares one in `config.xml`, which moves Tizen
from WARP to CSP mode: `default-src 'self'; script-src 'self'; style-src
'self' 'unsafe-inline'; img-src * blob: data:; font-src 'self'; media-src
*; connect-src *; object-src 'self'; worker-src 'self'`. The renderer needs
inline styles (its `<style>` elements), `blob:` images and `object-src` for
AVPlay. The Worker compiles WebAssembly outside the page's policy; the
page-thread benchmark compiles on the page, which Chromium 69 allows only
with `'unsafe-eval'` (it has no `'wasm-unsafe-eval'`), so `build.sh` adds
it only to that build. `tools/page-test.mjs` serves the package's policy as
the page's CSP header and fails on any violation.

## Build and test

```sh
TIZEN_SIGNING_PROFILE=<profile> ./build.sh [--install <tv-ip>:26101]
#   NSH_PAGE=page-thread.html  the page-thread benchmark variant
#   NSH_BENCH=1                include the shared benchmark (tools/tv.sh bench needs it)
#   NSH_OPT=s|z|3  NSH_FEATURES=ballast  NSH_FONT=x.ttf  NSH_APP_FONT=x.ttf NSH_APP_FONT_FAMILY=name
cargo test                               # encoding, keys, routing, fonts, components, inputs, images
(cd tools && npm ci)                     # acorn, for the ES2017 check (tools only)
node tools/page-test.mjs                 # the built package in headless Chromium (after build.sh)
tools/tv.sh install|debug|eval|bench     # on the TV (TV=host:port, APP=id)
```

The TV build needs rustup with the nightly Patina pins (`nightly-2026-10-24`,
`NSH_NIGHTLY` to change it) and its `rust-src` component. It rebuilds std,
with `-C target-cpu=mvp -C target-feature=+sign-ext,+mutable-globals`. It
also needs Tizen Studio's CLI and a signing profile. `cargo test` and the
page test need neither.

NSH comes from `teng-lin/nsh` at the commit Patina pins (the `patina`
branch), and the test app's `iptv-core` (and, with the `ballast`
features, `iptv-web`) from `teng-lin/patina-iptv`, both as git
dependencies pinned by revision in `Cargo.toml`, with `Cargo.lock`
committed. A fresh clone builds as it is.

### Local checkouts

To work against local checkouts of NSH or Patina, patch the git sources in
an uncommitted `.cargo/config.toml` (it is in `.gitignore`):

```toml
[patch."https://github.com/teng-lin/nsh"]
nsh-core = { path = "../nsh/crates/nsh-core" }
nsh-engine = { path = "../nsh/crates/nsh-engine" }
nsh-base = { path = "../nsh/crates/nsh-base" }

[patch."https://github.com/teng-lin/patina-iptv"]
iptv-core = { path = "../patina-iptv/crates/iptv-core" }
iptv-web = { path = "../patina-iptv/crates/iptv-web" }
```

For a single command, use `--config`:

```sh
cargo test --config 'patch."https://github.com/teng-lin/nsh".nsh-core.path="../nsh/crates/nsh-core"'
```

A patch changes `Cargo.lock`; don't commit that change. An app
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
| Worker, after the review fixes (guarded imports, engine key routing) | 62–66 / 116–135 ms | 94–100 / 166–170 ms | 2 / 11 |
| Page thread, this renderer | 70–72 / 123–126 ms | 93–97 / 114–117 ms | 13–17 / 20 |

Per key on the page, with DevTools attached in both cases:

| | Before | After |
|---|---|---|
| DOM apply | 11.6 ms | 4.5–6.3 ms |
| JSON parse | 1.6 ms | 1.2–1.8 ms |
| Operations | 81 | 67–93 (idle–load scenario; about 2 per key are left out by the sink's deduplication) |

Engine per key (normal launches): 25–27 ms in the pump, of which about
8 ms is text layout (21–24 ms after the review fixes: guarding every import
costs nothing measurable). After those fixes the page's DOM apply was
6.3–7.2 ms idle and 9.5–9.8 ms under load, and page frames over 50 ms
under load rose from 2–7 to 11. That was one session of two runs, so the
difference may be noise. Encoding and serializing take another 2–3 ms. The
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
| AVPlay call order, close after errors, tokens, stop while hidden | Implemented. On the TV: open, prepare, play, pause and zap. Against a fake AVPlay in headless Chromium (`tools/runtime-cases.js`): the call order, late callbacks of a replaced stream dropped, a throwing `play()` and an error both closing and releasing the player, a seek before ready deferred. The hidden path wasn't exercised on the TV (`tizen run` relaunched the app). |
| Register keys one by one, again when visible; not Exit or Volume | Implemented. The registration worked; re-registration wasn't exercised. |
| Back debounce (about 600 ms) | Implemented (`backDebounceMs`). Not exercised with a real remote. |
| IME Done/Cancel are 65376 / 65385; blur when focus leaves | On the TV, with synthetic keys: Done submits without the app also seeing it, Back blurs without reaching the app. |
| Declaring a CSP switches Tizen to CSP mode | The example app declares one; the Worker, wasm compile, styles, images and AVPlay all work under it on the TV. |
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
- `captureKeys` decides `default_prevented` in the engine, but the page
  cannot wait for it: it prevents the default of every key in the table.
- `backdrop-filter` (Chromium 69 has none): not drawn.
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
