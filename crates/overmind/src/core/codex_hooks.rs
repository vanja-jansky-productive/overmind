//! The opt-in Codex hook: `overmind codex hooks install` adds one command hook to
//! `PermissionRequest`, `Stop` and `UserPromptSubmit` in `$CODEX_HOME/hooks.json`
//! (default `~/.codex`). Codex runs `'<overmind>' _codex-hook` with the event on stdin;
//! [`handle_hook`] writes one sidecar per thread and prints nothing. The hook is
//! `"async": true`: Codex 0.166 shows the approval menu without waiting for it and ignores
//! its output and exit code. A sync `PermissionRequest` hook that exits 2 (clap's exit for
//! an unknown subcommand, i.e. an overmind without `_codex-hook` at that path) or prints a
//! `decision` denies for the user — `docs/codex-findings.md` §4.
//!
//! Sidecar (`$OVERMIND_CODEX_HOOKS_DIR`, else
//! `${XDG_STATE_HOME:-~/.local/state}/overmind/codex-hooks/<session_id>.json`, v1):
//! `{ v, thread_id, turn_id, transcript_path, state: "waiting"|"clear", event, tool,
//! command, reason, cwd, at }`. Written 0600 to a per-process `<id>.json.<pid>.<nonce>.tmp`,
//! then renamed (two sub-agents asking at once both write their parent's sidecar).
//! `install` also leaves `.install.json` there: what it wrote and the trust it found, so
//! `status` can tell a stale trust entry from a fresh one.
//!
//! A sidecar (or a pending escalated call in the rollout) only *triggers* a look at the
//! terminal: discovery reads `waiting` off the screen ([`screen_shows_approval`]). Codex
//! persists nothing for a pending approval, in either mode — see `docs/codex-findings.md`.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::error::{Error, Result};

pub const HOOK_ARG: &str = "_codex-hook";
/// The events we hook, as hooks.json names them and as `[hooks.state]` keys spell them.
pub const EVENTS: [(&str, &str); 3] = [
    ("PermissionRequest", "permission_request"),
    ("Stop", "stop"),
    ("UserPromptSubmit", "user_prompt_submit"),
];
/// Codex's command-hook `timeout`, in seconds (its `/hooks` view shows `Timeout 5s`; a sync
/// hook still running then is killed, "hook timed out after 5s"; async hooks get it too).
pub const TIMEOUT_SECS: u64 = 5;
/// The most of stdin the hook reads; a bigger payload is dropped.
const MAX_PAYLOAD: u64 = 1024 * 1024;
pub const SIDECAR_VERSION: u64 = 1;

// ------------------------------------------------------------------ paths

/// Where sidecars live: `$OVERMIND_CODEX_HOOKS_DIR` (as given, like the web watcher reads
/// it), else `<state dir>/codex-hooks`. The hook resolves it in *Codex's* environment — in
/// daemon mode the app-server daemon's — so a daemon started without the shell's
/// `XDG_STATE_HOME` / `OVERMIND_CODEX_HOOKS_DIR` writes where `list` does not read.
pub fn sidecar_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("OVERMIND_CODEX_HOOKS_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    crate::core::tools::state_dir().join("codex-hooks")
}

/// `install`'s record, beside the sidecars (a dotfile: the watcher and prune skip it).
const INSTALL_RECORD: &str = ".install.json";

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

pub fn write_sidecar(dir: &Path, id: &str, sidecar: &Value) -> Result<()> {
    crate::core::brief::write_private(&dir.join(format!("{id}.json")), &sidecar.to_string())
}

