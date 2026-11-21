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
pub mod canvas;
mod effects;
pub mod encode;
#[cfg(target_arch = "wasm32")]
pub mod ffi;
pub mod font;
pub mod keys;
pub mod text;

/// Where time goes: milliseconds per stage, read and reset by the runtime
/// (`nsh_tz_stat`) for its timing recorder.
pub mod stats {
    use std::cell::Cell;

    /// The engine's pump, including encoding (the sink runs inside it).
    pub const PUMP: usize = 0;
    /// Encoding mount items into operations.
    pub const ENCODE: usize = 1;
    /// Serializing operations to JSON text for the page.
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
            ..Environment::default()
        }
    }
}

/// What the engine hands the page between two pumps.
#[derive(Default)]
struct Outbox {
    /// Each commit's operations ([`encode::batch`]), in order.
    batches: Vec<Value>,
    /// Images whose bytes are in memory, for the page to show by their URI
    /// (before the batches that show them).
    images: Vec<(String, ImageData)>,
    /// The engine asked for a display frame.
    frame: bool,
    /// Errors of the app, as text.
    errors: Vec<String>,
    /// The native animation graph, which the batches drive.
    anim: anim::Anim,
    /// What the page was last given per view, to leave out a style or a
    /// text encoded as the one it has.
    sent: Sent,
}

/// Hashes of the last `s` and `t` operation per view, and the in-memory
/// images the page has.
#[derive(Default)]
struct Sent {
    styles: HashMap<u32, u64>,
    texts: HashMap<u32, u64>,
    images: HashSet<Arc<str>>,
}

fn hash(value: &impl Hash) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut h);
    h.finish()
}

impl Sent {
    /// Whether `op` (an item's operation) changes what the page shows:
    /// false for a style or a text the view already has. The core sends
    /// a style when any of its fields changed, including ones this
    /// platform does not draw, and a text when its layout object is new.
    fn changes(&mut self, op: &Value) -> bool {
        let (Some(code), Some(id)) = (op[0].as_str(), op[1].as_u64()) else {
            return true;
        };
        let id = id as u32;
        let (map, h) = match code {
            "s" => (&mut self.styles, hash(&op[2].as_str())),
            "t" => (&mut self.texts, hash(&op[2].to_string())),
            "d" => {
                self.styles.remove(&id);
                self.texts.remove(&id);
                return true;
            }
            _ => return true,
        };
        map.insert(id, h) != Some(h)
    }
}

