//! GitHub identities: a session spawned with one acts on GitHub as a GitHub App (a bot)
//! instead of as the user who runs the machine. Which identity a session has is decided by
//! whoever spawns it — never by the agent inside it.
//!
//! Config (`ghIdentities` in config.json, per machine; read leniently):
//!
//! ```json
//! "ghIdentities": {
//!   "bot": {
//!     "command": "gh-bot",
//!     "login": "my-app[bot]",
//!     "prompt": "optional: replaces the default system-prompt note"
//!   }
//! }
//! ```
//!
//! `command` is a `gh` wrapper that authenticates as the App (mints an installation token and
//! runs `gh` with it as `GH_TOKEN`). A spawn with `--gh-identity <name>` (or a bot recipe's
//! `ghIdentity`) launches the agent as
//!
//! ```sh
//! export OVERMIND_GH_IDENTITY=<name> GH_CONFIG_DIR=<empty dir> PATH=<shim dir>:"$PATH" &&
//!   claude --append-system-prompt "$(cat <note>)" …
//! ```
//!
//! - the note tells the agent, in its system prompt, whose name it acts in and to use `command`;
//! - in that shell `gh` is a shim for `command`, so scripts and skills calling `gh` act as the
//!   App too, and the empty `GH_CONFIG_DIR` leaves a `gh` reached by absolute path with no
//!   credentials of the user's;
//! - `OVERMIND_GH_IDENTITY` (forwarded to remote spawns) makes every session the agent spawns
//!   inherit the identity; a spawn asking for another one fails.
//!
//! The pane gets the `@overmind_gh_identity` option, which `overmind list` reports as `gh_identity`.
//! Only Claude sessions take an identity for now. `git push` is untouched (it uses the
//! machine's own ssh key). Files live in `${XDG_STATE_HOME:-~/.local/state}/overmind/gh-identities/<name>/`.

use std::path::PathBuf;

use crate::core::harness::Harness;
use crate::core::tools::{self, shq};
use crate::error::{Error, Result};

/// The env var a session's GitHub identity travels in.
pub const ENV: &str = "OVERMIND_GH_IDENTITY";
/// The tmux pane option that marks a session's GitHub identity.
pub const PANE_OPTION: &str = "@overmind_gh_identity";

/// One configured identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhIdentity {
    pub name: String,
    /// The `gh` wrapper that acts as the App.
    pub command: String,
    /// The App's GitHub login, e.g. `my-app[bot]` (defaults to the name).
    pub login: String,
    /// Replaces the default system-prompt note.
    pub prompt: Option<String>,
}

impl GhIdentity {
    /// What the agent is told, in its system prompt.
    pub fn note(&self) -> String {
        if let Some(p) = &self.prompt {
            return p.clone();
        }
        let (login, cmd) = (&self.login, &self.command);
        format!(
            "GitHub identity of this session: you act on GitHub as {login}, a GitHub App — not as the \
person who runs this machine. Use `{cmd}` for every GitHub operation (comments, reviews, \
approvals, issues, pull requests, API calls). In this session plain `gh` is an alias for \
`{cmd}`, so scripts and skills that call gh act as {login} as well. Everything you post on \
GitHub is attributed to {login}: write it as that bot, and when you report what you did, say \
it was done as {login}. Never try to act on GitHub as the person: no other tokens, no \
`gh auth`, no unsetting GH_CONFIG_DIR. git push still uses this machine's own credentials.\n"
        )
    }
}

/// A name usable in a path, an env var and a shell line unquoted.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Every identity in the config, in file order; malformed entries are skipped.
pub fn all() -> Vec<GhIdentity> {
    parse_all(&crate::core::config::get().gh_identities)
}

fn parse_all(raw: &serde_json::Value) -> Vec<GhIdentity> {
    let Some(map) = raw.as_object() else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, v)| {
            let s = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .map(str::trim)
                    .filter(|x| !x.is_empty())
                    .map(str::to_string)
            };
            valid_name(name).then_some(())?;
            Some(GhIdentity {
                name: name.clone(),
                command: s("command")?,
                login: s("login").unwrap_or_else(|| name.clone()),
                prompt: s("prompt"),
            })
        })
        .collect()
}

