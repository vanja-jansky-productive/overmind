//! Small environment helpers: locating binaries, expanding `~`, shell quoting.
//!
//! A `overmind` started over ssh runs under a non-login shell whose PATH often lacks
//! Homebrew and `~/.local/bin`, so every external tool is resolved here, with the
//! usual install locations as fallbacks, instead of trusting a bare name.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Directories searched after `$PATH`.
pub fn fallback_dirs() -> Vec<PathBuf> {
    fallback_dirs_in(dirs::home_dir().as_deref())
}

/// [`fallback_dirs`] for a given home: Homebrew and `/usr/local/bin`, then the per-user bins —
/// `~/.local/bin`, `~/.cargo/bin`, `~/bin` and the ones npm-installed CLIs (Codex) land in: a
/// `~/.npm-global` prefix, Volta, fnm's default alias, and every nvm-installed Node, newest first.
pub fn fallback_dirs_in(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        for rel in [
            ".local/bin",
            ".cargo/bin",
            "bin",
            ".npm-global/bin",
            ".volta/bin",
            ".local/share/fnm/aliases/default/bin",
            "Library/Application Support/fnm/aliases/default/bin",
        ] {
            dirs.push(home.join(rel));
        }
        dirs.extend(nvm_bins(&home.join(".nvm/versions/node")));
    }
    dirs
}

/// `<dir>/<version>/bin` for each Node nvm installed, newest version first (a name that is
/// not `v<major>.<minor>.<patch>` sorts last).
fn nvm_bins(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut versions: Vec<(Option<(u32, u32, u32)>, String)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .map(|name| {
            let mut parts = name
                .trim_start_matches('v')
                .split('.')
                .map(str::parse::<u32>);
            let v = match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(Ok(a)), Some(Ok(b)), Some(Ok(c)), None) => Some((a, b, c)),
                _ => None,
            };
            (v, name)
        })
        .collect();
    versions.sort_by(|a, b| b.cmp(a));
    versions
        .into_iter()
        .map(|(_, name)| dir.join(name).join("bin"))
        .collect()
}

/// `$PATH` with the fallback dirs appended — for a child that itself looks things up
/// (pi's launcher is a script that runs `node`).
pub fn search_path() -> std::ffi::OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::env::split_paths(&path).chain(fallback_dirs())).unwrap_or(path)
}

pub fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// First executable called `name` on `$PATH`, then in the fallback dirs.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    find_in(name, std::env::split_paths(&path).chain(fallback_dirs()))
}

/// First executable called `name` in `dirs`, in order.
pub fn find_in(name: &str, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

/// `explicit` (a configured path, `~` allowed) when set, else [`find_binary`],
/// else the bare name so the spawn reports a clear "not found".
pub fn resolve_binary(name: &str, explicit: Option<&str>) -> String {
    if let Some(e) = explicit.map(str::trim).filter(|e| !e.is_empty()) {
        return expand_tilde(e);
    }
    find_binary(name)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// The tmux binary: `$OVERMIND_TMUX`, then config `tmux`, then PATH + fallbacks.
/// Resolved once per process.
pub fn tmux() -> &'static str {
    static TMUX: OnceLock<String> = OnceLock::new();
    TMUX.get_or_init(|| {
        let env = std::env::var("OVERMIND_TMUX").ok();
        let cfg = crate::core::config::load().config.tmux.clone();
        resolve_binary("tmux", env.as_deref().or(cfg.as_deref()))
    })
}

/// A `tmux` command with `-u`: without a UTF-8 locale (launchd, cron, `env -i`) tmux
/// escapes non-ASCII and control characters in its output — `-F` tab separators come
/// back as `_`, so pane discovery found nothing — and mangles UTF-8 typed via send-keys.
pub fn tmux_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new(tmux());
    cmd.arg("-u");
    cmd
}

/// The `claude` binary used for headless naming calls.
pub fn claude() -> Option<String> {
    find_binary("claude")
        .or_else(|| {
            dirs::home_dir()
                .map(|h| h.join(".claude/local/claude"))
                .filter(|p| is_executable(p))
        })
        .map(|p| p.display().to_string())
}

/// Expand a leading `~` / `~/` against `$HOME`. Anything else passes through.
pub fn expand_tilde(p: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return p.to_string();
    };
    if p == "~" {
        return home.display().to_string();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home.join(rest).display().to_string();
    }
    p.to_string()
}

/// Overmind's state dir: `${XDG_STATE_HOME:-~/.local/state}/overmind` (`~` expanded, like
/// the web server's `overmindStateDir`). Each kind of state lives in its own file or dir here.
pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"))
        .join("overmind")
}