/// The engine's [`MountSink`]: encodes each commit into the outbox.
struct Sink(Arc<Mutex<Outbox>>);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let started = nsh_core::time::now();
        let mut outbox = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let outbox = &mut *outbox;
        // Each item is encoded once.
        let mut list = Vec::with_capacity(batch.items.len());
        let mut deduped = 0;
        for item in &batch.items {
            outbox.anim.apply(item);
            if let nsh_core::MountItem::Image {
                source: Some(source),
                ..
            } = item
                && let Some(data) = &source.data
                && outbox.sent.images.insert(source.uri.clone())
            {
                outbox.images.push((source.uri.to_string(), data.clone()));
            }
            match encode::item(item) {
                Some(op) if outbox.sent.changes(&op) => list.push(op),
                Some(_) => deduped += 1,
                None if !encode::shown(item) => skipped(item),
                None => {}
            }
        }
        stats::count(stats::DEDUPED, f64::from(deduped));
        // Bound properties follow the styles just set.
        list.extend(outbox.anim.outputs());
        if !list.is_empty() {
            outbox.batches.push(Value::Array(list));
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

/// What a pump leaves for the page to do.
#[derive(Default)]
pub struct Pumped {
    /// The operations of the commits it made, one array per commit.
    pub batches: Vec<Value>,
    /// Images whose bytes are in memory, by the URI the batches show them
    /// by: the page needs them first.
    pub images: Vec<(String, ImageData)>,
    /// Call [`Runtime::frame`] at the next display frame.
    pub frame: bool,
    /// Pump again in this many milliseconds (`None`: only on input).
    pub next: Option<f64>,
    /// Errors of the app to show.
    pub errors: Vec<String>,
}

/// One running app: the engine, its input and what it committed.
pub struct Runtime<M: Measure + 'static> {
    engine: LocalEngine<TizenTextEngine<M>>,
    control: EngineControl,
    outbox: Arc<Mutex<Outbox>>,
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
        })
    }

    /// Runs what is due and returns what the commits made.
    pub fn pump(&mut self) -> Pumped {
        let started = nsh_core::time::now();
        let deadline = self.engine.pump();
        stats::add(stats::PUMP, started);
        let mut outbox = self.outbox.lock().unwrap_or_else(|e| e.into_inner());
        let finished = outbox.anim.finished();
        if !finished.is_empty() {
            self.control.animations_finished(finished);
        }
        let animating = outbox.anim.animating();
        Pumped {
            batches: std::mem::take(&mut outbox.batches),
            images: std::mem::take(&mut outbox.images),
            frame: std::mem::take(&mut outbox.frame) || animating,
            next: deadline.map(|at| {
                at.saturating_duration_since(nsh_core::time::Instant::now())
                    .as_secs_f64()
                    * 1000.0
            }),
            errors: std::mem::take(&mut outbox.errors),
        }
    }

    /// A display frame (asked for with [`Pumped::frame`]).
    pub fn frame(&mut self) -> Pumped {
        {
            let mut outbox = self.outbox.lock().unwrap_or_else(|e| e.into_inner());
            if outbox.anim.animating() {
                outbox.anim.tick();
                let ops = outbox.anim.outputs();
                if !ops.is_empty() {
                    outbox.batches.push(Value::Array(ops));
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
            let mut outbox = self.outbox.lock().unwrap_or_else(|e| e.into_inner());
            if outbox.anim.scrolled(id, offset) {
                let ops = outbox.anim.outputs();
                if !ops.is_empty() {
                    outbox.batches.push(Value::Array(ops));
                }
            }
        }
        self.control.scroll(id, offset, 0);
        self.pump()
    }

    /// A key went down or up on view `id` (the focused view, or the view
    /// the page sends keys to): `key` and `code` as the DOM spells them.
    /// The core routes it to `id` and its listening ancestors.
    pub fn key(&mut self, id: u32, key: &str, code: &str, down: bool, repeat: bool) -> Pumped {
        let mut event = nsh_core::keyboard::KeyEvent::default();
        event.key = key.to_owned().into();
        event.code = code.to_owned().into();
        event.repeat = repeat;
        let kind = if down {
            EventKind::KeyDown
        } else {
            EventKind::KeyUp
        };
        self.control
            .dispatch_event(id, kind, EventPayload::Key(event));
        self.pump()
    }

    /// A remote key with Samsung's code `key_code`, which the browser
    /// reported as `dom_key` / `dom_code`: [`Runtime::key`] with the DOM's
    /// name for it ([`keys::key_name`]).
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
        self.key(id, &key, dom_code, down, repeat)
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

    /// View `id` (an input, or a focusable view the app focused) took the
    /// focus or lost it.
    pub fn focus(&mut self, id: u32, focused: bool) -> Pumped {
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
/// nsh_platform_tizen::app!(nsh_rust_app::ui_sets(), nsh_rust_app::root());
/// ```
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
        pumped
            .batches
            .iter()
            .flat_map(|b| b.as_array().unwrap().clone())
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
        let ops: Vec<Value> = first
            .batches
            .iter()
            .flat_map(|b| b.as_array().unwrap().clone())
            .collect();
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
            .flat_map(|b| b.as_array().unwrap().clone())
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
        let (_, listener) = find(&first, "e");
        let toggled = ops(&runtime.remote_key(listener, 10252, "", "", true, false));
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
        let listener = first
            .iter()
            .find(|op| op[0] == "e" && op[2].as_u64().unwrap() as u32 & encode::events::KEYS != 0)
            .map(|op| op[1].as_u64().unwrap() as u32)
            .unwrap();
        let red = ops(&runtime.remote_key(listener, 403, "", "", true, false));
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
        let style = serde_json::json!(["s", 4, "opacity:0.5;"]);
        assert!(sent.changes(&style));
        assert!(!sent.changes(&style));
        assert!(sent.changes(&serde_json::json!(["s", 4, ""])));
        let text = serde_json::json!(["t", 4, { "runs": [["a", 0, 0, 10, 0]] }]);
        assert!(sent.changes(&text));
        assert!(!sent.changes(&text));
        // A view made again under the same id gets everything.
        assert!(sent.changes(&serde_json::json!(["d", 4])));
        assert!(sent.changes(&text));
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
