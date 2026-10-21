//! What happens to a URL the page navigates to or opens in a new window.

use tauri::Url;

/// Schemes handed to macOS (`open`) — editor links and mail. Anything else
/// that is not the app's own origin or http(s) is dropped.
const OS_SCHEMES: &[&str] = &["vscode", "vscode-insiders", "cursor", "mailto"];

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Load it in the app's window.
    Allow,
    /// Hand it to the OS: the default browser for http(s), the registered app otherwise.
    Open,
    /// `overmind://attach?host=<h>&session=<tmux session>`: open an iTerm tab attached to it.
    Attach {
        host: String,
        session: String,
    },
    Deny,
}

/// The app's own `overmind://` links: only `attach`, with a host and a session.
fn overmind_link(url: &Url) -> Action {
    if url.host_str() != Some("attach") {
        return Action::Deny;
    }
    let q = |k: &str| {
        url.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.is_empty())
    };
    match (q("host"), q("session")) {
        (Some(host), Some(session)) => Action::Attach { host, session },
        _ => Action::Deny,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host() == b.host()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// A navigation of the window (or of a frame in it). The app's own pages and the
/// Overmind server stay in the window; other web pages open in the browser.
pub fn navigation(url: &Url, server: &Url) -> Action {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => Action::Allow,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => Action::Allow,
        "http" | "https" if same_origin(url, server) => Action::Allow,
        "http" | "https" => Action::Open,
        s if OS_SCHEMES.contains(&s) => Action::Open,
        "overmind" => overmind_link(url),
        _ => Action::Deny,
    }
}

/// A `target="_blank"` link or `window.open`: never a second app window.
pub fn new_window(url: &Url) -> Action {
    match url.scheme() {
        "http" | "https" => Action::Open,
        s if OS_SCHEMES.contains(&s) => Action::Open,
        _ => Action::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn server_origin_stays_in_the_window() {
        let server = u("http://127.0.0.1:7878/");
        assert_eq!(
            navigation(&u("http://127.0.0.1:7878/#/s/laptop/abc"), &server),
            Action::Allow
        );
        assert_eq!(
            navigation(&u("http://127.0.0.1:7878/api/x"), &server),
            Action::Allow
        );
        assert_eq!(
            navigation(&u("tauri://localhost/index.html"), &server),
            Action::Allow
        );
        assert_eq!(navigation(&u("about:blank"), &server), Action::Allow);
    }

    #[test]
    fn other_origins_go_to_the_browser() {
        let server = u("http://127.0.0.1:7878/");
        assert_eq!(
            navigation(&u("http://127.0.0.1:7778/"), &server),
            Action::Open
        );
        assert_eq!(
            navigation(&u("https://127.0.0.1:7878/"), &server),
            Action::Open
        );
        assert_eq!(
            navigation(&u("https://github.com/owner/repo/pull/1"), &server),
            Action::Open
        );
    }

    #[test]
    fn editor_links_go_to_the_os_and_the_rest_is_dropped() {
        let server = u("http://127.0.0.1:7878/");
        assert_eq!(navigation(&u("vscode://file/tmp/x"), &server), Action::Open);
        assert_eq!(navigation(&u("cursor://file/tmp/x"), &server), Action::Open);
        assert_eq!(navigation(&u("file:///etc/passwd"), &server), Action::Deny);
        assert_eq!(navigation(&u("javascript:alert(1)"), &server), Action::Deny);
        assert_eq!(
            navigation(&u("x-apple-systempreferences:foo"), &server),
            Action::Deny
        );
    }

    #[test]
    fn new_windows_open_outside() {
        assert_eq!(new_window(&u("http://127.0.0.1:7878/api/x")), Action::Open);
        assert_eq!(new_window(&u("https://example.com/")), Action::Open);
        assert_eq!(new_window(&u("vscode://file/tmp")), Action::Open);
        assert_eq!(new_window(&u("file:///tmp")), Action::Deny);
    }

    #[test]
    fn overmind_attach_links_carry_host_and_session() {
        let server = u("http://127.0.0.1:7878/");
        assert_eq!(
            navigation(
                &u("overmind://attach?host=workstation&session=a%20b"),
                &server
            ),
            Action::Attach {
                host: "workstation".into(),
                session: "a b".into()
            }
        );
        let deny = [
            "overmind://attach?host=workstation",
            "overmind://attach?host=&session=x",
            "overmind://run?host=h&session=x",
        ];
        for d in deny {
            assert_eq!(navigation(&u(d), &server), Action::Deny, "{d}");
        }
        assert_eq!(
            new_window(&u("overmind://attach?host=h&session=x")),
            Action::Deny
        );
    }
}
