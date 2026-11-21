//! The WebAssembly module's interface with `runtime/nsh-tz.js`, the mini
//! program's side. Strings cross as a pointer and a length into this
//! module's memory (UTF-8); JS copies them before a call returns.
//!
//! Exports: `nsh_tz_alloc` / `nsh_tz_free` (memory for strings JS passes),
//! `nsh_tz_init` (the runner's [`crate::app!`]), `nsh_tz_start`,
//! `nsh_tz_pump`, `nsh_tz_frame`, `nsh_tz_event`, `nsh_tz_text`, `nsh_tz_states`,
//! `nsh_tz_scroll`,
//! `nsh_tz_device`. After each, what the engine made arrives through the
//! imports: `submit` per commit, `request_frame`, `schedule` (the next
//! pump, in ms; -1 for none) and `report_error`.
//!
//! Imports, module `nsh_mp`: those, `measure_text` and `log`. NSH's core
//! asks for two more, module `nsh`: `now_ms` (a monotonic clock in ms) and
//! `date_now_ms` (`Date.now()`) (NSH's `docs/dev/platforms.md`).

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
        let w = unsafe { js_measure_text(font.as_ptr(), font.len(), text.as_ptr(), text.len()) as f32 };
        WIDTHS.with(|c| {
            let mut c = c.borrow_mut();
            if c.len() >= MEASURE_CACHE {
                c.clear();
            }
            c.insert(key, w);
        });
        w
    }
}

type MakeApp = Box<dyn Fn() -> (Vec<Registry>, Root)>;

thread_local! {
    static APP: RefCell<Option<MakeApp>> = RefCell::new(None);
    static RUNTIME: RefCell<Option<Runtime<HostMeasure>>> = const { RefCell::new(None) };
}

/// The OS `nsh-tz.js` passes: 0 iOS, 1 Android, 2 macOS, 3 Windows,
/// 4 Linux (`osCode` there).
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

/// A remote key on view `id` (one listening for keys, op `e` bit 8): `key`
/// and `code` (DOM spellings) are UTF-8 strings from [`nsh_tz_alloc`].
///
/// # Safety
///
/// Both strings are memory from [`nsh_tz_alloc`] holding UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_tz_key(
    id: u32,
    key: *const u8,
    key_len: usize,
    code: *const u8,
    code_len: usize,
    down: u32,
    repeat: u32,
) {
    // SAFETY: guaranteed by the caller.
    let (key, code) = unsafe {
        (
            std::slice::from_raw_parts(key, key_len),
            std::slice::from_raw_parts(code, code_len),
        )
    };
    let key = String::from_utf8_lossy(key).into_owned();
    let code = String::from_utf8_lossy(code).into_owned();
    with_runtime(|r| r.key(id, &key, &code, down != 0, repeat != 0));
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
