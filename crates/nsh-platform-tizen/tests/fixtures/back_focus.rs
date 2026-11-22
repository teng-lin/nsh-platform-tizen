#![cfg(target_arch = "wasm32")]

use nsh_core::element::{Root, dynamic, input, modal};
use nsh_core::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialog {
    Editor,
    Confirmation,
    Transient,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BackAction {
    Handle,
    Decline,
    OpenOnRelease,
}

#[component]
fn BackFocus() -> impl IntoElement {
    let dialog = signal(Some(Dialog::Editor));
    let back_action = signal(BackAction::Handle);
    let events = signal(String::new());
    let record = move |event: &str| events.update(|log| log.push_str(event));
    let background = element_ref();
    let editor = element_ref();

    on_back_press(move || {
        if back_action.get() == BackAction::Decline {
            record("declined;");
            dialog.set(Some(Dialog::Confirmation));
            false
        } else {
            record("handled;");
            true
        }
    });

    view()
        .on_key_down(move |event: &KeyEvent| match &*event.key {
            "ColorF0Red" => dialog.set(None),
            "ColorF1Green" => dialog.set(Some(Dialog::Editor)),
            "ColorF2Yellow" => back_action.set(BackAction::Decline),
            "ColorF3Blue" => record("root key;"),
            "1" => {
                back_action.set(BackAction::OpenOnRelease);
                background.focus();
            }
            _ => {}
        })
        .on_key_up(move |event: &KeyEvent| {
            if &*event.key == "GoBack" && back_action.get() == BackAction::OpenOnRelease {
                background.blur();
                dialog.set(Some(Dialog::Transient));
            }
        })
        .child(
            view()
                .test_id("background")
                .focus_within(|style| style.bg(rgb(0x008000)))
                .child(
                    view()
                        .element_ref(&background)
                        .focusable(true)
                        .w(px(100.0))
                        .h(px(40.0))
                        .on_focus(move || record("background focus;"))
                        .on_blur(move || record("background blur;"))
                        .on_key_down(move |event: &KeyEvent| {
                            if &*event.key == "ColorF3Blue" {
                                record("background key;");
                            }
                        }),
                ),
        )
        .child(text(move || events.get()))
        .child(dynamic(move || {
            dialog.get().map(|dialog| {
                let transient = dialog == Dialog::Transient;
                let (id, close_event) = match dialog {
                    Dialog::Editor => ("editor", "editor close;"),
                    Dialog::Confirmation => ("confirmation", "confirmation close;"),
                    Dialog::Transient => ("transient", "transient close;"),
                };
                modal()
                    .test_id(id)
                    .on_close(move || {
                        record(close_event);
                        if transient {
                            background.focus();
                        }
                    })
                    .child(
                        view()
                            .on_key_down(move |event: &KeyEvent| match &*event.key {
                                "GoBack" if dialog == Dialog::Editor => editor.focus(),
                                "ColorF3Blue" => record("modal key;"),
                                _ => {}
                            })
                            .child(
                                input()
                                    .element_ref(&editor)
                                    .w(px(200.0))
                                    .h(px(40.0))
                                    .auto_focus(transient)
                                    .on_blur(move || record("input blur;"))
                                    .on_focus(move || {
                                        record(if transient {
                                            "transient focus;"
                                        } else {
                                            "editor focus;"
                                        });
                                    }),
                            ),
                    )
            })
        }))
}

nsh_platform_tizen::app!(Vec::new(), Root::of::<BackFocus>());
