// Derived from nsh-platform-miniprogram (Copyright 2026 Jason Lee, Apache-2.0); modified.
//! An NSH platform for Samsung Tizen TVs (Tizen 5.5 and later: Chromium 69,
//! ES2017, MVP WebAssembly), built only on NSH's public engine API outside
//! NSH's repository (NSH's `docs/dev/platforms.md`). It started from
//! `nsh-platform-miniprogram` (NOTICE).
//!
//! How it fits together:
//!
//! - The engine ([`nsh_engine::LocalEngine`]: the core, layout, the
//!   reactive graph and the app's Rust components) runs in WebAssembly in a
//!   Web Worker (`runtime/worker.js`), driven by its timers ([`Runtime`]).
//! - Each commit's [`nsh_core::MountBatch`] becomes JSON operations
//!   ([`encode`]) that the page (`runtime/renderer.js`) applies to the DOM:
//!   each view an absolutely positioned element at the frame the engine
//!   laid out.
//! - Text is measured in the Worker (`OffscreenCanvas`) and broken into
//!   runs here ([`text`]); the page draws each run where it was placed.
//! - Native components (`native("name")`) are the host page's: it
//!   registers an implementation per name (`NshTizen.registerComponent`),
//!   which gets the component's props and frame and emits its events.
//! - The remote's keys arrive as NSH key events with the DOM's names
//!   ([`keys`]), inputs are `<input>` elements over the TV's keyboard.
//!
//! The platform names itself `"tizen"` (`platform.name`,
//! [`Environment::platform`]) on [`Os::Web`] with [`Idiom::Tv`].
//!
//! A runner crate starts an app with [`app!`] and links this crate for
//! `wasm32-unknown-unknown`, where [`ffi`] exports the functions the
//! runtime calls.

mod anim;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod calls;
pub mod canvas;
mod effects;
pub mod encode;
#[cfg(target_arch = "wasm32")]
pub mod ffi;
pub mod font;
pub mod keys;
mod route;
pub mod text;

/// Where time goes: milliseconds per stage, read and reset by the runtime
/// (`nsh_tz_stat`) for its timing recorder.
pub mod stats {
    use std::cell::Cell;

    /// The engine's pump, including encoding (the sink runs inside it).
    pub const PUMP: usize = 0;
    /// Encoding mount items into operations.
    pub const ENCODE: usize = 1;
    /// Kept for the runtime's stat numbering: operations are serialized
    /// once, while they are encoded, so this stays 0.
    pub const SERIALIZE: usize = 2;
    /// Text layout requests (`TextEngine` calls).
    pub const TEXT: usize = 3;
    /// Operations left out because nothing changed for the page (a style
    /// or text encoded as the one it has): a count, not milliseconds.
    pub const DEDUPED: usize = 4;
    const N: usize = 5;

    thread_local! {
        static MS: [Cell<f64>; N] = const { [const { Cell::new(0.0) }; N] };
    }

    /// Adds `n` to counter `stage`.
    pub fn count(stage: usize, n: f64) {
        MS.with(|m| m[stage].set(m[stage].get() + n));
    }

    /// Adds the time since `since` to stage `stage`.
    pub fn add(stage: usize, since: nsh_core::time::Instant) {
        let ms = since.elapsed().as_secs_f64() * 1000.0;
        MS.with(|m| m[stage].set(m[stage].get() + ms));
    }

    /// The total of `stage`, then zero.
    pub fn take(stage: usize) -> f64 {
        MS.with(|m| m.get(stage).map_or(0.0, |c| c.replace(0.0)))
    }
}

/// Sends `message` (JSON) to the host page (its `onHost` option): what an
/// app asks of its host beyond drawing. A no-op off the TV (tests).
pub fn host(message: &str) {
    #[cfg(target_arch = "wasm32")]
    ffi::host(message);
    #[cfg(not(target_arch = "wasm32"))]
    let _ = message;
}

use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};

use nsh_core::MountBatch;
use nsh_core::{
    EventKind, EventPayload, Points, Size,
    element::{Registry, Root},
    geometry::{DevicePixels, point},
    image::ImageData,
    platform::{ColorScheme, Idiom, Os},
};
use nsh_engine::{App, EngineConfig, EngineControl, Environment, LocalEngine, MountSink};
use serde_json::Value;

use crate::text::{Measure, TizenTextEngine};

/// The name this platform reports in `platform.name`.
pub const PLATFORM_NAME: &str = "tizen";

/// What the page reports about the TV at start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Device {
    /// The page's size in px (points).
    pub width: f32,
    /// The page's height.
    pub height: f32,
    /// Device pixels per px.
    pub pixel_ratio: f32,
    /// The system shows dark mode.
    pub dark: bool,
    /// The OS: [`Os::Web`] (a Tizen app is a web app).
    pub os: Os,
}

impl Default for Device {
    /// A Tizen TV web app's page: 1920 × 1080 px whatever the panel.
    fn default() -> Self {
        Device {
            width: 1920.0,
            height: 1080.0,
            pixel_ratio: 1.0,
            dark: true,
            // Tizen apps are web apps: a browser, a TV by its idiom.
            os: Os::Web,
        }
    }
}

impl Device {
    /// The environment the engine runs the app in.
    pub fn environment(&self) -> Environment {
        Environment {
            window: Size::new(Points(self.width), Points(self.height)),
            color_scheme: match self.dark {
                true => ColorScheme::Dark,
                false => ColorScheme::Light,
            },
            pixel_ratio: self.pixel_ratio,
            os: self.os,
            platform: Some(PLATFORM_NAME),
            // A Samsung TV: driven by its remote, seen from across the room.
            idiom: Idiom::Tv,
            // No clipboard images (nor a clipboard at all: its reads are
            // answered empty).
            clipboard_images: Some(false),
            ..Environment::default()
        }
    }
}

/// What the engine hands the page between two pumps.
#[derive(Default)]
struct Outbox {
    /// Each commit's operations, with the in-memory images they show.
    batches: Vec<Batch>,
    /// The engine asked for a display frame.
    frame: bool,
    /// Errors of the app, as text.
    errors: Vec<String>,
    /// The native animation graph, which the batches drive.
    anim: anim::Anim,
    /// What the page was last given per view, to leave out a style or a
    /// text encoded as the one it has.
    sent: Sent,
    /// Where keys go, and the focus of views.
    routes: route::Routes,
    /// Requests this platform cannot serve, answered after the pump:
    /// an app awaiting one must not wait forever.
    answers: Vec<(EventKind, EventPayload)>,
}

/// Hashes of the last `s` and `t` operation per view, and the in-memory
/// images the page holds (by URI, how many views show each).
#[derive(Default)]
struct Sent {
    styles: HashMap<u32, u64>,
    texts: HashMap<u32, u64>,
    images: HashMap<Arc<str>, u32>,
    /// The in-memory images whose bytes the page holds (from their bytes
    /// to their release, which is decided at a batch's end).
    on_page: HashSet<Arc<str>>,
    /// The in-memory images each view shows (source, placeholder).
    shown: HashMap<u32, Vec<Arc<str>>>,
}

