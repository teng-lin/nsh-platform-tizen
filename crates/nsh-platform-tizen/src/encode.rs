// Derived from nsh-platform-miniprogram (Copyright 2026 Jason Lee, Apache-2.0); modified.
//! The batches the engine commits, as the operations the page runtime
//! applies (`runtime/renderer.js`): one JSON array per commit, each
//! operation an array led by its code. Everything here is plain Rust over
//! NSH's mount items, so it is tested on the host.
//!
//! | Op | Fields | Meaning |
//! |---|---|---|
//! | `c` | id, kind | create a view (`view`, `text`, `scroll`, `image`, `input`, `native`, ...) |
//! | `i` | parent, child, before | insert `child` below sibling `before` (`null`: on top) |
//! | `r` | id | detach a view, keeping it |
//! | `d` | id | destroy a view |
//! | `f` | id, x, y, width, height | the frame, in the parent (px) |
//! | `s` | id, css | the view's decoration as inline CSS |
//! | `a` | id, css | animated properties ([`crate::anim`]), after the decoration |
//! | `t` | id, text | a text's runs: `{ x, y, styles: [css], runs: [[text, x, y, lineHeight, style]] }` |
//! | `e` | id, events | the events it reports ([`events`]: bits) |
//! | `ts` | id, states | the interaction states it reports (`tailwind::state` bits) |
//! | `vp` | id, focusable, testId | `focusable` (`true`, `false`, `null`) and the test id |
//! | `sc` | id, horizontal | a scroll view's axis |
//! | `ss` | id, width, height | a scroll view's content size |
//! | `sb` / `st` | id, dx, dy / id, x, y, animated | scroll by / to |
//! | `im` | id, src, fit, placeholder, blur, position, tint | an image: `src` (`null`: none), CSS `object-fit`, placeholder `src`, blur px, CSS `object-position`, and for an `svg()` the color its `currentColor` paints (drawn as a mask of that color; `null` otherwise) |
//! | `in` | id, config | an input's configuration ([`input`]) |
//! | `iv` | id, text, count | an input's text, set by the app after the user's `count`th edit |
//! | `ic` | id, x, y, width, height | where an input's text goes |
//! | `fo` | id, focus | focus (`true`) or blur an input or a focusable view |
//! | `n` | id, name | create the registered native component `name` in a `native` view |
//! | `np` | id, props, removed | its changed props `{ name: value }` (a value may be `null`) and the names of those removed |
//! | `nc` | id, name, args | a command to it (`ElementRef::command`) |
//! | `x` | id | leave the app (`Command::ExitApp`) |
//! | `ir` | uri | no view shows the in-memory image `uri` any more: release its blob |
//!
//! Canvases are not drawn yet: [`crate::canvas`] encodes a drawing, but
//! the page has no interpreter for it, so `Canvas` items count as not
//! shown.
//!
//! Items this platform does not show yet are left out ([`shown`] says
//! which; the README's "Not done").

use std::fmt::Write as _;

use nsh_core::{BorderStyle, Color, EventKind, MountItem, ViewKind, ViewStyle};
use serde_json::{Value, json};

use crate::text::Layout;

/// The bits of op `e`.
pub mod events {
    /// `onPress`.
    pub const PRESS: u32 = 1;
    /// `onPressIn` / `onPressOut`.
    pub const PRESS_IN_OUT: u32 = 2;
    /// `onLongPress`.
    pub const LONG_PRESS: u32 = 4;
    /// `onKeyDown` / `onKeyUp`: the remote's keys go to this view.
    pub const KEYS: u32 = 8;
    /// `onFocus` / `onBlur`.
    pub const FOCUS: u32 = 16;
    /// An image's `onLoad`, `onLoadStart`, `onLoadEnd`.
    pub const LOAD: u32 = 32;
    /// An image's `onError`.
    pub const ERROR: u32 = 64;
}

