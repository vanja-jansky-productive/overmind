//! The opt-in Codex hook: `overmind codex hooks install` adds one command hook to
//! `PermissionRequest`, `Stop` and `UserPromptSubmit` in `$CODEX_HOME/hooks.json`
//! (default `~/.codex`). Codex runs `'<overmind>' _codex-hook` with the event on stdin;
//! [`handle_hook`] writes one sidecar per thread and prints nothing — a
//! `PermissionRequest` hook that prints a decision would approve or deny for the user.
//!
//! Sidecar (`$OVERMIND_CODEX_HOOKS_DIR`, else
//! `${XDG_STATE_HOME:-~/.local/state}/overmind/codex-hooks/<session_id>.json`, v1):
//! `{ v, thread_id, turn_id, transcript_path, state: "waiting"|"clear", event, tool,
//! command, reason, cwd, at }`. Written as `<id>.json.tmp`, then renamed.
//!
//! A sidecar (or a pending escalated call in the rollout) only *triggers* a look at the
//! terminal: discovery reads `waiting` off the screen ([`screen_shows_approval`]). Codex
//! persists nothing for a pending approval, in either mode — see
//! `docs/notes/codex-0166-findings.md`.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::error::{Error, Result};

/// The hidden subcommand Codex runs.
pub const HOOK_ARG: &str = "_codex-hook";
/// The events we hook, as hooks.json names them and as `[hooks.state]` keys spell them.
pub const EVENTS: [(&str, &str); 3] = [
    ("PermissionRequest", "permission_request"),
    ("Stop", "stop"),
    ("UserPromptSubmit", "user_prompt_submit"),
];
/// Codex's command-hook `timeout`, in seconds (`timeoutSec` in its hook metadata).
pub const TIMEOUT_SECS: u64 = 5;
/// The most of stdin the hook reads; a bigger payload is dropped.
const MAX_PAYLOAD: u64 = 1024 * 1024;
pub const SIDECAR_VERSION: u64 = 1;

// ------------------------------------------------------------------ paths

/// Where sidecars live: `$OVERMIND_CODEX_HOOKS_DIR`, else the overmind state dir.
pub fn sidecar_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("OVERMIND_CODEX_HOOKS_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"))
        .join("overmind")
        .join("codex-hooks")
}

pub fn hooks_path(codex_home: &Path) -> PathBuf {
    codex_home.join("hooks.json")
}

/// A thread id is a file name here: only `[A-Za-z0-9_-]`, never a path.
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ------------------------------------------------------------------ the hook itself

/// `overmind _codex-hook`: stdin → one sidecar. Never fails, never prints: a broken
/// write must not block or decide an approval, and it runs for every Codex process.
pub fn handle_hook(stdin: impl Read) {
    let mut buf = Vec::new();
    if stdin.take(MAX_PAYLOAD + 1).read_to_end(&mut buf).is_err() || buf.len() as u64 > MAX_PAYLOAD
    {
        return;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&buf) else {
        return;
    };
    let Some((id, sidecar)) = sidecar_from_payload(&payload, now_ms()) else {
        return;
    };
    let _ = write_sidecar(&sidecar_dir(), &id, &sidecar);
}

/// The sidecar an event writes, keyed by its `session_id`; None for events we ignore.
pub fn sidecar_from_payload(p: &Value, at: i64) -> Option<(String, Value)> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let id = s("session_id");
    if !safe_id(&id) {
        return None;
    }
    let event = s("hook_event_name");
    let state = match event.as_str() {
        "PermissionRequest" => "waiting",
        "Stop" | "UserPromptSubmit" => "clear",
        _ => return None,
    };
    let input = p.get("tool_input");
    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str);
    let (command, reason) = if state == "waiting" {
        let command = field("command")
            .map(str::to_string)
            .or_else(|| field("description").map(|d| d.lines().next().unwrap_or("").into()));
        (command, field("description").map(str::to_string))
    } else {
        (None, None)
    };
    let sidecar = json!({
        "v": SIDECAR_VERSION,
        "thread_id": id,
        "turn_id": p.get("turn_id").and_then(Value::as_str),
        "transcript_path": p.get("transcript_path").and_then(Value::as_str),
        "state": state,
        "event": event,
        "tool": p.get("tool_name").and_then(Value::as_str),
        "command": command,
        "reason": reason,
        "cwd": p.get("cwd").and_then(Value::as_str),
        "at": at,
    });
    Some((id, sidecar))
}

fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn write_sidecar(dir: &Path, id: &str, sidecar: &Value) -> std::io::Result<()> {
    ensure_dir(dir)?;
    let path = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!("{id}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(sidecar)?)?;
    std::fs::rename(&tmp, &path)
}

// ------------------------------------------------------------------ sidecar read side

/// A parsed v1 sidecar.
#[derive(Debug, Clone, PartialEq)]
pub struct Sidecar {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub waiting: bool,
    pub tool: Option<String>,
    pub command: Option<String>,
    pub reason: Option<String>,
    pub at: i64,
}

pub fn parse_sidecar(text: &str) -> Option<Sidecar> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("v")?.as_u64()? != SIDECAR_VERSION {
        return None;
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let waiting = match v.get("state")?.as_str()? {
        "waiting" => true,
        "clear" => false,
        _ => return None,
    };
    Some(Sidecar {
        thread_id: s("thread_id")?,
        turn_id: s("turn_id"),
        waiting,
        tool: s("tool"),
        command: s("command"),
        reason: s("reason"),
        at: v.get("at")?.as_i64()?,
    })
}

pub fn read_sidecar(dir: &Path, thread_id: &str) -> Option<Sidecar> {
    if !safe_id(thread_id) {
        return None;
    }
    let text = std::fs::read_to_string(dir.join(format!("{thread_id}.json"))).ok()?;
    parse_sidecar(&text).filter(|s| s.thread_id == thread_id)
}

/// Housekeeping in `list`: sidecars of threads no live row has, older than `max_age_ms`.
pub fn prune_sidecars(dir: &Path, live: &[&str], max_age_ms: i64, now: i64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if live.contains(&id) {
            continue;
        }
        let age = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| now - d.as_millis() as i64)
            .unwrap_or(0);
        if age > max_age_ms {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ------------------------------------------------------------------ hooks.json

/// POSIX single-quoting: Codex runs command hooks through a shell.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The command line our hook runs.
pub fn hook_command(exe: &Path) -> String {
    format!("{} {HOOK_ARG}", shell_quote(&exe.to_string_lossy()))
}

/// A shell command split into words (quotes and backslashes honoured; nothing expanded).
fn shell_words(s: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => cur.push(c),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => cur.push(chars.next()?),
                        c => cur.push(c),
                    }
                }
            }
            '\\' => {
                in_word = true;
                cur.push(chars.next()?);
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Some(words)
}

/// The binary of a command that is ours (`<exe> _codex-hook`), else None.
pub fn our_binary(command: &str) -> Option<String> {
    let w = shell_words(command)?;
    (w.len() == 2 && w[1] == HOOK_ARG).then(|| w[0].clone())
}

fn hook_is_ours(h: &Value) -> bool {
    h.get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| our_binary(c).is_some())
}

fn our_hook(cmd: &str) -> Value {
    json!({ "type": "command", "command": cmd, "timeout": TIMEOUT_SECS })
}

/// Index of the first group under `event` holding our hook.
fn our_group(groups: &[Value]) -> Option<usize> {
    groups.iter().position(|g| {
        g.get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hs| hs.iter().any(hook_is_ours))
    })
}

fn root_object(doc: &Value) -> Result<&Map<String, Value>> {
    doc.as_object()
        .ok_or_else(|| Error::Other("hooks.json is not a JSON object — fix it by hand".into()))
}