fn hash(value: &impl Hash) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut h);
    h.finish()
}

impl Sent {
    /// Whether operation `code` on view `id`, serialized as `json`, changes
    /// what the page shows: false for a style or a text the view already
    /// has. The core sends a style when any of its fields changed,
    /// including ones this platform does not draw, and a text when its
    /// layout object is new.
    fn changes(&mut self, code: &str, id: u32, json: &str) -> bool {
        let map = match code {
            "s" => &mut self.styles,
            "t" => &mut self.texts,
            "d" => {
                self.styles.remove(&id);
                self.texts.remove(&id);
                return true;
            }
            _ => return true,
        };
        let h = hash(&json);
        map.insert(id, h) != Some(h)
    }

    /// View `id` now shows the in-memory images `now` (or none, deleted):
    /// the bytes of those the page lacks go to `images`, and the URIs no
    /// view shows any more come back, for the page to release.
    fn show(
        &mut self,
        id: u32,
        now: Vec<(Arc<str>, ImageData)>,
        images: &mut Vec<(String, ImageData)>,
    ) -> Vec<Arc<str>> {
        let mut released = Vec::new();
        let uris: Vec<Arc<str>> = now.iter().map(|(u, _)| u.clone()).collect();
        for (uri, data) in now {
            *self.images.entry(uri.clone()).or_insert(0) += 1;
            if self.on_page.insert(uri.clone()) {
                images.push((uri.to_string(), data));
            }
        }
        let old = match uris.is_empty() {
            true => self.shown.remove(&id),
            false => self.shown.insert(id, uris),
        };
        for uri in old.unwrap_or_default() {
            if let Some(count) = self.images.get_mut(&uri) {
                *count -= 1;
                if *count == 0 {
                    self.images.remove(&uri);
                    released.push(uri);
                }
            }
        }
        released
    }
}

/// The in-memory images (bytes in hand) an image item shows: its source
/// and its placeholder.
/// In-memory images by URI.
type Images = Vec<(Arc<str>, ImageData)>;

fn in_memory(item: &nsh_core::MountItem) -> Option<(u32, Images)> {
    match item {
        nsh_core::MountItem::Image {
            id,
            source,
            options,
            ..
        } => Some((
            *id,
            [source.as_ref(), options.placeholder.as_ref()]
                .into_iter()
                .flatten()
                .filter_map(|s| Some((s.uri.clone(), s.data.clone()?)))
                .collect(),
        )),
        nsh_core::MountItem::Delete { id } => Some((*id, Vec::new())),
        _ => None,
    }
}

/// What a request command this platform cannot serve answers at once:
/// nothing on the clipboard, no URL opened, no color picked.
fn answer(item: &nsh_core::MountItem) -> Option<(EventKind, EventPayload)> {
    use nsh_core::{Command as C, PayloadValue as V};
    let nsh_core::MountItem::Command { command, .. } = item else {
        return None;
    };
    let id = |id: &u32| ("id", V::Number(f64::from(*id)));
    Some(match command {
        C::ReadClipboard { id: i, .. }
        | C::ReadClipboardImage { id: i, .. }
        | C::ReadClipboardFiles { id: i } => (
            EventKind::Clipboard,
            EventPayload::Map(vec![id(i), ("has", V::Bool(false))]),
        ),
        C::OpenUrl { id: i, .. } => (
            EventKind::OpenUrl,
            EventPayload::Map(vec![id(i), ("opened", V::Bool(false))]),
        ),
        C::PickScreenColor { id: i } => (EventKind::ScreenColor, EventPayload::Map(vec![id(i)])),
        _ => return None,
    })
}

/// The engine's [`MountSink`]: encodes each commit into the outbox.
struct Sink(Arc<Mutex<Outbox>>);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let started = nsh_core::time::now();
        let mut outbox = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let outbox = &mut *outbox;
        // Each item is encoded and serialized once.
        let mut json = String::with_capacity(batch.items.len() * 48);
        let mut deduped = 0;
        let mut released = Vec::new();
        let mut images = Vec::new();
        for item in &batch.items {
            outbox.anim.apply(item);
            outbox.routes.apply(item);
            if let Some((id, now)) = in_memory(item) {
                released.extend(outbox.sent.show(id, now, &mut images));
            }
            if let Some(answer) = answer(item) {
                outbox.answers.push(answer);
            }
            match encode::item(item) {
                Some(op) => {
                    let text = op.to_string();
                    let code = op[0].as_str().unwrap_or_default();
                    let id = op[1].as_u64().unwrap_or_default() as u32;
                    if outbox.sent.changes(code, id, &text) {
                        push(&mut json, &text);
                    } else {
                        deduped += 1;
                    }
                }
                None if !encode::shown(item) => skipped(item),
                None => {}
            }
        }
        stats::count(stats::DEDUPED, f64::from(deduped));
        // Bound properties follow the styles just set.
        for op in outbox.anim.outputs() {
            push(&mut json, &op.to_string());
        }
        outbox.routes.end_batch();
        // Released after the batch's ops, which no longer show them: only
        // what no view shows at the batch's end (a view may have taken an
        // image another let go of), once each.
        for uri in released {
            if !outbox.sent.images.contains_key(&uri) && outbox.sent.on_page.remove(&uri) {
                push(&mut json, &serde_json::json!(["ir", &*uri]).to_string());
            }
        }
        if !json.is_empty() || !images.is_empty() {
            json.insert(0, '[');
            json.push(']');
            outbox.batches.push(Batch { json, images });
        }
        stats::add(stats::ENCODE, started);
    }

    fn request_frame(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).frame = true;
    }

    fn report_error(&self, message: &str) {
        log::error!("{message}");
        let mut outbox = self.0.lock().unwrap_or_else(|e| e.into_inner());
        outbox.errors.push(message.to_owned());
    }
}

/// Appends one serialized operation to a batch being built.
fn push(json: &mut String, op: &str) {
    if !json.is_empty() {
        json.push(',');
    }
    json.push_str(op);
}

/// Logs each kind of mount item this platform does not show yet, once:
/// what an app uses that the TV leaves out (the README's "Not done").
fn skipped(item: &nsh_core::MountItem) {
    use std::sync::OnceLock;
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let debug = format!("{item:?}");
    let mut kind: String = debug
        .split(|c: char| !c.is_alphanumeric())
        .next()
        .unwrap_or_default()
        .to_owned();
    if let nsh_core::MountItem::Command { command, .. } = item {
        let name = format!("{command:?}");
        let name = name
            .split(|c: char| !c.is_alphanumeric())
            .next()
            .unwrap_or_default();
        kind = format!("Command::{name}");
    }
    let mut seen = SEEN
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if seen.insert(kind.clone()) {
        log::warn!("not shown on this platform: MountItem::{kind}");
    }
}

/// One commit for the page.
#[derive(Default)]
pub struct Batch {
    /// Its operations, a JSON array.
    pub json: String,
    /// The in-memory images it shows that the page lacks, by URI: handed
    /// over right before its operations (a later batch's may need bytes an
    /// earlier one released).
    pub images: Vec<(String, ImageData)>,
}