/// The configured identity called `name`.
pub fn get(name: &str) -> Result<GhIdentity> {
    let all = all();
    all.iter().find(|i| i.name == name).cloned().ok_or_else(|| {
        let known: Vec<&str> = all.iter().map(|i| i.name.as_str()).collect();
        Error::Other(format!(
            "no GitHub identity '{name}' in this machine's overmind config (ghIdentities: {})",
            if known.is_empty() {
                "none".to_string()
            } else {
                known.join(", ")
            }
        ))
    })
}

/// The identity this process runs under (`OVERMIND_GH_IDENTITY`), if any.
pub fn current() -> Option<String> {
    std::env::var(ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Adopt `--gh-identity <name>` for this process, so every spawn it makes (here or, through
/// the forwarded env, on another host) gets it. A process that already runs under an identity
/// cannot switch to another: a session's spawns inherit its identity.
pub fn adopt(requested: &str) -> Result<()> {
    let requested = requested.trim();
    if !valid_name(requested) {
        return Err(Error::Other(format!(
            "invalid GitHub identity name '{requested}' (letters, digits, - and _)"
        )));
    }
    check_inherit(current().as_deref(), requested)?;
    // SAFETY: called once from `main` before any thread is started.
    unsafe { std::env::set_var(ENV, requested) };
    Ok(())
}

fn check_inherit(inherited: Option<&str>, requested: &str) -> Result<()> {
    match inherited {
        Some(cur) if cur != requested => Err(Error::Other(format!(
            "this session acts on GitHub as '{cur}'; what it spawns inherits that identity \
— it cannot spawn as '{requested}'"
        ))),
        _ => Ok(()),
    }
}

fn base_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"))
        .join("overmind")
        .join("gh-identities")
}

/// Paths of an identity's files.
struct Files {
    bin: PathBuf,
    config: PathBuf,
    note: PathBuf,
}

fn files(name: &str) -> Files {
    let d = base_dir().join(name);
    Files {
        bin: d.join("bin"),
        config: d.join("gh-config"),
        note: d.join("note.md"),
    }
}

/// The `gh` shim: drops its own dir from PATH (so `command` finds the real gh) and runs `command`.
fn shim_script(id: &GhIdentity, bin: &str) -> String {
    format!(
        "#!/bin/sh\n\
# overmind: gh for the GitHub identity '{name}' — runs `{cmd}` (ghIdentities in the overmind config)\n\
PATH=$(printf '%s' \"$PATH\" | tr ':' '\\n' | grep -vxF {bin} | paste -sd: -)\n\
export PATH\n\
exec {cmd} \"$@\"\n",
        name = id.name,
        cmd = id.command,
        bin = shq(bin),
    )
}

/// Write the identity's shim, empty gh config dir and note (idempotent).
fn prepare(id: &GhIdentity) -> Result<Files> {
    use std::os::unix::fs::PermissionsExt;
    let f = files(&id.name);
    std::fs::create_dir_all(&f.bin)?;
    std::fs::create_dir_all(&f.config)?;
    let gh = f.bin.join("gh");
    std::fs::write(&gh, shim_script(id, &f.bin.display().to_string()))?;
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755))?;
    std::fs::write(&f.note, id.note())?;
    Ok(f)
}

const EXPORT_PREFIX: &str = "export OVERMIND_GH_IDENTITY=";

fn wrap_with(launcher: &str, name: &str, f: &Files) -> String {
    format!(
        "{EXPORT_PREFIX}{name} GH_CONFIG_DIR={} PATH={}:\"$PATH\" && {launcher} --append-system-prompt \"$(cat {})\"",
        shq(&f.config.display().to_string()),
        shq(&f.bin.display().to_string()),
        shq(&f.note.display().to_string()),
    )
}

/// The launcher for a session with `identity` (`None` = the user's own: unchanged).
pub fn wrap(launcher: &str, harness: Harness, identity: Option<&str>) -> Result<String> {
    let Some(name) = identity else {
        return Ok(launcher.to_string());
    };
    if harness != Harness::Claude {
        return Err(Error::Other(format!(
            "GitHub identity '{name}': only Claude sessions take one for now, not {}",
            harness.label()
        )));
    }
    let id = get(name)?;
    if crate::core::hosts::dry_run() {
        return Ok(wrap_with(launcher, &id.name, &files(&id.name)));
    }
    let f = prepare(&id)?;
    Ok(wrap_with(launcher, &id.name, &f))
}