/// `doc` with our hook in each event: kept where it is (its command updated), else one
/// group appended. Everything else stays as it was.
pub fn merged(doc: &Value, cmd: &str) -> Result<Value> {
    let mut out = root_object(doc)?.clone();
    let hooks = out
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or_else(|| {
        Error::Other("hooks.json `hooks` is not an object — fix it by hand".into())
    })?;
    for (event, _) in EVENTS {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()));
        let groups = groups.as_array_mut().ok_or_else(|| {
            Error::Other(format!(
                "hooks.json `hooks.{event}` is not a list — fix it by hand"
            ))
        })?;
        match our_group(groups) {
            Some(i) => {
                if let Some(hs) = groups[i].get_mut("hooks").and_then(Value::as_array_mut) {
                    for h in hs.iter_mut().filter(|h| hook_is_ours(h)) {
                        *h = our_hook(cmd);
                    }
                }
            }
            None => groups.push(json!({ "hooks": [our_hook(cmd)] })),
        }
    }
    Ok(Value::Object(out))
}

/// `doc` without our hooks (empty groups and events dropped), and whether a user group
/// followed one of ours in its event (its trust key shifts down, so Codex re-asks).
pub fn removed(doc: &Value) -> Result<(Value, bool)> {
    let mut out = root_object(doc)?.clone();
    let mut shifted = false;
    if let Some(hooks) = out.get_mut("hooks").and_then(Value::as_object_mut) {
        for (event, _) in EVENTS {
            let Some(groups) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
                continue;
            };
            let mut seen_ours = false;
            let mut kept = Vec::new();
            for mut g in std::mem::take(groups) {
                let had = g
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|hs| hs.iter().any(hook_is_ours));
                if had {
                    seen_ours = true;
                    if let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                        hs.retain(|h| !hook_is_ours(h));
                        if hs.is_empty() {
                            continue;
                        }
                    }
                } else if seen_ours {
                    shifted = true;
                }
                kept.push(g);
            }
            if kept.is_empty() {
                hooks.remove(event);
            } else {
                *hooks.get_mut(event).unwrap() = Value::Array(kept);
            }
        }
    }
    Ok((Value::Object(out), shifted))
}

/// The file, read: its bytes (None when missing) and its parse (`{}` when missing/blank).
fn read_doc(path: &Path) -> Result<(Option<Vec<u8>>, Value)> {
    let bytes = match std::fs::read(path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let doc = match &bytes {
        Some(b) if !String::from_utf8_lossy(b).trim().is_empty() => serde_json::from_slice(b)
            .map_err(|e| Error::Other(format!("{}: not valid JSON ({e})", path.display())))?,
        _ => Value::Object(Map::new()),
    };
    Ok((bytes, doc))
}

/// Replace `path` with `doc`, unless someone else wrote it since we read `before`
/// (Codex rewrites it on a `/hooks` toggle).
fn write_guarded(path: &Path, before: Option<&[u8]>, doc: &Value) -> Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".hooks.json.overmind-{}.tmp", std::process::id()));
    let mut text = serde_json::to_string_pretty(doc)?;
    text.push('\n');
    std::fs::write(&tmp, text)?;
    let now = std::fs::read(&target).ok();
    if now.as_deref() != before {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Other(format!(
            "{} changed underneath (a `/hooks` toggle in Codex?) — re-run",
            path.display()
        )));
    }
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

/// What `install` did.
#[derive(Debug, Clone, PartialEq)]
pub enum Installed {
    Fresh,
    AlreadyInstalled,
    /// Our hook was there with another binary path.
    Rewritten {
        old: String,
    },
}

/// Install into `codex_home`; `sidecars` (see [`sidecar_dir`]) is created so a watcher can arm.
pub fn install(codex_home: &Path, exe: &Path, sidecars: &Path) -> Result<Installed> {
    let path = hooks_path(codex_home);
    let (bytes, doc) = read_doc(&path)?;
    let cmd = hook_command(exe);
    let new = merged(&doc, &cmd)?;
    ensure_dir(sidecars)?;
    if new == doc {
        return Ok(Installed::AlreadyInstalled);
    }
    let old = installed_binary(&doc);
    write_guarded(&path, bytes.as_deref(), &new)?;
    Ok(match old {
        Some(old) if old != exe.to_string_lossy() => Installed::Rewritten { old },
        _ => Installed::Fresh,
    })
}