impl Batch {
    fn ops(json: String) -> Batch {
        Batch {
            json,
            images: Vec::new(),
        }
    }
}

/// What a pump leaves for the page to do.
#[derive(Default)]
pub struct Pumped {
    /// The commits it made, in order.
    pub batches: Vec<Batch>,
    /// Call [`Runtime::frame`] at the next display frame.
    pub frame: bool,
    /// Pump again in this many milliseconds (`None`: only on input).
    pub next: Option<f64>,
    /// Errors of the app to show.
    pub errors: Vec<String>,
}

/// Rounds of a pump that report what it produced (finished animations,
/// focus transitions, answers) back to the engine before returning.
const PUMP_ROUNDS: usize = 4;

/// One running app: the engine, its input and what it committed.
pub struct Runtime<M: Measure + 'static> {
    engine: LocalEngine<TizenTextEngine<M>>,
    control: EngineControl,
    outbox: Arc<Mutex<Outbox>>,
    /// The last key transition's capture decision.
    captured: bool,
}

impl<M: Measure + 'static> Runtime<M> {
    /// Starts `root` with `ui_sets` (`nsh/base` and the app's) on `device`,
    /// measuring text with `measure`; `None` if the app could not start
    /// (the reason is in the log).
    pub fn start(root: Root, ui_sets: Vec<Registry>, device: Device, measure: M) -> Option<Self> {
        let outbox = Arc::new(Mutex::new(Outbox::default()));
        let config = EngineConfig {
            viewport: Size::new(Points(device.width), Points(device.height)),
            environment: device.environment(),
            // A TV page has no system header: a screen's `header` slot
            // sits at its top.
            header_heights: nsh_core::NO_NATIVE_HEADER,
            ui_sets,
            ..EngineConfig::new(App::Rust(root))
        };
        let engine =
            LocalEngine::start(config, TizenTextEngine::new(measure), Sink(outbox.clone()))?;
        let control = engine.control();
        Some(Runtime {
            engine,
            control,
            outbox,
            captured: false,
        })
    }

    /// Calls `wake` when the engine has work outside a pump (a task a host
    /// callback woke, or what a pump's bound left): the host pumps soon
    /// ([`LocalEngine::set_wake`]).
    pub fn set_wake(&mut self, wake: Arc<dyn Fn() + Send + Sync>) {
        self.engine.set_wake(wake);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Outbox> {
        self.outbox.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs what is due and returns what the commits made. What the
    /// commits produced for the engine itself (finished animations, focus
    /// transitions, answers to requests) goes back to it and is run in the
    /// same call, so an `on_finish` or `on_focus` does not wait for the
    /// next input.
    pub fn pump(&mut self) -> Pumped {
        let started = nsh_core::time::now();
        let mut deadline = self.engine.pump();
        for _ in 1..PUMP_ROUNDS {
            if !self.report_back() {
                break;
            }
            deadline = self.engine.pump();
        }
        stats::add(stats::PUMP, started);
        let mut outbox = self.lock();
        let animating = outbox.anim.animating();
        // What the last round produced waits for a pump at once, not for
        // the next input.
        let left = outbox.anim.has_finished()
            || !outbox.routes.transitions.is_empty()
            || !outbox.answers.is_empty();
        let next = deadline.map(|at| {
            at.saturating_duration_since(nsh_core::time::Instant::now())
                .as_secs_f64()
                * 1000.0
        });
        Pumped {
            batches: std::mem::take(&mut outbox.batches),
            frame: std::mem::take(&mut outbox.frame) || animating,
            next: if left { Some(0.0) } else { next },
            errors: std::mem::take(&mut outbox.errors),
        }
    }

    /// Sends the engine what the last commits produced for it; false if
    /// there was nothing.
    fn report_back(&mut self) -> bool {
        let mut outbox = self.lock();
        let finished = outbox.anim.finished();
        let transitions = std::mem::take(&mut outbox.routes.transitions);
        let answers = std::mem::take(&mut outbox.answers);
        drop(outbox);
        let any = !finished.is_empty() || !transitions.is_empty() || !answers.is_empty();
        if !finished.is_empty() {
            self.control.animations_finished(finished);
        }
        self.transitions(transitions);
        for (kind, payload) in answers {
            self.control
                .dispatch_event(nsh_core::ROOT_ID, kind, payload);
        }
        any
    }

    /// Reports focus transitions in order, each with its focused state
    /// (always reported: the core tracks FOCUSED for every view).
    fn transitions(&self, transitions: Vec<(u32, bool)>) {
        for (id, on) in transitions {
            let kind = if on {
                EventKind::Focus
            } else {
                EventKind::Blur
            };
            self.control.dispatch_event(id, kind, EventPayload::None);
            self.control.set_states(id, route::Routes::states(on));
        }
    }

    /// A display frame (asked for with [`Pumped::frame`]).
    pub fn frame(&mut self) -> Pumped {
        {
            let mut outbox = self.lock();
            if outbox.anim.animating() {
                outbox.anim.tick();
                let ops = outbox.anim.outputs();
                if !ops.is_empty() {
                    outbox
                        .batches
                        .push(Batch::ops(Value::Array(ops).to_string()));
                }
            }
        }
        self.control.frame();
        self.pump()
    }

    /// The user's finger on view `id`: `kind` is `onPress`, `onPressIn`,
    /// `onPressOut` or `onLongPress` ([`EventKind::from_prop`]).
    pub fn event(&mut self, id: u32, kind: &str) -> Pumped {
        if let Some(kind) = EventKind::from_prop(kind) {
            self.control.dispatch_event(id, kind, EventPayload::None);
        } else {
            log::warn!("unknown event {kind}");
        }
        self.pump()
    }

    /// Input `id` reported `kind` (`onChangeText`, `onSubmitEditing`) with
    /// its whole `text`, after its `count`th edit by the user.
    pub fn text(&mut self, id: u32, kind: &str, text: String, count: u32) -> Pumped {
        match EventKind::from_prop(kind) {
            Some(kind) => self
                .control
                .dispatch_event(id, kind, EventPayload::Text { text, count }),
            None => log::warn!("unknown event {kind}"),
        }
        self.pump()
    }

    /// The interaction states of view `id` the core tracks
    /// ([`nsh_core::MountItem::TrackStates`], `nsh_core::tailwind::state`
    /// bits): pressed, focused.
    pub fn states(&mut self, id: u32, states: u16) -> Pumped {
        self.control.set_states(id, states);
        self.pump()
    }

    /// Scroll view `id` is at `(x, y)`.
    pub fn scroll(&mut self, id: u32, x: f32, y: f32) -> Pumped {
        let offset = point(Points(x), Points(y));
        {
            let mut outbox = self.lock();
            if outbox.anim.scrolled(id, offset) {
                let ops = outbox.anim.outputs();
                if !ops.is_empty() {
                    outbox
                        .batches
                        .push(Batch::ops(Value::Array(ops).to_string()));
                }
            }
        }
        self.control.scroll(id, offset, 0);
        self.pump()
    }

    /// A key went down or up on view `id`: `key` and `code` as the DOM
    /// spells them. The core routes it to `id` and its listening ancestors.
    pub fn key(&mut self, id: u32, key: &str, code: &str, down: bool, repeat: bool) -> Pumped {
        self.settle();
        self.send_key(id, key, code, down, repeat);
        self.pump()
    }

    /// Whether the app's `captureKeys` took the last key transition sent
    /// ([`nsh_core::KeyEvent::default_prevented`]).
    pub fn key_captured(&self) -> bool {
        self.captured
    }

    /// Runs what the last pumps left for the engine (focus transitions,
    /// finished animations, answers) before input that depends on it: a
    /// key after a focus change goes where the focus is now.
    fn settle(&mut self) {
        for _ in 0..PUMP_ROUNDS {
            if !self.report_back() {
                break;
            }
            self.engine.pump();
        }
    }

    /// Hands one key transition to the engine without pumping; true when
    /// the app's `captureKeys` took it.
    fn send_key(&mut self, id: u32, key: &str, code: &str, down: bool, repeat: bool) -> bool {
        let mut event = nsh_core::keyboard::KeyEvent::default();
        event.key = key.to_owned().into();
        event.code = code.to_owned().into();
        event.repeat = repeat;
        let kind = if down {
            EventKind::KeyDown
        } else {
            EventKind::KeyUp
        };
        // The engine's own entry for a key (`#[doc(hidden)]` in NSH; its web
        // backend uses it too): it sets `default_prevented` from the
        // mounted `captureKeys` rules (the page cannot wait for that
        // decision, so it prevents the default of every remote key).
        self.captured =
            self.engine
                .key_event(id, kind, EventPayload::Key(event), keys::stroke(key));
        self.captured
    }

    /// The view a key would go to now ([`route`]): the focused view while
    /// attached, else an open modal's content, else the root.
    pub fn key_target(&self) -> u32 {
        self.lock().routes.target()
    }

    /// A remote key with Samsung's code `key_code`, which the browser
    /// reported as `dom_key` / `dom_code`, with the DOM's name for it
    /// ([`keys::key_name`]). `id` 0 lets the platform choose its view
    /// ([`Runtime::key_target`]); the page names one only for the input
    /// being edited. OK on a focused view that takes presses is a key
    /// there and, when the app's `captureKeys` did not take it, presses it.
    /// Repeats go where keys go now; the release to the views the last
    /// down reached ([`route`]).
    pub fn remote_key(
        &mut self,
        id: u32,
        key_code: u32,
        dom_key: &str,
        dom_code: &str,
        down: bool,
        repeat: bool,
    ) -> Pumped {
        let key = keys::key_name(key_code, dom_key).to_owned();
        self.settle();
        let route = self
            .lock()
            .routes
            .route(key_code, key == "Enter", down, repeat, id);
        match route {
            route::Route::Key(target) => {
                self.send_key(target, &key, dom_code, down, repeat);
            }
            route::Route::Press(target) => {
                let captured = self.send_key(target, &key, dom_code, down, repeat);
                // The press is OK's default: only when nothing took the key.
                if down && !repeat && !captured {
                    self.control
                        .dispatch_event(target, EventKind::Press, EventPayload::None);
                }
            }
            route::Route::Drop => {}
        }
        self.pump()
    }

    /// Native component `id` emitted `name` with `data`.
    pub fn native_event(&mut self, id: u32, name: &str, data: Value) -> Pumped {
        self.control.dispatch_event(
            id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: name.into(),
                data,
            },
        );
        self.pump()
    }

    /// Input `id` took the DOM focus or lost it. An input taking it takes
    /// it from the focused view.
    pub fn focus(&mut self, id: u32, focused: bool) -> Pumped {
        if focused {
            // The view's Blur comes before the input's Focus.
            let transitions = {
                let mut outbox = self.lock();
                outbox.routes.input_focused(id);
                std::mem::take(&mut outbox.routes.transitions)
            };
            self.transitions(transitions);
        } else if !self.lock().routes.input_blurred(id) {
            // A view took the focus from it: its Blur went first already.
            return self.pump();
        }
        let kind = if focused {
            EventKind::Focus
        } else {
            EventKind::Blur
        };
        self.control.dispatch_event(id, kind, EventPayload::None);
        self.pump()
    }

    /// Image `id` loaded (`Ok`: its size in pixels) or failed.
    pub fn image(&mut self, id: u32, result: Result<(i32, i32), String>) -> Pumped {
        match result {
            Ok((width, height)) => self.control.dispatch_event(
                id,
                EventKind::Load,
                EventPayload::Image(Size::new(DevicePixels(width), DevicePixels(height))),
            ),
            Err(message) => {
                self.control
                    .dispatch_event(id, EventKind::Error, EventPayload::Error { message })
            }
        }
        self.control
            .dispatch_event(id, EventKind::LoadEnd, EventPayload::None);
        self.pump()
    }

    /// Fonts finished loading on the host: text measured before is
    /// measured again.
    pub fn fonts_changed(&mut self) -> Pumped {
        self.control.fonts_changed();
        self.pump()
    }

    /// The page changed size or appearance.
    pub fn set_device(&mut self, device: Device) -> Pumped {
        self.control
            .resize(Size::new(Points(device.width), Points(device.height)));
        self.control.set_environment(device.environment());
        self.pump()
    }
}

