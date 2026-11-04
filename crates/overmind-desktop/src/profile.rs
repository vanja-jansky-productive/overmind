//! Which app this binary is. With no profile it is Overmind.app; a profile
//! (`Contents/Resources/profile.json`, written by `bundle.sh --profile …`) turns the
//! same shell into a plain window on another web app: its own name and bundle
//! identifier, a fixed remote URL, and none of Overmind's extras (local server,
//! `overmind://` links, menu commands). Its title bar is native unless the profile asks
//! for Overmind's overlay chrome (`"titleBar": "overlay"`).

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::Url;

/// Points at a profile file instead of the bundle's (for `cargo run`).
pub const PROFILE_ENV: &str = "OVERMIND_DESKTOP_PROFILE";

/// A web app other than Overmind, at a remote URL.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Remote {
    /// The app's name: menu, window title, start page.
    pub name: String,
    /// Tauri's identifier: keeps single-instance, window state and the app's
    /// config dir apart from Overmind.app's (Info.plist carries the same one).
    pub identifier: String,
    /// The URL baked in at bundle time.
    #[serde(default)]
    pub url: Option<String>,
    /// An env var that overrides `url` (e.g. `FIN_DESKTOP_URL`).
    #[serde(default)]
    pub url_env: Option<String>,
    /// The window chrome; the page has to handle `overlay` (see `shell`).
    #[serde(default)]
    pub title_bar: TitleBar,
    /// Other origins the page may load in a frame (e.g. Overmind's embed view, an `<iframe>`
    /// panel); without one, a frame's navigation there would open in the browser.
    #[serde(default)]
    pub frame_origins: Vec<String>,
}

/// `native`: the macOS title bar. `overlay`: Overmind's chrome — no title bar, the traffic
/// lights over the page's own top bar, the page script and the window-drag grant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleBar {
    #[default]
    Native,
    Overlay,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Profile {
    Overmind,
    Remote(Remote),
}

impl Profile {
    pub fn name(&self) -> &str {
        match self {
            Profile::Overmind => "Overmind",
            Profile::Remote(r) => &r.name,
        }
    }

    pub fn is_overmind(&self) -> bool {
        matches!(self, Profile::Overmind)
    }

    /// Origins a frame of the page may navigate to (Overmind.app has none: everything it shows is its server's).
    pub fn frame_origins(&self) -> Vec<Url> {
        match self {
            Profile::Overmind => Vec::new(),
            Profile::Remote(r) => r
                .frame_origins
                .iter()
                .filter_map(|o| Url::parse(o).ok())
                .collect(),
        }
    }

    /// Overmind's overlay chrome: always for Overmind, opt-in for another profile.
    pub fn overlay(&self) -> bool {
        match self {
            Profile::Overmind => true,
            Profile::Remote(r) => r.title_bar == TitleBar::Overlay,
        }
    }
}

/// `$OVERMIND_DESKTOP_PROFILE`, else `profile.json` in the bundle's Resources, else Overmind.
pub fn load() -> Result<Profile, String> {
    if let Some(p) = std::env::var_os(PROFILE_ENV).filter(|p| !p.is_empty()) {
        return read(Path::new(&p));
    }
    match bundled() {
        Some(p) if p.exists() => read(&p),
        _ => Ok(Profile::Overmind),
    }
}

/// `<App>.app/Contents/Resources/profile.json`, next to `Contents/MacOS/<exe>`.
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.parent()?.join("Resources/profile.json"))
}

pub fn read(path: &Path) -> Result<Profile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn parse(text: &str) -> Result<Profile, String> {
    let r: Remote = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if r.name.trim().is_empty() || r.identifier.trim().is_empty() {
        return Err("name and identifier must not be empty".into());
    }
    for o in &r.frame_origins {
        match Url::parse(o) {
            Ok(u) if matches!(u.scheme(), "http" | "https") && u.host().is_some() => {}
            _ => return Err(format!("frameOrigins: not an http(s) origin: {o}")),
        }
    }
    Ok(Profile::Remote(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_remote_profile() {
        let p = parse(
            r#"{ "name": "Example", "identifier": "dev.example.app",
                 "url": "https://app.example.com:4443", "urlEnv": "EXAMPLE_URL" }"#,
        )
        .unwrap();
        assert_eq!(p.name(), "Example");
        assert!(!p.is_overmind());
        let Profile::Remote(r) = p else { panic!() };
        assert_eq!(r.url.as_deref(), Some("https://app.example.com:4443"));
        assert_eq!(r.url_env.as_deref(), Some("EXAMPLE_URL"));
        assert_eq!(r.title_bar, TitleBar::Native);
    }

    #[test]
    fn overlay_chrome_is_opt_in() {
        let p = parse(r#"{ "name": "X", "identifier": "x", "titleBar": "overlay" }"#).unwrap();
        assert!(p.overlay());
        assert!(Profile::Overmind.overlay());
        assert!(
            !parse(r#"{ "name": "X", "identifier": "x" }"#)
                .unwrap()
                .overlay()
        );
        assert!(parse(r#"{ "name": "X", "identifier": "x", "titleBar": "hidden" }"#).is_err());
    }

    #[test]
    fn frame_origins_are_http_urls() {
        let p = parse(
            r#"{ "name": "X", "identifier": "x", "frameOrigins": ["https://overmind.example.com:7443"] }"#,
        )
        .unwrap();
        assert_eq!(
            p.frame_origins(),
            vec![Url::parse("https://overmind.example.com:7443").unwrap()]
        );
        assert!(
            parse(r#"{ "name": "X", "identifier": "x" }"#)
                .unwrap()
                .frame_origins()
                .is_empty()
        );
        assert!(Profile::Overmind.frame_origins().is_empty());
        for bad in ["file:///tmp", "not a url", "javascript:alert(1)"] {
            let text =
                format!(r#"{{ "name": "X", "identifier": "x", "frameOrigins": ["{bad}"] }}"#);
            assert!(parse(&text).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_bad_profiles() {
        assert!(parse(r#"{ "name": "", "identifier": "x" }"#).is_err());
        assert!(parse(r#"{ "name": "X" }"#).is_err());
        assert!(parse(r#"{ "name": "X", "identifier": "x", "localServer": true }"#).is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn no_profile_is_overmind() {
        assert_eq!(Profile::Overmind.name(), "Overmind");
        assert!(Profile::Overmind.is_overmind());
        let dir = tempfile::tempdir().unwrap();
        assert!(read(&dir.path().join("missing.json")).is_err());
    }
}
