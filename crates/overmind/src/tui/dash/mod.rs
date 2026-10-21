//! The `watch` dashboard, split into pure pieces so the sizes that matter can be
//! tested rather than eyeballed.
//!
//! - [`keys`] — input → action, modifier-aware.
//! - [`layout`] — what fits at a given terminal size.
//! - [`rows`] — one session → one list item, built to that plan.
//!
//! [`crate::tui::watch`] owns the loop, the state and the actual drawing.

pub mod keys;
pub mod layout;
pub mod rows;