/// Whether this platform shows `item` (or takes it elsewhere: the
/// animation graph's): the others are counted as skipped.
pub fn shown(item: &MountItem) -> bool {
    use nsh_core::MountItem as M;
    match item {
        M::Command { command, .. } => matches!(
            command,
            nsh_core::Command::Focus
                | nsh_core::Command::Blur
                | nsh_core::Command::ScrollTo { .. }
                | nsh_core::Command::Native { .. }
                | nsh_core::Command::ExitApp
                // The back button's default, done where the batch is
                // encoded (`Outbox::back`).
                | nsh_core::Command::Back
        ),
        M::Create { .. }
        | M::Insert { .. }
        | M::Remove { .. }
        | M::Delete { .. }
        | M::Frame { .. }
        | M::ViewStyle { .. }
        | M::Text { .. }
        | M::Events { .. }
        | M::TrackStates { .. }
        | M::ViewProps { .. }
        | M::ScrollConfig { .. }
        | M::ScrollContent { .. }
        | M::ScrollBy { .. }
        | M::Image { .. }
        | M::Input { .. }
        | M::InputValue { .. }
        | M::InputContent { .. }
        | M::Component { .. }
        | M::ComponentProps { .. }
        | M::Animation(_)
        | M::AnimationBindings { .. }
        | M::Gestures { .. }
        | M::StickyCells { .. } => true,
        _ => false,
    }
}

/// One item's operation, if this platform shows it.
pub fn item(item: &MountItem) -> Option<Value> {
    Some(match item {
        MountItem::Create { id, kind } => json!(["c", id, kind_name(*kind)]),
        MountItem::Insert {
            parent,
            child,
            before,
        } => json!(["i", parent, child, before]),
        MountItem::Remove { id } => json!(["r", id]),
        MountItem::Delete { id } => json!(["d", id]),
        MountItem::Frame { id, frame } => json!([
            "f",
            id,
            round(frame.origin.x.0),
            round(frame.origin.y.0),
            round(frame.size.width.0),
            round(frame.size.height.0)
        ]),
        MountItem::ViewStyle { id, style } => json!(["s", id, css(style)]),
        MountItem::Text {
            id,
            layout,
            content,
            ..
        } => {
            let layout = layout.downcast::<Layout>()?;
            let runs: Vec<Value> = layout
                .lines
                .iter()
                .flat_map(|l| &l.runs)
                .filter(|r| !r.text.is_empty())
                .map(|r| json!([r.text, round(r.x), round(r.y), round(r.height), r.style]))
                .collect();
            let styles: Vec<&str> = layout.styles.iter().map(|s| s.css.as_str()).collect();
            json!(["t", id, {
                "x": round(content.origin.x.0),
                "y": round(content.origin.y.0),
                "styles": styles,
                "runs": runs,
            }])
        }
        MountItem::Events { id, events } => {
            let mut bits = 0;
            let mut set = |kinds: &[EventKind], bit: u32| {
                if kinds.iter().any(|k| events.contains(*k)) {
                    bits |= bit;
                }
            };
            set(&[EventKind::Press], events::PRESS);
            set(
                &[EventKind::PressDown, EventKind::PressUp],
                events::PRESS_IN_OUT,
            );
            set(&[EventKind::LongPress], events::LONG_PRESS);
            set(&[EventKind::KeyDown, EventKind::KeyUp], events::KEYS);
            set(&[EventKind::Focus, EventKind::Blur], events::FOCUS);
            set(
                &[EventKind::Load, EventKind::LoadStart, EventKind::LoadEnd],
                events::LOAD,
            );
            set(&[EventKind::Error], events::ERROR);
            json!(["e", id, bits])
        }
        MountItem::TrackStates { id, states } => json!(["ts", id, states]),
        MountItem::ViewProps { id, props } => {
            json!(["vp", id, props.focusable, props.test_id.as_deref()])
        }
        MountItem::ScrollConfig { id, horizontal, .. } => json!(["sc", id, horizontal]),
        MountItem::ScrollContent { id, size } => {
            json!(["ss", id, round(size.width.0), round(size.height.0)])
        }
        MountItem::ScrollBy { id, dx, dy } => json!(["sb", id, round(dx.0), round(dy.0)]),
        MountItem::Image {
            id,
            source,
            resize_mode,
            options,
        } => {
            let fit = match resize_mode {
                nsh_core::ResizeMode::Cover => "cover",
                nsh_core::ResizeMode::Contain => "contain",
                nsh_core::ResizeMode::ScaleDown => "scale-down",
                nsh_core::ResizeMode::Stretch => "fill",
                nsh_core::ResizeMode::Center => "none",
            };
            let position = object_position(&options.position);
            json!([
                "im",
                id,
                source.as_ref().map(|s| image_src(&s.uri)),
                fit,
                options.placeholder.as_ref().map(|s| image_src(&s.uri)),
                round(options.blur_radius.0),
                position,
                options.current_color.map(color)
            ])
        }
        MountItem::Input { id, config } => json!(["in", id, input(config)]),
        MountItem::InputValue { id, text, count } => json!(["iv", id, text, count]),
        MountItem::InputContent { id, content } => json!([
            "ic",
            id,
            round(content.origin.x.0),
            round(content.origin.y.0),
            round(content.size.width.0),
            round(content.size.height.0)
        ]),
        MountItem::Component { id, name } => json!(["n", id, &**name]),
        MountItem::ComponentProps { id, props } => {
            // A prop set to JSON `null` and a prop removed are told apart.
            let changed: serde_json::Map<String, Value> = props
                .iter()
                .filter_map(|(name, value)| Some((name.to_string(), value.clone()?)))
                .collect();
            let removed: Vec<&str> = props
                .iter()
                .filter(|(_, value)| value.is_none())
                .map(|(name, _)| &**name)
                .collect();
            json!(["np", id, changed, removed])
        }
        MountItem::Command { id, command } => match command {
            nsh_core::Command::Focus => json!(["fo", id, true]),
            nsh_core::Command::Blur => json!(["fo", id, false]),
            nsh_core::Command::ScrollTo { x, y, animated } => {
                json!(["st", id, round(x.0), round(y.0), animated])
            }
            nsh_core::Command::Native { name, args } => json!(["nc", id, &**name, args]),
            nsh_core::Command::ExitApp => json!(["x", id]),
            _ => return None,
        },
        _ => return None,
    })
}

