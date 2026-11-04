//! `overmind` — see, steer and spawn Claude Code sessions and tmux sessions across
//! your machines.
//!
//! Layout:
//! - [`core`] is the reusable library: config, Claude-session discovery and
//!   backends (iTerm/tmux), LLM naming, tmux sessions, host resolution and ssh
//!   dispatch. It prints nothing; any UI (this CLI, the TUI, a web server) builds
//!   on it.
//! - [`cli`] renders the command-line verbs on top of `core`.
//! - [`tui`] is the `watch` dashboard.
//!
//! The Claude-session discovery, backends, naming and dashboard are derived from
//! `tb-fleet` in productiveio/cli-toolbox (MIT); the tmux-session and host
//! commands port a standalone shell tool with the same job.

pub mod cli;
pub mod core;
pub mod error;
pub mod tui;

/// This binary's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
