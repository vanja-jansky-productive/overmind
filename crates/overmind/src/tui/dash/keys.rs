//! Pure input → [`Action`] mapping for the dashboard.
//!
//! Extracted so it can be tested exhaustively, because the naive version was
//! wrong in a way that only bit on a phone: matching on `KeyCode` alone means a
//! bare Return arriving as LF (0x0A) — which is what Termius over mosh sends —
//! decodes as `Char('j') + CONTROL` and scrolls the list instead of focusing.
//! Every arm here looks at the modifiers, and Ctrl-J is bound to Focus on purpose.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    Quit,
    /// Force an immediate poll.
    Refresh,
    Up,
    Down,
    /// Focus the terminal of the currently selected session.
    Focus,
    /// Select row `n` (0-based) **and** focus it — one keypress, one tap. The
    /// gutter shows `n + 1`, so `1` is the first row and `0` the tenth.
    JumpTo(usize),
    /// Start the rename buffer for the selected session.
    Rename,
    ToggleHelp,
    /// 1-row ⇄ 2-row items.
    ToggleRows,
    ToggleEvents,
    /// batch B: LLM-suggest a name for the selected session.
    SuggestName,
    /// batch B: LLM-suggest names for every derived-name session.
    SuggestNameAll,
}

/// What a key press means while the rename buffer is open.
///
/// Separate from [`Action`] because the buffer reads keys as text, but it still
/// has to agree with [`action`] about the control chords — the first version of
/// this lived inline in the event loop, drifted, and left the buffer
/// uncommittable from a phone (Return arrives as Ctrl-J, which fell through).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenameAction {
    /// Not a key the buffer cares about — stay open, unchanged.
    None,
    /// Apply the buffer to the pinned session.
    Commit,
    /// Discard the buffer, keep the dashboard.
    Cancel,
    /// Delete the last character.
    Backspace,
    /// Append a literal character.
    Insert(char),
    /// Ctrl-C: leave the dashboard entirely, even mid-rename.
    Quit,
}

/// Map a key press to a [`RenameAction`]. Pure — no app state, no side effects.
pub fn rename_action(k: KeyEvent) -> RenameAction {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let alt = k.modifiers.contains(KeyModifiers::ALT);

    if ctrl {
        return match k.code {
            KeyCode::Char('c') => RenameAction::Quit,
            // LF-as-Return: Termius' on-screen ⏎ sends 0x0A, which crossterm
            // decodes as Ctrl-J. The header promises "⏎ apply", so honour it.
            KeyCode::Char('j') | KeyCode::Char('m') => RenameAction::Commit,
            // 0x08 — some mobile clients send it where a desktop sends DEL.
            KeyCode::Char('h') => RenameAction::Backspace,
            // Ctrl-U/Ctrl-W-style line editing isn't wired up; stay inert rather
            // than typing a stray control character into the name.
            _ => RenameAction::None,
        };
    }
    if alt {
        return RenameAction::None;
    }
    match k.code {
        KeyCode::Esc => RenameAction::Cancel,
        KeyCode::Enter => RenameAction::Commit,
        KeyCode::Backspace | KeyCode::Delete => RenameAction::Backspace,
        KeyCode::Char(c) => RenameAction::Insert(c),
        _ => RenameAction::None,
    }
}

/// Map a key press to an action. Pure — no app state, no side effects.
///
/// Callers must route the rename buffer *before* this (through
/// [`rename_action`]): while renaming, keys are literal text and must not be
/// interpreted as commands.
pub fn action(k: KeyEvent) -> Action {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let alt = k.modifiers.contains(KeyModifiers::ALT);

    if ctrl {
        // Deliberately short: every other Ctrl-<letter> used to leak into its
        // bare-letter binding (Ctrl-Q quit, Ctrl-R refreshed, Ctrl-K scrolled).
        return match k.code {
            KeyCode::Char('c') => Action::Quit,
            // LF-as-Return. See the module docs.
            KeyCode::Char('j') => Action::Focus,
            KeyCode::Char('n') => Action::SuggestNameAll,
            _ => Action::None,
        };
    }
    if alt {
        return Action::None;
    }
    match k.code {
        KeyCode::Char('q') | KeyCode::Esc => Action::Quit,
        KeyCode::Char('r') => Action::Refresh,
        KeyCode::Char('n') => Action::Rename,
        KeyCode::Char('N') => Action::SuggestName,
        KeyCode::Char('?') => Action::ToggleHelp,
        KeyCode::Char('z') => Action::ToggleRows,
        KeyCode::Char('e') => Action::ToggleEvents,
        KeyCode::Up | KeyCode::Char('k') => Action::Up,
        KeyCode::Down | KeyCode::Char('j') => Action::Down,
        // Enter is unreliable over some mobile SSH clients, so give Focus four
        // more ways in — space is the easiest thing to hit on a phone keyboard.
        KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Char('l') | KeyCode::Char('o') => {
            Action::Focus
        }
        KeyCode::Char(c @ '1'..='9') => Action::JumpTo(c as usize - '1' as usize),
        KeyCode::Char('0') => Action::JumpTo(9),
        _ => Action::None,
    }
}