/// `objectPosition` as CSS's `object-position` (`""` for the center, the
/// default).
fn object_position(p: &nsh_core::ObjectPosition) -> String {
    if *p == nsh_core::ObjectPosition::CENTER {
        return String::new();
    }
    let axis = |a: &nsh_core::PositionAxis, start: &str, end: &str| {
        let offset = crate::effects::origin(a.offset);
        format!("{} {offset}", if a.from_end { end } else { start })
    };
    format!(
        "{} {}",
        axis(&p.x, "left", "right"),
        axis(&p.y, "top", "bottom")
    )
}

/// An input's configuration as the page's `<input>` / `<textarea>` takes
/// it: `css` (font, color, caret, alignment), `ph` / `phc` (placeholder and
/// its color), `type` (`text`, `password`, `number`, `email`, `tel`,
/// `url`), `ml` (multiline; never for a masked input, which a `<textarea>`
/// would show in plain text), `max` (-1: none), `off` (not editable),
/// `submit` (`blur`, `keep` or `newline`: what the keyboard's Done does),
/// `auto` (focus once on screen).
fn input(config: &nsh_core::InputConfig) -> Value {
    use nsh_core::{KeyboardType as K, SubmitBehavior as S, TextAlign};
    let style = &config.style;
    let name = style.font_family.as_ref().map(|f| f.name());
    let font = crate::text::font_css(
        style.font_size.0,
        style.font_weight,
        style.italic,
        name.as_deref(),
    );
    let mut css = format!("{font}color:{};", color(style.color));
    if let Some(c) = config.caret_color {
        let _ = write!(css, "caret-color:{};", color(c));
    }
    if config.caret_hidden {
        css.push_str("caret-color:transparent;");
    }
    match config.align {
        TextAlign::Center => css.push_str("text-align:center;"),
        TextAlign::Right => css.push_str("text-align:right;"),
        _ => {}
    }
    // The TV's keyboard picks its layout by the input's type.
    let kind = match config.keyboard {
        _ if config.secure => "password",
        K::Number | K::Decimal | K::Numeric => "number",
        K::Email => "email",
        K::Phone => "tel",
        K::Url => "url",
        _ => "text",
    };
    let submit = match config.submit() {
        S::BlurAndSubmit => "blur",
        S::Submit => "keep",
        S::Newline => "newline",
    };
    json!({
        "css": css,
        "ph": config.placeholder,
        "phc": config.placeholder_color.map(color),
        "type": kind,
        // A masked input is one line: a <textarea> cannot hide its text.
        "ml": config.multiline && !config.secure,
        "max": config.max_length.map_or(-1, i64::from),
        "off": !config.editable,
        "submit": submit,
        "auto": config.auto_focus,
    })
}

/// The kind a view is shown as.
fn kind_name(kind: ViewKind) -> &'static str {
    match kind {
        ViewKind::Text => "text",
        ViewKind::Scroll => "scroll",
        ViewKind::Image => "image",
        ViewKind::Canvas => "canvas",
        ViewKind::Stack => "stack",
        ViewKind::Screen => "screen",
        ViewKind::Modal => "modal",
        ViewKind::Input => "input",
        ViewKind::Native => "native",
        _ => "view",
    }
}

