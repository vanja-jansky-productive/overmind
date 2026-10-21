//! Pure responsive layout planning for the dashboard.
//!
//! No ratatui widgets and no `Rect`s: [`plan`] takes the frame's dimensions in
//! columns and rows and answers "what fits". The reason this is its own module is
//! that the interesting sizes — a ~40-column iPhone terminal, a 16-row split pane
//! — are exactly the ones nobody renders while developing.
//!
//! The shape it plans is a **multi-line item**: the session name is the thing the
//! user orients by, so it gets a line to itself, and the prompt gets a line of its
//! own too — two lines on a desktop, three on a phone, where the terminal label
//! cannot share a line with the prompt without starving it. One line per session
//! is the opt-in (`z`, `--rows 1`) for when density beats legibility.

/// How much room the sessions block has, in three coarse regimes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Density {
    /// Desktop: the terminal label and the status column both fit on the name's
    /// line, and the prompt gets the whole second one.
    Wide,
    /// Phone: three lines, one job each — name and state, then the terminal and
    /// the directory, then the prompt across the full width. Sharing line 2 is
    /// what left the prompt fifteen columns of a forty-column pane.
    Narrow,
    /// Barely a terminal. Name and age on one line, nothing else.
    Tiny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub density: Density,
    /// Terminal rows one session occupies: 1 (compact, or Tiny), 2 (desktop) or 3
    /// (phone). Which lines those are is the row builder's business.
    pub lines: u16,
    /// Usable content width inside the sessions block — borders already excluded.
    /// Rows are built to exactly this, never wider.
    pub width: usize,
    /// Cap on the label's own width in columns before it gets ellipsised. It's a
    /// cap, not a promise: the row builder gives the label less when the
    /// right-hand status column would otherwise not fit.
    pub name_width: usize,
    pub show_cwd: bool,
    /// `false` = the status dot carries the state on its own.
    pub show_status_word: bool,
    /// Cap on the `⧉ <terminal>` cell. The row builder narrows it to the widest
    /// label the overmind actually has, so the cells line up across rows.
    pub term_cell: usize,
    /// `true` = the terminal label rides in line 1's right-hand column; `false` =
    /// it gets line 2 to itself.
    pub term_on_head: bool,
    /// `true` = this pane can name the overmind's common base directory in its block
    /// title, so rows may draw paths relative to it (and nothing at all when they
    /// *are* it). Whether such a base exists — and whether it actually fits in the
    /// title — is [`crate::tui::dash::rows::OvermindCtx`]'s call.
    pub show_base: bool,
    /// Terminal rows for the events pane; `0` = hidden.
    pub events_height: u16,
    pub borders: bool,
    /// Show the `1`-`9` index gutter that makes digit-jumping discoverable.
    pub gutter: bool,
}

impl Plan {
    /// Terminal rows one session occupies.
    pub fn item_height(&self) -> u16 {
        self.lines
    }
}

/// Width below which we stop drawing borders and take the two columns back.
const BORDER_FLOOR: usize = 40;

/// Columns a full item keeps on the right of line 1 for `status age`.
const HEAD_RESERVE: usize = 12;

/// …and what it keeps when the status word moved to line 2: just the age.
const AGE_RESERVE: usize = 6;

