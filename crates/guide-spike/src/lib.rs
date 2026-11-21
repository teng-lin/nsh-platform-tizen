//! Spike: a guide over live video like Patina's, written with NSH and
//! `iptv-core`'s guide focus model on its synthetic schedule, rendered on a
//! Samsung TV by `nsh-platform-tizen`. It measures what Patina's real UI
//! would cost there: a header over a transparent video preview, a time
//! ruler, and channel rows whose program cells follow the remote's focus.
//!
//! The rows are a fixed set of slots: moving the focus changes their text,
//! colors and frames, not the tree (as Patina's virtualized grid recycles
//! its rows). Layout is in 1920 × 1080 px, Patina's palette (Blue on Dark).

use iptv_core::guide::{Focus, Move, Program, Schedule, SyntheticSchedule};
use nsh_core::prelude::*;

/// Channel rows on screen.
const ROWS: usize = 9;
/// Program cells per row slot (more than a 2-hour window ever holds).
const CELLS: usize = 8;
const ROW_H: f32 = 66.0;
const GRID_TOP: f32 = 474.0;
const RULER_TOP: f32 = 430.0;
const CHANNEL_W: f32 = 320.0;
const GRID_W: f32 = 1600.0;

// Patina's own palette (crates/iptv-app/src/theme.rs, Blue on Dark).
const WINDOW: u32 = 0x141C21;
const PANEL: u32 = 0x1C2429;
const ALT: u32 = 0x262E33;
const LIGHT: u32 = 0x9CCBEB;
const TEXT: u32 = 0xE3E8EC;
const MUTED: u32 = 0x9AA5AD;
const DARK_TEXT: u32 = 0x101418;

fn schedule() -> SyntheticSchedule {
    SyntheticSchedule
}

/// Guide minutes are minutes of the day here: the synthetic schedule has
/// programs at every minute, and the clock only places the now line.
fn now_minute() -> i32 {
    ((nsh_core::time::unix_ms() / 60_000.0) as i64).rem_euclid(24 * 60) as i32
}

