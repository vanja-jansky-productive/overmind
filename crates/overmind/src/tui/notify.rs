//! Best-effort macOS notifications: terminal-notifier when present, osascript otherwise.

use std::process::Command;
use std::sync::OnceLock;

static NOTIFIER: OnceLock<bool> = OnceLock::new();

fn has_terminal_notifier() -> bool {
    *NOTIFIER.get_or_init(|| {
        Command::new("which")
            .arg("terminal-notifier")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

pub fn notify(title: &str, message: &str) {
    // A canned overmind must not ring the real Notification Center.
    if crate::core::discovery::is_fixture() {
        return;
    }
    let _ = if has_terminal_notifier() {
        Command::new("terminal-notifier")
            .args(["-title", title, "-message", message, "-sound", "Glass"])
            .status()
    } else {
        let script = format!(
            "display notification {} with title {} sound name \"Glass\"",
            applescript_string(message),
            applescript_string(title)
        );
        Command::new("osascript").args(["-e", &script]).status()
    };
}

fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}
