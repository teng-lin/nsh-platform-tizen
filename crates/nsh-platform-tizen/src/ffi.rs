//! The WebAssembly module's interface with the runtime
//! (`runtime/engine.js`, in the Worker). Strings cross as a pointer and a
//! length into this module's memory (UTF-8); JS copies them before a call
//! returns. No 64-bit integer crosses (Tizen 5.5's engine has no BigInt
//! integration): counts and ids are `u32`, times `f64`.
//!
//! Exports: `nsh_tz_alloc` / `nsh_tz_free` (memory for strings JS passes),
//! `nsh_tz_init` (the runner's [`crate::app!`]), `nsh_tz_start`,
//! `nsh_tz_pump`, `nsh_tz_frame`, `nsh_tz_event`, `nsh_tz_text`,
//! `nsh_tz_states`, `nsh_tz_scroll`, `nsh_tz_key`, `nsh_tz_native`,
//! `nsh_tz_focus`, `nsh_tz_image`, `nsh_tz_fonts_loaded`, `nsh_tz_device`,
//! `nsh_tz_stat`. After each, what the engine made arrives through the
//! imports: `image_bytes` per in-memory image, `submit` per commit,
//! `request_frame`, `schedule` (the next pump, in ms; -1 for none) and
//! `report_error`.
//!
//! Imports, module `nsh_tz`: those, `measure_text`, `register_font`,
//! `remote_keys` (the key table, once at start), `log` and `host`. NSH's
//! core asks for two more, module `nsh`: `now_ms` (a monotonic clock in
//! ms) and `date_now_ms` (`Date.now()`) (NSH's `docs/dev/platforms.md`).

use std::cell::RefCell;

use nsh_core::element::{Registry, Root};

use crate::{Device, Pumped, Runtime, text::Measure};

#[link(wasm_import_module = "nsh_tz")]
unsafe extern "C" {
    #[link_name = "submit"]
    fn js_submit(json: *const u8, len: usize);
    #[link_name = "request_frame"]
    fn js_request_frame();
    #[link_name = "schedule"]
    fn js_schedule(delay_ms: f64);
    #[link_name = "report_error"]
    fn js_report_error(message: *const u8, len: usize);
    #[link_name = "measure_text"]
    fn js_measure_text(font: *const u8, font_len: usize, text: *const u8, text_len: usize) -> f64;
    #[link_name = "log"]
    fn js_log(level: u32, message: *const u8, len: usize);
    #[link_name = "host"]
    fn js_host(message: *const u8, len: usize);
    #[link_name = "register_font"]
    fn js_register_font(
        family: *const u8,
        family_len: usize,
        data: *const u8,
        data_len: usize,
        weight: u32,
        italic: u32,
    );
    #[link_name = "image_bytes"]
    fn js_image_bytes(uri: *const u8, uri_len: usize, data: *const u8, data_len: usize);
    #[link_name = "remote_keys"]
    fn js_remote_keys(json: *const u8, len: usize);
}

/// Sends `message` (JSON) to the page's own code: what the app asks of the
/// TV beyond drawing (play a stream, exit).
pub fn host(message: &str) {
    // SAFETY: a live string JS only reads during the call.
    unsafe { js_host(message.as_ptr(), message.len()) }
}

/// Measures with the page's canvas (`measure_text`), remembering widths:
/// a guide re-lays the same titles and times on every focus move, and each
/// measurement is a call into JavaScript.
struct HostMeasure;

/// Widths by font and text; cleared when it grows past this many.
const MEASURE_CACHE: usize = 20_000;

thread_local! {
    static WIDTHS: RefCell<std::collections::HashMap<(String, String), f32>> =
        RefCell::new(std::collections::HashMap::new());
}

impl Measure for HostMeasure {
    fn width(&self, font: &str, text: &str) -> f32 {
        let key = (font.to_owned(), text.to_owned());
        if let Some(w) = WIDTHS.with(|c| c.borrow().get(&key).copied()) {
            return w;
        }
        // SAFETY: both ranges are live strings JS only reads during the call.
        let w =
            unsafe { js_measure_text(font.as_ptr(), font.len(), text.as_ptr(), text.len()) as f32 };
        WIDTHS.with(|c| {
            let mut c = c.borrow_mut();
            if c.len() >= MEASURE_CACHE {
                c.clear();
            }
            c.insert(key, w);
        });
        w
    }

