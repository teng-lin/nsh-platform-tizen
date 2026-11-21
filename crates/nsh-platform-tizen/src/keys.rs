//! The remote's keys: Samsung's key codes (`KeyboardEvent.keyCode`, the
//! `code` of `tizen.tvinputdevice.getSupportedKeys()`) as the DOM's key
//! names (UI Events `KeyboardEvent.key` values), which NSH's `KeyEvent::key`
//! carries on every platform. A key the UI Events list has no name for
//! keeps Tizen's own name (`ChannelList`, `Tools`).
//!
//! Tizen's Chromium reports most remote keys with an empty or
//! vendor-specific `KeyboardEvent.key`, so the page sends each key's code
//! and the name comes from [`KEYS`]; a code not in it keeps the browser's
//! `key`. The event's `code` is the browser's `KeyboardEvent.code` as it is
//! (often empty for remote keys), never derived from the name.
//!
//! Only Back, Enter and the arrows reach a web app unasked; the others
//! need `tizen.tvinputdevice.registerKey(name)` first. The page registers
//! the keys marked [`RemoteKey::register`] at start ([`keys_json`]), and a
//! host page can register more by their Tizen names. Volume keys and Exit
//! keep their system behavior and are never registered by default.

/// One key of the remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteKey {
    /// Samsung's key code.
    pub code: u32,
    /// The name an app's `KeyEvent::key` gets.
    pub key: &'static str,
    /// Tizen's name for `tvinputdevice.registerKey`; `None` for the keys
    /// every app gets (Back, Enter, the arrows).
    pub tizen: Option<&'static str>,
    /// Registered when the app starts.
    pub register: bool,
}

const fn always(code: u32, key: &'static str) -> RemoteKey {
    RemoteKey {
        code,
        key,
        tizen: None,
        register: false,
    }
}

const fn registered(code: u32, key: &'static str, tizen: &'static str) -> RemoteKey {
    RemoteKey {
        code,
        key,
        tizen: Some(tizen),
        register: true,
    }
}

const fn optional(code: u32, key: &'static str, tizen: &'static str) -> RemoteKey {
    RemoteKey {
        code,
        key,
        tizen: Some(tizen),
        register: false,
    }
}

/// Every key this platform names, from a 2020 set's
/// `tvinputdevice.getSupportedKeys()` (UN55TU7000, Tizen 5.5).
pub const KEYS: &[RemoteKey] = &[
    always(13, "Enter"),
    always(37, "ArrowLeft"),
    always(38, "ArrowUp"),
    always(39, "ArrowRight"),
    always(40, "ArrowDown"),
    always(10009, "GoBack"),
    registered(48, "0", "0"),
    registered(49, "1", "1"),
    registered(50, "2", "2"),
    registered(51, "3", "3"),
    registered(52, "4", "4"),
    registered(53, "5", "5"),
    registered(54, "6", "6"),
    registered(55, "7", "7"),
    registered(56, "8", "8"),
    registered(57, "9", "9"),
    registered(403, "ColorF0Red", "ColorF0Red"),
    registered(404, "ColorF1Green", "ColorF1Green"),
    registered(405, "ColorF2Yellow", "ColorF2Yellow"),
    registered(406, "ColorF3Blue", "ColorF3Blue"),
    registered(427, "ChannelUp", "ChannelUp"),
    registered(428, "ChannelDown", "ChannelDown"),
    registered(457, "Info", "Info"),
    registered(458, "Guide", "Guide"),
    registered(10252, "MediaPlayPause", "MediaPlayPause"),
    registered(415, "MediaPlay", "MediaPlay"),
    registered(19, "MediaPause", "MediaPause"),
    registered(413, "MediaStop", "MediaStop"),
    registered(412, "MediaRewind", "MediaRewind"),
    registered(417, "MediaFastForward", "MediaFastForward"),
    registered(416, "MediaRecord", "MediaRecord"),
    registered(10232, "MediaTrackPrevious", "MediaTrackPrevious"),
    registered(10233, "MediaTrackNext", "MediaTrackNext"),
    registered(10073, "ChannelList", "ChannelList"),
    registered(10190, "MediaLast", "PreviousChannel"),
    registered(10221, "ClosedCaptionToggle", "Caption"),
    optional(189, "-", "Minus"),
    optional(10133, "ContextMenu", "Menu"),
    optional(10135, "Tools", "Tools"),
    optional(10225, "BrowserSearch", "Search"),
    optional(10182, "Exit", "Exit"),
    optional(10072, "TVInput", "Source"),
    optional(10140, "ZoomToggle", "PictureSize"),
    optional(10195, "MediaAudioTrack", "MTS"),
    optional(10199, "TV3DMode", "3D"),
    optional(10200, "Teletext", "Teletext"),
    optional(10146, "E-Manual", "E-Manual"),
    optional(10228, "Soccer", "Soccer"),
    optional(10253, "Extra", "Extra"),
];

