//! Where the remote's keys go, decided here from the tree the engine just
//! committed rather than on the page, whose copy lags a message behind:
//! the view the app focused while it is attached, else the newest attached
//! view listening for keys, else the root. OK on a focused view that takes
//! presses presses it instead of reaching it as a key.
//!
//! The focus of views (not inputs, whose focus is the page's `<input>`) is
//! kept here too: `Command::Focus` / `Blur` on a view, an input taking the
//! focus, and the focused view leaving the tree are transitions, each
//! reported as `Focus` / `Blur` (and the focused state where the core
//! tracks it) after the pump that made it.

use std::collections::{HashMap, HashSet};

use nsh_core::{Command, EventKind, MountItem, ROOT_ID, ViewKind};

/// What a key transition is routed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// A key event on this view (bubbling from there).
    Key(u32),
    /// OK pressed this focused view (`onPress` on the way down, nothing on
    /// the way up).
    Press(u32),
}

#[derive(Default)]
pub(crate) struct Routes {
    parent: HashMap<u32, u32>,
    inputs: HashSet<u32>,
    pressable: HashSet<u32>,
    /// Views listening for keys, oldest first.
    listeners: Vec<u32>,
    /// The `tailwind::state` bits the core tracks per view.
    tracked: HashMap<u32, u16>,
    /// The focused view (not an input).
    focused: Option<u32>,
    /// Focus transitions to report: view, focused.
    pub(crate) transitions: Vec<(u32, bool)>,
    /// Each held key's route, so its release goes where its press went.
    held: HashMap<u32, Route>,
}

impl Routes {
    pub(crate) fn apply(&mut self, item: &MountItem) {
        match item {
            MountItem::Create { id, kind } => {
                if *kind == ViewKind::Input {
                    self.inputs.insert(*id);
                }
            }
            MountItem::Insert { parent, child, .. } => {
                self.parent.insert(*child, *parent);
            }
            MountItem::Remove { id } => {
                self.parent.remove(id);
            }
            MountItem::Delete { id } => {
                self.parent.remove(id);
                self.inputs.remove(id);
                self.pressable.remove(id);
                self.tracked.remove(id);
                self.listeners.retain(|l| l != id);
                if self.focused == Some(*id) {
                    self.focused = None;
                }
            }
            MountItem::Events { id, events } => {
                let keys = events.contains(EventKind::KeyDown) || events.contains(EventKind::KeyUp);
                self.listeners.retain(|l| l != id);
                if keys {
                    self.listeners.push(*id);
                }
                if events.contains(EventKind::Press) {
                    self.pressable.insert(*id);
                } else {
                    self.pressable.remove(id);
                }
            }
            MountItem::TrackStates { id, states } => {
                self.tracked.insert(*id, *states);
            }
            MountItem::Command {
                id,
                command: Command::Focus,
            } if !self.inputs.contains(id) => self.focus_view(Some(*id)),
            MountItem::Command {
                id,
                command: Command::Blur,
            } if !self.inputs.contains(id) && (self.focused == Some(*id) || *id == ROOT_ID) => {
                self.focus_view(None)
            }
            _ => {}
        }
    }

    fn focus_view(&mut self, view: Option<u32>) {
        if self.focused == view {
            return;
        }
        if let Some(old) = self.focused.take() {
            self.transitions.push((old, false));
        }
        if let Some(new) = view {
            self.focused = Some(new);
            self.transitions.push((new, true));
        }
    }

    /// An input took the DOM focus: the focused view loses it.
    pub(crate) fn input_focused(&mut self) {
        self.focus_view(None);
    }

    /// Whether `id` is in the tree under the root.
    pub(crate) fn attached(&self, mut id: u32) -> bool {
        // Bounded: a cycle cannot come from the core, but a walk must end.
        for _ in 0..10_000 {
            if id == ROOT_ID {
                return true;
            }
            match self.parent.get(&id) {
                Some(&p) => id = p,
                None => return false,
            }
        }
        false
    }

