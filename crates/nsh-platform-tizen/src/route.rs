//! Where the remote's keys go, decided here from the tree the engine just
//! committed rather than on the page, whose copy lags a message behind:
//! the view the app focused while it is attached; else, with a modal
//! open, the topmost attached modal's content (its first child that is not
//! itself a modal, as the core's `key_start` picks a root's content); else
//! the root, where the core starts the key at the view mounted there. The
//! core bubbles a key through its logical ancestors up to its window, as on
//! NSH's own backends: a plain modal is not a window, so its background's
//! listeners hear what its content does not take (`captureKeys` or a
//! focus inside the modal keep keys there).
//!
//! OK on a focused view that takes presses is a key like any other (the
//! app's `captureKeys` may take it) and, when nothing captured it, presses
//! the view, as NSH's web backend does.
//!
//! Each physical key's press decides its route and its family (a key, or
//! OK pressing a view): its repeats and release keep the family, and go to
//! the pressed view, or where keys go now if that view left the tree. A
//! release without a press is dropped.
//!
//! The focus of views (not inputs, whose focus is the page's `<input>`) is
//! kept here too. `Command::Focus` / `Blur` on a view, an input taking the
//! focus, and the focused view leaving the tree (detached, or under a
//! detached ancestor, at the end of a batch) are transitions, each reported
//! as `Focus` / `Blur` with the focused state after the pump that made it,
//! a Blur always before the Focus that caused it (an input being edited
//! loses the focus before a view takes it). A deleted focused view is
//! gone: nothing is reported for it.

use std::collections::{HashMap, HashSet};

use nsh_core::{Command, EventKind, MountItem, ROOT_ID, ViewKind};

/// What a key transition is routed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// A key event on this view (bubbling from there).
    Key(u32),
    /// OK on this focused view that takes presses: a key event on it and,
    /// on the first press when nothing captured the key, `onPress`.
    Press(u32),
    /// Nothing: a release without its press.
    Drop,
}

/// A key held down.
struct Held {
    route: Route,
    /// The last down's target and its ancestors then, nearest first.
    reached: Vec<u32>,
}

#[derive(Default)]
pub(crate) struct Routes {
    parent: HashMap<u32, u32>,
    /// Each view's children, bottom to top (`Insert`'s `before`).
    children: HashMap<u32, Vec<u32>>,
    inputs: HashSet<u32>,
    pressable: HashSet<u32>,
    modals: HashSet<u32>,
    /// The focused view (not an input).
    focused: Option<u32>,
    /// The input being edited (its DOM focus), as the page reported it.
    pub(crate) editing: Option<u32>,
    /// Focus transitions to report: view, focused.
    pub(crate) transitions: Vec<(u32, bool)>,
    /// Each held key: its route's family and the views its last down
    /// reached (the target, then its ancestors), for the release.
    held: HashMap<u32, Held>,
}