/// Map a mouse event to an action. `list` is the **inner** area the session rows
/// are drawn into (borders already excluded), `offset` the first visible row and
/// `item_height` the terminal rows one session occupies (1 or 2).
///
/// A left click selects *and* focuses: on a phone there is no second tap.
pub fn mouse_action(ev: MouseEvent, list: Rect, offset: usize, item_height: u16) -> Action {
    match ev.kind {
        MouseEventKind::ScrollUp => Action::Up,
        MouseEventKind::ScrollDown => Action::Down,
        MouseEventKind::Down(MouseButton::Left) => {
            let inside = ev.row >= list.y
                && ev.row < list.y.saturating_add(list.height)
                && ev.column >= list.x
                && ev.column < list.x.saturating_add(list.width);
            if !inside {
                return Action::None;
            }
            let h = item_height.max(1);
            Action::JumpTo(offset + ((ev.row - list.y) / h) as usize)
        }
        _ => Action::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventKind;

    fn key(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }
    fn bare(code: KeyCode) -> Action {
        action(key(code, KeyModifiers::NONE))
    }
    fn ctrl(c: char) -> Action {
        action(key(KeyCode::Char(c), KeyModifiers::CONTROL))
    }

    #[test]
    fn every_way_to_focus() {
        assert_eq!(bare(KeyCode::Enter), Action::Focus);
        assert_eq!(bare(KeyCode::Char(' ')), Action::Focus);
        assert_eq!(bare(KeyCode::Char('l')), Action::Focus);
        assert_eq!(bare(KeyCode::Char('o')), Action::Focus);
        assert_eq!(ctrl('j'), Action::Focus);
    }

    // The bug this module exists for: Termius' Return sends LF, crossterm decodes
    // it as Ctrl-J, and the old `match k.code` scrolled the list instead.
    #[test]
    fn ctrl_j_is_focus_not_down() {
        assert_ne!(ctrl('j'), Action::Down);
        assert_eq!(bare(KeyCode::Char('j')), Action::Down);
        assert_eq!(bare(KeyCode::Down), Action::Down);
    }

    // Same leak in the other direction: a Ctrl-<letter> must not trigger the
    // bare-letter command.
    #[test]
    fn control_does_not_leak_into_bare_letters() {
        assert_ne!(ctrl('q'), Action::Quit);
        assert_ne!(ctrl('r'), Action::Refresh);
        assert_ne!(ctrl('k'), Action::Up);
        assert_ne!(ctrl('e'), Action::ToggleEvents);
        assert_ne!(ctrl('z'), Action::ToggleRows);
        assert_eq!(ctrl('q'), Action::None);
        assert_eq!(ctrl('r'), Action::None);
        assert_eq!(ctrl('k'), Action::None);
        // Ctrl-N is claimed by batch B, and Ctrl-C still quits.
        assert_eq!(ctrl('n'), Action::SuggestNameAll);
        assert_ne!(ctrl('n'), Action::Rename);
        assert_eq!(ctrl('c'), Action::Quit);
    }

    #[test]
    fn bare_letters_still_work() {
        assert_eq!(bare(KeyCode::Char('q')), Action::Quit);
        assert_eq!(bare(KeyCode::Esc), Action::Quit);
        assert_eq!(bare(KeyCode::Char('r')), Action::Refresh);
        assert_eq!(bare(KeyCode::Char('n')), Action::Rename);
        assert_eq!(bare(KeyCode::Char('k')), Action::Up);
        assert_eq!(bare(KeyCode::Up), Action::Up);
        assert_eq!(bare(KeyCode::Char('?')), Action::ToggleHelp);
        assert_eq!(bare(KeyCode::Char('z')), Action::ToggleRows);
        assert_eq!(bare(KeyCode::Char('e')), Action::ToggleEvents);
    }

    // Shift must not be mistaken for a control modifier — N is its own binding.
    #[test]
    fn shifted_n_is_the_batch_b_seam() {
        assert_eq!(
            action(key(KeyCode::Char('N'), KeyModifiers::SHIFT)),
            Action::SuggestName
        );
    }

    #[test]
    fn digits_jump_and_focus() {
        assert_eq!(bare(KeyCode::Char('1')), Action::JumpTo(0));
        assert_eq!(bare(KeyCode::Char('9')), Action::JumpTo(8));
        // 0 is the tenth row, so a 10-session overmind is fully reachable.
        assert_eq!(bare(KeyCode::Char('0')), Action::JumpTo(9));
    }

    #[test]
    fn alt_and_unknown_keys_do_nothing() {
        assert_eq!(
            action(key(KeyCode::Char('j'), KeyModifiers::ALT)),
            Action::None
        );
        assert_eq!(bare(KeyCode::Char('%')), Action::None);
        assert_eq!(bare(KeyCode::F(4)), Action::None);
    }

    #[test]
    fn key_kind_is_the_callers_problem() {
        // action() doesn't filter Release events — run_tui does, before calling.
        let k =
            KeyEvent::new_with_kind(KeyCode::Char('q'), KeyModifiers::NONE, KeyEventKind::Press);
        assert_eq!(action(k), Action::Quit);
    }

    // --- rename buffer -------------------------------------------------------

    fn ren(code: KeyCode, mods: KeyModifiers) -> RenameAction {
        rename_action(key(code, mods))
    }
    fn ren_ctrl(c: char) -> RenameAction {
        ren(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    // The regression: on Termius the on-screen Return is LF, crossterm hands it
    // over as Ctrl-J, and the inline `Char(c) if !CONTROL` version dropped it —
    // the rename could only ever be cancelled, never applied.
    #[test]
    fn ctrl_j_commits_the_rename_buffer() {
        assert_eq!(ren_ctrl('j'), RenameAction::Commit);
        assert_eq!(
            ren(KeyCode::Enter, KeyModifiers::NONE),
            RenameAction::Commit
        );
    }

    // The documented global quit must not be dead while renaming.
    #[test]
    fn ctrl_c_quits_from_inside_the_rename_buffer() {
        assert_eq!(ren_ctrl('c'), RenameAction::Quit);
        // …and it agrees with the dashboard's own binding.
        assert_eq!(ctrl('c'), Action::Quit);
    }

    #[test]
    fn ctrl_h_deletes_like_backspace() {
        assert_eq!(ren_ctrl('h'), RenameAction::Backspace);
        assert_eq!(
            ren(KeyCode::Backspace, KeyModifiers::NONE),
            RenameAction::Backspace
        );
    }

    #[test]
    fn printable_characters_are_literal_text() {
        assert_eq!(
            ren(KeyCode::Char('n'), KeyModifiers::NONE),
            RenameAction::Insert('n')
        );
        // Bare 'q'/'z'/digits are text here, not commands.
        for c in ['q', 'z', '1', ' ', '-', 'ü'] {
            assert_eq!(
                ren(KeyCode::Char(c), KeyModifiers::NONE),
                RenameAction::Insert(c)
            );
        }
        // Shift is how a capital letter arrives; it is not a control chord.
        assert_eq!(
            ren(KeyCode::Char('N'), KeyModifiers::SHIFT),
            RenameAction::Insert('N')
        );
    }

    #[test]
    fn esc_cancels_and_other_chords_stay_inert() {
        assert_eq!(ren(KeyCode::Esc, KeyModifiers::NONE), RenameAction::Cancel);
        for c in ['a', 'z', 'n', 'q', 'r'] {
            assert_eq!(ren_ctrl(c), RenameAction::None, "ctrl-{c}");
        }
        assert_eq!(
            ren(KeyCode::Char('x'), KeyModifiers::ALT),
            RenameAction::None
        );
        assert_eq!(ren(KeyCode::F(4), KeyModifiers::NONE), RenameAction::None);
    }

    fn mouse(kind: MouseEventKind, col: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column: col,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    #[test]
    fn clicks_map_through_the_scroll_offset() {
        let list = Rect::new(1, 3, 40, 10);
        // First visible row, single-height items, nothing scrolled off.
        assert_eq!(
            mouse_action(
                mouse(MouseEventKind::Down(MouseButton::Left), 5, 3),
                list,
                0,
                1
            ),
            Action::JumpTo(0)
        );
        assert_eq!(
            mouse_action(
                mouse(MouseEventKind::Down(MouseButton::Left), 5, 7),
                list,
                0,
                1
            ),
            Action::JumpTo(4)
        );
        // Two-row items: rows 3 and 4 are both session 0.
        assert_eq!(
            mouse_action(
                mouse(MouseEventKind::Down(MouseButton::Left), 5, 4),
                list,
                0,
                2
            ),
            Action::JumpTo(0)
        );
        assert_eq!(
            mouse_action(
                mouse(MouseEventKind::Down(MouseButton::Left), 5, 5),
                list,
                0,
                2
            ),
            Action::JumpTo(1)
        );
        // Scrolled: the top visible row is session 4.
        assert_eq!(
            mouse_action(
                mouse(MouseEventKind::Down(MouseButton::Left), 5, 3),
                list,
                4,
                2
            ),
            Action::JumpTo(4)
        );
    }

    #[test]
    fn clicks_outside_the_list_are_ignored() {
        let list = Rect::new(1, 3, 40, 10);
        for (c, r) in [(5, 2), (5, 13), (0, 5), (41, 5)] {
            assert_eq!(
                mouse_action(
                    mouse(MouseEventKind::Down(MouseButton::Left), c, r),
                    list,
                    0,
                    1
                ),
                Action::None
            );
        }
    }

    #[test]
    fn wheel_moves_the_selection() {
        let list = Rect::new(0, 0, 40, 10);
        assert_eq!(
            mouse_action(mouse(MouseEventKind::ScrollUp, 5, 5), list, 0, 1),
            Action::Up
        );
        assert_eq!(
            mouse_action(mouse(MouseEventKind::ScrollDown, 5, 5), list, 0, 1),
            Action::Down
        );
        assert_eq!(
            mouse_action(mouse(MouseEventKind::Moved, 5, 5), list, 0, 1),
            Action::None
        );
    }
}