/// [`wrap`] with the identity this process runs under (`--gh-identity` or inherited).
pub fn wrap_current(launcher: &str, harness: Harness) -> Result<String> {
    wrap(launcher, harness, current().as_deref())
}

/// The identity a launcher made by [`wrap`] carries, if any.
pub fn in_launcher(launcher: &str) -> Option<&str> {
    let rest = launcher.strip_prefix(EXPORT_PREFIX)?;
    let name = rest.split(' ').next()?;
    valid_name(name).then_some(name)
}

/// Mark a tmux pane with its identity. Best effort: the shell already carries it.
pub fn tag_pane(target: &str, name: &str) {
    let _ = tools::tmux_cmd()
        .args(["set-option", "-p", "-t", target, PANE_OPTION, name])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_leniently() {
        let raw = json!({
            "bot": { "command": "gh-bot", "login": "my-app[bot]" },
            "plain": { "command": " gh-plain " },
            "nocmd": { "login": "x" },
            "bad name": { "command": "x" },
            "notobj": 3
        });
        let ids = parse_all(&raw);
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0].login, "my-app[bot]");
        assert_eq!(ids[1].command, "gh-plain");
        assert_eq!(ids[1].login, "plain");
        assert!(parse_all(&json!(null)).is_empty());
    }

    #[test]
    fn note_names_login_and_command_unless_overridden() {
        let mut id = GhIdentity {
            name: "bot".into(),
            command: "gh-bot".into(),
            login: "my-app[bot]".into(),
            prompt: None,
        };
        let n = id.note();
        assert!(
            n.contains("as my-app[bot]") && n.contains("`gh-bot`"),
            "{n}"
        );
        id.prompt = Some("custom".into());
        assert_eq!(id.note(), "custom");
    }

    #[test]
    fn inherited_identity_cannot_change() {
        assert!(check_inherit(None, "bot").is_ok());
        assert!(check_inherit(Some("bot"), "bot").is_ok());
        let e = check_inherit(Some("bot"), "other").unwrap_err().to_string();
        assert!(e.contains("'bot'") && e.contains("'other'"), "{e}");
    }

    #[test]
    fn wrapped_launcher_round_trips_the_name() {
        let f = Files {
            bin: "/s/bot/bin".into(),
            config: "/s/bot/gh-config".into(),
            note: "/s/bot/note.md".into(),
        };
        let l = wrap_with("claude --model opus", "bot", &f);
        assert_eq!(
            l,
            "export OVERMIND_GH_IDENTITY=bot GH_CONFIG_DIR='/s/bot/gh-config' PATH='/s/bot/bin':\"$PATH\" \
&& claude --model opus --append-system-prompt \"$(cat '/s/bot/note.md')\""
        );
        assert_eq!(in_launcher(&l), Some("bot"));
        assert_eq!(in_launcher("claude"), None);
    }

    #[test]
    fn wrap_without_identity_is_a_no_op_and_other_harnesses_refuse() {
        assert_eq!(wrap("claude", Harness::Claude, None).unwrap(), "claude");
        assert!(wrap("codex", Harness::Codex, Some("bot")).is_err());
    }

    #[test]
    fn valid_names() {
        assert!(valid_name("overmind-bot_2"));
        assert!(!valid_name(""));
        assert!(!valid_name("a b"));
        assert!(!valid_name("a;b"));
    }

    #[test]
    fn shim_drops_its_dir_and_execs_the_command() {
        let id = GhIdentity {
            name: "bot".into(),
            command: "gh-bot".into(),
            login: "bot".into(),
            prompt: None,
        };
        let s = shim_script(&id, "/s/bot/bin");
        assert!(s.contains("grep -vxF '/s/bot/bin'"), "{s}");
        assert!(s.ends_with("exec gh-bot \"$@\"\n"), "{s}");
    }
}