/// What `uninstall` did: whether anything was removed, and whether a user group shifted.
pub fn uninstall(codex_home: &Path, sidecars: &Path) -> Result<(bool, bool)> {
    let path = hooks_path(codex_home);
    let (bytes, doc) = read_doc(&path)?;
    let (new, shifted) = removed(&doc)?;
    if new != doc {
        write_guarded(&path, bytes.as_deref(), &new)?;
    }
    if sidecars.is_dir() {
        let _ = std::fs::remove_dir_all(sidecars);
    }
    Ok((new != doc, shifted))
}

/// The binary our installed hook runs (from the first event that has it).
pub fn installed_binary(doc: &Value) -> Option<String> {
    let hooks = doc.get("hooks")?.as_object()?;
    EVENTS.iter().find_map(|(event, _)| {
        hooks
            .get(*event)?
            .as_array()?
            .iter()
            .filter_map(|g| g.get("hooks")?.as_array())
            .flatten()
            .find_map(|h| our_binary(h.get("command")?.as_str()?))
    })
}

// ------------------------------------------------------------------ status

/// Trust of one hook, from `config.toml`'s `[hooks.state."<path>:<event>:<group>:<hook>"]`.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct EventState {
    pub installed: bool,
    pub trusted: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Daemon {
    pub pid: Option<i64>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<i64>,
    #[serde(rename = "olderThanHooks")]
    pub older_than_hooks: bool,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Status {
    pub installed: bool,
    pub path: String,
    pub binary: Option<String>,
    #[serde(rename = "binaryMatches")]
    pub binary_matches: bool,
    pub daemon: Option<Daemon>,
    pub events: Map<String, Value>,
}

/// The `trusted_hash` / `enabled` of one `[hooks.state."<key>"]` table: a line scanner for
/// that one shape, not a TOML parser. None when the table is absent.
pub fn hook_state(config: &str, key: &str) -> Option<(bool, bool)> {
    let header = format!("[hooks.state.\"{key}\"]");
    let mut lines = config.lines().skip_while(|l| l.trim() != header);
    lines.next()?;
    let (mut trusted, mut enabled) = (false, true);
    for l in lines {
        let l = l.trim();
        if l.starts_with('[') {
            break;
        }
        let Some((k, v)) = l.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"');
        match k.trim() {
            "trusted_hash" => trusted = !v.is_empty(),
            "enabled" => enabled = v != "false",
            _ => {}
        }
    }
    Some((trusted, enabled))
}

/// The daemon's pid and start (ms) from `$CODEX_HOME/app-server-daemon/daemon.pid`.
pub fn daemon_info(codex_home: &Path) -> Option<(i64, i64)> {
    let text = std::fs::read_to_string(codex_home.join("app-server-daemon/daemon.pid")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let pid = v.get("pid")?.as_i64()?;
    let started = v
        .get("processIdentity")
        .and_then(|p| p.get("startSeconds"))
        .and_then(Value::as_i64)
        .map(|s| s * 1000)?;
    Some((pid, started))
}

fn pid_alive(pid: i64) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn status(codex_home: &Path, exe: &Path) -> Result<Status> {
    let path = hooks_path(codex_home);
    let (_, doc) = read_doc(&path)?;
    let abs = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    let config = std::fs::read_to_string(codex_home.join("config.toml")).unwrap_or_default();
    let mut events = Map::new();
    let mut all = true;
    for (event, snake) in EVENTS {
        let groups = doc
            .get("hooks")
            .and_then(|h| h.get(event))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let st = match our_group(&groups) {
            Some(gi) => {
                let hi = groups[gi]
                    .get("hooks")
                    .and_then(Value::as_array)
                    .and_then(|hs| hs.iter().position(hook_is_ours))
                    .unwrap_or(0);
                // Codex keys the trust by the path it loaded the file from.
                let (trusted, enabled) = [abs.display().to_string(), path.display().to_string()]
                    .iter()
                    .find_map(|p| hook_state(&config, &format!("{p}:{snake}:{gi}:{hi}")))
                    .unwrap_or((false, true));
                EventState {
                    installed: true,
                    trusted,
                    enabled,
                }
            }
            None => {
                all = false;
                EventState::default()
            }
        };
        events.insert(snake.to_string(), serde_json::to_value(st)?);
    }
    let binary = installed_binary(&doc);
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let daemon = daemon_info(codex_home)
        .filter(|(pid, _)| pid_alive(*pid))
        .map(|(pid, started)| Daemon {
            pid: Some(pid),
            started_at: Some(started),
            older_than_hooks: all && mtime.is_some_and(|m| started < m),
        });
    Ok(Status {
        installed: all,
        path: path.display().to_string(),
        binary_matches: binary.as_deref() == Some(&*exe.to_string_lossy()),
        binary,
        daemon,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(event: &str) -> Value {
        json!({
            "session_id": "01a1a7b0-6cde-7072-b218-4394de17e1c6",
            "turn_id": "t1",
            "transcript_path": "/x/rollout.jsonl",
            "cwd": "/x",
            "hook_event_name": event,
            "tool_name": "Bash",
            "tool_input": { "command": "printf hi > hello.txt", "description": "Allow creating hello.txt?" },
        })
    }

    #[test]
    fn a_permission_request_writes_a_waiting_sidecar_and_stop_clears_it() {
        let (id, sc) = sidecar_from_payload(&payload("PermissionRequest"), 42).unwrap();
        assert_eq!(id, "01a1a7b0-6cde-7072-b218-4394de17e1c6");
        let parsed = parse_sidecar(&sc.to_string()).unwrap();
        assert!(parsed.waiting);
        assert_eq!(parsed.command.as_deref(), Some("printf hi > hello.txt"));
        assert_eq!(parsed.reason.as_deref(), Some("Allow creating hello.txt?"));
        assert_eq!(parsed.tool.as_deref(), Some("Bash"));
        assert_eq!(parsed.at, 42);
        for ev in ["Stop", "UserPromptSubmit"] {
            let (_, sc) = sidecar_from_payload(&payload(ev), 43).unwrap();
            let p = parse_sidecar(&sc.to_string()).unwrap();
            assert!(!p.waiting);
            assert_eq!(p.command, None);
        }
        assert!(sidecar_from_payload(&payload("SessionStart"), 1).is_none());
        let mut bad = payload("Stop");
        bad["session_id"] = json!("../../etc/passwd");
        assert!(sidecar_from_payload(&bad, 1).is_none());
    }

    #[test]
    fn a_sidecar_of_another_version_or_state_is_ignored() {
        let (_, mut sc) = sidecar_from_payload(&payload("PermissionRequest"), 1).unwrap();
        sc["v"] = json!(2);
        assert!(parse_sidecar(&sc.to_string()).is_none());
        sc["v"] = json!(1);
        sc["state"] = json!("maybe");
        assert!(parse_sidecar(&sc.to_string()).is_none());
        assert!(parse_sidecar("not json").is_none());
    }

    #[test]
    fn the_hook_writes_atomically_and_survives_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let (id, sc) = sidecar_from_payload(&payload("PermissionRequest"), 7).unwrap();
        write_sidecar(dir.path(), &id, &sc).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![format!("{id}.json")]);
        assert!(read_sidecar(dir.path(), &id).unwrap().waiting);
        assert!(read_sidecar(dir.path(), "missing").is_none());
        // Garbage, oversize, an unwritable dir: no panic, no output (handle_hook returns ()).
        handle_hook(&b"{not json"[..]);
        handle_hook(std::io::repeat(b' ').take(MAX_PAYLOAD + 10));
    }

    #[test]
    fn prune_drops_only_old_sidecars_of_threads_no_row_has() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["live", "dead"] {
            std::fs::write(dir.path().join(format!("{id}.json")), "{}").unwrap();
        }
        let now = now_ms();
        prune_sidecars(dir.path(), &["live"], 3_600_000, now);
        assert!(dir.path().join("dead.json").exists(), "young: kept");
        prune_sidecars(dir.path(), &["live"], -1, now + 10);
        assert!(!dir.path().join("dead.json").exists());
        assert!(dir.path().join("live.json").exists());
    }

    #[test]
    fn our_command_is_quoted_and_recognised() {
        let exe = Path::new("/Users/me/Library/Application Support/Overmind/it's/overmind");
        let cmd = hook_command(exe);
        assert_eq!(
            cmd,
            r"'/Users/me/Library/Application Support/Overmind/it'\''s/overmind' _codex-hook"
        );
        assert_eq!(our_binary(&cmd).as_deref(), Some(&*exe.to_string_lossy()));
        assert_eq!(
            our_binary("overmind _codex-hook").as_deref(),
            Some("overmind")
        );
        assert_eq!(our_binary("python3 ~/.brain/scripts/log-read.py"), None);
        assert_eq!(our_binary("overmind _codex-hook --x"), None);
        assert_eq!(our_binary("echo '_codex-hook"), None);
    }

    fn user_doc() -> Value {
        json!({
            "hooks": {
                "PostToolUse": [{ "matcher": "Read", "hooks": [{ "type": "command", "command": "python3 log.py" }] }],
                "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }],
            }
        })
    }

    #[test]
    fn install_appends_one_group_per_event_and_is_idempotent() {
        let cmd = hook_command(Path::new("/bin/overmind"));
        let once = merged(&user_doc(), &cmd).unwrap();
        assert_eq!(merged(&once, &cmd).unwrap(), once, "idempotent");
        let hooks = once["hooks"].as_object().unwrap();
        assert_eq!(hooks["PostToolUse"], user_doc()["hooks"]["PostToolUse"]);
        let stop = hooks["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "the user's Stop group stays first");
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert_eq!(stop[1]["hooks"][0]["command"], cmd);
        assert_eq!(stop[1]["hooks"][0]["timeout"], TIMEOUT_SECS);
        for (ev, _) in EVENTS {
            assert!(our_group(hooks[ev].as_array().unwrap()).is_some());
        }
        assert_eq!(
            hooks.keys().next().map(String::as_str),
            Some("PostToolUse"),
            "order kept"
        );
        // A moved binary: rewritten in place (same group index), not appended.
        let moved = merged(&once, &hook_command(Path::new("/new/overmind"))).unwrap();
        assert_eq!(moved["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(installed_binary(&moved).as_deref(), Some("/new/overmind"));
        assert!(merged(&json!([1]), &cmd).is_err());
        assert!(merged(&json!({"hooks": {"Stop": {}}}), &cmd).is_err());
    }

    #[test]
    fn uninstall_removes_only_ours_and_warns_when_a_user_group_shifts() {
        let cmd = hook_command(Path::new("/bin/overmind"));
        let installed = merged(&user_doc(), &cmd).unwrap();
        let (back, shifted) = removed(&installed).unwrap();
        assert_eq!(back, user_doc());
        assert!(!shifted);
        // A user group added after ours under the same event.
        let mut later = installed.clone();
        later["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "hooks": [{ "type": "command", "command": "afterwards" }] }));
        let (back, shifted) = removed(&later).unwrap();
        assert!(shifted);
        assert_eq!(back["hooks"]["Stop"].as_array().unwrap().len(), 2);
        let (fresh, _) = removed(&merged(&json!({}), &cmd).unwrap()).unwrap();
        assert_eq!(fresh, json!({ "hooks": {} }));
    }

    #[test]
    fn install_and_uninstall_round_trip_a_real_file_and_refuse_a_changed_one() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state/codex-hooks");
        {
            let path = hooks_path(home.path());
            let original = serde_json::to_string_pretty(&user_doc()).unwrap();
            std::fs::write(&path, &original).unwrap();
            let exe = Path::new("/opt/overmind dir/overmind");
            assert_eq!(install(home.path(), exe, &state).unwrap(), Installed::Fresh);
            assert!(
                state.is_dir(),
                "the sidecar dir exists so a watcher can arm"
            );
            assert_eq!(
                install(home.path(), exe, &state).unwrap(),
                Installed::AlreadyInstalled
            );
            assert_eq!(
                install(home.path(), Path::new("/elsewhere/overmind"), &state).unwrap(),
                Installed::Rewritten {
                    old: "/opt/overmind dir/overmind".into()
                }
            );
            let (bytes, doc) = read_doc(&path).unwrap();
            // Someone else writes between our read and our rename.
            std::fs::write(&path, "{}").unwrap();
            let err = write_guarded(&path, bytes.as_deref(), &doc).unwrap_err();
            assert!(err.to_string().contains("changed underneath"), "{err}");
            std::fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();
            assert_eq!(uninstall(home.path(), &state).unwrap(), (true, false));
            assert_eq!(read_doc(&path).unwrap().1, user_doc());
            assert!(!state.exists());
            assert_eq!(uninstall(home.path(), &state).unwrap(), (false, false));
        }
    }

    #[test]
    fn status_reads_trust_and_enablement_from_config_toml() {
        let cfg = r#"
[projects."/"]
trust_level = "trusted"

[hooks.state."/h/hooks.json:permission_request:0:0"]
trusted_hash = "sha256:abc"

[hooks.state."/h/hooks.json:stop:1:0"]
trusted_hash = "sha256:def"
enabled = false

[tui]
x = 1
"#;
        assert_eq!(
            hook_state(cfg, "/h/hooks.json:permission_request:0:0"),
            Some((true, true))
        );
        assert_eq!(
            hook_state(cfg, "/h/hooks.json:stop:1:0"),
            Some((true, false))
        );
        assert_eq!(hook_state(cfg, "/h/hooks.json:stop:0:0"), None);

        let home = tempfile::tempdir().unwrap();
        let exe = Path::new("/bin/overmind");
        let doc = merged(&user_doc(), &hook_command(exe)).unwrap();
        std::fs::write(hooks_path(home.path()), doc.to_string()).unwrap();
        let abs = std::fs::canonicalize(hooks_path(home.path())).unwrap();
        let a = abs.display();
        std::fs::write(
            home.path().join("config.toml"),
            format!(
                "[hooks.state.\"{a}:permission_request:0:0\"]\ntrusted_hash = \"sha256:1\"\n\n\
                 [hooks.state.\"{a}:stop:1:0\"]\ntrusted_hash = \"sha256:2\"\nenabled = false\n"
            ),
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join("app-server-daemon")).unwrap();
        // A daemon (this test's own pid, so alive) that started long before hooks.json.
        std::fs::write(
            home.path().join("app-server-daemon/daemon.pid"),
            format!(
                r#"{{"pid":{},"processIdentity":{{"startSeconds":1000}}}}"#,
                std::process::id()
            ),
        )
        .unwrap();
        let st = status(home.path(), exe).unwrap();
        assert!(st.installed);
        assert!(st.binary_matches);
        assert_eq!(st.events["permission_request"]["trusted"], true);
        assert_eq!(st.events["stop"]["trusted"], true);
        assert_eq!(st.events["stop"]["enabled"], false);
        assert_eq!(st.events["user_prompt_submit"]["trusted"], false);
        let d = st.daemon.unwrap();
        assert!(d.older_than_hooks);
        assert_eq!(d.started_at, Some(1_000_000));
        assert!(
            !status(home.path(), Path::new("/other"))
                .unwrap()
                .binary_matches
        );
    }
}