/// A file `uninstall` and prune may delete: a sidecar, the install record, a temp file.
fn is_ours(name: &str) -> bool {
    name == INSTALL_RECORD
        || name.ends_with(".tmp")
        || name.strip_suffix(".json").is_some_and(safe_id)
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

/// Housekeeping in `list`: sidecars of threads no live row has and temp files a killed
/// hook left, older than `max_age_ms`.
pub fn prune_sidecars(dir: &Path, live: &[&str], max_age_ms: i64, now: i64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == INSTALL_RECORD || !is_ours(&name) {
            continue;
        }
        if name
            .strip_suffix(".json")
            .is_some_and(|id| live.contains(&id))
        {
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

// ------------------------------------------------------------------ triggers and truth
//
// A sidecar or a rollout match only *triggers* a look; the screen is the truth: a Codex
// row is `waiting` while, and only while, its terminal shows the approval menu. Where no
// backend can peek, the sidecar's word stands until the rollout resolves it.

/// Why discovery should look at a busy Codex row's screen.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Trigger {
    /// The sidecar says `waiting` and nothing after it in the rollout says otherwise.
    pub sidecar: bool,
    /// The sidecar's command has not run yet (for rows no backend can peek).
    pub sidecar_unresolved: bool,
    /// The current turn's last `exec` call asks for escalation and has no outcome yet.
    pub rollout: bool,
    /// "exec approval", "<tool> approval".
    pub label: String,
    /// The command, when known (first line; " (+N)" for several escalated calls).
    pub command: Option<String>,
    /// This request's identity: the pending escalated call's `call_id`, else the sidecar's
    /// stamp. The same command asked again is another request (the web's card id mixes it in).
    pub request: Option<String>,
}

/// `sandbox_permissions\W{1,4}require_escalated`, without a regex crate: the key is
/// quoted in one call shape (`"sandbox_permissions":"require_escalated"`) and bare in
/// the other (`sandbox_permissions:"require_escalated"`).
pub fn asks_escalation(s: &str) -> bool {
    const KEY: &str = "sandbox_permissions";
    const VAL: &str = "require_escalated";
    s.match_indices(KEY).any(|(i, _)| {
        let rest = &s.as_bytes()[i + KEY.len()..];
        (1..=4).any(|k| {
            rest.len() >= k + VAL.len()
                && rest[..k]
                    .iter()
                    .all(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))
                && rest[k..].starts_with(VAL.as_bytes())
        })
    })
}

/// The first `cmd` JS string literal in `seg` (`"…"`, `'…'` or a backtick, escapes
/// honoured; nothing else of the JS is parsed).
fn cmd_literal(seg: &str) -> Option<String> {
    let b = seg.as_bytes();
    for (i, _) in seg.match_indices("cmd") {
        let before = i.checked_sub(1).map(|j| b[j]);
        if !matches!(
            before,
            None | Some(b'{' | b',' | b'"' | b'\'' | b' ' | b'\n' | b'\t')
        ) {
            continue;
        }
        let mut j = i + 3;
        if matches!(b.get(j), Some(b'"' | b'\'')) {
            j += 1;
        }
        while b.get(j).is_some_and(|c| c.is_ascii_whitespace()) {
            j += 1;
        }
        if b.get(j) != Some(&b':') {
            continue;
        }
        j += 1;
        while b.get(j).is_some_and(|c| c.is_ascii_whitespace()) {
            j += 1;
        }
        let Some(&q) = b.get(j).filter(|c| matches!(c, b'"' | b'\'' | b'`')) else {
            continue;
        };
        let mut out = String::new();
        let mut chars = seg[j + 1..].chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => match chars.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    c => out.push(c),
                },
                c if c as u32 == q as u32 => return Some(out),
                c => out.push(c),
            }
        }
        return None;
    }
    None
}

/// The escalated command(s) of one code-mode `exec` input: the first one's `cmd` and how
/// many more there are. None when no `exec_command(` in it asks for escalation.
pub fn escalated_commands(input: &str) -> Option<(Option<String>, usize)> {
    let segs: Vec<&str> = input
        .split("exec_command(")
        .skip(1)
        .filter(|seg| asks_escalation(seg))
        .collect();
    let first = segs.first()?;
    Some((cmd_literal(first), segs.len() - 1))
}

fn first_line_max(s: &str, max: usize) -> String {
    let l = s.lines().next().unwrap_or("").trim();
    if l.chars().count() > max {
        format!("{}…", l.chars().take(max - 1).collect::<String>())
    } else {
        l.to_string()
    }
}