/// Rewrite an absolute path under this machine's `$HOME` to `~/…`, so it means
/// "the same place under *your* home" on a remote host.
pub fn tildify(p: &str) -> String {
    match dirs::home_dir().and_then(|h| h.to_str().map(String::from)) {
        Some(home) if p == home => "~".into(),
        Some(home) if p.starts_with(&format!("{home}/")) => format!("~{}", &p[home.len()..]),
        _ => p.to_string(),
    }
}

/// Single-quote a value for a POSIX shell.
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Quote an argument only when it needs it — keeps dry-run output readable.
/// A leading `=` is quoted too: zsh expands `=word` to a command path.
pub fn shq_min(s: &str) -> String {
    if !s.is_empty()
        && !s.starts_with('=')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/@%+,:=-".contains(c))
    {
        s.to_string()
    } else {
        shq(s)
    }
}

/// A path for a remote shell: `~` / `~/x` becomes `"$HOME"/x` so it expands over
/// there; anything else is quoted.
pub fn remote_path(p: &str) -> String {
    if p == "~" {
        return "\"$HOME\"".into();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return format!("\"$HOME\"/{}", shq_min(rest));
    }
    shq(p)
}

/// Truthy env flag: `1`, `true`, `yes`.
pub fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

/// Is stdin *and* stdout a terminal?
pub fn interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Short hostname, lowercased (`hostname -s`), used only as a default name.
pub fn short_hostname() -> String {
    std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_lowercase())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "local".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(shq("a b"), "'a b'");
        assert_eq!(shq("it's"), r"'it'\''s'");
        assert_eq!(shq_min("plain-word_1"), "plain-word_1");
        assert_eq!(shq_min("two words"), "'two words'");
        assert_eq!(shq_min(""), "''");
        assert_eq!(shq_min("=session:"), "'=session:'");
        assert_eq!(shq_min("a=b"), "a=b");
    }

    #[test]
    fn remote_paths_expand_over_there() {
        assert_eq!(remote_path("~"), "\"$HOME\"");
        assert_eq!(remote_path("~/Code/x"), "\"$HOME\"/Code/x");
        assert_eq!(remote_path("~/a b"), "\"$HOME\"/'a b'");
        assert_eq!(remote_path("/tmp/x"), "'/tmp/x'");
    }

    fn exe(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn fallback_dirs_cover_npm_volta_fnm_and_every_nvm_node_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        for v in ["v9.11.2", "v22.1.0", "v20.10.1", "system"] {
            std::fs::create_dir_all(h.join(".nvm/versions/node").join(v).join("bin")).unwrap();
        }
        let dirs = fallback_dirs_in(Some(h));
        assert_eq!(dirs[0], PathBuf::from("/opt/homebrew/bin"));
        for rel in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".local/share/fnm/aliases/default/bin",
            "Library/Application Support/fnm/aliases/default/bin",
        ] {
            assert!(dirs.contains(&h.join(rel)), "{rel} missing from {dirs:?}");
        }
        let nvm: Vec<_> = dirs
            .iter()
            .filter_map(|d| d.strip_prefix(h.join(".nvm/versions/node")).ok())
            .map(|d| d.display().to_string())
            .collect();
        assert_eq!(
            nvm,
            ["v22.1.0/bin", "v20.10.1/bin", "v9.11.2/bin", "system/bin"]
        );
        assert_eq!(fallback_dirs_in(None).len(), 2);
    }

    #[test]
    fn a_binary_only_in_an_npm_global_or_nvm_bin_is_found() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        // only the per-user dirs: this machine's Homebrew may hold a real codex
        let user_dirs = || {
            fallback_dirs_in(Some(h))
                .into_iter()
                .filter(|d| d.starts_with(h))
        };
        exe(&h.join(".nvm/versions/node/v20.0.0/bin/codex"));
        exe(&h.join(".nvm/versions/node/v22.0.0/bin/codex"));
        assert_eq!(
            find_in("codex", user_dirs()),
            Some(h.join(".nvm/versions/node/v22.0.0/bin/codex"))
        );
        exe(&h.join(".npm-global/bin/codex"));
        assert_eq!(
            find_in("codex", user_dirs()),
            Some(h.join(".npm-global/bin/codex"))
        );
        // not executable → not found
        let plain = h.join("plain/codex");
        std::fs::create_dir_all(plain.parent().unwrap()).unwrap();
        std::fs::write(&plain, "").unwrap();
        assert_eq!(find_in("codex", [h.join("plain")]), None);
    }

    #[test]
    fn tilde_round_trip() {
        let home = dirs::home_dir().unwrap().display().to_string();
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/x"), format!("{home}/x"));
        assert_eq!(expand_tilde("/abs"), "/abs");
        assert_eq!(tildify(&format!("{home}/x/y")), "~/x/y");
        assert_eq!(tildify(&home), "~");
        assert_eq!(tildify("/elsewhere"), "/elsewhere");
        // A sibling directory that merely shares the prefix is not under $HOME.
        assert_eq!(tildify(&format!("{home}x")), format!("{home}x"));
    }
}