/// Makes the runner a Tizen runtime of a Rust app: `$sets` are
/// its UI sets (`nsh/base` and the app's, a `Vec<Registry>`) and `$root`
/// its root (a [`Root`]), as NSH's generated crate `nsh_rust_app` gives
/// them:
///
/// ```ignore
/// nsh_platform_tizen::app!(nsh_rust_app::app_ui_sets(), nsh_rust_app::root());
/// ```
///
/// `app_ui_sets()` rather than `ui_sets()`: this platform runs no TSX, so
/// only the base components the app's code uses are linked (module size
/// is launch time on a TV).
#[macro_export]
macro_rules! app {
    ($sets:expr, $root:expr) => {
        /// Registers the app (the runtime calls it before starting).
        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn nsh_tz_init() {
            $crate::ffi::set_app(|| ($sets, $root));
        }
    };
}

#[cfg(test)]
mod tests {
    use nsh_core::prelude::*;

    use super::*;
    use crate::text::ApproxMeasure;

    #[component]
    fn Counter() -> impl IntoElement {
        let count = signal(0);
        view()
            .test_id("button")
            .bg(rgb(0x2563eb))
            .on_press(move || count.update(|n| *n += 1))
            .child(text(move || format!("Count {}", count.get())))
    }

    /// The text ops' runs, in order.
    fn texts(pumped: &Pumped) -> Vec<String> {
        ops(pumped)
            .into_iter()
            .filter(|op| op[0] == "t")
            .flat_map(|op| {
                op[2]["runs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| l[0].as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn an_app_renders_and_answers_presses() {
        let mut runtime = Runtime::start(
            Root::of::<Counter>(),
            Vec::new(),
            Device::default(),
            ApproxMeasure,
        )
        .unwrap();
        let first = runtime.pump();
        assert_eq!(texts(&first), ["Count 0"]);
        let ops: Vec<Value> = ops(&first);
        // The button reports presses, and has its background.
        let button = ops
            .iter()
            .find(|op| op[0] == "e" && op[2].as_u64().unwrap() & 1 == 1)
            .map(|op| op[1].as_u64().unwrap() as u32)
            .expect("a view reporting presses");
        assert!(ops.iter().any(|op| op[0] == "s"
            && op[1] == button
            && op[2] == "background-color:rgb(37,99,235);"));
        let pressed = runtime.event(button, "onPress");
        assert_eq!(texts(&pressed), ["Count 1"]);
    }

    /// Every operation of a pump, in order.
    fn ops(pumped: &Pumped) -> Vec<Value> {
        pumped
            .batches
            .iter()
            .flat_map(|b| {
                serde_json::from_str::<Value>(&b.json)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .clone()
            })
            .collect()
    }

    /// The first operation `code` on any view, and its view.
    fn find<'a>(ops: &'a [Value], code: &str) -> (&'a Value, u32) {
        let op = ops
            .iter()
            .find(|op| op[0] == code)
            .unwrap_or_else(|| panic!("no {code} in {ops:?}"));
        (op, op[1].as_u64().unwrap() as u32)
    }

    fn start(root: Root) -> (Runtime<ApproxMeasure>, Vec<Value>) {
        let mut runtime =
            Runtime::start(root, Vec::new(), Device::default(), ApproxMeasure).unwrap();
        let first = ops(&runtime.pump());
        (runtime, first)
    }

    #[component]
    fn Player() -> impl IntoElement {
        let state = signal(String::from("none"));
        let paused = signal(false);
        view()
            .on_key_down(move |e: &KeyEvent| {
                if &*e.key == "MediaPlayPause" {
                    paused.update(|p| *p = !*p);
                }
            })
            .child(
                native("test.player")
                    .w(px(320.0))
                    .h(px(180.0))
                    .prop(
                        "source",
                        serde_json::json!({ "url": "https://x.test/a.m3u8", "token": 7 }),
                    )
                    .prop("paused", move || serde_json::json!(paused.get()))
                    .on_native_event(move |e: &NativeEvent| {
                        state.set(format!(
                            "{} {}",
                            e.name,
                            e.data["state"].as_str().unwrap_or("?")
                        ))
                    }),
            )
            .child(text(move || state.get()))
    }

    #[test]
    fn native_components_get_their_props_and_report_events() {
        let (mut runtime, first) = start(Root::of::<Player>());
        let (create, id) = first
            .iter()
            .find(|op| op[0] == "c" && op[2] == "native")
            .map(|op| (op, op[1].as_u64().unwrap() as u32))
            .expect("a native container");
        assert_eq!(create[2], "native");
        assert!(
            first
                .iter()
                .any(|op| op[0] == "n" && op[1] == id && op[2] == "test.player")
        );
        let props = first
            .iter()
            .find(|op| op[0] == "np" && op[1] == id)
            .unwrap();
        assert_eq!(props[2]["source"]["token"], 7);
        assert_eq!(props[2]["paused"], false);
        assert!(
            first
                .iter()
                .any(|op| op[0] == "f" && op[1] == id && op[4] == 320.0)
        );
        // A prop that changes is sent alone.
        let toggled = ops(&runtime.remote_key(0, 10252, "", "", true, false));
        let props = toggled.iter().find(|op| op[0] == "np").unwrap();
        assert_eq!(props[2], serde_json::json!({ "paused": true }));
        // Its events reach the app.
        let event = runtime.native_event(id, "state", serde_json::json!({ "state": "playing" }));
        assert_eq!(texts(&event), ["state playing"]);
    }

    #[component]
    fn Search() -> impl IntoElement {
        let query = signal(String::new());
        let submitted = signal(String::new());
        let focus = element_ref();
        view()
            .on_key_down(move |e: &KeyEvent| {
                if &*e.key == "ColorF0Red" {
                    focus.focus();
                }
            })
            .child(
                nsh_core::element::input()
                    .element_ref(&focus)
                    .w(px(400.0))
                    .h(px(48.0))
                    .placeholder("Search")
                    .value(move || query.get())
                    .on_change(move |t: &str| query.set(t.to_owned()))
                    .on_submit(move |t: &str| submitted.set(t.to_owned())),
            )
            .child(text(move || format!("{}|{}", query.get(), submitted.get())))
    }

    #[test]
    fn inputs_focus_take_the_users_text_and_submit() {
        let (mut runtime, first) = start(Root::of::<Search>());
        let (config, input) = find(&first, "in");
        assert_eq!(config[2]["ph"], "Search");
        assert_eq!(config[2]["type"], "text");
        assert_eq!(config[2]["submit"], "blur");
        assert!(first.iter().any(|op| op[0] == "ic" && op[1] == input));
        // Red focuses it: the page gets the command.
        let red = ops(&runtime.remote_key(0, 403, "", "", true, false));
        assert!(
            red.iter()
                .any(|op| *op == serde_json::json!(["fo", input, true])),
            "{red:?}"
        );
        runtime.focus(input, true);
        let typed = runtime.text(input, "onChangeText", "news".into(), 1);
        assert_eq!(texts(&typed), ["news|"]);
        let submitted = runtime.text(input, "onSubmitEditing", "news".into(), 1);
        assert_eq!(texts(&submitted), ["news|news"]);
    }

    #[component]
    fn Logo() -> impl IntoElement {
        let status = signal(String::from("loading"));
        view()
            .child(
                image("asset:/logo.png")
                    .w(px(64.0))
                    .h(px(64.0))
                    .on_load(move |s: &Size<DevicePixels>| {
                        status.set(format!("{}x{}", s.width.0, s.height.0))
                    })
                    .on_error(move |m: &str| status.set(format!("error {m}"))),
            )
            .child(text(move || status.get()))
    }

    #[test]
    fn images_load_from_the_package_and_report() {
        let (mut runtime, first) = start(Root::of::<Logo>());
        let (op, id) = find(&first, "im");
        assert_eq!(op[2], "assets/logo.png");
        assert_eq!(op[3], "cover");
        let events = first.iter().find(|op| op[0] == "e" && op[1] == id).unwrap();
        let bits = events[2].as_u64().unwrap() as u32;
        assert_ne!(bits & encode::events::LOAD, 0);
        assert_ne!(bits & encode::events::ERROR, 0);
        assert_eq!(texts(&runtime.image(id, Ok((128, 96)))), ["128x96"]);
        assert_eq!(texts(&runtime.image(id, Err("404".into()))), ["error 404"]);
    }

    #[test]
    fn unchanged_styles_and_texts_are_not_sent_again() {
        let mut sent = Sent::default();
        let style = r#"["s",4,"opacity:0.5;"]"#;
        assert!(sent.changes("s", 4, style));
        assert!(!sent.changes("s", 4, style));
        assert!(sent.changes("s", 4, r#"["s",4,""]"#));
        let text = r#"["t",4,{"runs":[["a",0,0,10,0]]}]"#;
        assert!(sent.changes("t", 4, text));
        assert!(!sent.changes("t", 4, text));
        // A view made again under the same id gets everything.
        assert!(sent.changes("d", 4, r#"["d",4]"#));
        assert!(sent.changes("t", 4, text));
    }

    #[component]
    fn Toggle() -> impl IntoElement {
        let shown = signal(true);
        view()
            .on_key_down(move |_: &KeyEvent| shown.update(|s| *s = !*s))
            .child(nsh_core::element::dynamic(move || {
                shown.get().then(|| {
                    view()
                        .bg(rgb(0x123456))
                        .rounded(px(4.0))
                        .child(text("again").text_color(rgb(0xabcdef)))
                })
            }))
    }

    /// Through the engine: a view made again gets its style and text again
    /// (the cache forgets a deleted view), exactly as the first time.
    #[test]
    fn a_view_made_again_gets_its_style_and_text() {
        let (mut runtime, first) = start(Root::of::<Toggle>());
        let styled = |ops: &[Value]| {
            let mut v: Vec<String> = ops
                .iter()
                .filter(|op| op[0] == "t" || (op[0] == "s" && op[2] != ""))
                .map(|op| format!("{} {}", op[0], op[2]))
                .collect();
            v.sort();
            v
        };
        let before = styled(&first);
        assert_eq!(before.len(), 2, "{before:?}");
        let gone = ops(&runtime.remote_key(0, 13, "", "", true, false));
        assert!(gone.iter().any(|op| op[0] == "d"));
        runtime.remote_key(0, 13, "", "", false, false);
        let again = ops(&runtime.remote_key(0, 13, "", "", true, false));
        assert_eq!(styled(&again), before);
    }

    /// A registered font: family, weight, italic, file size.
    type Registered = (String, u16, bool, usize);

    #[derive(Default, Clone)]
    struct Fonts(std::rc::Rc<std::cell::RefCell<Vec<Registered>>>);

    impl Measure for Fonts {
        fn width(&self, font: &str, text: &str) -> f32 {
            ApproxMeasure.width(font, text)
        }

        fn register_font(&self, face: &font::Face, data: &[u8]) -> Result<(), String> {
            self.0
                .borrow_mut()
                .push((face.family.clone(), face.weight, face.italic, data.len()));
            Ok(())
        }
    }

    #[test]
    fn an_apps_fonts_reach_the_host() {
        let fonts = Fonts::default();
        let file = font::tests::font("Guide Sans", 600, false);
        let root = Root::of::<Counter>().font(file.clone());
        let mut runtime =
            Runtime::start(root, Vec::new(), Device::default(), fonts.clone()).unwrap();
        runtime.pump();
        assert_eq!(
            *fonts.0.borrow(),
            [("Guide Sans".to_owned(), 600, false, file.len())]
        );
        runtime.fonts_changed();
    }

    #[component]
    fn Masked() -> impl IntoElement {
        let masked = signal(true);
        let multiline = signal(true);
        view()
            .on_key_down(move |e: &KeyEvent| match &*e.key {
                "1" => masked.update(|m| *m = !*m),
                "2" => multiline.update(|m| *m = !*m),
                _ => {}
            })
            .child(
                nsh_core::element::input()
                    .w(px(300.0))
                    .h(px(80.0))
                    .masked(move || masked.get())
                    .multiline(move || multiline.get()),
            )
    }

    #[test]
    fn a_masked_input_is_never_a_textarea() {
        let (mut runtime, first) = start(Root::of::<Masked>());
        let config = |ops: &[Value]| {
            let (op, _) = find(ops, "in");
            (op[2]["type"].clone(), op[2]["ml"].clone())
        };
        assert_eq!(
            config(&first),
            (serde_json::json!("password"), serde_json::json!(false))
        );
        // Unmasked: the multiline field it asks for.
        let shown = ops(&runtime.remote_key(0, 49, "1", "Digit1", true, false));
        assert_eq!(
            config(&shown),
            (serde_json::json!("text"), serde_json::json!(true))
        );
        let one_line = ops(&runtime.remote_key(0, 50, "2", "Digit2", true, false));
        assert_eq!(
            config(&one_line),
            (serde_json::json!("text"), serde_json::json!(false))
        );
        let masked = ops(&runtime.remote_key(0, 49, "1", "Digit1", true, false));
        assert_eq!(
            config(&masked),
            (serde_json::json!("password"), serde_json::json!(false))
        );
        let both = ops(&runtime.remote_key(0, 50, "2", "Digit2", true, false));
        assert_eq!(
            config(&both),
            (serde_json::json!("password"), serde_json::json!(false))
        );
    }

    #[test]
    fn commands_and_prop_removals_encode() {
        use nsh_core::Command as C;
        let command =
            |command| encode::item(&nsh_core::MountItem::Command { id: 7, command }).unwrap();
        assert_eq!(command(C::Blur), serde_json::json!(["fo", 7, false]));
        assert_eq!(command(C::ExitApp), serde_json::json!(["x", 7]));
        assert_eq!(
            command(C::ScrollTo {
                x: Points(1.0),
                y: Points(2.5),
                animated: true
            }),
            serde_json::json!(["st", 7, 1.0, 2.5, true])
        );
        assert_eq!(
            command(C::Native {
                name: "seek".into(),
                args: serde_json::json!({ "ms": 5 })
            }),
            serde_json::json!(["nc", 7, "seek", { "ms": 5 }])
        );
        let props = encode::item(&nsh_core::MountItem::ComponentProps {
            id: 7,
            props: vec![("source".into(), Some(Value::Null)), ("seek".into(), None)],
        })
        .unwrap();
        assert_eq!(
            props,
            serde_json::json!(["np", 7, { "source": null }, ["seek"]])
        );
    }

    #[component]
    fn Pictures() -> impl IntoElement {
        let shown = signal(true);
        // A 1×1 PNG, in memory.
        const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const SVG: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
        view()
            .on_key_down(move |_: &KeyEvent| shown.update(|s| *s = !*s))
            .child(nsh_core::element::dynamic(move || {
                shown.get().then(|| {
                    view()
                        .child(image(PNG).placeholder(SVG).w(px(10.0)).h(px(10.0)))
                        .child(image(PNG).w(px(10.0)).h(px(10.0)))
                })
            }))
    }

    #[test]
    fn in_memory_images_go_once_with_placeholders_and_are_released() {
        let mut runtime = Runtime::start(
            Root::of::<Pictures>(),
            Vec::new(),
            Device::default(),
            ApproxMeasure,
        )
        .unwrap();
        let first = runtime.pump();
        let uris: Vec<&str> = first
            .batches
            .iter()
            .flat_map(|b| &b.images)
            .map(|(u, _)| u.as_str())
            .collect();
        // The PNG once for both views, and the placeholder's SVG.
        assert_eq!(uris.len(), 2, "{uris:?}");
        assert!(uris.iter().any(|u| u.starts_with("data:image/png")));
        assert!(uris.iter().any(|u| u.starts_with("data:image/svg+xml")));
        let first_ops = ops(&first);
        let shows: Vec<_> = first_ops.iter().filter(|op| op[0] == "im").collect();
        assert!(
            shows
                .iter()
                .all(|op| uris.contains(&op[2].as_str().unwrap()))
        );
        assert!(shows.iter().any(|op| {
            op[4]
                .as_str()
                .is_some_and(|p| p.starts_with("data:image/svg"))
        }));
        // Gone: both released, after the views that showed them.
        let gone = ops(&runtime.remote_key(0, 13, "Enter", "Enter", true, false));
        let released: Vec<usize> = (0..gone.len()).filter(|&i| gone[i][0] == "ir").collect();
        assert_eq!(released.len(), 2, "{gone:?}");
        let last_delete = (0..gone.len()).rfind(|&i| gone[i][0] == "d").unwrap();
        assert!(
            released.iter().all(|&i| i > last_delete),
            "released after the deletes"
        );
        // Back: their bytes go again.
        let back = runtime.remote_key(0, 13, "Enter", "Enter", true, false);
        assert_eq!(
            back.batches.iter().map(|b| b.images.len()).sum::<usize>(),
            2
        );
    }

    const RED: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const BLUE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADAgH/pC5K9QAAAABJRU5ErkJggg==";

    #[component]
    fn Swap() -> impl IntoElement {
        let swapped = signal(false);
        let pick = move |a: bool| if a { RED } else { BLUE };
        view()
            .on_key_down(move |_: &KeyEvent| swapped.update(|s| *s = !*s))
            .child(image(move || pick(!swapped.get())).w(px(10.0)).h(px(10.0)))
            .child(image(move || pick(swapped.get())).w(px(10.0)).h(px(10.0)))
    }

    /// Two views swapping their images in one batch: nothing is released.
    #[test]
    fn a_swap_in_one_batch_releases_nothing() {
        let (mut runtime, _) = start(Root::of::<Swap>());
        let swapped = runtime.remote_key(0, 13, "", "", true, false);
        assert!(
            ops(&swapped).iter().all(|op| op[0] != "ir"),
            "{:?}",
            ops(&swapped)
        );
        assert!(swapped.batches.iter().all(|b| b.images.is_empty()));
    }

    #[component]
    fn Reuse() -> impl IntoElement {
        let shown = signal(true);
        let anchor = element_ref();
        view()
            .on_key_down(move |_: &KeyEvent| {
                shown.set(false);
                anchor.focus();
            })
            .child(
                view()
                    .element_ref(&anchor)
                    .focusable(true)
                    .w(px(10.0))
                    .h(px(10.0))
                    .on_focus(move || shown.set(true)),
            )
            .child(nsh_core::element::dynamic(move || {
                shown.get().then(|| image(RED).w(px(10.0)).h(px(10.0)))
            }))
    }

    /// An image let go of in one batch and shown again in the next of the
    /// same pump: the second batch carries its bytes, after the release.
    #[test]
    fn an_image_released_then_shown_again_has_its_bytes_after_the_release() {
        let (mut runtime, _) = start(Root::of::<Reuse>());
        let pumped = runtime.remote_key(0, 13, "", "", true, false);
        let release = pumped
            .batches
            .iter()
            .position(|b| b.json.contains("\"ir\""))
            .expect("released in one batch");
        let bytes = pumped
            .batches
            .iter()
            .position(|b| !b.images.is_empty())
            .expect("shown again in a later one");
        assert!(
            bytes > release,
            "bytes in batch {bytes}, release in batch {release}"
        );
    }

    #[component]
    fn Ring() -> impl IntoElement {
        let child = element_ref();
        view()
            .on_key_down(move |_: &KeyEvent| child.focus())
            .focus_within(|s| s.bg(rgb(0xff0000)))
            .w(px(100.0))
            .h(px(100.0))
            .child(
                view()
                    .element_ref(&child)
                    .focusable(true)
                    .w(px(10.0))
                    .h(px(10.0)),
            )
    }

    /// A focused view's state is reported whatever it tracks itself: the
    /// core needs it (here for its parent's `focus-within`).
    #[test]
    fn a_focused_view_is_reported_focused() {
        let (mut runtime, _) = start(Root::of::<Ring>());
        let focused = ops(&runtime.remote_key(0, 13, "", "", true, false));
        assert!(
            focused
                .iter()
                .any(|op| op[0] == "s" && op[2].as_str().unwrap().contains("rgb(255,0,0)")),
            "{focused:?}"
        );
    }

    #[component]
    fn Clipboard() -> impl IntoElement {
        let read = signal(String::from("waiting"));
        nsh_core::element::spawn(async move {
            let text = nsh_core::element::clipboard_string().await;
            read.set(format!("read [{text}]"));
        });
        text(move || read.get())
    }

    #[test]
    fn unsupported_requests_are_answered_in_the_same_pump() {
        let (_, first) = start(Root::of::<Clipboard>());
        let texts: Vec<_> = first
            .iter()
            .filter(|op| op[0] == "t")
            .map(|op| op[2]["runs"][0][0].clone())
            .collect();
        assert_eq!(texts.last().unwrap(), "read []", "{texts:?}");
    }

    #[component]
    fn Fade() -> impl IntoElement {
        let done = signal(false);
        let opacity = nsh_core::element::animated_value(0.0);
        let value = opacity;
        nsh_core::element::spawn(async move {
            value
                .timing(1.0, 10.0, nsh_core::animation::Easing::Linear)
                .await;
            done.set(true);
        });
        view()
            .bind_opacity(&opacity)
            .child(text(move || if done.get() { "done" } else { "running" }))
    }

    #[test]
    fn a_finished_animation_reaches_the_app_in_the_same_frame() {
        let (mut runtime, first) = start(Root::of::<Fade>());
        assert!(
            first
                .iter()
                .any(|op| op[0] == "t" && op[2]["runs"][0][0] == "running")
        );
        // The frame that sets the final opacity also shows on_finish's text.
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            let frame = runtime.frame();
            let ops = ops(&frame);
            let ended = ops
                .iter()
                .any(|op| op[0] == "a" && op[2].as_str().is_some_and(|c| c.contains("opacity:1;")));
            let done = texts(&frame).iter().any(|t| t == "done");
            assert!(!done || ended, "done before the end");
            if ended {
                assert!(done, "on_finish ran in the frame that finished it: {ops:?}");
                return;
            }
        }
        panic!("the animation never ended");
    }

    #[component]
    fn Menu() -> impl IntoElement {
        let pressed = signal(String::from("none"));
        let released = signal(0u32);
        let focus = element_ref();
        let other = element_ref();
        view()
            .on_key_down(move |e: &KeyEvent| match &*e.key {
                "ArrowDown" => other.focus(),
                "Enter" => pressed.set("key Enter".into()),
                "1" => focus.focus(),
                _ => {}
            })
            .on_key_up(move |e: &KeyEvent| {
                if &*e.key == "Enter" {
                    released.update(|n| *n += 1);
                }
            })
            .child(
                view()
                    .element_ref(&focus)
                    .focusable(true)
                    .w(px(100.0))
                    .h(px(40.0))
                    .on_press(move || pressed.set("first".into())),
            )
            .child(
                view()
                    .element_ref(&other)
                    .focusable(true)
                    .w(px(100.0))
                    .h(px(40.0))
                    .on_press(move || pressed.set("second".into())),
            )
            .child(text(move || pressed.get()))
            .child(text(move || format!("up {}", released.get())))
    }

    #[test]
    fn ok_right_after_a_move_presses_the_new_focus() {
        let (mut runtime, _) = start(Root::of::<Menu>());
        runtime.remote_key(0, 49, "1", "Digit1", true, false);
        runtime.remote_key(0, 49, "1", "Digit1", false, false);
        // The page sends Down and OK back to back, before it has drawn
        // the move: the platform routes OK by the focus Down just set.
        runtime.remote_key(0, 40, "", "", true, false);
        let ok = runtime.remote_key(0, 13, "", "", true, false);
        assert_eq!(
            texts(&ok),
            ["second"],
            "the press, after the key (nothing captured it)"
        );
        // Its release is the key's release (paired, bubbling), and presses
        // nothing again.
        assert_eq!(
            texts(&runtime.remote_key(0, 13, "", "", false, false)),
            ["up 1"]
        );
        // A release without a press reaches nobody.
        assert!(texts(&runtime.remote_key(0, 13, "", "", false, false)).is_empty());
        runtime.remote_key(0, 40, "", "", false, false);
    }

    #[component]
    fn Captures() -> impl IntoElement {
        let seen = signal(String::from("none"));
        let pressed = signal(false);
        let button = element_ref();
        view()
            .capture_keys(nsh_core::KeyCapture::keys([
                nsh_core::keymap::Keystroke::parse_with("up", false).unwrap(),
                nsh_core::keymap::Keystroke::parse_with("enter", false).unwrap(),
            ]))
            .on_key_down(move |e: &KeyEvent| {
                if &*e.key == "1" {
                    button.focus();
                }
                seen.set(format!("{} {}", e.key, e.default_prevented));
            })
            .child(
                view()
                    .element_ref(&button)
                    .focusable(true)
                    .w(px(10.0))
                    .h(px(10.0))
                    .on_press(move || pressed.set(true)),
            )
            .child(text(move || format!("{} {}", seen.get(), pressed.get())))
    }

    /// The app's `captureKeys` decides `default_prevented`, and OK it
    /// captures presses nothing.
    #[test]
    fn capture_keys_decides_and_keeps_ok_from_pressing() {
        let (mut runtime, _) = start(Root::of::<Captures>());
        assert_eq!(
            texts(&runtime.remote_key(0, 38, "", "", true, false)),
            ["ArrowUp true false"]
        );
        assert!(runtime.key_captured());
        runtime.remote_key(0, 38, "", "", false, false);
        assert_eq!(
            texts(&runtime.remote_key(0, 40, "", "", true, false)),
            ["ArrowDown false false"]
        );
        assert!(!runtime.key_captured());
        runtime.remote_key(0, 40, "", "", false, false);
        runtime.remote_key(0, 49, "1", "", true, false);
        runtime.remote_key(0, 49, "1", "", false, false);
        let ok = runtime.remote_key(0, 13, "", "", true, false);
        assert_eq!(texts(&ok), ["Enter true false"], "captured: no press");
    }

    #[component]
    fn Dialog() -> impl IntoElement {
        let heard = signal(String::new());
        view()
            .on_key_down(move |_: &KeyEvent| heard.update(|h| h.push_str("background ")))
            .child(text(move || heard.get()))
            .child(
                nsh_core::element::modal().child(
                    view()
                        .w(px(100.0))
                        .h(px(100.0))
                        .on_key_down(move |_: &KeyEvent| heard.update(|h| h.push_str("dialog "))),
                ),
            )
    }

    /// With a modal open and nothing focused, its content hears keys first
    /// (then, as on NSH's own backends, its logical ancestors).
    #[test]
    fn an_open_modals_content_hears_keys() {
        let (mut runtime, _) = start(Root::of::<Dialog>());
        let heard = texts(&runtime.remote_key(0, 40, "", "", true, false));
        assert_eq!(heard, ["dialog background"], "{heard:?}");
    }

    #[component]
    fn PingPong() -> impl IntoElement {
        let a = element_ref();
        let b = element_ref();
        view()
            .on_key_down(move |_: &KeyEvent| a.focus())
            .child(
                view()
                    .element_ref(&a)
                    .focusable(true)
                    .w(px(10.0))
                    .h(px(10.0))
                    .on_focus(move || b.focus()),
            )
            .child(
                view()
                    .element_ref(&b)
                    .focusable(true)
                    .w(px(10.0))
                    .h(px(10.0))
                    .on_focus(move || a.focus()),
            )
    }

    /// Work the last report-back round left asks for a pump at once.
    #[test]
    fn work_left_after_the_rounds_pumps_again_at_once() {
        let (mut runtime, _) = start(Root::of::<PingPong>());
        let pumped = runtime.remote_key(0, 40, "", "", true, false);
        assert_eq!(pumped.next, Some(0.0));
    }

    #[component]
    fn Items() -> impl IntoElement {
        let refs = [element_ref(), element_ref(), element_ref(), element_ref()];
        let at = signal(0usize);
        view()
            .on_key_down(move |e: &KeyEvent| {
                if &*e.key == "1" {
                    refs[0].focus();
                }
            })
            .children((0..4).map(move |i| {
                view()
                    .element_ref(&refs[i])
                    .focusable(true)
                    .w(px(10.0))
                    .h(px(10.0))
                    // Each item moves the focus to the next on Down.
                    .on_key_down(move |e: &KeyEvent| {
                        if &*e.key == "ArrowDown" && i + 1 < 4 {
                            refs[i + 1].focus();
                            at.set(i + 1);
                        }
                    })
            }))
            .child(text(move || format!("at {}", at.get())))
    }

    /// Holding Down on items that each move the focus on: every repeat
    /// reaches the item focused now, so the focus walks the list.
    #[test]
    fn a_held_key_walks_items_that_move_the_focus() {
        let (mut runtime, _) = start(Root::of::<Items>());
        runtime.remote_key(0, 49, "1", "", true, false);
        runtime.remote_key(0, 49, "1", "", false, false);
        assert_eq!(
            texts(&runtime.remote_key(0, 40, "", "", true, false)),
            ["at 1"]
        );
        assert_eq!(
            texts(&runtime.remote_key(0, 40, "", "", true, true)),
            ["at 2"]
        );
        assert_eq!(
            texts(&runtime.remote_key(0, 40, "", "", true, true)),
            ["at 3"]
        );
        runtime.remote_key(0, 40, "", "", false, false);
    }

    #[test]
    fn the_platform_reports_its_own_name() {
        let environment = Device::default().environment();
        assert_eq!(environment.platform_name(), "tizen");
        assert_eq!(environment.os, Os::Web);
        assert!(!environment.desktop());
        let android = Device {
            os: Os::Android,
            ..Device::default()
        }
        .environment();
        assert_eq!(android.os.name(), "android");
        assert_eq!(android.platform_name(), "tizen");
    }
}
