//! The window chrome: no macOS title bar, the traffic lights overlaid on the
//! page's own top bar. The page learns it is inside the app from an
//! initialization script (`data-shell="desktop"`, `data-attach="iterm"` when it opens
//! `overmind://attach` links, + CSS variables), not IPC.

use tauri::Url;

/// The traffic lights' `trafficLightPosition` (logical px): the close button's left edge,
/// and a y that puts the 14 px buttons at 21–35 px — centred on the web UI's 56 px top
/// bar (tao sizes the title-bar container to button + y; the buttons sit 9 px above its
/// bottom). The three buttons span x 16–76.
pub const TRAFFIC_LIGHTS: (f64, f64) = (16.0, 30.0);
/// Room the page leaves for the traffic lights at the left of its top bar (76 px + a gap).
pub const INSET_LEFT_PX: u32 = 88;
/// The height of the web UI's top bar row (the traffic lights are centred on it).
pub const TITLEBAR_HEIGHT_PX: u32 = 56;

/// The script that tells the page it is in the desktop shell and whether the
/// traffic lights are showing (they hide in full screen, so the inset collapses).
/// Runs as the initialization script of every page and again on full-screen changes.
pub fn script(fullscreen: bool) -> String {
    let inset = if fullscreen { 0 } else { INSET_LEFT_PX };
    format!(
        "(function(){{var d=document.documentElement;if(!d)return;\
d.dataset.shell='desktop';d.classList.add('shell-desktop');\
d.dataset.attach='iterm';\
d.dataset.fullscreen='{fullscreen}';\
d.style.setProperty('--titlebar-inset-left','{inset}px');\
d.style.setProperty('--titlebar-height','{TITLEBAR_HEIGHT_PX}px');}})();"
    )
}

/// The script a native menu item runs to ask the web UI for an action (`overmind:command`, the
/// UI's `APP_COMMAND_EVENT`); the page decides whether it applies (not over a dialog, …).
pub fn command(action: &'static str) -> String {
    assert!(
        action.bytes().all(|b| b.is_ascii_alphanumeric()),
        "action {action:?}"
    );
    format!("window.dispatchEvent(new CustomEvent('overmind:command',{{detail:'{action}'}}));")
}

/// The `remote.urls` pattern granting window dragging to the server's pages:
/// the server's origin, any path. `None` for an opaque origin.
pub fn drag_pattern(server: &Url) -> Option<String> {
    let origin = server.origin();
    origin
        .is_tuple()
        .then(|| format!("{}/*", origin.ascii_serialization()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_marks_the_shell_and_sets_the_inset() {
        let s = script(false);
        assert!(s.contains("d.dataset.shell='desktop'"));
        assert!(s.contains("classList.add('shell-desktop')"));
        assert!(s.contains("d.dataset.attach='iterm'"));
        assert!(s.contains("'--titlebar-inset-left','88px'"));
        assert!(s.contains("'--titlebar-height','56px'"));
        assert!(s.contains("fullscreen='false'"));
    }

    #[test]
    fn full_screen_collapses_the_inset() {
        let s = script(true);
        assert!(s.contains("'--titlebar-inset-left','0px'"));
        assert!(s.contains("fullscreen='true'"));
    }

    #[test]
    fn command_dispatches_a_dom_event() {
        assert_eq!(
            command("new"),
            "window.dispatchEvent(new CustomEvent('overmind:command',{detail:'new'}));"
        );
    }

    #[test]
    #[should_panic(expected = "action")]
    fn command_rejects_script_text() {
        command("new');alert(1);('");
    }

    #[test]
    fn drag_pattern_is_the_server_origin() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert_eq!(
            drag_pattern(&u("http://127.0.0.1:7878/")).as_deref(),
            Some("http://127.0.0.1:7878/*")
        );
        assert_eq!(
            drag_pattern(&u("http://192.0.2.10:7878/some/path?x=1")).as_deref(),
            Some("http://192.0.2.10:7878/*")
        );
        assert_eq!(
            drag_pattern(&u("https://overmind.example.com")).as_deref(),
            Some("https://overmind.example.com/*")
        );
        assert_eq!(drag_pattern(&u("data:text/plain,x")), None);
    }
}