    fn register_font(&self, face: &crate::font::Face, data: &[u8]) -> Result<(), String> {
        // SAFETY: live slices JS copies during the call.
        unsafe {
            js_register_font(
                face.family.as_ptr(),
                face.family.len(),
                data.as_ptr(),
                data.len(),
                u32::from(face.weight),
                u32::from(face.italic),
            )
        };
        // Widths measured in the fallback font are stale (and again once
        // the face has loaded: `nsh_tz_fonts_loaded`).
        WIDTHS.with(|c| c.borrow_mut().clear());
        Ok(())
    }
}

type MakeApp = Box<dyn Fn() -> (Vec<Registry>, Root)>;

thread_local! {
    static APP: RefCell<Option<MakeApp>> = RefCell::new(None);
    static RUNTIME: RefCell<Option<Runtime<HostMeasure>>> = const { RefCell::new(None) };
}

/// The OS the runtime passes: 5 (the web) on a TV; 0 iOS, 1 Android,
/// 2 macOS, 3 Windows, 4 Linux for tests of an app's OS props.
fn os_of(code: u32) -> nsh_core::platform::Os {
    use nsh_core::platform::Os;
    match code {
        1 => Os::Android,
        2 => Os::MacOs,
        3 => Os::Windows,
        4 => Os::Linux,
        0 => Os::Ios,
        _ => Os::Web,
    }
}

/// Sets the app [`nsh_tz_start`] starts ([`crate::app!`]).
pub fn set_app(make: impl Fn() -> (Vec<Registry>, Root) + 'static) {
    APP.with(|a| *a.borrow_mut() = Some(Box::new(make)));
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = format!("[{}] {}", record.target(), record.args());
        // SAFETY: a live string JS only reads during the call.
        unsafe { js_log(record.level() as u32, message.as_ptr(), message.len()) };
    }

    fn flush(&self) {}
}

static LOGGER: Logger = Logger;

fn report_error(message: &str) {
    // SAFETY: a live string JS only reads during the call.
    unsafe { js_report_error(message.as_ptr(), message.len()) };
}

/// Hands what a pump made to JS.
fn deliver(pumped: Pumped) {
    for (uri, data) in &pumped.images {
        let bytes = data.bytes();
        // SAFETY: live slices JS copies during the call.
        unsafe { js_image_bytes(uri.as_ptr(), uri.len(), bytes.as_ptr(), bytes.len()) };
    }
    for batch in pumped.batches {
        let started = nsh_core::time::now();
        let json = batch.to_string();
        crate::stats::add(crate::stats::SERIALIZE, started);
        // SAFETY: a live string JS only reads during the call.
        unsafe { js_submit(json.as_ptr(), json.len()) };
    }
    for error in pumped.errors {
        report_error(&error);
    }
    if pumped.frame {
        // SAFETY: a host function without arguments.
        unsafe { js_request_frame() };
    }
    // SAFETY: a host function taking a number.
    unsafe { js_schedule(pumped.next.unwrap_or(-1.0)) };
}

fn with_runtime(f: impl FnOnce(&mut Runtime<HostMeasure>) -> Pumped) {
    let pumped = RUNTIME.with(|r| r.borrow_mut().as_mut().map(f));
    if let Some(pumped) = pumped {
        deliver(pumped);
    }
}

/// `len` bytes of memory for a string JS passes in.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Frees memory from [`nsh_tz_alloc`].
///
/// # Safety
///
/// `ptr` came from `nsh_tz_alloc(len)` and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_tz_free(ptr: *mut u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// Starts the app on a page `width` × `height` px; 1 if it started.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_start(
    width: f32,
    height: f32,
    pixel_ratio: f32,
    dark: u32,
    os: u32,
) -> u32 {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Info);
        std::panic::set_hook(Box::new(|info| {
            report_error(&format!("nsh panicked: {info}"))
        }));
    });
    let Some((sets, root)) = APP.with(|a| a.borrow().as_ref().map(|make| make())) else {
        report_error("this module has no app: its runner calls `nsh_platform_tizen::app!`");
        return 0;
    };
    let device = Device {
        width,
        height,
        pixel_ratio,
        dark: dark != 0,
        os: os_of(os),
    };
    let keys = crate::keys::keys_json();
    // SAFETY: a live string JS only reads during the call.
    unsafe { js_remote_keys(keys.as_ptr(), keys.len()) };
    let Some(runtime) = Runtime::start(root, sets, device, HostMeasure) else {
        return 0;
    };
    RUNTIME.with(|r| *r.borrow_mut() = Some(runtime));
    with_runtime(Runtime::pump);
    1
}

/// Runs what is due (at the time `schedule` asked for, or after input JS
/// handled itself).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_pump() {
    with_runtime(Runtime::pump);
}

