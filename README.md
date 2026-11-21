# nsh-platform-tizen (spike)

Can Patina's NSH user interface run on a Samsung Tizen TV? This spike runs
an NSH Rust app on Tizen 5.5 (2020, Chromium 69, ARMv7) through an NSH
*external platform* (NSH's `docs/dev/platforms.md`), without changing NSH or
Patina:

- `crates/nsh-platform-tizen`: the engine (`LocalEngine`) in WebAssembly,
  each commit encoded as operations. It starts from
  [nsh-platform-miniprogram](https://github.com/huacnlee/nsh-platform-miniprogram)
  (Apache-2.0, see NOTICE), adapted for a TV: a 1920 × 1080 dark browser TV
  environment (`Os::Web`, `Idiom::Tv`), remote keys to the view listening for
  them, a `host` message for the page, and cached text widths.
- `runtime/nsh-tz.js`: an ES2017 page runtime that applies the operations
  to the DOM, measures text with a canvas, plays AVPlay under the page, and
  caches the compiled module in IndexedDB. It records its own timings
  (`localStorage['spike.metrics']`, `window.__spike`).
- `crates/guide-spike`: a guide over video like Patina's (header, transparent
  preview, time ruler and now line, 9 channel rows of program cells, focused
  pill), on `iptv-core`'s guide focus model and synthetic schedule, built
  against Patina's NSH pin (`../nsh-patina`).

Patina's own `iptv-app` cannot be built for the TV yet: it reaches the native
`iptv-runtime` (multithreaded Tokio, SQLCipher) from 37 files. The spike
measures a representative screen instead.

```sh
TIZEN_SIGNING_PROFILE=<profile> ./build.sh --install <tv-ip>:26101
```

## Results on a UN55TU7000 (2020, Tizen 5.5)

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

## Round 2: where the time goes, and how size scales

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

## What it means

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

## Round 3: page thread or Worker

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