/// Plan a frame. `width`/`height` are the whole terminal; `rows` is how many
/// sessions there are; `longest_label` the widest session name in display
/// columns; `force_two_row` the `--rows`/`z` override — `Some(false)` is the
/// compact single line, `Some(true)` and `None` both mean "the full item, at
/// whatever height this width needs".
pub fn plan(
    width: u16,
    height: u16,
    rows: usize,
    longest_label: usize,
    force_two_row: Option<bool>,
) -> Plan {
    // The sessions block spans the frame, so its inner width depends on whether
    // we can afford borders — and below BORDER_FLOOR usable columns we can't.
    let bordered_inner = width.saturating_sub(2) as usize;
    let borders = bordered_inner >= BORDER_FLOOR;
    let inner = if borders {
        bordered_inner
    } else {
        width as usize
    };

    let density = if inner >= 70 {
        Density::Wide
    } else if inner >= 28 {
        Density::Narrow
    } else {
        // Tiny sizes the name from the row buffer's remaining room, so there is
        // no cap to compute here.
        Density::Tiny
    };
    let wide = density == Density::Wide;

    // The full item is the default; only `z`/`--rows 1` compacts it, and Tiny has
    // no second line to give in the first place.
    let lines: u16 = match (density, force_two_row) {
        (Density::Tiny, _) => 1,
        (_, Some(false)) => 1,
        (Density::Wide, _) => 2,
        // A phone gives the prompt a line of its own: sharing line 2 with the
        // terminal label left it a fifteen-column stub.
        (Density::Narrow, _) => 3,
    };
    let full = lines >= 2;

    // Under 40 columns the name and the status word can't share line 1 without the
    // name losing; the three-line item hands the word to line 2 instead (see
    // `rows::where_line`), and the name gets the columns back.
    let word_on_head = !(lines == 3 && inner < BORDER_FLOOR);
    let (name_width, show_cwd, show_status_word, term_cell) = if full {
        // The name owns line 1 up to the status column, so it is sized to the
        // pane rather than to the longest name: at a desktop width nothing the
        // user would call a session gets ellipsised.
        (
            inner
                .saturating_sub(if word_on_head {
                    HEAD_RESERVE
                } else {
                    AGE_RESERVE
                })
                .max(12),
            inner >= BORDER_FLOOR,
            word_on_head,
            if inner >= 140 {
                // A really wide pane has line 1 mostly to itself once the prompt
                // moved to line 2, so stop clipping: iTerm tab titles like
                // `▣ ✳ PR #42 retry budget persisted state (web-backend)` run to
                // fifty-odd columns and fit whole in a third of the pane. The cell
                // is data-driven (see `OvermindCtx::of`), so this only widens a row
                // when a label actually needs it.
                inner / 3
            } else if inner >= 100 {
                // Long enough for `⧉ nightly-backup-rotation-v2`: a desktop pane
                // has the columns, and a clipped terminal name is a row that
                // can't say where it will take you.
                30
            } else if wide {
                16
            } else {
                // Phone widths: the label has line 2 to itself now, so it can run
                // as long as the pane. An iTerm tab title like
                // `▣ ✳ Nightly backup rotation (web-backend)` is the most
                // informative thing on the row while the name is still `app-03`.
                inner.saturating_sub(6)
            },
        )
    } else if inner >= 100 {
        // Compact: one line per session, columns to spare.
        (longest_label.clamp(12, 32), true, true, 18)
    } else if wide {
        // Compact, and room for a prompt but not a path; the dot replaces the
        // status word.
        (longest_label.clamp(12, 26), false, false, 16)
    } else if density == Density::Narrow {
        // Compact in a pane that can't hold the columns. Size the name to the
        // data instead of reserving room for a status word we are about to drop —
        // the leftovers are better spent on the terminal name. `.max(12)` on the
        // ceiling: `clamp` panics when min > max, and a pane narrower than 24
        // columns would otherwise get there.
        (
            longest_label.clamp(12, inner.saturating_sub(HEAD_RESERVE).max(12)),
            false,
            false,
            14,
        )
    } else {
        (0, false, false, 0)
    };

    let item_height = lines;

    // Height policy. The old fixed `Length(10)` ate two thirds of a 16-row pane.
    let base_events: u16 = match height {
        h if h >= 30 => 10,
        h if h >= 24 => 8,
        h if h >= 18 => 5,
        h if h >= 12 => 3,
        _ => 0,
    };
    // Never let the events pane squeeze the sessions list below three items — the
    // `+N more ↓` line included, or a three-line item on a 12-row phone pane lost
    // a session to a row the events pane took.
    let chrome = if borders { 2 } else { 1 };
    let hint = u16::from(rows > 3);
    let need = (rows.min(3) as u16) * item_height + chrome + hint;
    let events_height = base_events.min(height.saturating_sub(1).saturating_sub(need));

    Plan {
        density,
        lines,
        width: inner,
        name_width,
        show_cwd,
        show_status_word,
        term_cell,
        // A one-line item has nowhere else to put the terminal label; the
        // three-line one hands it a line of its own.
        term_on_head: lines == 1 || wide,
        // Any pane that draws a block title can name the base in it — ten columns
        // plus the path, which even a 32-column phone pane has. Tiny draws no
        // paths, so it has nothing to explain.
        show_base: density != Density::Tiny,
        events_height,
        borders,
        // Digit-jumping is the only way to act on a row from a phone client that
        // eats Return, so the gutter is drawn wherever there is a row to number.
        gutter: density != Density::Tiny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every size worth caring about, from a full-screen desktop terminal down to
    /// a split pane on a phone.
    const SIZES: [(u16, u16); 9] = [
        (200, 50),
        (170, 40),
        (160, 40),
        (120, 40),
        (80, 24),
        (50, 20),
        (40, 16),
        (30, 10),
        (20, 5),
    ];

    // Two lines on a desktop, three on a phone — the prompt gets a line of its
    // own either way, which is the whole point of the shape.
    #[test]
    fn the_item_is_as_tall_as_the_width_makes_it() {
        let got: Vec<_> = SIZES
            .iter()
            .map(|&(w, h)| {
                let p = plan(w, h, 3, 22, None);
                (p.density, p.lines)
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (Density::Wide, 2),
                (Density::Wide, 2),
                (Density::Wide, 2),
                (Density::Wide, 2),
                (Density::Wide, 2),
                (Density::Narrow, 3),
                (Density::Narrow, 3),
                (Density::Narrow, 3),
                (Density::Tiny, 1),
            ]
        );
        // `z` compacts every one of them but the Tiny row, which is already one.
        for &(w, h) in &SIZES {
            assert_eq!(plan(w, h, 3, 22, Some(false)).lines, 1, "{w}x{h}");
        }
    }

    // The terminal label is what the row promises to focus, so a desktop width
    // puts it on the name's line and only a phone-sized pane demotes it.
    #[test]
    fn the_terminal_label_rides_line_one_until_the_pane_is_phone_sized() {
        assert!(plan(170, 40, 3, 22, None).term_on_head);
        assert!(plan(100, 30, 3, 22, None).term_on_head);
        assert!(!plan(50, 20, 3, 22, None).term_on_head);
        assert!(!plan(32, 12, 3, 22, None).term_on_head);
        // A one-line item has nowhere else to put it.
        assert!(plan(50, 20, 3, 22, Some(false)).term_on_head);
    }

    #[test]
    fn events_pane_shrinks_with_height_and_disappears_on_a_phone() {
        let got: Vec<u16> = SIZES
            .iter()
            .map(|&(w, h)| plan(w, h, 3, 22, None).events_height)
            .collect();
        assert_eq!(got, vec![10, 10, 10, 10, 8, 5, 3, 0, 0]);
    }

    #[test]
    fn borders_are_dropped_when_the_columns_are_needed_elsewhere() {
        let got: Vec<bool> = SIZES
            .iter()
            .map(|&(w, h)| plan(w, h, 3, 22, None).borders)
            .collect();
        assert_eq!(
            got,
            vec![true, true, true, true, true, true, false, false, false]
        );
        // Dropping the border hands the two columns to the content.
        assert_eq!(plan(40, 16, 3, 22, None).width, 40);
        assert_eq!(plan(50, 20, 3, 22, None).width, 48);
    }

    // The invariant that makes names readable at all: nothing narrows the name
    // column past 12 columns while there are 28 to work with.
    #[test]
    fn name_width_never_collapses_above_28_columns() {
        for w in 28..=220u16 {
            for h in [5u16, 10, 16, 20, 24, 40, 60] {
                for rows in [0usize, 1, 15] {
                    for longest in [3usize, 12, 22, 64] {
                        for forced in [None, Some(true), Some(false)] {
                            let p = plan(w, h, rows, longest, forced);
                            if p.width >= 28 {
                                assert!(
                                    p.name_width >= 12,
                                    "{w}x{h} rows={rows} longest={longest} forced={forced:?} -> {}",
                                    p.name_width
                                );
                            }
                            assert!(p.name_width <= p.width, "name wider than the pane");
                            assert!(p.term_cell <= p.width, "terminal cell wider than the pane");
                        }
                    }
                }
            }
        }
    }

    // A two-line item sizes the name to the *pane*: the whole point of the shape
    // is that `resolve-css-conflicts` is never cut at a desktop width.
    #[test]
    fn a_full_item_gives_the_name_everything_but_the_status_column() {
        assert_eq!(plan(200, 50, 3, 5, None).name_width, 198 - 12);
        assert_eq!(plan(170, 40, 3, 64, None).name_width, 168 - 12);
        assert_eq!(plan(50, 20, 3, 60, None).name_width, 48 - 12);
        // …and everything but the age once the status word moved to line 2.
        assert_eq!(plan(32, 12, 3, 60, None).name_width, 32 - 6);
    }

    #[test]
    fn compact_panes_size_the_name_column_to_the_data() {
        let one = |w, h, longest| plan(w, h, 3, longest, Some(false));
        assert_eq!(one(200, 50, 5).name_width, 12);
        assert_eq!(one(200, 50, 22).name_width, 22);
        assert_eq!(one(200, 50, 99).name_width, 32);
        // The 70..100 band is stingier, and trades the status word for the dot.
        let p = one(80, 24, 99);
        assert_eq!(p.name_width, 26);
        assert!(!p.show_status_word);
        assert!(!p.show_cwd);
    }

    #[test]
    fn narrow_panes_reserve_twelve_columns_for_status_and_age() {
        let p = plan(50, 20, 3, 60, None);
        assert_eq!(p.width, 48);
        assert_eq!(p.name_width, 36);
        assert!(p.show_status_word);
        assert!(p.show_cwd);
        assert!(p.gutter);
        // Below 40 the path and the status word go; the name takes the room.
        let p = plan(30, 10, 3, 60, None);
        assert_eq!(p.name_width, 24);
        assert!(!p.show_cwd);
        assert!(!p.show_status_word);
        assert!(p.gutter);
    }

    // Relative paths are only honest when something says what they are relative
    // to, and that something is the block title — which every pane that draws one
    // can carry. Whether the base *fits* is `OvermindCtx`'s call, not the plan's.
    #[test]
    fn every_pane_with_a_block_title_can_name_the_base_directory() {
        for (w, h) in [(170u16, 40u16), (100, 30), (50, 20), (44, 16), (32, 12)] {
            assert!(plan(w, h, 3, 22, None).show_base, "{w}x{h}");
        }
        // A Tiny row draws no paths, so it has no base to explain.
        assert!(!plan(20, 5, 3, 22, None).show_base);
        assert!(!plan(24, 10, 3, 22, None).show_base);
    }

    #[test]
    fn the_row_override_wins_except_on_a_tiny_pane() {
        assert_eq!(plan(200, 50, 3, 22, Some(true)).lines, 2);
        assert_eq!(plan(200, 50, 3, 22, Some(false)).lines, 1);
        assert_eq!(plan(50, 20, 3, 22, Some(false)).lines, 1);
        // Forced compact sizes the name to the data, not to the reserved column.
        assert_eq!(plan(50, 20, 3, 22, Some(false)).name_width, 22);
        // Tiny has no second line to give.
        assert_eq!(plan(20, 5, 3, 22, Some(true)).lines, 1);
    }

    // The digits are the phone's only reliable "act on this row", so they are
    // numbered in every mode that draws a row at all.
    #[test]
    fn the_gutter_survives_the_compact_override() {
        for forced in [None, Some(true), Some(false)] {
            assert!(plan(170, 40, 3, 22, forced).gutter, "{forced:?}");
            assert!(plan(50, 20, 3, 22, forced).gutter, "{forced:?}");
        }
        assert!(!plan(20, 5, 3, 22, None).gutter);
    }

    #[test]
    fn item_height_follows_the_row_mode() {
        assert_eq!(plan(120, 40, 3, 22, None).item_height(), 2);
        assert_eq!(plan(120, 40, 3, 22, Some(false)).item_height(), 1);
        assert_eq!(plan(50, 20, 3, 22, None).item_height(), 3);
        assert_eq!(plan(20, 5, 3, 22, None).item_height(), 1);
    }

    // Desktop panes stop clipping the terminal label: a real iTerm tab title runs
    // to fifty columns, and there is nothing else on line 1 to spend them on.
    #[test]
    fn a_really_wide_pane_lets_the_terminal_label_have_a_third_of_it() {
        assert_eq!(plan(170, 40, 3, 22, None).term_cell, 168 / 3);
        assert_eq!(plan(200, 50, 3, 22, None).term_cell, 198 / 3);
        // Narrower desktop panes keep the tighter caps.
        assert_eq!(plan(120, 40, 3, 22, None).term_cell, 30);
        assert_eq!(plan(80, 24, 3, 22, None).term_cell, 16);
    }

    // The phone item's line 2 carries the terminal label, so the label is no
    // longer squeezed into a 14-column cell next to the prompt.
    #[test]
    fn a_phone_item_gives_the_terminal_label_its_own_line() {
        let p = plan(44, 16, 3, 22, None);
        assert_eq!(p.lines, 3);
        assert!(!p.term_on_head);
        assert!(p.term_cell >= p.width - 6);
        // Compact keeps the old single-line cell, since everything shares a line.
        assert!(plan(44, 16, 3, 22, Some(false)).term_on_head);
    }

    // Under 40 columns the name and the status word can't share line 1; the word
    // moves to line 2, where there is room for it.
    #[test]
    fn a_split_phone_pane_moves_the_status_word_off_line_one() {
        assert!(plan(44, 16, 3, 22, None).show_status_word);
        assert!(plan(50, 20, 3, 22, None).show_status_word);
        assert!(!plan(32, 12, 3, 22, None).show_status_word);
        assert!(!plan(28, 12, 3, 22, None).show_status_word);
    }

    #[test]
    fn events_never_squeeze_the_list_below_three_sessions() {
        // 12 rows, three-line items: 1 header + 9 + 2 borders + the `+N more`
        // line is the whole frame, so the events pane gets nothing.
        let p = plan(50, 12, 15, 22, None);
        assert_eq!(p.events_height, 0);
        // A borderless 32-column phone pane has exactly the same problem, and the
        // third session wins there too.
        assert_eq!(plan(32, 12, 15, 22, None).events_height, 0);
        // With room for both, the events pane comes back.
        assert!(plan(50, 20, 15, 22, None).events_height > 0);
    }

    // `clamp(12, inner - 12)` panics when the ceiling drops below the floor.
    // Nothing reaches that today — the Narrow floor is 28 — so the guard is what
    // keeps a future floor change from being a crash instead of a layout tweak.
    #[test]
    fn no_width_panics_in_any_row_mode() {
        for w in 0..=220u16 {
            for forced in [None, Some(true), Some(false)] {
                let p = plan(w, 24, 3, 60, forced);
                assert!(p.name_width <= p.width.max(1));
            }
        }
    }

    #[test]
    fn degenerate_sizes_do_not_panic() {
        for (w, h) in [(0u16, 0u16), (1, 1), (2, 3), (5, 2), (300, 1)] {
            let p = plan(w, h, 0, 0, None);
            assert!(p.width <= w.max(1) as usize);
            assert_eq!(p.events_height, 0);
        }
    }
}