impl Routes {
    pub(crate) fn apply(&mut self, item: &MountItem) {
        match item {
            MountItem::Create { id, kind } => match kind {
                ViewKind::Input => {
                    self.inputs.insert(*id);
                }
                ViewKind::Modal => {
                    self.modals.insert(*id);
                }
                _ => {}
            },
            MountItem::Insert {
                parent,
                child,
                before,
            } => {
                self.unlink(*child);
                self.parent.insert(*child, *parent);
                let list = self.children.entry(*parent).or_default();
                match before.and_then(|b| list.iter().position(|c| *c == b)) {
                    Some(i) => list.insert(i, *child),
                    None => list.push(*child),
                }
            }
            MountItem::Remove { id } => self.unlink(*id),
            MountItem::Delete { id } => {
                self.unlink(*id);
                self.children.remove(id);
                self.inputs.remove(id);
                self.pressable.remove(id);
                self.modals.remove(id);
                if self.focused == Some(*id) {
                    self.focused = None;
                }
                if self.editing == Some(*id) {
                    self.editing = None;
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

    fn unlink(&mut self, id: u32) {
        if let Some(p) = self.parent.remove(&id)
            && let Some(list) = self.children.get_mut(&p)
        {
            list.retain(|c| *c != id);
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
            // The input being edited loses the focus first (the page blurs
            // it; its Blur message is then not reported again).
            if let Some(input) = self.editing.take() {
                self.transitions.push((input, false));
            }
            self.focused = Some(new);
            self.transitions.push((new, true));
        }
    }

    /// An input took the DOM focus: the focused view loses it (reported
    /// before the input's own Focus).
    pub(crate) fn input_focused(&mut self, id: u32) {
        self.focus_view(None);
        self.editing = Some(id);
    }

    /// An input lost the DOM focus; false when its Blur was reported
    /// already (a view took the focus from it).
    pub(crate) fn input_blurred(&mut self, id: u32) -> bool {
        if self.editing == Some(id) {
            self.editing = None;
            true
        } else {
            false
        }
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

    /// The topmost attached modal: the last in drawing order (children
    /// bottom to top, depth first).
    fn top_modal(&self) -> Option<u32> {
        if self.modals.is_empty() {
            return None;
        }
        let mut top = None;
        let mut stack = vec![ROOT_ID];
        while let Some(id) = stack.pop() {
            if id != ROOT_ID && self.modals.contains(&id) {
                top = Some(id);
            }
            if let Some(children) = self.children.get(&id) {
                // Visited bottom to top: pushed in reverse.
                stack.extend(children.iter().rev());
            }
        }
        top
    }

    /// Where a key goes now.
    pub(crate) fn target(&self) -> u32 {
        if let Some(f) = self.focused.filter(|f| self.attached(*f)) {
            return f;
        }
        match self.top_modal() {
            // Its content, as the core's `key_start` takes a root's.
            Some(m) => self
                .children
                .get(&m)
                .and_then(|c| c.iter().copied().find(|c| !self.modals.contains(c)))
                .unwrap_or(m),
            None => ROOT_ID,
        }
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
                // A held OK stays on the pressed view while it is there
                // (it pressed once; its repeats are its keys).
                Some(held)
                    if repeat && matches!(held.route, Route::Press(id) if self.attached(id)) =>
                {
                    held.route
                }
                // A key's auto-repeat goes where keys go now (a list's
                // items each moving the focus on), as NSH's web and macOS
                // backends pick its view per event.
                Some(_) if repeat => match self.fresh(false, requested) {
                    Route::Press(id) => Route::Key(id),
                    route => route,
                },
                _ => self.fresh(enter, requested),
            };
            let reached = match route {
                Route::Key(id) | Route::Press(id) => self.ancestry(id),
                Route::Drop => Vec::new(),
            };
            self.held.insert(code, Held { route, reached });
            return route;
        }
        let Some(held) = self.held.remove(&code) else {
            return Route::Drop;
        };
        // The release goes to the last down's view, or, if it left, to the
        // nearest view that heard that down and is still there; never to a
        // view that heard no down.
        let Some(&to) = held.reached.iter().find(|v| self.attached(**v)) else {
            return Route::Drop;
        };
        match held.route {
            Route::Press(id) if id == to => Route::Press(id),
            _ => Route::Key(to),
        }
    }

    /// `id` and its ancestors, nearest first.
    fn ancestry(&self, mut id: u32) -> Vec<u32> {
        let mut out = vec![id];
        while let Some(&p) = self.parent.get(&id) {
            if out.len() > 10_000 {
                break;
            }
            out.push(p);
            id = p;
        }
        out
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

    fn modal(r: &mut Routes, id: u32, parent: u32, before: Option<u32>, content: u32) {
        r.apply(&MountItem::Create {
            id,
            kind: ViewKind::Modal,
        });
        r.apply(&MountItem::Insert {
            parent,
            child: id,
            before,
        });
        insert(r, id, content);
    }

    #[test]
    fn an_open_modal_takes_keys_without_a_focus() {
        let mut r = tree();
        modal(&mut r, 9, 1, None, 10);
        assert_eq!(r.target(), 10, "the modal's content");
        r.apply(&MountItem::Remove { id: 9 });
        assert_eq!(r.target(), ROOT_ID);
    }

    #[test]
    fn the_topmost_modal_is_the_last_drawn() {
        let mut r = tree();
        modal(&mut r, 9, 1, None, 10);
        // Inserted later but below 9 in drawing order.
        modal(&mut r, 11, 1, Some(9), 12);
        assert_eq!(r.target(), 10);
        // A modal opened from inside another is above it.
        modal(&mut r, 13, 10, None, 14);
        assert_eq!(r.target(), 14);
    }

    #[test]
    fn an_edited_input_loses_the_focus_before_a_view_takes_it() {
        let mut r = tree();
        r.apply(&MountItem::Create {
            id: 20,
            kind: ViewKind::Input,
        });
        insert(&mut r, 2, 20);
        r.input_focused(20);
        focus(&mut r, 4);
        assert_eq!(r.transitions, [(20, false), (4, true)]);
        assert!(!r.input_blurred(20), "its Blur was reported already");
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
    fn repeats_follow_the_focus_and_releases_their_downs() {
        let mut r = tree();
        focus(&mut r, 4);
        assert_eq!(r.route(40, false, true, false, 0), Route::Key(4));
        // Held Down: each repeat goes where the focus is now.
        focus(&mut r, 3);
        assert_eq!(r.route(40, false, true, true, 0), Route::Key(3));
        assert_eq!(
            r.route(40, false, false, false, 0),
            Route::Key(3),
            "to the last down's view"
        );
        assert_eq!(
            r.route(40, false, false, false, 0),
            Route::Drop,
            "no press held"
        );
        // The view the down reached left: the release goes to the nearest
        // ancestor that heard it, never to a view that heard none.
        assert_eq!(r.route(417, false, true, false, 0), Route::Key(3));
        r.apply(&MountItem::Remove { id: 3 });
        r.end_batch();
        focus(&mut r, 4);
        assert_eq!(
            r.route(417, false, false, false, 0),
            Route::Key(2),
            "3's parent, not 4"
        );
    }

    #[test]
    fn a_held_press_keeps_its_family() {
        let mut r = tree();
        focus(&mut r, 3);
        assert_eq!(r.route(13, true, true, false, 0), Route::Press(3));
        assert_eq!(
            r.route(13, true, true, true, 0),
            Route::Press(3),
            "a repeat is the press's"
        );
        assert_eq!(r.route(13, true, false, false, 0), Route::Press(3));
        // The pressed view goes: the release is a key for the nearest view
        // that heard the down, never a press of another.
        assert_eq!(r.route(13, true, true, false, 0), Route::Press(3));
        r.apply(&MountItem::Remove { id: 3 });
        r.end_batch();
        focus(&mut r, 4);
        assert_eq!(r.route(13, true, false, false, 0), Route::Key(2));
        // Its whole branch gone: the root heard it.
        assert_eq!(
            r.route(13, true, true, false, 0),
            Route::Key(4),
            "4 takes no presses"
        );
        r.apply(&MountItem::Remove { id: 2 });
        r.end_batch();
        assert_eq!(r.route(13, true, false, false, 0), Route::Key(ROOT_ID));
    }

    #[test]
    fn the_page_names_the_input_it_edits() {
        let mut r = tree();
        insert(&mut r, 2, 9);
        assert_eq!(r.route(403, false, true, false, 9), Route::Key(9));
        assert_eq!(r.route(403, false, false, false, 0), Route::Key(9));
    }
}