fn line_ms(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.get("timestamp")?.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// An `item_completed` CommandExecution's command, as the user's shell line.
fn completed_command(p: &Value) -> Option<String> {
    let item = p.get("item")?;
    (item.get("type")?.as_str()? == "CommandExecution").then_some(())?;
    match item.get("command")? {
        Value::Array(a) => a.last()?.as_str().map(str::to_string),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// What a busy Codex row's rollout tail (`text`) and sidecar say about a pending
/// approval, for a process started at `proc_start_ms`. None: nothing to look at.
pub fn trigger(text: &str, sidecar: Option<&Sidecar>, proc_start_ms: i64) -> Option<Trigger> {
    const SLACK_MS: i64 = 2000;
    let sidecar = sidecar.filter(|s| s.waiting && s.at >= proc_start_ms - SLACK_MS);
    // (call_id, command, more) of the current turn's last exec call, if escalated.
    let mut pending: Option<(String, Option<String>, usize)> = None;
    let mut sidecar_live = sidecar.is_some();
    let mut sidecar_ran = false;
    for line in text.lines() {
        // Cheap filter before parsing: the lines that matter name one of these.
        if !(line.contains("custom_tool_call")
            || line.contains("item_completed")
            || line.contains("task_")
            || line.contains("turn_aborted"))
        {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(p) = v.get("payload") else {
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
        let after_sidecar = sidecar.is_some_and(|s| line_ms(&v).is_some_and(|t| t > s.at));
        match (kind, ptype) {
            ("event_msg", "task_started" | "task_complete" | "turn_aborted") => {
                pending = None;
                if after_sidecar {
                    sidecar_live = false;
                }
            }
            ("response_item", "custom_tool_call")
                if p.get("name").and_then(Value::as_str) == Some("exec") =>
            {
                let input = p.get("input").and_then(Value::as_str).unwrap_or("");
                let call_id = p.get("call_id").and_then(Value::as_str).unwrap_or("");
                pending = escalated_commands(input).map(|(c, n)| (call_id.to_string(), c, n));
            }
            ("response_item", "custom_tool_call_output") => {
                let id = p.get("call_id").and_then(Value::as_str);
                if let Some((_, cmd, _)) = pending.take_if(|(c, _, _)| Some(c.as_str()) == id) {
                    // Denied, or the whole exec script done: the sidecar's command is over.
                    if after_sidecar && cmd.is_some() && sidecar.is_some_and(|s| s.command == cmd) {
                        sidecar_ran = true;
                    }
                }
            }
            ("event_msg", "item_completed") => {
                let done = completed_command(p);
                // A sibling command's completion resolves nothing.
                if done.is_some() && pending.as_ref().is_some_and(|(_, c, _)| *c == done) {
                    pending = None;
                }
                if after_sidecar && done.is_some() && sidecar.is_some_and(|s| s.command == done) {
                    sidecar_ran = true;
                }
            }
            _ => {}
        }
    }
    let rollout = pending.is_some();
    if !rollout && !sidecar_live {
        return None;
    }
    let sc = sidecar.filter(|_| sidecar_live);
    let label = match sc.and_then(|s| s.tool.as_deref()) {
        None | Some("Bash") => "exec approval".to_string(),
        Some(t) => format!("{t} approval"),
    };
    let command = match (sc.and_then(|s| s.command.clone()), &pending) {
        (Some(c), _) => Some(first_line_max(&c, 80)),
        (None, Some((_, Some(c), more))) => Some(if *more > 0 {
            format!("{} (+{more})", first_line_max(c, 80))
        } else {
            first_line_max(c, 80)
        }),
        _ => None,
    };
    let request = match (&pending, sc) {
        (Some((call_id, _, _)), _) if !call_id.is_empty() => Some(call_id.clone()),
        (_, Some(s)) => Some(format!("hook-{}", s.at)),
        _ => None,
    };
    Some(Trigger {
        sidecar: sidecar_live,
        sidecar_unresolved: sidecar_live && !sidecar_ran,
        rollout,
        label,
        command,
        request,
    })
}

/// Is the terminal showing Codex's approval menu? Its first line, an option `1.` and its
/// footer, in that order, within the last 40 non-blank-padded lines: `✔ You approved …`
/// has none of them, a stale menu in the scrollback has lost its footer to the next screen,
/// and output that merely quotes the two strings (a `cat` of this file) has no option line
/// between them.
pub fn screen_shows_approval(screen: &str) -> bool {
    let mut lines: Vec<&str> = screen.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let tail = &lines[lines.len().saturating_sub(40)..];
    let Some(foot) = tail
        .iter()
        .rposition(|l| l.contains("Press enter to confirm"))
    else {
        return false;
    };
    let Some(head) = tail[..foot]
        .iter()
        .rposition(|l| l.contains("Would you like to run"))
    else {
        return false;
    };
    tail[head + 1..foot].iter().any(|l| is_first_option(l))
}

/// `› 1. …` or `  1. …`: the first option of a menu.
fn is_first_option(l: &str) -> bool {
    let l = l.trim_start();
    let l = l.strip_prefix('›').map_or(l, str::trim_start);
    l.strip_prefix("1.")
        .is_some_and(|r| r.starts_with(char::is_whitespace))
}

/// The `$ <cmd>` line of the menu on screen (its first line).
pub fn screen_command(screen: &str) -> Option<String> {
    let lines: Vec<&str> = screen.lines().collect();
    let start = lines
        .iter()
        .rposition(|l| l.contains("Would you like to run"))?;
    lines[start..]
        .iter()
        .find_map(|l| l.trim().strip_prefix("$ "))
        .map(|c| first_line_max(c, 80))
}

/// Which peek a row's backend allows for a trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// tmux: one `capture-pane`, cheap — any trigger.
    Cheap,
    /// iTerm: one osascript (0.1–0.3 s) — only while the hook's command has not run.
    Costly,
    /// No backend: nothing to peek.
    None,
}

/// The row's `waiting_for` when it waits on an approval, None when it doesn't (busy).
/// `peek` reads the terminal; it is called at most once.
pub fn truth(
    trig: &Trigger,
    look: Look,
    peek: impl FnOnce() -> std::result::Result<String, String>,
) -> Option<String> {
    let label = |cmd: Option<String>| match cmd {
        Some(c) if !c.is_empty() => format!("{}: `{c}`", trig.label),
        _ => trig.label.clone(),
    };
    match look {
        // Costly only while the sidecar's command has not run: answered, the menu is gone for
        // the rest of the turn, and Codex fires no hook to say so.
        Look::Cheap | Look::Costly if look == Look::Cheap || trig.sidecar_unresolved => {
            let screen = peek().ok()?;
            screen_shows_approval(&screen)
                .then(|| label(screen_command(&screen).or_else(|| trig.command.clone())))
        }
        Look::None if trig.sidecar_unresolved => Some(label(trig.command.clone())),
        _ => None,
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
    json!({ "type": "command", "command": cmd, "timeout": TIMEOUT_SECS, "async": true })
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
    // The user's mode (0600, read-only on purpose) survives the replace.
    if let Ok(m) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, m.permissions());
    }
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

/// Install into `codex_home`; `sidecars` (see [`sidecar_dir`]) is created so a watcher can
/// arm, and gets the install record [`status`] reads.
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
    // The trust entries at our keys *before* Codex has seen this hook: one still there at
    // `status` time predates it.
    let config = std::fs::read_to_string(codex_home.join("config.toml")).unwrap_or_default();
    let trust: Map<String, Value> = our_keys(&path, &new)
        .into_iter()
        .flat_map(|(_, keys)| keys)
        .map(|k| {
            let hash = hook_state(&config, &k).and_then(|st| st.hash);
            (k, hash.map_or(Value::Null, Value::String))
        })
        .collect();
    // Keys where our hook was already: its content changed (another binary, sync → async).
    let rewrote: Vec<String> = our_keys(&path, &doc)
        .into_iter()
        .flat_map(|(_, keys)| keys)
        .collect();
    write_guarded(&path, bytes.as_deref(), &new)?;
    let record = json!({
        "v": 1,
        "at": now_ms(),
        "command": cmd,
        "rewrote": rewrote,
        "trust": trust,
    });
    let _ = crate::core::brief::write_private(&sidecars.join(INSTALL_RECORD), &record.to_string());
    Ok(match old {
        Some(old) if old != exe.to_string_lossy() => Installed::Rewritten { old },
        _ => Installed::Fresh,
    })
}

/// What `uninstall` did: whether anything was removed, and whether a user group shifted.
/// Deletes only our files in `sidecars` (it may be a dir the user chose), and the dir when
/// that leaves it empty.
pub fn uninstall(codex_home: &Path, sidecars: &Path) -> Result<(bool, bool)> {
    let path = hooks_path(codex_home);
    let (bytes, doc) = read_doc(&path)?;
    let (new, shifted) = removed(&doc)?;
    if new != doc {
        write_guarded(&path, bytes.as_deref(), &new)?;
    }
    if let Ok(rd) = std::fs::read_dir(sidecars) {
        for e in rd.flatten() {
            let ours = e.file_type().is_ok_and(|t| t.is_file())
                && is_ours(&e.file_name().to_string_lossy());
            if ours {
                let _ = std::fs::remove_file(e.path());
            }
        }
        let _ = std::fs::remove_dir(sidecars);
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
///
/// `trusted_hash` is Codex's hash of the hook, which overmind does not reproduce, so `trust`
/// says how much the entry is worth:
/// - `"untrusted"`: no entry — Codex asks for a review at its next start;
/// - `"stale"`: the entry `install` found when it rewrote our hook in place is still there —
///   it is for the old hook, Codex asks for a review again (`trusted` false);
/// - `"trusted"`: an entry written after the install;
/// - `"unverified"`: an entry, but nothing to date it by (installed by an overmind that kept no
///   record, or one reinstalled at a key an earlier identical hook had) — likely trusted.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct EventState {
    pub installed: bool,
    pub trusted: bool,
    pub enabled: bool,
    pub trust: &'static str,
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

/// One `[hooks.state."<key>"]` table of `config.toml`.
#[derive(Debug, Clone, PartialEq)]
pub struct HookState {
    pub hash: Option<String>,
    pub enabled: bool,
}

/// The `trusted_hash` / `enabled` of one `[hooks.state."<key>"]` table: a line scanner for
/// that one shape, not a TOML parser. None when the table is absent.
pub fn hook_state(config: &str, key: &str) -> Option<HookState> {
    let header = format!("[hooks.state.\"{key}\"]");
    let mut lines = config.lines().skip_while(|l| l.trim() != header);
    lines.next()?;
    let mut st = HookState {
        hash: None,
        enabled: true,
    };
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
            "trusted_hash" => st.hash = Some(v.to_string()).filter(|v| !v.is_empty()),
            "enabled" => st.enabled = v != "false",
            _ => {}
        }
    }
    Some(st)
}

/// Per event: the `[hooks.state]` keys our hook in `doc` (loaded from `path`) would have —
/// Codex keys trust by the path it loaded the file from, so the canonical one and `path`.
/// An event without our hook is left out.
fn our_keys(path: &Path, doc: &Value) -> Vec<(&'static str, Vec<String>)> {
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut paths = vec![abs.display().to_string()];
    if path != abs {
        paths.push(path.display().to_string());
    }
    EVENTS
        .iter()
        .filter_map(|(event, snake)| {
            let groups = doc.get("hooks")?.get(event)?.as_array()?;
            let gi = our_group(groups)?;
            let hi = groups[gi]
                .get("hooks")
                .and_then(Value::as_array)
                .and_then(|hs| hs.iter().position(hook_is_ours))
                .unwrap_or(0);
            let keys = paths
                .iter()
                .map(|p| format!("{p}:{snake}:{gi}:{hi}"))
                .collect();
            Some((*snake, keys))
        })
        .collect()
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

/// The trust of one installed hook, given its `[hooks.state]` entry and `install`'s record.
fn trust_of(key: &str, state: Option<&HookState>, record: Option<&Value>) -> &'static str {
    let Some(hash) = state.and_then(|s| s.hash.as_deref()) else {
        return "untrusted";
    };
    let Some(r) = record else {
        return "unverified";
    };
    match r.get("trust").and_then(|t| t.get(key)) {
        // Unchanged since install: for the hook before it, or one it rewrote.
        Some(Value::String(old)) if old == hash => {
            let rewrote = r
                .get("rewrote")
                .and_then(Value::as_array)
                .is_some_and(|ks| ks.iter().any(|k| k.as_str() == Some(key)));
            if rewrote { "stale" } else { "unverified" }
        }
        Some(_) => "trusted",
        None => "unverified",
    }
}

pub fn status(codex_home: &Path, exe: &Path, sidecars: &Path) -> Result<Status> {
    let path = hooks_path(codex_home);
    let (_, doc) = read_doc(&path)?;
    let config = std::fs::read_to_string(codex_home.join("config.toml")).unwrap_or_default();
    let record = std::fs::read_to_string(sidecars.join(INSTALL_RECORD))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|r| {
            r.get("command").and_then(Value::as_str).is_some_and(|c| {
                installed_binary(&doc).is_some_and(|b| our_binary(c).as_deref() == Some(&*b))
            })
        });
    let keys: std::collections::HashMap<_, _> = our_keys(&path, &doc).into_iter().collect();
    let mut events = Map::new();
    let mut all = true;
    for (_, snake) in EVENTS {
        let st = match keys.get(snake) {
            Some(keys) => {
                let found = keys
                    .iter()
                    .find_map(|k| hook_state(&config, k).map(|st| (k, st)));
                let trust = match &found {
                    Some((k, st)) => trust_of(k, Some(st), record.as_ref()),
                    None => "untrusted",
                };
                EventState {
                    installed: true,
                    trusted: matches!(trust, "trusted" | "unverified"),
                    enabled: found.as_ref().is_none_or(|(_, st)| st.enabled),
                    trust,
                }
            }
            None => {
                all = false;
                EventState {
                    trust: "untrusted",
                    ..Default::default()
                }
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(format!("{id}.json")))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "a command can hold a secret");
            // An unwritable dir: an error, no panic, no file.
            let ro = dir.path().join("ro");
            std::fs::create_dir(&ro).unwrap();
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
            assert!(write_sidecar(&ro, &id, &sc).is_err());
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(std::fs::read_dir(&ro).unwrap().count(), 0);
        }
        // Garbage, oversize: no panic, no output (handle_hook returns ()).
        handle_hook(&b"{not json"[..]);
        handle_hook(std::io::repeat(b' ').take(MAX_PAYLOAD + 10));
    }

    #[test]
    fn prune_drops_only_old_sidecars_of_threads_no_row_has() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "live.json",
            "dead.json",
            "dead.json.123.0000abcd.tmp",
            INSTALL_RECORD,
            "notes.txt",
        ] {
            std::fs::write(dir.path().join(name), "{}").unwrap();
        }
        let now = now_ms();
        prune_sidecars(dir.path(), &["live"], 3_600_000, now);
        assert!(dir.path().join("dead.json").exists(), "young: kept");
        prune_sidecars(dir.path(), &["live"], -1, now + 10);
        assert!(!dir.path().join("dead.json").exists());
        assert!(
            !dir.path().join("dead.json.123.0000abcd.tmp").exists(),
            "a killed hook's temp file"
        );
        for kept in ["live.json", INSTALL_RECORD, "notes.txt"] {
            assert!(dir.path().join(kept).exists(), "{kept}");
        }
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
        assert_eq!(
            stop[1]["hooks"][0]["async"], true,
            "never blocks, never decides"
        );
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
        // A sync hook from an earlier install: made async in place, nothing appended.
        let sync = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": cmd, "timeout": 5}]}]}});
        let upgraded = merged(&sync, &cmd).unwrap();
        assert_ne!(
            upgraded, sync,
            "install rewrites it (not \"already installed\")"
        );
        assert_eq!(upgraded["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(upgraded["hooks"]["Stop"][0]["hooks"][0]["async"], true);
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
            assert!(state.join(INSTALL_RECORD).exists());
            assert_eq!(uninstall(home.path(), &state).unwrap(), (true, false));
            assert_eq!(read_doc(&path).unwrap().1, user_doc());
            assert!(!state.exists(), "only ours in it: removed");
            assert_eq!(uninstall(home.path(), &state).unwrap(), (false, false));
        }
    }

    #[test]
    fn uninstall_leaves_a_user_chosen_dir_and_its_other_files_alone() {
        let home = tempfile::tempdir().unwrap();
        let shared = home.path().join("shared");
        std::fs::create_dir_all(shared.join("sub")).unwrap();
        std::fs::write(shared.join("keep.txt"), "x").unwrap();
        std::fs::write(shared.join("sub/also.json"), "{}").unwrap();
        std::fs::write(shared.join("not an id.json"), "{}").unwrap();
        let exe = Path::new("/bin/overmind");
        install(home.path(), exe, &shared).unwrap();
        let (id, sc) = sidecar_from_payload(&payload("PermissionRequest"), 1).unwrap();
        write_sidecar(&shared, &id, &sc).unwrap();
        std::fs::write(shared.join("x.json.9.tmp"), "").unwrap();
        uninstall(home.path(), &shared).unwrap();
        let mut left: Vec<_> = std::fs::read_dir(&shared)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["keep.txt", "not an id.json", "sub"]);
        assert!(shared.join("sub/also.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn install_keeps_the_mode_of_the_users_hooks_json() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let path = hooks_path(home.path());
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        install(
            home.path(),
            Path::new("/bin/overmind"),
            &home.path().join("s"),
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
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
            Some(HookState {
                hash: Some("sha256:abc".into()),
                enabled: true
            })
        );
        assert_eq!(
            hook_state(cfg, "/h/hooks.json:stop:1:0"),
            Some(HookState {
                hash: Some("sha256:def".into()),
                enabled: false
            })
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
        let no_record = home.path().join("no-record");
        let st = status(home.path(), exe, &no_record).unwrap();
        assert!(st.installed);
        assert!(st.binary_matches);
        assert_eq!(st.events["permission_request"]["trusted"], true);
        assert_eq!(
            st.events["permission_request"]["trust"], "unverified",
            "a hash, but no install record to date it by"
        );
        assert_eq!(st.events["stop"]["trusted"], true);
        assert_eq!(st.events["stop"]["enabled"], false);
        assert_eq!(st.events["user_prompt_submit"]["trusted"], false);
        assert_eq!(st.events["user_prompt_submit"]["trust"], "untrusted");
        let d = st.daemon.unwrap();
        assert!(d.older_than_hooks);
        assert_eq!(d.started_at, Some(1_000_000));
        assert!(
            !status(home.path(), Path::new("/other"), &no_record)
                .unwrap()
                .binary_matches
        );
    }

    #[test]
    fn a_hook_install_rewrote_is_stale_until_codex_rehashes_it() {
        let home = tempfile::tempdir().unwrap();
        let sidecars = home.path().join("sidecars");
        let path = hooks_path(home.path());
        // A sync hook from an earlier install, trusted as such.
        let cmd = hook_command(Path::new("/bin/overmind"));
        let sync = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": cmd, "timeout": 5}]}]}});
        std::fs::write(&path, sync.to_string()).unwrap();
        let a = std::fs::canonicalize(&path).unwrap().display().to_string();
        let cfg = |stop: &str| {
            format!(
                "[hooks.state.\"{a}:stop:0:0\"]\ntrusted_hash = \"{stop}\"\n\n\
                 [hooks.state.\"{a}:permission_request:0:0\"]\ntrusted_hash = \"sha256:pr\"\n"
            )
        };
        std::fs::write(home.path().join("config.toml"), cfg("sha256:old")).unwrap();
        install(home.path(), Path::new("/bin/overmind"), &sidecars).unwrap();
        let st = status(home.path(), Path::new("/bin/overmind"), &sidecars).unwrap();
        assert_eq!(
            st.events["stop"]["trust"], "stale",
            "sync → async: new hash"
        );
        assert_eq!(st.events["stop"]["trusted"], false);
        // An entry that predates a *fresh* hook at its key (an earlier, maybe identical one).
        assert_eq!(st.events["permission_request"]["trust"], "unverified");
        assert_eq!(st.events["user_prompt_submit"]["trust"], "untrusted");
        // The user accepts the review: Codex writes new hashes.
        std::fs::write(home.path().join("config.toml"), cfg("sha256:new")).unwrap();
        let st = status(home.path(), Path::new("/bin/overmind"), &sidecars).unwrap();
        assert_eq!(st.events["stop"]["trust"], "trusted");
        assert_eq!(st.events["stop"]["trusted"], true);
        // A record from another binary's install dates nothing.
        install(home.path(), Path::new("/new/overmind"), &sidecars).unwrap();
        std::fs::write(
            hooks_path(home.path()),
            merged(
                &read_doc(&path).unwrap().1,
                &hook_command(Path::new("/bin/overmind")),
            )
            .unwrap()
            .to_string(),
        )
        .unwrap();
        let st = status(home.path(), Path::new("/bin/overmind"), &sidecars).unwrap();
        assert_eq!(st.events["stop"]["trust"], "unverified");
    }

    // ---- read side. Lines modelled on Codex 0.166's real rollout (instructions, ids and
    // paths replaced): L17 is the embedded-mode shape (quoted key), L168 the daemon one.
    const STARTED: &str = r#"{"timestamp":"2026-11-04T17:52:40.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#;
    const L17: &str = r#"{"timestamp":"2026-11-04T17:52:44.163Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_a","name":"exec","input":"text(await tools.exec_command({cmd:\"printf hi > hello.txt\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Allow creating hello.txt?\",\"max_output_tokens\":1000}));\n"}}"#;
    const L168: &str = r#"{"timestamp":"2026-11-04T17:59:38.014Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_b","name":"exec","input":"text(await tools.exec_command({cmd:\"printf bye > bye.txt\",sandbox_permissions:\"require_escalated\",justification:\"Allow creating bye.txt?\",max_output_tokens:1000}));\n"}}"#;
    const L75: &str = r#"{"timestamp":"2026-11-04T17:54:49.528Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_c","name":"exec","input":"for (let i = 0; i < 9; i++) {\n  await tools.exec_command({cmd:\"cat big.txt\",\"max_output_tokens\":1000});\n}\n"}}"#;
    const COMPACTED: &str = r#"{"timestamp":"2026-11-04T17:55:00.000Z","type":"compacted","payload":{"message":"","replacement_history":[{"type":"message","content":"use sandbox_permissions: \"require_escalated\" to ask"}]}}"#;
    const ITEM_HI: &str = r#"{"timestamp":"2026-11-04T17:53:14.576Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":["/bin/zsh","-lc","printf hi > hello.txt"],"status":"completed"}}}"#;
    const ITEM_OTHER: &str = r#"{"timestamp":"2026-11-04T17:53:14.576Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":["/bin/zsh","-lc","ls"],"status":"completed"}}}"#;
    const OUT_A: &str = r#"{"timestamp":"2026-11-04T17:53:14.580Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_a","output":"ok"}}"#;
    const ABORTED: &str = r#"{"timestamp":"2026-11-04T18:00:04.538Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#;

    fn text(lines: &[&str]) -> String {
        lines.join("\n") + "\n"
    }

    #[test]
    fn the_escalation_match_reads_both_call_shapes_and_nothing_else() {
        assert!(asks_escalation(
            r#"{cmd:"x","sandbox_permissions":"require_escalated"}"#
        ));
        assert!(asks_escalation(
            r#"{cmd:"x",sandbox_permissions:"require_escalated"}"#
        ));
        assert!(asks_escalation("sandbox_permissions: 'require_escalated'"));
        assert!(!asks_escalation(r#"sandbox_permissions:"use_default""#));
        assert!(!asks_escalation("sandbox_permissions_x:require_escalated"));
        assert!(!asks_escalation(
            "sandbox_permissions      require_escalated"
        ));
        assert_eq!(
            escalated_commands(
                r#"text(await tools.exec_command({cmd:"printf \"a b\" > c.txt",sandbox_permissions:"require_escalated"}))"#
            ),
            Some((Some(r#"printf "a b" > c.txt"#.to_string()), 0))
        );
        let script = r#"await tools.exec_command({cmd:'ls'}); await tools.exec_command({"cmd": `mkdir -p out`, sandbox_permissions:"require_escalated"}); await tools.exec_command({cmd:"rm x",sandbox_permissions:"require_escalated"})"#;
        assert_eq!(
            escalated_commands(script),
            Some((Some("mkdir -p out".to_string()), 1)),
            "one escalated call among several: the first escalated one, + the rest"
        );
        assert_eq!(escalated_commands(r#"exec_command({cmd:"ls"})"#), None);
        assert_eq!(
            escalated_commands(
                r#"exec_command({command:x,sandbox_permissions:"require_escalated"})"#
            ),
            Some((None, 0)),
            "no literal: label only"
        );
    }

    #[test]
    fn a_pending_escalated_call_triggers_until_it_resolves() {
        let t = |lines: &[&str]| trigger(&text(lines), None, 0);
        let hi = t(&[STARTED, L17]).unwrap();
        assert!(hi.rollout && !hi.sidecar);
        assert!(
            hi.request.as_deref().is_some_and(|r| !r.is_empty()),
            "the call id names the request"
        );
        assert_ne!(
            t(&[STARTED, L17]).unwrap().request,
            t(&[STARTED, L168]).unwrap().request,
            "another call, another request"
        );
        assert_eq!(hi.label, "exec approval");
        assert_eq!(hi.command.as_deref(), Some("printf hi > hello.txt"));
        assert_eq!(
            t(&[STARTED, L168]).unwrap().command.as_deref(),
            Some("printf bye > bye.txt")
        );
        // Resolution: its output, its own command completing, a turn end.
        assert_eq!(t(&[STARTED, L17, OUT_A]), None);
        assert_eq!(t(&[STARTED, L17, ITEM_HI]), None);
        assert_eq!(t(&[STARTED, L17, ABORTED]), None);
        assert_eq!(t(&[STARTED, L17, STARTED]), None);
        // A sibling command's completion resolves nothing.
        assert!(t(&[STARTED, L17, ITEM_OTHER]).is_some());
        // The nine-command loop asks nothing; a later plain call replaces the pending one.
        assert_eq!(t(&[STARTED, L75]), None);
        assert_eq!(t(&[STARTED, L17, L75]), None);
        // `require_escalated` in a compacted history or instructions is never a call.
        assert_eq!(t(&[STARTED, COMPACTED]), None);
    }

    fn sc(waiting: bool, at: i64, command: Option<&str>) -> Sidecar {
        Sidecar {
            thread_id: "t".into(),
            turn_id: None,
            waiting,
            tool: Some("Bash".into()),
            command: command.map(str::to_string),
            reason: None,
            at,
        }
    }

    #[test]
    fn a_waiting_sidecar_triggers_until_the_turn_moves_on() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-04T17:52:45.000Z")
            .unwrap()
            .timestamp_millis();
        let s = sc(true, at, Some("printf hi > hello.txt"));
        let trig = trigger(&text(&[STARTED, L17]), Some(&s), at - 60_000).unwrap();
        assert!(trig.sidecar && trig.sidecar_unresolved && trig.rollout);
        assert_eq!(trig.command.as_deref(), Some("printf hi > hello.txt"));
        let hook_only = trigger(&text(&[STARTED]), Some(&s), 0).unwrap();
        assert_eq!(hook_only.request, Some(format!("hook-{at}")));
        assert_ne!(
            hook_only.request,
            trigger(&text(&[STARTED]), Some(&sc(true, at + 5_000, None)), 0)
                .unwrap()
                .request,
            "the same command asked again by the hook is another request"
        );
        // The command ran (approved): still a trigger (the screen decides) but resolved for Unknown.
        let ran = trigger(&text(&[STARTED, L17, ITEM_HI]), Some(&s), at - 60_000).unwrap();
        assert!(ran.sidecar && !ran.sidecar_unresolved && !ran.rollout);
        // A turn end after it, a `clear`, a sidecar from before this process: no trigger.
        assert_eq!(
            trigger(&text(&[STARTED, L17, OUT_A, ABORTED]), Some(&s), 0),
            None
        );
        assert_eq!(
            trigger(&text(&[STARTED]), Some(&sc(false, at, None)), 0),
            None
        );
        assert_eq!(trigger(&text(&[STARTED]), Some(&s), at + 10_000), None);
        // A turn boundary *before* the sidecar does not clear it.
        assert!(trigger(&text(&[STARTED]), Some(&s), 0).is_some());
        let mut patch = s.clone();
        patch.tool = Some("apply_patch".into());
        assert_eq!(
            trigger(&text(&[STARTED]), Some(&patch), 0).unwrap().label,
            "apply_patch approval"
        );
    }

    const MENU: &str = "› create a file hello.txt containing the word hi
• Running printf hi > hello.txt
  Would you like to run the following command?
  Environment: local
  Reason: Allow creating hello.txt containing hi in this directory?
  $ printf hi > hello.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `printf hi > hello.txt` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
";
    const APPROVED: &str = "✔ You approved codex to run printf hi > hello.txt this time
• Working (3s • esc to interrupt)
› Ask Codex to do anything
";

    #[test]
    fn the_screen_decides_waiting() {
        assert!(screen_shows_approval(MENU));
        assert!(!screen_shows_approval(APPROVED));
        let scrolled = format!("{MENU}{}", "• more output\n".repeat(45));
        assert!(
            !screen_shows_approval(&scrolled),
            "a menu scrolled away is gone"
        );
        let padded = format!("{}{}", "• earlier\n".repeat(30), MENU) + &"\n".repeat(40);
        assert!(
            screen_shows_approval(&padded),
            "capture-pane pads to the pane's height"
        );
        // Output that quotes both strings (a `cat` of this file) has no option line between.
        let quoted = "• Ran cat questions.mjs\n  // Would you like to run the following command?\n  //   $ printf hi\n  // Press enter to confirm or esc to cancel\n› Ask Codex to do anything\n";
        assert!(!screen_shows_approval(quoted));
        assert_eq!(
            screen_command(MENU).as_deref(),
            Some("printf hi > hello.txt")
        );
        let trig = Trigger {
            sidecar: false,
            sidecar_unresolved: false,
            rollout: true,
            label: "exec approval".into(),
            command: Some("from rollout".into()),
            request: None,
        };
        let menu = || Ok(MENU.to_string());
        assert_eq!(
            truth(&trig, Look::Cheap, menu).as_deref(),
            Some("exec approval: `printf hi > hello.txt`")
        );
        assert_eq!(
            truth(&trig, Look::Cheap, || Ok(APPROVED.into())),
            None,
            "approved → busy"
        );
        assert_eq!(
            truth(&trig, Look::Cheap, || Err("no pane".into())),
            None,
            "peek error → busy"
        );
        // iTerm peeks only for the hook; no backend: the sidecar's word, the rollout alone never.
        assert_eq!(
            truth(&trig, Look::Costly, || panic!(
                "no osascript without the hook"
            )),
            None
        );
        assert_eq!(truth(&trig, Look::None, || panic!("nothing to peek")), None);
        let hooked = Trigger {
            sidecar: true,
            sidecar_unresolved: true,
            ..trig.clone()
        };
        assert!(truth(&hooked, Look::Costly, menu).is_some());
        assert_eq!(
            truth(&hooked, Look::None, || panic!()).as_deref(),
            Some("exec approval: `from rollout`")
        );
        let ran = Trigger {
            sidecar_unresolved: false,
            ..hooked
        };
        assert_eq!(truth(&ran, Look::None, || panic!()), None);
        assert_eq!(
            truth(&ran, Look::Costly, || panic!(
                "no osascript for the rest of the turn once the command ran"
            )),
            None
        );
    }

    #[test]
    fn a_denied_or_finished_exec_call_resolves_the_sidecar() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-04T17:52:45.000Z")
            .unwrap()
            .timestamp_millis();
        let s = sc(true, at, Some("printf hi > hello.txt"));
        // OUT_A: call_a's output, after the sidecar, no item_completed (denied).
        let t = trigger(&text(&[STARTED, L17, OUT_A]), Some(&s), 0).unwrap();
        assert!(t.sidecar && !t.sidecar_unresolved && !t.rollout);
    }
}
