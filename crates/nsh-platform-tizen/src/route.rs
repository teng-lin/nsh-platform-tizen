//! Where the remote's keys go, decided here from the tree the engine just
//! committed rather than on the page, whose copy lags a message behind:
//! the view the app focused while it is attached, else the topmost
//! attached modal's root, else the root. A key reported at the root (or a
//! modal window's root) starts at the view mounted there and bubbles from
//! it, as NSH's own backends report a key with nothing focused (the
//! core's `key_start`). OK on a focused view that takes presses presses it
//! instead of reaching it as a key.
//!
//! Each physical key's press decides its route: an auto-repeat and the
//! release follow it (a release whose view left the tree goes where keys go
//! now; a release without a press is dropped).
//!
//! The focus of views (not inputs, whose focus is the page's `<input>`) is
//! kept here too. `Command::Focus` / `Blur` on a view, an input taking the
//! focus, and the focused view leaving the tree (detached, or under a
//! detached ancestor, at the end of a batch) are transitions, each reported
//! as `Focus` / `Blur` with the focused state after the pump that made it.
//! A deleted focused view is gone: nothing is reported for it.

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
    /// Nothing: a release without its press.
    Drop,
}

#[derive(Default)]
pub(crate) struct Routes {
    parent: HashMap<u32, u32>,
    inputs: HashSet<u32>,
    pressable: HashSet<u32>,
    /// Modal roots, in the order they were last inserted.
    modals: Vec<u32>,
    modal_kind: HashSet<u32>,
    /// The focused view (not an input).
    focused: Option<u32>,
    /// Focus transitions to report: view, focused.
    pub(crate) transitions: Vec<(u32, bool)>,
    /// Each held key's route, so its repeats and release go where its
    /// press went.
    held: HashMap<u32, Route>,
}

