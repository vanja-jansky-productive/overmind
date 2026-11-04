//! `overmind config path|show|get|set|edit`.

use crate::core::config;
use crate::error::{Error, Result};

#[derive(clap::Subcommand, Debug, Clone)]
pub enum ConfigAction {
    /// Print where the config file lives
    Path,
    /// Print the config (with problems, if any, on stderr)
    Show {
        /// Print the effective settings (defaults filled in) instead of the file
        #[arg(long)]
        resolved: bool,
    },
    /// Print one value by dotted key (e.g. hosts.workstation.ssh)
    Get { key: String },
    /// Set one value by dotted key. VALUE is parsed as JSON when it can be
    /// (7878, true, null, {"a":1}), else taken as a string.
    Set { key: String, value: String },
    /// Open the config in $VISUAL / $EDITOR
    Edit,
}

pub fn run(action: &ConfigAction) -> Result<()> {
    let path = config::path();
    match action {
        ConfigAction::Path => {
            println!("{}", path.display());
            Ok(())
        }
        ConfigAction::Show { resolved } => {
            let l = config::load_from(&path);
            if let Some(p) = &l.problem {
                eprintln!("overmind: {p}");
            }
            if *resolved {
                let c = &l.config;
                let hosts: serde_json::Map<String, serde_json::Value> = c
                    .hosts()
                    .into_iter()
                    .map(|(k, h)| (k, serde_json::to_value(h).unwrap_or_default()))
                    .collect();
                let out = serde_json::json!({
                    "path": path.display().to_string(),
                    "exists": l.exists,
                    "self": c.self_name(),
                    "defaultHost": c.default_host(),
                    "hosts": hosts,
                    "web": {
                        "port": c.web_port(),
                        "bind": c.web.bind.clone().unwrap_or_else(|| "0.0.0.0".into()),
                        "dir": config::web_dir(c).map(|p| p.display().to_string()),
                    },
                    "tmux": crate::core::tools::tmux(),
                    "claude": c.claude.clone().unwrap_or_else(|| "claude".into()),
                    "spawnDirs": c.spawn_dir_entries_for(&c.self_name())
                        .into_iter()
                        .map(|(label, path, hidden)| {
                            let mut d = serde_json::json!({"label": label, "path": path});
                            if hidden {
                                d["hidden"] = serde_json::Value::Bool(true);
                            }
                            d
                        })
                        .collect::<Vec<_>>(),
                });
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else if l.exists {
                match std::fs::read_to_string(&path) {
                    Ok(t) => print!("{t}"),
                    Err(e) => return Err(Error::Other(format!("{}: {e}", path.display()))),
                }
            } else {
                eprintln!(
                    "overmind: no config at {} — run: overmind init",
                    path.display()
                );
                return Err(Error::exit(1, ""));
            }
            for p in l.config.problems() {
                if l.exists {
                    eprintln!("overmind: config: {p}");
                }
            }
            Ok(())
        }
        ConfigAction::Get { key } => {
            let l = config::load_from(&path);
            match config::get_path(&l.raw, key) {
                Some(serde_json::Value::String(s)) => println!("{s}"),
                Some(v) => println!("{}", serde_json::to_string_pretty(v)?),
                None => return Err(Error::exit(1, format!("{key}: not set"))),
            }
            Ok(())
        }
        ConfigAction::Set { key, value } => {
            config::patch_at(&path, key, config::parse_value(value))?;
            let l = config::load_from(&path);
            if let Some(p) = l.problem {
                eprintln!("overmind: warning: {p}");
            }
            println!("{key} = {}", value);
            if let Some(note) = restart_note(key) {
                eprintln!("overmind: {note}");
            }
            Ok(())
        }
        ConfigAction::Edit => {
            if !path.exists() {
                return Err(Error::exit(
                    1,
                    format!("no config at {} — run: overmind init", path.display()),
                ));
            }
            open_editor(&path)?;
            let l = config::load_from(&path);
            if let Some(p) = l.problem {
                return Err(Error::Other(p));
            }
            for p in l.config.problems() {
                eprintln!("overmind: config: {p}");
            }
            Ok(())
        }
    }
}

/// A key the web server reads only when it starts: what to do for it to take effect. `None`
/// for keys read on every call (the CLI's) or reloaded live (`slack.owner`, `slack.owners`, `slack.spawn`).
pub fn restart_note(key: &str) -> Option<&'static str> {
    let live = ["slack.owner", "slack.owners", "slack.spawn"];
    if live
        .iter()
        .any(|k| key == *k || key.starts_with(&format!("{k}.")))
    {
        return None;
    }
    let at_start = ["web", "slack", "inbox", "peers", "self"];
    let top = key.split('.').next().unwrap_or(key);
    at_start.contains(&top).then_some(
        "the web server reads this when it starts: restart it where it runs (launchctl kickstart -k gui/$(id -u)/overmind.web)",
    )
}

/// `$VISUAL`, else `$EDITOR`, else `vi`.
pub fn editor() -> String {
    ["VISUAL", "EDITOR"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "vi".into())
}

/// Open `path` in the user's editor and wait for it to exit.
pub fn open_editor(path: &std::path::Path) -> Result<()> {
    let editor = editor();
    // $EDITOR may carry flags (`code -w`): let the shell split it.
    let st = std::process::Command::new("sh")
        .args(["-c", &format!("{editor} \"$1\""), "overmind-edit"])
        .arg(path)
        .status()?;
    if !st.success() {
        return Err(Error::Other(format!("{editor} exited {st}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::restart_note;

    #[test]
    fn restart_note_only_for_keys_read_at_start() {
        assert!(restart_note("slack.owner").is_none());
        assert!(restart_note("slack.owners").is_none());
        assert!(restart_note("slack.spawn").is_none());
        assert!(restart_note("slack.spawn.host").is_none());
        assert!(restart_note("slack.host").is_some());
        assert!(restart_note("slack.ownerX").is_some());
        assert!(restart_note("web.port").is_some());
        assert!(restart_note("hosts.ws.ssh").is_none());
        assert!(restart_note("spawnDirs").is_none());
    }
}