fn clock(minute: i32) -> String {
    let m = minute.rem_euclid(24 * 60);
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn program_line(channel: usize, p: Program) -> String {
    format!("{} – {}  {}", clock(p.start), clock(p.end), schedule().title(channel, p))
}

/// The first row shown, keeping `channel` on screen.
fn follow(first: usize, channel: usize) -> usize {
    if channel < first {
        channel
    } else if channel >= first + ROWS {
        channel + 1 - ROWS
    } else {
        first
    }
}

#[component]
pub fn Guide() -> impl IntoElement {
    let focus = signal(Focus::at(now_minute()));
    let first = signal(0usize);
    let playing = signal(None::<usize>);

    let on_key = move |event: &KeyEvent| {
        let step = match &*event.key {
            "ArrowUp" => Some(Move::Up),
            "ArrowDown" => Some(Move::Down),
            "ArrowLeft" => Some(Move::Left),
            "ArrowRight" => Some(Move::Right),
            _ => None,
        };
        if let Some(step) = step {
            focus.update(|f| f.apply(step, &schedule()));
            let channel = focus.with_untracked(|f| f.channel);
            first.update(|r| *r = follow(*r, channel));
            return;
        }
        match &*event.key {
            "Enter" => {
                let channel = focus.with_untracked(|f| f.channel);
                playing.set(Some(channel));
                nsh_platform_tizen::host(&format!(r#"{{"play":{channel}}}"#));
            }
            "ChannelUp" | "ChannelDown" => {
                let delta: isize = if &*event.key == "ChannelUp" { -1 } else { 1 };
                let count = schedule().channel_count() as isize;
                let from = playing.get_untracked().unwrap_or(0) as isize;
                let to = (from + delta).rem_euclid(count) as usize;
                playing.set(Some(to));
                nsh_platform_tizen::host(&format!(r#"{{"play":{to}}}"#));
            }
            "GoBack" => nsh_platform_tizen::host(r#"{"exit":true}"#),
            _ => {}
        }
    };

    view()
        .test_id("guide")
        .absolute()
        .left(px(0.0))
        .top(px(0.0))
        .w(px(1920.0))
        .h(px(1080.0))
        .on_key_down(on_key)
        .child(header(focus, playing))
        .child(ruler(focus))
        .child(
            view()
                .absolute()
                .left(px(0.0))
                .top(px(GRID_TOP))
                .w(px(1920.0))
                .h(px(ROW_H * ROWS as f32))
                .bg(rgb(WINDOW))
                .children((0..ROWS).map(move |slot| row(slot, focus, first, playing))),
        )
}

/// The focused channel and program over the left of the screen; the right
/// is a transparent frame the TV's video plane shows through.
fn header(focus: Signal<Focus>, playing: Signal<Option<usize>>) -> impl IntoElement {
    let focused = computed(move || {
        let f = focus.get();
        (f.channel, f.program(&schedule()))
    });
    view()
        .absolute()
        .left(px(0.0))
        .top(px(0.0))
        .w(px(1920.0))
        .h(px(RULER_TOP))
        .child(
            view()
                .absolute()
                .left(px(0.0))
                .top(px(0.0))
                .w(px(1160.0))
                .h(px(RULER_TOP))
                .bg(rgb(PANEL))
                .px(px(56.0))
                .pt(px(48.0))
                .child(
                    text(move || schedule().channel_name(focused.get().0))
                        .text_size(px(30.0))
                        .text_color(rgb(LIGHT)),
                )
                .child(
                    text(move || {
                        let (channel, p) = focused.get();
                        schedule().title(channel, p)
                    })
                    .text_size(px(48.0))
                    .text_color(rgb(TEXT))
                    .number_of_lines(1u32),
                )
                .child(
                    text(move || {
                        let (_, p) = focused.get();
                        format!("{} – {}", clock(p.start), clock(p.end))
                    })
                    .text_size(px(28.0))
                    .text_color(rgb(MUTED)),
                )
                .child(
                    text(move || {
                        let (channel, p) = focused.get();
                        format!(
                            "A synthetic program on {}. Patina's guide shows the focused program's \
                             description here, up to three lines, while the preview keeps playing.",
                            schedule().channel_name(channel).to_lowercase(),
                        ) + &" ".repeat((p.start.rem_euclid(3)) as usize)
                    })
                    .text_size(px(26.0))
                    .text_color(rgb(MUTED))
                    .number_of_lines(3u32),
                ),
        )
        .child(
            // The preview: an outline only; AVPlay draws under the page here.
            view()
                .absolute()
                .left(px(1184.0))
                .top(px(32.0))
                .w(px(704.0))
                .h(px(396.0))
                .border_2()
                .border_color(rgb(ALT))
                .child(
                    text(move || match playing.get() {
                        Some(c) => schedule().channel_name(c),
                        None => "OK plays the focused channel here".to_owned(),
                    })
                    .absolute()
                    .left(px(16.0))
                    .top(px(12.0))
                    .text_size(px(22.0))
                    .text_color(rgb(TEXT)),
                ),
        )
}

/// Times across the grid, every half hour of the window, and the now line.
fn ruler(focus: Signal<Focus>) -> impl IntoElement {
    let window = computed(move || focus.with(|f| (f.window, f.visible, f.now)));
    let scale = move || GRID_W / window.get().1.max(1) as f32;
    view()
        .absolute()
        .left(px(0.0))
        .top(px(RULER_TOP))
        .w(px(1920.0))
        .h(px(GRID_TOP - RULER_TOP))
        .bg(rgb(WINDOW))
        .children((0..6).map(move |i| {
            let at = move || {
                let (w, _, _) = window.get();
                (w.div_euclid(30) + i) * 30
            };
            text(move || clock(at()))
                .absolute()
                .top(px(8.0))
                .left(move || px(CHANNEL_W + (at() - window.get().0) as f32 * scale()))
                .text_size(px(24.0))
                .text_color(rgb(MUTED))
        }))
        .child(
            view()
                .absolute()
                .top(px(0.0))
                .w(px(3.0))
                .h(px(1080.0 - RULER_TOP))
                .bg(rgb(LIGHT))
                .left(move || {
                    let (w, _, now) = window.get();
                    px(CHANNEL_W + (now - w) as f32 * scale())
                }),
        )
}

/// Row slot `slot`: the channel `first + slot` with its programs in the window.
fn row(
    slot: usize,
    focus: Signal<Focus>,
    first: Signal<usize>,
    playing: Signal<Option<usize>>,
) -> impl IntoElement {
    let channel = computed(move || first.get() + slot);
    let programs = computed(move || {
        let (window, visible) = focus.with(|f| (f.window, f.visible));
        schedule().programs_between(channel.get(), window, visible)
    });
    let lit = computed(move || focus.with(|f| f.channel) == channel.get());
    let focused_start = computed(move || {
        let f = focus.get();
        (f.channel == channel.get()).then(|| f.program(&schedule()).start)
    });
    view()
        .absolute()
        .left(px(0.0))
        .top(px(slot as f32 * ROW_H))
        .w(px(1920.0))
        .h(px(ROW_H))
        .child(
            view()
                .absolute()
                .left(px(0.0))
                .top(px(0.0))
                .w(px(CHANNEL_W))
                .h(px(ROW_H))
                .bg(move || rgb(if lit.get() { ALT } else { PANEL }))
                .child(
                    text(move || format!("{}", channel.get() + 1))
                        .absolute()
                        .left(px(24.0))
                        .top(px(18.0))
                        .text_size(px(24.0))
                        .text_color(rgb(MUTED)),
                )
                .child(
                    text(move || schedule().channel_name(channel.get()))
                        .absolute()
                        .left(px(96.0))
                        .top(px(16.0))
                        .text_size(px(28.0))
                        .text_color(move || {
                            rgb(if playing.get() == Some(channel.get()) { LIGHT } else { TEXT })
                        }),
                ),
        )
        .children((0..CELLS).map(move |i| cell(i, channel, programs, focus, lit, focused_start)))
}

fn cell(
    i: usize,
    channel: Memo<usize>,
    programs: Memo<Vec<Program>>,
    focus: Signal<Focus>,
    lit: Memo<bool>,
    focused_start: Memo<Option<i32>>,
) -> impl IntoElement {
    let program = move || programs.with(|ps| ps.get(i).copied());
    let geometry = move || {
        let (window, visible) = focus.with(|f| (f.window, f.visible));
        let scale = GRID_W / visible.max(1) as f32;
        program().map_or((0.0, 0.0), |p| {
            let start = p.start.max(window);
            let end = p.end.min(window + visible);
            ((start - window) as f32 * scale, (end - start).max(0) as f32 * scale)
        })
    };
    let focused = move || program().is_some_and(|p| focused_start.get() == Some(p.start));
    view()
        .absolute()
        .top(px(6.0))
        .h(px(ROW_H - 12.0))
        .left(move || px(CHANNEL_W + geometry().0 + 3.0))
        .w(move || px((geometry().1 - 6.0).max(0.0)))
        .opacity(move || if program().is_some() { 1.0_f32 } else { 0.0_f32 })
        .rounded(px(10.0))
        .px(px(14.0))
        .justify_center()
        .overflow_hidden()
        .bg(move || {
            rgb(if focused() {
                LIGHT
            } else if lit.get() {
                0x34414A
            } else {
                PANEL
            })
        })
        .child(
            text(move || match program() {
                Some(p) => program_line(channel.get(), p),
                None => String::new(),
            })
            .number_of_lines(1u32)
            .text_overflow(nsh_core::EllipsizeMode::Tail)
            .text_size(px(24.0))
            .text_color(move || {
                rgb(if focused() {
                    DARK_TEXT
                } else if lit.get() {
                    TEXT
                } else {
                    MUTED
                })
            }),
        )
}

#[cfg(feature = "ballast-core")]
extern crate iptv_web;

/// The UI sets: none, or with the ballast NSH's base components (all of
/// them registered, as an app using `nsh/base` links them).
fn ui_sets() -> Vec<nsh_core::element::Registry> {
    #[cfg(feature = "ballast")]
    return vec![nsh_base::registry()];
    #[cfg(not(feature = "ballast"))]
    Vec::new()
}

nsh_platform_tizen::app!(ui_sets(), nsh_core::element::Root::of::<Guide>());

#[cfg(test)]
mod tests {
    use nsh_platform_tizen::text::ApproxMeasure;
    use nsh_platform_tizen::{Device, Runtime};

    fn ops(pumped: &nsh_platform_tizen::Pumped) -> Vec<serde_json::Value> {
        pumped.batches.iter().flat_map(|b| b.as_array().unwrap().clone()).collect()
    }

    #[test]
    fn renders_and_moves_the_focus_with_few_operations() {
        let mut rt = Runtime::start(
            nsh_core::element::Root::of::<super::Guide>(),
            Vec::new(),
            Device::default(),
            ApproxMeasure,
        )
        .unwrap();
        let first = ops(&rt.pump());
        let listener = first
            .iter()
            .find(|op| op[0] == "e" && op[2].as_u64().unwrap() & 8 == 8)
            .map(|op| op[1].as_u64().unwrap() as u32)
            .expect("the guide listens for keys");
        let created = first.iter().filter(|op| op[0] == "c").count();
        let down = ops(&rt.key(listener, "ArrowDown", "ArrowDown", true, false));
        let right = ops(&rt.key(listener, "ArrowRight", "ArrowRight", true, false));
        eprintln!("first render: {} ops, {} views; Down: {} ops; Right: {} ops", first.len(), created, down.len(), right.len());
        assert!(created > 100);
        assert!(!down.is_empty() && down.len() < 200, "{}", down.len());
    }
}
