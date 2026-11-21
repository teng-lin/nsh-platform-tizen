//! The order calls into the module run in (`ffi`'s): a call that arrives
//! while another runs, while what it made is delivered to JS, or while the
//! app starts waits behind the calls already waiting, and they run one at a
//! time, each delivered before the next. Generic over the call, so it is
//! tested on the host.

use std::collections::VecDeque;

/// Calls waiting for the runtime.
pub(crate) struct Calls<T> {
    queued: VecDeque<T>,
    /// A call runs, or its output is being delivered.
    pub(crate) busy: bool,
    /// The app is starting: its runtime is not there yet.
    pub(crate) starting: bool,
}

impl<T> Default for Calls<T> {
    fn default() -> Self {
        Calls {
            queued: VecDeque::new(),
            busy: false,
            starting: false,
        }
    }
}

impl<T> Calls<T> {
    /// `call` arrives: it is the caller's to run now (`Some`, and the
    /// queue is busy until [`Calls::next`] says none is left), or it waits.
    pub(crate) fn admit(&mut self, call: T) -> Option<T> {
        if self.busy || self.starting {
            self.queued.push_back(call);
            return None;
        }
        self.busy = true;
        Some(call)
    }

    /// The call to run after the one that just finished, or none (and the
    /// queue is free again).
    pub(crate) fn next(&mut self) -> Option<T> {
        let next = self.queued.pop_front();
        if next.is_none() {
            self.busy = false;
        }
        next
    }

    /// The start ended. Started, the queue is busy: the caller runs the
    /// first pump, then [`Calls::next`] gives what waited for the start.
    /// Failed, what waited is dropped.
    pub(crate) fn started(&mut self, ok: bool) {
        self.starting = false;
        if ok {
            self.busy = true;
        } else {
            self.queued.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_during_a_call_wait_their_turn_in_order() {
        let mut calls = Calls::default();
        let mut ran = Vec::new();
        let mut current = calls.admit(1);
        while let Some(c) = current {
            ran.push(c);
            if c == 1 {
                // Arriving during call 1 (an import calling back, or the
                // delivery of 1's output).
                assert_eq!(calls.admit(2), None);
                assert_eq!(calls.admit(3), None);
            }
            if c == 2 {
                assert_eq!(calls.admit(4), None);
            }
            current = calls.next();
        }
        assert_eq!(ran, [1, 2, 3, 4]);
        assert!(!calls.busy);
        assert_eq!(calls.admit(5), Some(5));
    }

    #[test]
    fn calls_during_the_start_run_after_it_or_go_with_it() {
        let mut calls = Calls {
            starting: true,
            ..Calls::default()
        };
        assert_eq!(calls.admit(1), None);
        assert_eq!(calls.admit(2), None);
        calls.started(true);
        // The first pump runs now (the caller's); then what waited.
        assert_eq!(calls.admit(9), None, "busy with the first pump");
        assert_eq!(calls.next(), Some(1));
        assert_eq!(calls.next(), Some(2));
        assert_eq!(calls.next(), Some(9));
        assert_eq!(calls.next(), None);
        calls.starting = true;
        assert_eq!(calls.admit(3), None);
        calls.started(false);
        assert_eq!(calls.admit(4), Some(4));
    }
}