/// A display frame (after `request_frame`).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_frame() {
    with_runtime(Runtime::frame);
}

/// An event on view `id`, named by its prop (`onPress`).
///
/// # Safety
///
/// `name..name + len` is memory from [`nsh_tz_alloc`] holding UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_tz_event(id: u32, name: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(name, len) };
    let name = String::from_utf8_lossy(bytes).into_owned();
    with_runtime(|r| r.event(id, &name));
}

/// Input `id` reported event `name` with its whole text, after the user's
/// `count`th edit.
///
/// # Safety
///
/// Both strings are memory from [`nsh_tz_alloc`] holding UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_tz_text(
    id: u32,
    name: *const u8,
    name_len: usize,
    text: *const u8,
    text_len: usize,
    count: u32,
) {
    // SAFETY: guaranteed by the caller.
    let (name, text) = unsafe {
        (
            std::slice::from_raw_parts(name, name_len),
            std::slice::from_raw_parts(text, text_len),
        )
    };
    let name = String::from_utf8_lossy(name).into_owned();
    let text = String::from_utf8_lossy(text).into_owned();
    with_runtime(|r| r.text(id, &name, text, count));
}

/// A remote key on view `id` (the focused view, or the one the page sends
/// keys to): Samsung's `key_code` and the browser's `KeyboardEvent.key` /
/// `.code` (UTF-8 strings from [`nsh_tz_alloc`]); the app gets the DOM's
/// name for it ([`crate::keys`]).
///
/// # Safety
///
/// Both strings are memory from [`nsh_tz_alloc`] holding UTF-8.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn nsh_tz_key(
    id: u32,
    key_code: u32,
    key: *const u8,
    key_len: usize,
    code: *const u8,
    code_len: usize,
    down: u32,
    repeat: u32,
) {
    // SAFETY: guaranteed by the caller.
    let (key, code) = unsafe { (string(key, key_len), string(code, code_len)) };
    with_runtime(|r| r.remote_key(id, key_code, &key, &code, down != 0, repeat != 0));
}

/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_tz_alloc`].
unsafe fn string(ptr: *const u8, len: usize) -> String {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

/// Native component `id` emitted event `name` with `data` (JSON text; an
/// unreadable one arrives as `null`).
///
/// # Safety
///
/// Both strings are memory from [`nsh_tz_alloc`] holding UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_tz_native(
    id: u32,
    name: *const u8,
    name_len: usize,
    data: *const u8,
    data_len: usize,
) {
    // SAFETY: guaranteed by the caller.
    let (name, data) = unsafe { (string(name, name_len), string(data, data_len)) };
    let data = serde_json::from_str(&data).unwrap_or(serde_json::Value::Null);
    with_runtime(|r| r.native_event(id, &name, data));
}

/// View `id` took (`focused` 1) or lost the focus.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_focus(id: u32, focused: u32) {
    with_runtime(|r| r.focus(id, focused != 0));
}

/// Image `id` loaded (`ok` 1, `width` × `height` pixels) or failed with
/// `message` (UTF-8 from [`nsh_tz_alloc`]).
///
/// # Safety
///
/// `message..message + len` is memory from [`nsh_tz_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_tz_image(
    id: u32,
    ok: u32,
    width: u32,
    height: u32,
    message: *const u8,
    len: usize,
) {
    let result = match ok {
        // SAFETY: guaranteed by the caller.
        0 => Err(unsafe { string(message, len) }),
        _ => Ok((width as i32, height as i32)),
    };
    with_runtime(|r| r.image(id, result));
}

/// The fonts the app registered have loaded on the page and in the
/// Worker: widths are measured again.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_fonts_loaded() {
    WIDTHS.with(|c| c.borrow_mut().clear());
    with_runtime(Runtime::fonts_changed);
}

/// Milliseconds spent in `stage` (`crate::stats`) since the last read.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_stat(stage: u32) -> f64 {
    crate::stats::take(stage as usize)
}

/// View `id` shows interaction `states` (`nsh_core::tailwind::state`).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_states(id: u32, states: u32) {
    with_runtime(|r| r.states(id, states as u16));
}

/// Scroll view `id` scrolled to `(x, y)`.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_scroll(id: u32, x: f32, y: f32) {
    with_runtime(|r| r.scroll(id, x, y));
}

/// The page's size or appearance changed.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_tz_device(width: f32, height: f32, pixel_ratio: f32, dark: u32, os: u32) {
    let device = Device {
        width,
        height,
        pixel_ratio,
        dark: dark != 0,
        os: os_of(os),
    };
    with_runtime(|r| r.set_device(device));
}