/// The remote key with Samsung's code `code`.
pub fn by_code(code: u32) -> Option<&'static RemoteKey> {
    KEYS.iter().find(|k| k.code == code)
}

/// The key name an app gets for a key with Samsung's code `code` that the
/// browser reported as `dom_key`: the table's, else the browser's, else
/// `"Unidentified"`.
pub fn key_name(code: u32, dom_key: &str) -> &str {
    match by_code(code) {
        Some(key) => key.key,
        None if dom_key.is_empty() => "Unidentified",
        None => dom_key,
    }
}

/// The canonical shortcut stroke of key `key` (a DOM name), for
/// `captureKeys` matching: the arrows, OK, digits and minus; `None` for
/// the TV's own keys, which only `KeyCapture::All` captures.
pub fn stroke(key: &str) -> Option<nsh_core::keymap::Keystroke> {
    use nsh_core::keymap::Key;
    let key = match key {
        "ArrowUp" => Key::Up,
        "ArrowDown" => Key::Down,
        "ArrowLeft" => Key::Left,
        "ArrowRight" => Key::Right,
        "Enter" => Key::Enter,
        "-" => Key::Char('-'),
        d if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() => Key::Char(d.as_bytes()[0] as char),
        _ => return None,
    };
    Some(nsh_core::keymap::Keystroke {
        modifiers: Default::default(),
        key,
    })
}

/// The table as the page reads it: `[[code, key, tizen name or null,
/// registered at start, the input's own while edited], ...]`.
pub fn keys_json() -> String {
    let rows: Vec<serde_json::Value> = KEYS
        .iter()
        .map(|k| serde_json::json!([k.code, k.key, k.tizen, k.register, editing_key(k.code)]))
        .collect();
    serde_json::Value::Array(rows).to_string()
}

/// Whether a remote key is an input's own while it is edited: the TV's
/// keyboard takes the arrows, OK, digits and minus (the page adds the
/// keyboard's own Done and Cancel, 65376 and 65385, which reach no app).
pub fn editing_key(code: u32) -> bool {
    matches!(code, 13 | 37..=40 | 48..=57 | 189)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samsung_codes_get_dom_names() {
        assert_eq!(key_name(10009, ""), "GoBack");
        assert_eq!(key_name(403, "XF86Red"), "ColorF0Red");
        assert_eq!(key_name(427, ""), "ChannelUp");
        assert_eq!(key_name(10252, "Unidentified"), "MediaPlayPause");
        assert_eq!(key_name(53, "5"), "5");
        assert_eq!(key_name(10190, ""), "MediaLast");
    }

    #[test]
    fn unknown_codes_keep_the_browsers_name() {
        assert_eq!(key_name(65, "a"), "a");
        assert_eq!(key_name(9999, ""), "Unidentified");
    }

    #[test]
    fn the_table_is_one_to_one_and_keeps_system_keys() {
        for (i, a) in KEYS.iter().enumerate() {
            for b in &KEYS[i + 1..] {
                assert_ne!(a.code, b.code);
                assert_ne!(a.key, b.key);
                if a.tizen.is_some() {
                    assert_ne!(a.tizen, b.tizen);
                }
            }
            // What every app gets needs no registering, and what is
            // registered has a Tizen name.
            assert!(a.tizen.is_some() || !a.register);
        }
        // Exit, Menu and Source keep the TV's behavior.
        for code in [10182, 10133, 10072] {
            assert!(!by_code(code).unwrap().register);
        }
    }

    #[test]
    fn the_page_reads_the_table() {
        let rows: serde_json::Value = serde_json::from_str(&keys_json()).unwrap();
        let back = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r[0] == 10009)
            .unwrap();
        assert_eq!(
            back,
            &serde_json::json!([10009, "GoBack", null, false, false])
        );
        let ok = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r[0] == 13)
            .unwrap();
        assert_eq!(ok[4], true, "OK is the keyboard's while editing");
        assert!(
            rows.as_array()
                .unwrap()
                .iter()
                .any(|r| r[1] == "ColorF0Red" && r[3] == true)
        );
    }
}