impl Routes {
    pub(crate) fn apply(&mut self, item: &MountItem) {
        match item {
            MountItem::Create { id, kind } => match kind {
                ViewKind::Input => {
                    self.inputs.insert(*id);
                }
                ViewKind::Modal => {
                    self.modal_kind.insert(*id);
                }
                _ => {}
            },
            MountItem::Insert { parent, child, .. } => {
                self.parent.insert(*child, *parent);
                if self.modal_kind.contains(child) {
                    self.modals.retain(|m| m != child);
                    self.modals.push(*child);
                }
            }
            MountItem::Remove { id } => {
                self.parent.remove(id);
            }
            MountItem::Delete { id } => {
                self.parent.remove(id);
                self.inputs.remove(id);
                self.pressable.remove(id);
                self.modal_kind.remove(id);
                self.modals.retain(|m| m != id);
                if self.focused == Some(*id) {
                    self.focused = None;
                }
            }
            MountItem::Events { id, events } => {
                if events.contains(EventKind::Press) {
                    self.pressable.insert(*id);
                } else {
                    self.pressable.remove(id);
                }
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

    /// The end of a batch: a focused view no longer in the tree (it, or an
    /// ancestor, was detached; a move within the batch is not a removal)
    /// loses the focus.
    pub(crate) fn end_batch(&mut self) {
        if let Some(f) = self.focused
            && !self.attached(f)
        {
            self.focus_view(None);
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

    /// An input took the DOM focus: the focused view loses it (reported
    /// before the input's own Focus).
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
        self.modals
            .iter()
            .rev()
            .copied()
            .find(|m| self.attached(*m))
            .unwrap_or(ROOT_ID)
    }

    fn fresh(&self, enter: bool, requested: u32) -> Route {
        if requested != 0 {
            return Route::Key(requested);
        }
        let target = self.target();
        if enter && self.focused == Some(target) && self.pressable.contains(&target) {
            Route::Press(target)
        } else {
            Route::Key(target)
        }
    }

    /// The route of key `code` going down (`down`, `repeat` for an
    /// auto-repeat) or up. `requested` is the page's view (the input being
    /// edited), 0 to choose here.
    pub(crate) fn route(
        &mut self,
        code: u32,
        enter: bool,
        down: bool,
        repeat: bool,
        requested: u32,
    ) -> Route {
        if down {
            let route = match self.held.get(&code) {
                Some(&held) if repeat => self.still(held, enter, requested),
                _ => self.fresh(enter, requested),
            };
            self.held.insert(code, route);
            return route;
        }
        match self.held.remove(&code) {
            Some(held) => self.still(held, enter, requested),
            None => Route::Drop,
        }
    }

    /// A held route, or where keys go now if its view left the tree.
    fn still(&self, held: Route, enter: bool, requested: u32) -> Route {
        match held {
            Route::Key(id) | Route::Press(id) if !self.attached(id) => self.fresh(enter, requested),
            route => route,
        }
    }

    /// The focused-state bits to report for a view going to `focused`:
    /// always reported (NSH's `reported_states` includes FOCUSED whatever a
    /// view tracks: focus-within, modal focus restore and culling need it).
    pub(crate) fn states(focused: bool) -> u16 {
        if focused {
            nsh_core::tailwind::state::FOCUSED
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(r: &mut Routes, parent: u32, child: u32) {
        r.apply(&MountItem::Insert {
            parent,
            child,
            before: None,
        });
    }

    fn focus(r: &mut Routes, id: u32) {
        r.apply(&MountItem::Command {
            id,
            command: Command::Focus,
        });
    }

    fn tree() -> Routes {
        let mut r = Routes::default();
        for (parent, child) in [(1, 2), (2, 3), (2, 4)] {
            insert(&mut r, parent, child);
        }
        let mut press = nsh_core::EventMask::default();
        press.set(EventKind::Press, true);
        r.apply(&MountItem::Events {
            id: 3,
            events: press,
        });
        r
    }

    #[test]
    fn keys_go_to_the_focus_else_the_root() {
        let mut r = tree();
        assert_eq!(r.target(), ROOT_ID);
        focus(&mut r, 4);
        assert_eq!(r.target(), 4);
        assert_eq!(r.transitions, [(4, true)]);
    }

    #[test]
    fn an_open_modal_takes_keys_without_a_focus() {
        let mut r = tree();
        r.apply(&MountItem::Create {
            id: 9,
            kind: ViewKind::Modal,
        });
        insert(&mut r, 1, 9);
        assert_eq!(r.target(), 9);
        r.apply(&MountItem::Remove { id: 9 });
        assert_eq!(r.target(), ROOT_ID);
    }

    #[test]
    fn a_detached_focus_takes_no_keys_and_is_blurred() {
        let mut r = tree();
        focus(&mut r, 4);
        r.transitions.clear();
        r.apply(&MountItem::Remove { id: 4 });
        r.end_batch();
        assert_eq!(r.target(), ROOT_ID);
        assert_eq!(r.transitions, [(4, false)]);
        // Under a detached ancestor too.
        focus(&mut r, 3);
        r.transitions.clear();
        r.apply(&MountItem::Remove { id: 2 });
        r.end_batch();
        assert_eq!(r.transitions, [(3, false)]);
        assert_eq!(r.target(), ROOT_ID);
    }

    #[test]
    fn a_move_within_a_batch_keeps_the_focus() {
        let mut r = tree();
        focus(&mut r, 4);
        r.transitions.clear();
        r.apply(&MountItem::Remove { id: 4 });
        insert(&mut r, 2, 4);
        r.end_batch();
        assert!(r.transitions.is_empty());
        assert_eq!(r.target(), 4);
    }

    #[test]
    fn ok_presses_a_focused_pressable_and_its_release_follows() {
        let mut r = tree();
        focus(&mut r, 3);
        assert_eq!(r.route(13, true, true, false, 0), Route::Press(3));
        // The focus moves before OK comes up: the release is the press's.
        focus(&mut r, 4);
        assert_eq!(r.route(13, true, false, false, 0), Route::Press(3));
        // Down then OK at once: OK goes where the focus is now.
        assert_eq!(r.route(40, false, true, false, 0), Route::Key(4));
        assert_eq!(r.route(13, true, true, false, 0), Route::Key(4));
        assert_eq!(r.route(40, false, false, false, 0), Route::Key(4));
    }

    #[test]
    fn repeats_follow_their_press_and_lone_releases_drop() {
        let mut r = tree();
        focus(&mut r, 4);
        assert_eq!(r.route(417, false, true, false, 0), Route::Key(4));
        focus(&mut r, 3);
        assert_eq!(
            r.route(417, false, true, true, 0),
            Route::Key(4),
            "a repeat follows its press"
        );
        assert_eq!(r.route(417, false, false, false, 0), Route::Key(4));
        assert_eq!(
            r.route(417, false, false, false, 0),
            Route::Drop,
            "no press held"
        );
        // The pressed view left the tree: its release goes where keys go.
        assert_eq!(r.route(417, false, true, false, 0), Route::Key(3));
        r.apply(&MountItem::Remove { id: 3 });
        r.end_batch();
        assert_eq!(r.route(417, false, false, false, 0), Route::Key(ROOT_ID));
    }

    #[test]
    fn the_page_names_the_input_it_edits() {
        let mut r = tree();
        insert(&mut r, 2, 9);
        assert_eq!(r.route(403, false, true, false, 9), Route::Key(9));
        assert_eq!(r.route(403, false, false, false, 0), Route::Key(9));
    }
}