    /// Where a key goes now.
    pub(crate) fn target(&self) -> u32 {
        if let Some(f) = self.focused.filter(|f| self.attached(*f)) {
            return f;
        }
        self.listeners
            .iter()
            .rev()
            .copied()
            .find(|l| self.attached(*l))
            .unwrap_or(ROOT_ID)
    }

    /// The route of key `code` going down (`down`) or up: a release goes
    /// where its press went. `requested` is the page's view (the input
    /// being edited), 0 to choose here.
    pub(crate) fn route(&mut self, code: u32, enter: bool, down: bool, requested: u32) -> Route {
        if !down && let Some(route) = self.held.remove(&code) {
            return route;
        }
        let route = if requested != 0 {
            Route::Key(requested)
        } else {
            let target = self.target();
            if enter && self.focused == Some(target) && self.pressable.contains(&target) {
                Route::Press(target)
            } else {
                Route::Key(target)
            }
        };
        if down {
            self.held.insert(code, route);
        }
        route
    }

    /// The focused-state bits to report for `id` going to `focused`, when
    /// the core tracks them.
    pub(crate) fn states(&self, id: u32, focused: bool) -> Option<u16> {
        let tracked = *self.tracked.get(&id)?;
        (tracked & nsh_core::tailwind::state::FOCUSED != 0).then_some(if focused {
            nsh_core::tailwind::state::FOCUSED
        } else {
            0
        })
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::EventMask;

    use super::*;

    fn tree() -> Routes {
        let mut r = Routes::default();
        for (parent, child) in [(1, 2), (2, 3), (2, 4)] {
            r.apply(&MountItem::Insert {
                parent,
                child,
                before: None,
            });
        }
        let mut keys = EventMask::default();
        keys.set(EventKind::KeyDown, true);
        r.apply(&MountItem::Events {
            id: 2,
            events: keys,
        });
        let mut press = EventMask::default();
        press.set(EventKind::Press, true);
        r.apply(&MountItem::Events {
            id: 3,
            events: press,
        });
        r
    }

    #[test]
    fn keys_go_to_the_focus_else_the_newest_listener() {
        let mut r = tree();
        assert_eq!(r.target(), 2);
        r.apply(&MountItem::Command {
            id: 4,
            command: Command::Focus,
        });
        assert_eq!(r.target(), 4);
        assert_eq!(r.transitions, [(4, true)]);
    }

    #[test]
    fn a_detached_focus_takes_no_keys() {
        let mut r = tree();
        r.apply(&MountItem::Command {
            id: 4,
            command: Command::Focus,
        });
        r.apply(&MountItem::Remove { id: 4 });
        assert_eq!(r.target(), 2);
        // Its whole subtree is out too.
        r.apply(&MountItem::Command {
            id: 3,
            command: Command::Focus,
        });
        r.apply(&MountItem::Remove { id: 2 });
        assert_eq!(r.target(), ROOT_ID);
    }

    #[test]
    fn ok_presses_a_focused_pressable_and_its_release_follows() {
        let mut r = tree();
        r.apply(&MountItem::Command {
            id: 3,
            command: Command::Focus,
        });
        assert_eq!(r.route(13, true, true, 0), Route::Press(3));
        // The focus moves before OK comes up: the release is the press's.
        r.apply(&MountItem::Command {
            id: 4,
            command: Command::Focus,
        });
        assert_eq!(r.route(13, true, false, 0), Route::Press(3));
        // Down then OK at once: OK goes where the focus is now.
        assert_eq!(r.route(40, false, true, 0), Route::Key(4));
        assert_eq!(r.route(13, true, true, 0), Route::Key(4));
        assert_eq!(r.route(40, false, false, 0), Route::Key(4));
    }

    #[test]
    fn the_page_names_the_input_it_edits() {
        let mut r = tree();
        assert_eq!(r.route(403, false, true, 9), Route::Key(9));
        assert_eq!(r.route(403, false, false, 0), Route::Key(9));
    }
}