/// An image URI as the page's `<img>` loads it: an app's own file
/// (`asset:/x.png`) from the package's `assets/` (next to the page), a URL
/// as it is. An image whose bytes are in memory keeps its key URI, which
/// the page maps to the blob it was given (`image_bytes`).
pub fn image_src(uri: &str) -> String {
    match uri.strip_prefix("asset:/") {
        Some(path) => format!("assets/{}", path.trim_start_matches('/')),
        None => uri.to_owned(),
    }
}

/// `v` to a hundredth: the render layer's pixels need no more.
fn round(v: f32) -> f64 {
    (f64::from(v) * 100.0).round() / 100.0
}

/// A color as CSS (`rgba(…)`).
pub fn color(c: Color) -> String {
    let [r, g, b, a] = c.0.to_be_bytes();
    if a == 255 {
        format!("rgb({r},{g},{b})")
    } else {
        format!("rgba({r},{g},{b},{})", round(f32::from(a) / 255.0))
    }
}

/// A view's decoration as inline CSS: background, corners, borders,
/// opacity, clipping, hiding.
pub fn css(style: &ViewStyle) -> String {
    let mut out = String::new();
    if style.background_color.0 & 0xff != 0 {
        let _ = write!(out, "background-color:{};", color(style.background_color));
    }
    let corners = style.corner_radius;
    let radius = |r: Option<nsh_core::Points>| round(r.unwrap_or(style.border_radius).0);
    let radii = [
        radius(corners.top_left),
        radius(corners.top_right),
        radius(corners.bottom_right),
        radius(corners.bottom_left),
    ];
    if radii.iter().any(|r| *r > 0.0) {
        if radii.iter().all(|r| *r == radii[0]) {
            let _ = write!(out, "border-radius:{}px;", radii[0]);
        } else {
            let _ = write!(
                out,
                "border-radius:{}px {}px {}px {}px;",
                radii[0], radii[1], radii[2], radii[3]
            );
        }
    }
    let borders = &style.borders;
    let kind = match borders.style {
        BorderStyle::Solid => "solid",
        BorderStyle::Dashed => "dashed",
        BorderStyle::Dotted => "dotted",
    };
    let widths = borders.widths;
    for (side, width, c) in [
        ("top", widths.top, borders.colors[0]),
        ("right", widths.right, borders.colors[1]),
        ("bottom", widths.bottom, borders.colors[2]),
        ("left", widths.left, borders.colors[3]),
    ] {
        if width.0 > 0.0 {
            let _ = write!(
                out,
                "border-{side}:{}px {kind} {};",
                round(width.0),
                color(c)
            );
        }
    }
    if style.opacity < 1.0 {
        let _ = write!(out, "opacity:{};", round(style.opacity));
    }
    if style.overflow_hidden {
        out.push_str("overflow:hidden;");
    }
    if style.hidden {
        out.push_str("visibility:hidden;");
    }
    crate::effects::write(&mut out, style);
    out
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Points,
        geometry::{Bounds, point, size},
    };

    use super::*;

    #[test]
    fn structure_and_frames() {
        let items = [
            MountItem::Create {
                id: 2,
                kind: ViewKind::View,
            },
            MountItem::Insert {
                parent: 0,
                child: 2,
                before: None,
            },
            MountItem::Frame {
                id: 2,
                frame: Bounds::new(
                    point(Points(1.0), Points(2.5)),
                    size(Points(100.0), Points(1.0 / 3.0)),
                ),
            },
        ];
        let ops: Vec<_> = items.iter().filter_map(item).collect();
        assert_eq!(
            Value::Array(ops),
            json!([
                ["c", 2, "view"],
                ["i", 0, 2, null],
                ["f", 2, 1.0, 2.5, 100.0, 0.33]
            ])
        );
    }

    #[test]
    fn decoration_as_css() {
        let style = ViewStyle {
            background_color: Color(0xff000080),
            border_radius: Points(8.0),
            opacity: 0.5,
            overflow_hidden: true,
            ..ViewStyle::default()
        };
        assert_eq!(
            css(&style),
            "background-color:rgba(255,0,0,0.5);border-radius:8px;opacity:0.5;overflow:hidden;"
        );
        assert_eq!(css(&ViewStyle::default()), "");
    }

    #[test]
    fn image_sources() {
        assert_eq!(image_src("asset:/img/a.png"), "assets/img/a.png");
        assert_eq!(image_src("https://x.dev/a.png"), "https://x.dev/a.png");
    }
}
