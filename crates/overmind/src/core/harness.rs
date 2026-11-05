//! Coding-agent harnesses: Claude Code, Codex and pi.
//!
//! Claude Code keeps a live registry (`~/.claude/sessions/<pid>.json`, see
//! [`crate::core::discovery`]); the others don't. For them this module finds the
//! interactive processes with `ps`, matches each to the transcript it writes, and
//! reads the status, first prompt, model and context use from that transcript's tail:
//!
//! - **Codex** — `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl` (default
//!   `~/.codex`); the first line is `session_meta` with `id` and `cwd`. A turn runs from
//!   `task_started` to `task_complete` / `turn_aborted`. Codex 0.166 persists no
//!   approval request: a busy row's pending approval is read off its screen (see
//!   [`crate::core::codex_hooks`]); the old `*_approval_request` branch stays for older Codex.
//!   A turn left open by a crashed TUI (no line stamped since the current process
//!   started) is idle. Sub-agent threads (`session_meta.payload.thread_source:
//!   "subagent"`) write their own rollout in the parent's cwd; they are never a session.
//! - **pi** — `~/.pi/agent/sessions/--<cwd with / as ->--/<stamp>_<id>.jsonl`; the first
//!   line is `{ type: "session", id, cwd }`. Busy while the last message is the user's, a
//!   tool result or an assistant turn that stopped for a tool call.
//!
//! A process is matched to a transcript by an id on its command line (`codex resume <id>`,
//! `pi --session <id>`), else by cwd and start time: the newest transcript in its cwd that
//! was created after it started, then the newest one written to since — never a `codex exec`
//! / `codex review` rollout (`source: "exec"`, `originator: "codex_exec"`): one run in the
//! same cwd would take the TUI's row. A fresh Codex
//! session has no transcript until its first prompt — it is listed without a session id.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::context::ContextUsage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    #[default]
    Claude,
    Codex,
    Pi,
}

impl Harness {
    pub const ALL: [Harness; 3] = [Harness::Claude, Harness::Codex, Harness::Pi];

    /// The id used on the command line, in config and in JSON.
    pub fn id(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
            Harness::Pi => "pi",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Harness::Claude => "Claude Code",
            Harness::Codex => "Codex",
            Harness::Pi => "pi",
        }
    }

    pub fn parse(s: &str) -> Option<Harness> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" | "cc" => Some(Harness::Claude),
            "codex" => Some(Harness::Codex),
            "pi" => Some(Harness::Pi),
            _ => None,
        }
    }

    /// The command that launches it in a spawned session. Claude: `OVERMIND_CMD`, then
    /// config `claude`; the others: config `harnesses.<id>.command`; else the bare name.
    pub fn command(self) -> String {
        let cfg = crate::core::config::get();
        let configured = match self {
            Harness::Claude => std::env::var("OVERMIND_CMD")
                .ok()
                .filter(|c| !c.trim().is_empty())
                .or_else(|| cfg.claude.clone()),
            _ => cfg.harness_command(self.id()),
        };
        configured
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| self.id().to_string())
    }

    /// Whether the launcher takes `-n <name>` for the session's display name.
    pub fn takes_name(self) -> bool {
        matches!(self, Harness::Claude | Harness::Pi)
    }

    /// The slash command that renames a live session.
    pub fn rename_command(self, title: &str) -> String {
        match self {
            Harness::Claude | Harness::Codex => format!("/rename {title}"),
            Harness::Pi => format!("/name {title}"),
        }
    }

    /// Arguments that resume `session_id` (appended to the launcher).
    pub fn resume_args(self, session_id: &str) -> String {
        let id = crate::core::tools::shq_min(session_id);
        match self {
            Harness::Claude => format!("--resume {id}"),
            Harness::Codex => format!("resume {id}"),
            Harness::Pi => format!("--session {id}"),
        }
    }

    /// Reasoning-effort levels it takes, lowest first. Codex: the union of its model cache's
    /// `supported_reasoning_levels`, else a fixed list.
    pub fn efforts(self) -> Vec<String> {
        let fixed: &[&str] = match self {
            Harness::Claude => &["low", "medium", "high", "xhigh", "max"],
            Harness::Codex => &["minimal", "low", "medium", "high", "xhigh"],
            Harness::Pi => &["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        };
        if self == Harness::Codex {
            let cached = codex_efforts(&codex_home());
            if !cached.is_empty() {
                return cached;
            }
        }
        fixed.iter().map(|s| s.to_string()).collect()
    }

    /// The launcher arguments that set the reasoning effort.
    pub fn effort_args(self, level: &str) -> String {
        let l = crate::core::tools::shq_min(level);
        match self {
            Harness::Claude => format!("--effort {l}"),
            Harness::Codex => format!("-c model_reasoning_effort={l}"),
            Harness::Pi => format!("--thinking {l}"),
        }
    }

    /// The levels a spawn of `model` (None = the default it starts) may pick, lowest first.
    /// Codex: that model's `supported_reasoning_levels` from its cache — the default being
    /// `harnesses.codex.model`, else `config.toml`'s `model` — and the union when the cache
    /// does not know the model. Claude and pi: the same levels for every model.
    pub fn efforts_for(self, model: Option<&str>) -> Vec<String> {
        if self == Harness::Codex {
            let own = codex_model_efforts(&codex_home(), model, self.default_model().as_deref());
            if !own.is_empty() {
                return own;
            }
        }
        self.efforts()
    }

    /// A picked effort is one `model` takes: else an error naming the levels it does take.
    pub fn check_effort(self, model: Option<&str>, effort: &str) -> Result<(), String> {
        check_effort_in(&self.efforts_for(model), self, model, effort)
    }

    /// The configured default model (`harnesses.<id>.model`), when it is a safe id.
    pub fn default_model(self) -> Option<String> {
        crate::core::config::get()
            .harness_default(self.id(), "model")
            .filter(|m| is_model_id(m))
    }

    /// The configured default effort (`harnesses.<id>.effort`), when it is a level this
    /// harness takes.
    pub fn default_effort(self) -> Option<String> {
        crate::core::config::get()
            .harness_default(self.id(), "effort")
            .filter(|e| is_level(e))
    }

    /// The launcher a spawn types: `--model` and the effort (the picked ones, else the
    /// defaults) appended. A launcher that already sets one (a job's own command, a wrapper with
    /// flags) keeps its own: the default is not added on top; a picked one still is (the
    /// harness's last flag wins).
    pub fn with_defaults(
        self,
        launcher: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> String {
        self.with(
            launcher,
            model,
            effort,
            self.default_model(),
            self.default_effort(),
        )
    }

    fn with(
        self,
        launcher: &str,
        model: Option<&str>,
        effort: Option<&str>,
        def_model: Option<String>,
        def_effort: Option<String>,
    ) -> String {
        let words: Vec<&str> = launcher.split_whitespace().collect();
        let has = |flags: &[&str]| {
            words.iter().any(|w| {
                flags
                    .iter()
                    .any(|f| w == f || w.starts_with(&format!("{f}=")))
            })
        };
        let mut out = launcher.to_string();
        let model = model.map(str::to_string).or_else(|| {
            let sets_model = has(&["--model"]) || (self == Harness::Codex && has(&["-m"]));
            def_model.filter(|_| !sets_model)
        });
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            out.push_str(" --model ");
            out.push_str(&crate::core::tools::shq(&m));
        }
        let effort = effort
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .or_else(|| {
                let sets_effort =
                    has(&["--effort", "--thinking"]) || launcher.contains("model_reasoning_effort");
                def_effort.filter(|_| !sets_effort)
            });
        if let Some(e) = effort {
            out.push(' ');
            out.push_str(&self.effort_args(&e));
        }
        out
    }

    /// The resume command line: `<launcher> [--model m] <resume args>`.
    pub fn resume_command(self, launcher: &str, model: Option<&str>, session_id: &str) -> String {
        let mut cmd = launcher.to_string();
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            cmd.push_str(" --model ");
            cmd.push_str(&crate::core::tools::shq(m));
        }
        cmd.push(' ');
        cmd.push_str(&self.resume_args(session_id));
        cmd
    }
}

impl std::fmt::Display for Harness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

// --- models -------------------------------------------------------------------

/// One entry of a harness's model picker. `id: ""` is the harness's own default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    /// The reasoning-effort levels this model takes, lowest first, when the harness says per
    /// model (Codex's `supported_reasoning_levels`); empty = the harness's `efforts`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

fn opt(id: &str, label: &str) -> ModelOption {
    ModelOption {
        id: id.into(),
        label: label.into(),
        efforts: Vec::new(),
    }
}

/// A Claude model version: `(major, minor)` (`claude-opus-6` has no minor).
pub type Version = (u32, Option<u32>);

/// Claude Code's model families, as `(alias, label, newest version overmind knows of)`. The
/// picker offers the alias, so `claude --model sonnet` always starts the newest Sonnet; the
/// version is only the label's fallback. Mirrored by `web/lib/config.mjs` `DEFAULT_MODELS` and
/// `web/ui/src/lib/models.ts` (a web test keeps the three in step).
pub const CLAUDE_FAMILIES: [(&str, &str, Version); 4] = [
    ("fable", "Fable", (5, Some(1))),
    ("opus", "Opus", (5, Some(5))),
    ("sonnet", "Sonnet", (5, Some(5))),
    ("haiku", "Haiku", (5, Some(5))),
];

/// Claude's picker (the web's `web.models` overrides it there): Default, then one entry per
/// family, labelled with the newest version Claude Code has recorded on this machine.
pub fn claude_models() -> Vec<ModelOption> {
    let seen = std::fs::read_to_string(crate::core::context::claude_state_path())
        .map(|t| claude_used_models(&t))
        .unwrap_or_default();
    claude_models_from(&seen)
}

/// The picker from the model ids Claude Code has used (`claude-opus-5-5`, `claude-haiku-4-5-20251001`).
pub fn claude_models_from(seen: &[String]) -> Vec<ModelOption> {
    let mut out = vec![opt("", "Default")];
    for (alias, label, known) in CLAUDE_FAMILIES {
        let newest = seen
            .iter()
            .filter_map(|id| claude_model_version(id))
            .filter(|(fam, _)| fam == alias)
            .map(|(_, v)| v)
            .fold(known, |a, b| {
                if version_key(b) > version_key(a) {
                    b
                } else {
                    a
                }
            });
        let version = match newest {
            (major, Some(minor)) => format!("{major}.{minor}"),
            (major, None) => major.to_string(),
        };
        out.push(opt(alias, &format!("{label} {version}")));
    }
    out
}

fn version_key((major, minor): Version) -> (u32, u32) {
    (major, minor.unwrap_or(0))
}

/// `claude-<family>-<major>[-<minor>][-<yyyymmdd>][[1m]]` -> (family, (major, minor)).
fn claude_model_version(id: &str) -> Option<(String, Version)> {
    let id = id.to_lowercase();
    let id = id.strip_suffix("[1m]").unwrap_or(&id);
    let mut parts = id.strip_prefix("claude-")?.split('-');
    let family = parts.next()?.to_string();
    let major = parts.next()?.parse().ok()?;
    // A minor is short; a dated snapshot suffix (20251001) is not a version.
    let minor = parts
        .next()
        .filter(|p| p.len() <= 2)
        .and_then(|p| p.parse().ok());
    Some((family, (major, minor)))
}

/// Every model id in `~/.claude.json`'s `projects.*.lastModelUsage`.
fn claude_used_models(state: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(state) else {
        return Vec::new();
    };
    let mut out: Vec<String> = v["projects"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .filter_map(|p| p["lastModelUsage"].as_object())
        .flat_map(|u| u.keys().cloned())
        .collect();
    out.sort();
    out.dedup();
    out
}

pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
}

pub fn pi_home() -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".pi/agent"))
}

/// Codex's picker: Default, then the newest listed model of each family in its own cache
/// (`models_cache.json`), each with the effort levels it takes. Default reads plain "Default",
/// like Claude's: `config.toml`'s `model` is what it starts, but the chip does not name it;
/// its levels are those of the model it starts (`default`: overmind's `harnesses.codex.model`,
/// else `config.toml`'s).
pub fn codex_models(home: &Path, default: Option<&str>) -> Vec<ModelOption> {
    let mut out = codex_models_from(&codex_cache(home));
    if let Some(d) = out.first_mut() {
        d.efforts = codex_model_efforts(home, None, default);
    }
    out
}

fn codex_cache(home: &Path) -> Value {
    std::fs::read_to_string(home.join("models_cache.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

/// `config.toml`'s top-level `model = "…"` (a `[profiles.x]` one is not the default).
fn codex_config_model(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join("config.toml")).ok()?;
    text.lines()
        .map(str::trim)
        .take_while(|l| !l.starts_with('['))
        .find_map(|l| {
            let (k, v) = l.split_once('=')?;
            let v = v
                .split('#')
                .next()?
                .trim()
                .trim_matches(|c| c == '"' || c == '\'');
            (k.trim() == "model" && is_model_id(v)).then(|| v.to_string())
        })
}

/// The effort levels Codex's cache lists for `model` (None = the default: `default`, else
/// `config.toml`'s `model`), lowest first; empty when the cache does not know the model.
pub fn codex_model_efforts(home: &Path, model: Option<&str>, default: Option<&str>) -> Vec<String> {
    let Some(slug) = model
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| default.filter(|m| !m.is_empty()).map(str::to_string))
        .or_else(|| codex_config_model(home))
    else {
        return Vec::new();
    };
    codex_cache(home)
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|m| m.get("slug").and_then(Value::as_str) == Some(slug.as_str()))
        .map(codex_levels)
        .unwrap_or_default()
}

/// One cache entry's `supported_reasoning_levels[].effort`, in its order.
fn codex_levels(m: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in m
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| l.get("effort").and_then(Value::as_str))
        .filter(|e| is_level(e))
    {
        if !out.iter().any(|o| o == e) {
            out.push(e.to_string());
        }
    }
    out
}

/// `check_effort`'s rule on given levels: `effort` must be a level and one of `levels`.
fn check_effort_in(
    levels: &[String],
    h: Harness,
    model: Option<&str>,
    effort: &str,
) -> Result<(), String> {
    if is_level(effort) && levels.iter().any(|l| l == effort) {
        return Ok(());
    }
    let who = match model.filter(|m| !m.is_empty()) {
        Some(m) => format!("{} model {m}", h.label()),
        None => format!("{}'s default model", h.label()),
    };
    Err(format!(
        "effort \"{effort}\" is not one {who} takes — pick one of: {}",
        levels.join(", ")
    ))
}

/// The picker from Codex's model cache: Default, then of the `visibility: "list"` models the
/// newest version of each family (`gpt-6.1-sol` beats `gpt-6-sol`), in Codex's priority order.
/// A slug without a `<prefix>-<version>` shape is a family of its own at version 0.
pub fn codex_models_from(cache: &Value) -> Vec<ModelOption> {
    // family -> (version, priority, option); a tie on version goes to the lower priority
    let mut newest: Vec<(String, (u32, u32), i64, ModelOption)> = Vec::new();
    for m in cache
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
    {
        let Some(id) = m.get("slug").and_then(Value::as_str) else {
            continue;
        };
        let label = m
            .get("display_name")
            .and_then(Value::as_str)
            .map_or_else(|| id.to_string(), codex_label);
        let prio = m
            .get("priority")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX);
        let (family, version) = match codex_model_version(id) {
            Some((prefix, v, suffix)) => (format!("{prefix}:{suffix}"), version_key(v)),
            None => (id.to_lowercase(), (0, 0)),
        };
        let mut option = opt(id, &label);
        option.efforts = codex_levels(m);
        let candidate = (family, version, prio, option);
        match newest.iter_mut().find(|n| n.0 == candidate.0) {
            Some(n)
                if (candidate.1, std::cmp::Reverse(candidate.2))
                    > (n.1, std::cmp::Reverse(n.2)) =>
            {
                *n = candidate
            }
            Some(_) => {}
            None => newest.push(candidate),
        }
    }
    newest.sort_by_key(|n| n.2);
    let mut out = vec![opt("", "Default")];
    out.extend(newest.into_iter().map(|n| n.3));
    out
}

/// `gpt-6.1-sol` -> ("gpt", (6, Some(1)), "sol"); `gpt-6-astra` -> ("gpt", (6, None), "astra");
/// `gpt-5.2` -> ("gpt", (5, Some(2)), ""). None when the shape is not
/// `<letters>-<major>[.<minor>][-<rest>]`.
fn codex_model_version(slug: &str) -> Option<(String, Version, String)> {
    let slug = slug.to_lowercase();
    let (prefix, rest) = slug.split_once('-')?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let (ver, suffix) = rest.split_once('-').unwrap_or((rest, ""));
    Some((prefix.to_string(), parse_version(ver)?, suffix.to_string()))
}

/// `6` -> (6, None), `6.1` -> (6, Some(1)); anything else None.
fn parse_version(v: &str) -> Option<Version> {
    match v.split_once('.') {
        Some((a, b)) => Some((a.parse().ok()?, Some(b.parse().ok()?))),
        None => Some((v.parse().ok()?, None)),
    }
}

/// Codex's `display_name` shaped like Claude's chips: `GPT-6.1-Sol` -> `GPT-6.1 Sol`. Any
/// other shape (`GPT-6.1 Terra`, `Codex Auto Review`) stays verbatim.
fn codex_label(name: &str) -> String {
    let spaced = name.strip_prefix("GPT-").and_then(|rest| {
        let (ver, family) = rest.split_once('-')?;
        parse_version(ver)?;
        (!family.is_empty() && !family.contains(char::is_whitespace))
            .then(|| format!("GPT-{ver} {family}"))
    });
    spaced.unwrap_or_else(|| name.to_string())
}

/// A model id safe to type into a shell (the `--model` rule: letters, digits, `._[]-/:`).
pub fn is_model_id(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 100
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._[]-/:".contains(c))
}

/// An effort level: a short lowercase word.
pub fn is_level(e: &str) -> bool {
    !e.is_empty() && e.len() <= 20 && e.chars().all(|c| c.is_ascii_lowercase())
}

/// Codex's effort levels: every `supported_reasoning_levels[].effort` of its model cache, in
/// first-seen order (models list them lowest first).
pub fn codex_efforts(home: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in codex_cache(home)
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for e in codex_levels(m) {
            if !out.contains(&e) {
                out.push(e);
            }
        }
    }
    out
}

/// pi's picker: `pi --list-models` (the providers it has credentials for) after the
/// default from its `settings.json`, narrowed to its `enabledModels` patterns when set
/// (pi lists every model of a provider, also ones its login cannot use). Ids are
/// `provider/model`.
pub fn pi_models(home: &Path, launcher: &str) -> Vec<ModelOption> {
    let settings: Value = std::fs::read_to_string(home.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let default = settings
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(str::to_string);
    let enabled: Vec<String> = settings
        .get("enabledModels")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut out = vec![opt("", &default_label(default.as_deref()))];
    let bin = launcher.split_whitespace().next().unwrap_or("pi");
    let bin = crate::core::tools::resolve_binary(bin, None);
    if let Some(text) = run_with_timeout(
        Command::new(bin)
            .arg("--list-models")
            .arg("--offline")
            .env("PATH", crate::core::tools::search_path()),
        Duration::from_secs(15),
    ) {
        out.extend(
            parse_pi_models(&text)
                .into_iter()
                .filter(|m| pi_model_enabled(&m.id, &enabled)),
        );
    }
    out
}

fn default_label(model: Option<&str>) -> String {
    match model.filter(|m| !m.is_empty()) {
        Some(m) => format!("Default ({m})"),
        None => "Default".into(),
    }
}

/// `provider  model  context …` table rows → `provider/model`. Only rows under the
/// header count: without a login pi prints a "No models available …" message instead.
fn parse_pi_models(text: &str) -> Vec<ModelOption> {
    let mut lines = text.lines();
    if !lines.any(|l| {
        let mut cols = l.split_whitespace();
        cols.next() == Some("provider") && cols.next() == Some("model")
    }) {
        return Vec::new();
    }
    lines
        .filter_map(|l| {
            let mut cols = l.split_whitespace();
            let provider = cols.next()?;
            let model = cols.next()?;
            Some(opt(
                &format!("{provider}/{model}"),
                &format!("{model} ({provider})"),
            ))
        })
        .collect()
}

/// pi's `enabledModels` semantics, enough for the picker: a pattern matches
/// `provider/model` or the bare model, case-insensitively, `*` and `?` as globs, a
/// `:<thinking>` suffix ignored. No patterns: everything is enabled.
fn pi_model_enabled(id: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return true;
    }
    let id = id.to_lowercase();
    let bare = id.split_once('/').map_or(id.as_str(), |(_, m)| m);
    patterns.iter().any(|p| {
        let p = p.to_lowercase();
        let p = match p.rsplit_once(':') {
            Some((base, level))
                if ["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&level) =>
            {
                base.to_string()
            }
            _ => p,
        };
        glob_match(&p, &id) || glob_match(&p, bare)
    })
}

/// `*` (any run) and `?` (one char) globbing.
fn glob_match(pat: &str, s: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (pat.chars().collect(), s.chars().collect());
    let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if let Some(st) = star {
            pi = st + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// stdout of `cmd`, or `None` when it fails or outlives `timeout`. It runs in its own process
/// group, and on timeout the whole group is killed: a wrapper that ran the real launcher
/// without `exec` takes that launcher with it. When it exits but something it left behind
/// still holds stdout (a daemon), what was printed is returned after a short grace, without
/// waiting for that process.
pub fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<String> {
    use std::os::unix::process::CommandExt;
    use std::sync::{Arc, Mutex, mpsc};
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let buf = Arc::new(Mutex::new(Vec::new()));
    let (done, eof) = mpsc::channel();
    {
        let buf = Arc::clone(&buf);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n @ 1..) = stdout.read(&mut chunk) {
                buf.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
            let _ = done.send(());
        });
    }
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let now = std::time::Instant::now();
        match child.try_wait() {
            Ok(Some(st)) => {
                let grace = deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_secs(1));
                let _ = eof.recv_timeout(grace);
                let out = String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
                return st.success().then_some(out);
            }
            Ok(None) if now < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                // the group's id is the child's pid (`process_group(0)`); the shell's `kill`
                // builtin, so no `kill` binary on $PATH is needed
                let _ = Command::new("/bin/sh")
                    .args(["-c", "kill -KILL -- -$0", &child.id().to_string()])
                    .stderr(std::process::Stdio::null())
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// `overmind harness list --json`: one row per harness.
#[derive(Debug, Clone, Serialize)]
pub struct HarnessInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// The launch command (`claude`, a wrapper, …).
    pub command: String,
    /// Its first word resolves to an executable (PATH, the usual install dirs).
    pub installed: bool,
    /// Why it can't be used here, with the fix: not found (and where overmind looked), or —
    /// Codex — never run / not logged in. `null` when nothing is known to be wrong.
    pub problem: Option<String>,
    pub models: Vec<ModelOption>,
    /// Reasoning-effort levels it takes (`--effort`, `-c model_reasoning_effort=`, `--thinking`).
    pub efforts: Vec<String>,
    /// `harnesses.<id>.model` / `.effort`: what a spawn uses when it picks none.
    #[serde(rename = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(rename = "defaultEffort")]
    pub default_effort: Option<String>,
}

pub fn info(h: Harness, with_models: bool) -> HarnessInfo {
    let command = h.command();
    let installed = binary(&command).is_some();
    let models = match (with_models && installed, h) {
        (false, _) => Vec::new(),
        (true, Harness::Claude) => claude_models(),
        (true, Harness::Codex) => codex_models(&codex_home(), h.default_model().as_deref()),
        (true, Harness::Pi) => pi_models(&pi_home(), &command),
    };
    let problem = problem(
        h,
        &command,
        installed,
        crate::core::tools::fallback_dirs,
        &codex_home(),
    );
    HarnessInfo {
        id: h.id(),
        label: h.label(),
        command,
        installed,
        problem,
        models,
        efforts: h.efforts(),
        default_model: h.default_model(),
        default_effort: h.default_effort(),
    }
}

/// The executable a launch command's first word resolves to: a path (`~` allowed) as given,
/// a bare name on `$PATH` and in the usual install dirs ([`crate::core::tools::find_binary`]).
pub fn binary(command: &str) -> Option<PathBuf> {
    let bin = command.split_whitespace().next()?;
    if bin.contains('/') {
        let p = PathBuf::from(crate::core::tools::expand_tilde(bin));
        crate::core::tools::is_executable(&p).then_some(p)
    } else {
        crate::core::tools::find_binary(bin)
    }
}

/// What overmind can tell about Codex's login in its home (`$CODEX_HOME`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexLogin {
    /// No `auth.json`, and the config keeps credentials in a file (or says nothing).
    None,
    /// `auth.json` is there.
    File,
    /// No `auth.json`, and `cli_auth_credentials_store` is `"keyring"` or `"auto"`: the
    /// credentials may be in the OS keyring, where overmind can't look. Counted as logged in,
    /// but unverified — `"auto"` on a host without a keyring (headless Linux) falls back to a
    /// file, so no `auth.json` there really means not logged in.
    Keyring,
}

impl CodexLogin {
    pub fn logged_in(self) -> bool {
        self != CodexLogin::None
    }
}

/// Codex's login in `home`: its `auth.json`, or a top-level `cli_auth_credentials_store` of
/// `"keyring"` / `"auto"` in `config.toml` ([`CodexLogin::Keyring`]).
pub fn codex_login(home: &Path) -> CodexLogin {
    if home.join("auth.json").is_file() {
        return CodexLogin::File;
    }
    let config = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let keyring = config
        .lines()
        .map(str::trim)
        .take_while(|l| !is_table_header(l))
        .filter_map(|l| l.split_once('='))
        .any(|(k, v)| {
            k.trim() == "cli_auth_credentials_store"
                && matches!(toml_string(v), Some("keyring" | "auto"))
        });
    if keyring {
        CodexLogin::Keyring
    } else {
        CodexLogin::None
    }
}

/// `[table]` / `[[array.of.tables]]` (a trailing `# comment` allowed) — not a row of a
/// multi-line array (`[1, 2],`), which also starts with `[`.
fn is_table_header(l: &str) -> bool {
    let l = l.split_once('#').map_or(l, |(h, _)| h).trim_end();
    let inner = l
        .strip_prefix("[[")
        .and_then(|r| r.strip_suffix("]]"))
        .or_else(|| l.strip_prefix('[').and_then(|r| r.strip_suffix(']')));
    inner.is_some_and(|k| {
        !k.trim().is_empty()
            && k.chars()
                .all(|c| c.is_alphanumeric() || " _-.\"'".contains(c))
    })
}

/// A TOML string value on one line: `"x"` or `'x'`, a trailing `# comment` allowed.
fn toml_string(v: &str) -> Option<&str> {
    let v = v.trim_start();
    let q = v.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let rest = &v[1..];
    let end = rest.find(q)?;
    let tail = rest[end + 1..].trim_start();
    (tail.is_empty() || tail.starts_with('#')).then_some(&rest[..end])
}

/// Why `h` can't be used here, with the fix — `None` when nothing is known to be wrong.
/// `installed` is [`binary`]`(command).is_some()`, passed in so this stays pure;
/// `looked_in` gives the dirs searched after `$PATH` (only called when not installed);
/// `codex_home` is Codex's home (only read for Codex).
pub fn problem(
    h: Harness,
    command: &str,
    installed: bool,
    looked_in: impl FnOnce() -> Vec<PathBuf>,
    codex_home: &Path,
) -> Option<String> {
    use crate::core::tools::tildify;
    let setting = match h {
        Harness::Claude => "OVERMIND_CMD / config `claude`".to_string(),
        _ => format!("harnesses.{}.command", h.id()),
    };
    if !installed {
        let bin = command.split_whitespace().next().unwrap_or(h.id());
        if bin.contains('/') {
            return Some(format!("{bin} is not an executable — fix {setting}"));
        }
        let install = match h {
            Harness::Claude => "install Claude Code",
            Harness::Codex => "install it (brew install codex, or npm i -g @openai/codex)",
            Harness::Pi => "install it",
        };
        let dirs: Vec<String> = looked_in()
            .iter()
            .map(|d| tildify(&d.display().to_string()))
            .collect();
        return Some(format!(
            "not found — looked in $PATH, {}; {install}, or set {setting}",
            dirs.join(", ")
        ));
    }
    if h != Harness::Codex {
        return None;
    }
    if !codex_home.is_dir() {
        return Some(format!(
            "never run here (no {}) — run `codex login`",
            tildify(&codex_home.display().to_string())
        ));
    }
    (!codex_login(codex_home).logged_in()).then(|| "not logged in — run `codex login`".to_string())
}

// --- processes ----------------------------------------------------------------

/// A live interactive Codex or pi process.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: i64,
    pub tty: String,
    pub harness: Harness,
    /// Start time, ms since the epoch.
    pub start_ms: i64,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
}

impl Proc {
    /// A session id named on the command line.
    pub fn explicit_session(&self) -> Option<String> {
        explicit_session(self.harness, &self.argv)
    }

    /// `--model` / `-m` from the command line.
    pub fn model_arg(&self) -> Option<String> {
        let mut it = self.argv.iter().skip(1);
        while let Some(a) = it.next() {
            if a == "--model" || (a == "-m" && self.harness == Harness::Codex) {
                return it.next().cloned();
            }
            if let Some(v) = a.strip_prefix("--model=") {
                return Some(v.to_string());
            }
        }
        None
    }
}

fn explicit_session(h: Harness, argv: &[String]) -> Option<String> {
    let args: Vec<&str> = argv.iter().skip(1).map(String::as_str).collect();
    match h {
        Harness::Codex => {
            let i = args.iter().position(|a| *a == "resume" || *a == "fork")?;
            if args[i] == "fork" {
                return None; // a fork gets a new id
            }
            args[i + 1..]
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(|s| s.to_string())
        }
        Harness::Pi => {
            let mut it = args.iter();
            while let Some(a) = it.next() {
                if *a == "--session" || *a == "--session-id" {
                    return it.next().map(|s| s.to_string());
                }
            }
            None
        }
        Harness::Claude => None,
    }
}

/// Which harness an interactive process with this argv runs, if any.
/// Non-interactive runs (`codex exec`, `codex app-server`, `pi -p`, `pi --mode json`,
/// `pi install`, …) are not sessions anyone supervises.
pub fn classify(argv: &[String]) -> Option<Harness> {
    let prog = argv.first()?;
    let base = prog.rsplit('/').next().unwrap_or(prog);
    let rest: Vec<&str> = argv.iter().skip(1).map(String::as_str).collect();
    match base {
        "codex" => {
            // Subcommands come first; anything but resume/fork is not the TUI.
            let first = rest.iter().find(|a| !a.starts_with('-')).copied();
            const TUI: [&str; 2] = ["resume", "fork"];
            const OTHER: [&str; 22] = [
                "exec",
                "e",
                "review",
                "login",
                "logout",
                "mcp",
                "plugin",
                "app-server",
                "remote-control",
                "app",
                "completion",
                "update",
                "doctor",
                "sandbox",
                "debug",
                "apply",
                "a",
                "queue",
                "archive",
                "delete",
                "cloud",
                "exec-server",
            ];
            if first.is_some_and(|f| OTHER.contains(&f) || f == "help" || f == "features")
                && !first.is_some_and(|f| TUI.contains(&f))
            {
                return None;
            }
            if rest
                .iter()
                .any(|a| matches!(*a, "--version" | "-V" | "--help" | "-h"))
            {
                return None;
            }
            Some(Harness::Codex)
        }
        "pi" => {
            const OTHER: [&str; 8] = [
                "install",
                "remove",
                "uninstall",
                "update",
                "list",
                "config",
                "auth",
                "mcp",
            ];
            if rest.first().is_some_and(|f| OTHER.contains(f)) {
                return None;
            }
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                match *a {
                    "-p" | "--print" | "--list-models" | "--export" | "--help" | "-h"
                    | "--version" | "-v" => return None,
                    "--mode" if it.next().is_some_and(|m| *m != "text") => return None,
                    _ => {}
                }
            }
            Some(Harness::Pi)
        }
        _ => None,
    }
}

/// `[[dd-]hh:]mm:ss` (ps `etime`) → seconds.
fn parse_etime(s: &str) -> Option<i64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<i64> = rest
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86400 + secs)
}

/// One `ps` line (`pid etime tty args…`) → a harness process (cwd not filled).
fn parse_ps_line(line: &str, now_ms: i64) -> Option<Proc> {
    let mut cols = line.split_whitespace();
    let pid = cols.next()?.parse().ok()?;
    let etime = parse_etime(cols.next()?)?;
    let tty = cols.next()?;
    if tty == "??" || tty == "?" || tty == "-" {
        return None;
    }
    let argv: Vec<String> = cols.map(str::to_string).collect();
    let harness = classify(&argv)?;
    Some(Proc {
        pid,
        tty: tty.to_string(),
        harness,
        start_ms: now_ms - etime * 1000,
        argv,
        cwd: None,
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Every live interactive Codex / pi process with a terminal.
pub fn processes() -> Vec<Proc> {
    let Ok(out) = Command::new("ps")
        .args(["-axww", "-o", "pid=,etime=,tty=,args="])
        .output()
    else {
        return Vec::new();
    };
    let now = now_ms();
    let mut procs: Vec<Proc> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| parse_ps_line(l, now))
        .collect();
    let cwds = cwds_of(&procs.iter().map(|p| p.pid).collect::<Vec<_>>());
    for p in &mut procs {
        p.cwd = cwds.get(&p.pid).cloned();
    }
    procs
}

/// The working directory of each pid: `/proc/<pid>/cwd`, else one `lsof` call.
fn cwds_of(pids: &[i64]) -> HashMap<i64, String> {
    let mut out = HashMap::new();
    let mut rest = Vec::new();
    for &pid in pids {
        match std::fs::read_link(format!("/proc/{pid}/cwd")) {
            Ok(p) => {
                out.insert(pid, p.display().to_string());
            }
            Err(_) => rest.push(pid.to_string()),
        }
    }
    if rest.is_empty() {
        return out;
    }
    let Ok(o) = Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fpn", "-p", &rest.join(",")])
        .output()
    else {
        return out;
    };
    let mut pid = None;
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse::<i64>().ok();
        } else if let (Some(n), Some(p)) = (line.strip_prefix('n'), pid) {
            out.insert(p, n.to_string());
        }
    }
    out
}

// --- transcripts --------------------------------------------------------------

/// A transcript's identity, from its first line and the file's mtime.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptRef {
    pub path: PathBuf,
    pub session_id: String,
    pub cwd: String,
    pub created_ms: i64,
    pub mtime_ms: i64,
    /// A `codex exec` / `codex review` run (`source: "exec"`, `originator: "codex_exec"` —
    /// the web watcher's markers): never a TUI's by cwd and start time, only when a command
    /// line names it (`codex resume <id>`).
    pub headless: bool,
}

fn mtime_ms(p: &Path) -> Option<i64> {
    let m = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn first_line(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut line = String::new();
    // A Codex `session_meta` line carries the whole system prompt: read it, but cap it.
    std::io::BufReader::new(f)
        .take(4 * 1024 * 1024)
        .read_line(&mut line)
        .ok()?;
    Some(line)
}

fn iso_ms(v: Option<&Value>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v?.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn transcript_ref(h: Harness, path: &Path) -> Option<TranscriptRef> {
    let head: Value = serde_json::from_str(&first_line(path)?).ok()?;
    let meta = match h {
        Harness::Codex => {
            let meta =
                (head.get("type")?.as_str()? == "session_meta").then_some(head.get("payload")?)?;
            // A `spawn_agent` child: same cwd as its parent, created mid-turn, so it
            // would win the parent's process. Codex before 0.166 has no thread_source.
            let sub = meta.get("thread_source").and_then(Value::as_str) == Some("subagent")
                || meta.get("source").and_then(|s| s.get("subagent")).is_some();
            if sub {
                return None;
            }
            meta
        }
        Harness::Pi => (head.get("type")?.as_str()? == "session").then_some(&head)?,
        Harness::Claude => return None,
    };
    let headless = h == Harness::Codex
        && (meta.get("source").and_then(Value::as_str) == Some("exec")
            || meta.get("originator").and_then(Value::as_str) == Some("codex_exec"));
    let session_id = meta
        .get("id")
        .or_else(|| meta.get("session_id"))?
        .as_str()?
        .to_string();
    let cwd = meta.get("cwd")?.as_str()?.to_string();
    let mtime = mtime_ms(path)?;
    let created = iso_ms(meta.get("timestamp"))
        .or_else(|| iso_ms(head.get("timestamp")))
        .unwrap_or(mtime);
    Some(TranscriptRef {
        path: path.to_path_buf(),
        session_id,
        cwd,
        created_ms: created,
        mtime_ms: mtime,
        headless,
    })
}

/// pi's per-cwd session directory name: `--Users-me-Code-app--`.
pub fn pi_dir_name(cwd: &str) -> String {
    let trimmed = cwd.trim_start_matches(['/', '\\']);
    let enc: String = trimmed
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("--{enc}--")
}

fn jsonl_in(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
}

/// Transcripts that may belong to `procs` (all of one harness): pi's per-cwd
/// directories; Codex's day directories, skipping files nobody wrote to since the
/// oldest process started (unless an id on a command line names them).
pub fn transcripts(h: Harness, root: &Path, procs: &[&Proc]) -> Vec<TranscriptRef> {
    let mut out = Vec::new();
    match h {
        Harness::Pi => {
            let cwds: HashSet<&str> = procs.iter().filter_map(|p| p.cwd.as_deref()).collect();
            for cwd in cwds {
                let dir = root.join("sessions").join(pi_dir_name(cwd));
                out.extend(jsonl_in(&dir).filter_map(|p| transcript_ref(h, &p)));
            }
        }
        Harness::Codex => {
            let since = procs.iter().map(|p| p.start_ms).min().unwrap_or(0) - 60_000;
            let wanted: Vec<String> = procs.iter().filter_map(|p| p.explicit_session()).collect();
            // Files live under the day they were created, and a long session keeps
            // writing to an old day's file — so every day is walked, by mtime.
            let sessions = root.join("sessions");
            for y in subdirs(&sessions) {
                for m in subdirs(&y) {
                    for d in subdirs(&m) {
                        for f in jsonl_in(&d) {
                            let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            let named = wanted.iter().any(|w| name.contains(w.as_str()));
                            let recent = mtime_ms(&f).is_some_and(|m| m >= since);
                            if (named || recent)
                                && let Some(t) = transcript_ref(h, &f)
                            {
                                out.push(t);
                            }
                        }
                    }
                }
            }
        }
        Harness::Claude => {}
    }
    out
}

fn subdirs(p: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(p)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// Pair each process with its transcript (see the module docs). Later-started
/// processes choose first, so two sessions in one cwd each get their own. A headless
/// `codex exec` run is matched only by an id on the command line, never by cwd.
pub fn assign(procs: &[&Proc], ts: &[TranscriptRef]) -> HashMap<i64, TranscriptRef> {
    let mut out = HashMap::new();
    let mut taken: HashSet<&Path> = HashSet::new();
    for p in procs {
        if let Some(id) = p.explicit_session()
            && let Some(t) = ts
                .iter()
                .filter(|t| t.session_id == id || t.session_id.starts_with(&id))
                .max_by_key(|t| t.mtime_ms)
        {
            taken.insert(&t.path);
            out.insert(p.pid, t.clone());
        }
    }
    let mut order: Vec<&&Proc> = procs.iter().filter(|p| !out.contains_key(&p.pid)).collect();
    order.sort_by_key(|p| std::cmp::Reverse(p.start_ms));
    // Created after start (with a little clock slack), then merely written since.
    for pass in 0..2 {
        for p in &order {
            if out.contains_key(&p.pid) {
                continue;
            }
            let Some(cwd) = p.cwd.as_deref() else {
                continue;
            };
            let pick = ts
                .iter()
                .filter(|t| t.cwd == cwd && !t.headless && !taken.contains(t.path.as_path()))
                .filter(|t| {
                    if pass == 0 {
                        t.created_ms >= p.start_ms - 3000
                    } else {
                        t.mtime_ms >= p.start_ms
                    }
                })
                .max_by_key(|t| t.mtime_ms);
            if let Some(t) = pick {
                taken.insert(&t.path);
                out.insert(p.pid, t.clone());
            }
        }
    }
    out
}

/// What a transcript's tail says about its session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct State {
    /// `busy` | `idle` | `waiting`.
    pub status: String,
    /// The session's display name (pi's `/name`).
    pub name: Option<String>,
    pub waiting_for: Option<String>,
    pub model: Option<String>,
    pub context: Option<ContextUsage>,
    /// A busy Codex row that may wait on an approval: discovery looks at its screen.
    pub approval: Option<crate::core::codex_hooks::Trigger>,
}

/// The last `max` bytes of a file, starting at a line boundary.
fn tail(path: &Path, max: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Some(if start > 0 {
        text.split_once('\n')
            .map(|(_, r)| r.to_string())
            .unwrap_or_default()
    } else {
        text
    })
}

/// How much of a transcript's end `state` reads.
const TAIL_BYTES: u64 = 512 * 1024;
/// How far back a Codex read goes when the tail holds no turn boundary: one turn can
/// outgrow `TAIL_BYTES` (tool output), and without its `task_started` a busy row reads idle.
const CODEX_TURN_SCAN_BYTES: u64 = 16 * 1024 * 1024;

/// The state of the session `t` belongs to, for a process started at `proc_start_ms`.
pub fn state(h: Harness, t: &TranscriptRef, proc_start_ms: i64) -> State {
    let Some(mut text) = tail(&t.path, TAIL_BYTES) else {
        return State {
            status: "idle".into(),
            ..Default::default()
        };
    };
    match h {
        Harness::Codex => {
            let long = std::fs::metadata(&t.path).is_ok_and(|m| m.len() > TAIL_BYTES);
            if long
                && !codex_has_turn_boundary(&text)
                && let Some(more) = tail(&t.path, CODEX_TURN_SCAN_BYTES)
            {
                text = more;
            }
            let mut st = codex_state(&text);
            if st.status == "busy" && codex_turn_is_stale(&text, t.mtime_ms, proc_start_ms) {
                st.status = "idle".into();
            }
            if st.status == "busy" {
                use crate::core::codex_hooks;
                let sidecar = codex_hooks::read_sidecar(&codex_hooks::sidecar_dir(), &t.session_id);
                st.approval = codex_hooks::trigger(&text, sidecar.as_ref(), proc_start_ms);
            }
            st
        }
        Harness::Pi => pi_state(&text),
        Harness::Claude => State::default(),
    }
}

/// The Codex event lines that open or close a turn.
fn codex_turn_event(line: &str) -> Option<&'static str> {
    const KINDS: [&str; 3] = ["task_started", "task_complete", "turn_aborted"];
    let kind = KINDS.into_iter().find(|k| line.contains(k))?;
    let v: Value = serde_json::from_str(line).ok()?;
    (v.get("type")?.as_str()? == "event_msg" && v.get("payload")?.get("type")?.as_str()? == kind)
        .then_some(kind)
}

fn codex_has_turn_boundary(text: &str) -> bool {
    text.lines().any(|l| codex_turn_event(l).is_some())
}

/// ps `etime` has whole seconds, so a process's start is known to about a second.
const START_SLACK_MS: i64 = 2000;

/// An open turn a previous TUI left behind: an embedded-mode Codex killed mid-turn
/// never writes `task_complete` / `turn_aborted`, and `codex resume` does not close it.
/// Stale when nothing was written since this process started — a daemon-mode turn the
/// new TUI reattached to keeps writing, so stays busy. "Written" is the newest line
/// `timestamp`, not mtime: a branch's synthetic rollout is fresh on disk but carries the
/// original turn's stamps. mtime only when no line has a stamp.
fn codex_turn_is_stale(text: &str, mtime_ms: i64, proc_start_ms: i64) -> bool {
    let last_write = text
        .lines()
        .rev()
        .find_map(|line| {
            let v: Value = serde_json::from_str(line).ok()?;
            iso_ms(v.get("timestamp"))
        })
        .unwrap_or(mtime_ms);
    last_write < proc_start_ms - START_SLACK_MS
}

fn codex_state(text: &str) -> State {
    let mut st = State {
        status: "idle".into(),
        ..Default::default()
    };
    let mut window = None;
    let mut used = None;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let p = v.get("payload");
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let ptype = p
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match (kind, ptype) {
            ("turn_context", _) => {
                if let Some(m) = p.and_then(|p| p.get("model")).and_then(Value::as_str) {
                    st.model = Some(m.to_string());
                }
            }
            ("event_msg", "task_started") => {
                st.status = "busy".into();
                st.waiting_for = None;
            }
            ("event_msg", "task_complete" | "turn_aborted") => {
                st.status = "idle".into();
                st.waiting_for = None;
            }
            ("event_msg", t) if t.ends_with("approval_request") || t == "request_user_input" => {
                st.status = "waiting".into();
                st.waiting_for = Some(t.trim_end_matches("_request").replace('_', " "));
            }
            ("event_msg", "token_count") => {
                let info = p.and_then(|p| p.get("info"));
                if let Some(w) = info
                    .and_then(|i| i.get("model_context_window"))
                    .and_then(Value::as_u64)
                {
                    window = Some(w);
                }
                if let Some(u) = info
                    .and_then(|i| i.get("last_token_usage"))
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(Value::as_u64)
                {
                    used = Some(u);
                }
            }
            // Anything the agent does after an approval means it was answered.
            ("event_msg" | "response_item", _)
                if st.status == "waiting" && !matches!(ptype, "token_count" | "") =>
            {
                st.status = "busy".into();
                st.waiting_for = None;
            }
            _ => {}
        }
    }
    if let (Some(u), Some(w)) = (used, window) {
        st.context = Some(ContextUsage::new(u, w, st.model.clone()));
    }
    st
}

fn pi_state(text: &str) -> State {
    let mut st = State {
        status: "idle".into(),
        ..Default::default()
    };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                st.name = v
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(str::to_string);
            }
            Some("model_change") => {
                st.model = v.get("modelId").and_then(Value::as_str).map(str::to_string);
            }
            Some("message") => {
                let Some(m) = v.get("message") else { continue };
                let role = m.get("role").and_then(Value::as_str).unwrap_or("");
                st.status = match role {
                    "user" | "toolResult" | "bashExecution" => "busy",
                    "assistant" => {
                        if let Some(model) = m.get("model").and_then(Value::as_str) {
                            st.model = Some(model.to_string());
                        }
                        if let Some(u) = m.get("usage") {
                            let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                            let used = n("input") + n("cacheRead") + n("cacheWrite");
                            if used > 0 {
                                st.context = Some(ContextUsage::new(used, 0, st.model.clone()));
                            }
                        }
                        match m.get("stopReason").and_then(Value::as_str) {
                            Some("toolUse") => "busy",
                            _ => "idle",
                        }
                    }
                    _ => st.status.as_str(),
                }
                .to_string();
            }
            _ => {}
        }
    }
    // pi's transcript has no context window; leave usage out rather than guess one.
    st.context = None;
    st
}

/// Codex's thread names (`/rename`, or the title it generates after the first turn):
/// the last entry per id in `$CODEX_HOME/session_index.jsonl`.
pub fn codex_names(home: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(text) = tail(&home.join("session_index.jsonl"), 2 * 1024 * 1024) else {
        return out;
    };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (
            v.get("id").and_then(Value::as_str),
            v.get("thread_name").and_then(Value::as_str),
        ) && !name.trim().is_empty()
        {
            out.insert(id.to_string(), name.trim().to_string());
        }
    }
    out
}

/// The first genuine user prompt (Codex wraps its own context in user messages too).
pub fn first_prompt(h: Harness, path: &Path) -> Option<String> {
    prompts(h, path, 1).into_iter().next()
}

/// The first `n` genuine user prompts, in order.
pub fn prompts(h: Harness, path: &Path, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(f) = std::fs::File::open(path) else {
        return out;
    };
    for line in std::io::BufReader::new(f).take(16 * 1024 * 1024).lines() {
        let Ok(line) = line else { break };
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let msg = match h {
            Harness::Codex => {
                let Some(p) = v.get("payload") else {
                    continue;
                };
                if v.get("type").and_then(Value::as_str) != Some("response_item")
                    || p.get("type").and_then(Value::as_str) != Some("message")
                    || p.get("role").and_then(Value::as_str) != Some("user")
                {
                    continue;
                }
                p
            }
            Harness::Pi => {
                let Some(m) = v.get("message") else {
                    continue;
                };
                if m.get("role").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                m
            }
            Harness::Claude => return out,
        };
        let text = content_text(msg.get("content"));
        let t = text.trim();
        if t.is_empty() || is_codex_context(t) {
            continue;
        }
        out.push(t.to_string());
        if out.len() >= n {
            break;
        }
    }
    out
}

fn is_codex_context(t: &str) -> bool {
    t.starts_with('<') || t.starts_with("# AGENTS.md")
}

/// The text parts of a message `content` (a string or a list of parts).
pub fn content_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    // The picker offers aliases (always the newest model); labels follow what Claude Code used.
    #[test]
    fn claude_models_are_aliases_labelled_with_the_newest_version_seen() {
        let labels = |seen: &[&str]| {
            let seen: Vec<String> = seen.iter().map(|s| s.to_string()).collect();
            super::claude_models_from(&seen)
                .into_iter()
                .map(|m| format!("{}={}", m.id, m.label))
                .collect::<Vec<_>>()
        };
        // Nothing used yet: the built-in versions.
        assert_eq!(
            labels(&[]),
            [
                "=Default",
                "fable=Fable 5.1",
                "opus=Opus 5.5",
                "sonnet=Sonnet 5.5",
                "haiku=Haiku 5.5"
            ]
        );
        // A newer one Claude Code has run wins; older ones, snapshots and [1m] never lower it.
        assert_eq!(
            labels(&[
                "claude-sonnet-5-7",
                "claude-opus-6[1m]",
                "claude-haiku-4-5-20251001",
                "claude-fable-5-1",
                "not-a-model",
            ])[1..],
            [
                "fable=Fable 5.1",
                "opus=Opus 6",
                "sonnet=Sonnet 5.7",
                "haiku=Haiku 5.5"
            ]
        );
    }

    #[test]
    fn claude_used_models_reads_every_projects_last_model_usage() {
        let state = r#"{"projects":{"/a":{"lastModelUsage":{"claude-opus-5-5":{},"claude-sonnet-5-5":{}}},"/b":{"lastModelUsage":{"claude-opus-5-5":{}}},"/c":{}}}"#;
        assert_eq!(
            super::claude_used_models(state),
            ["claude-opus-5-5", "claude-sonnet-5-5"]
        );
        assert!(super::claude_used_models("not json").is_empty());
    }

    #[test]
    fn with_adds_the_picked_or_default_model_and_the_default_effort() {
        use super::Harness::*;
        let s = |o: &str| Some(o.to_string());
        // picked model, no defaults: as before
        assert_eq!(
            Claude.with("claude", Some("claude-haiku-5-5"), None, None, None),
            "claude --model 'claude-haiku-5-5'"
        );
        assert_eq!(Claude.with("cc", None, None, None, None), "cc");
        // defaults fill in; a picked model wins over the default one
        assert_eq!(
            Claude.with("claude", None, None, s("claude-opus-5-5"), s("high")),
            "claude --model 'claude-opus-5-5' --effort high"
        );
        assert_eq!(
            Claude.with("claude", Some("x"), None, s("claude-opus-5-5"), None),
            "claude --model 'x'"
        );
        assert_eq!(
            Codex.with("codex", None, None, None, s("xhigh")),
            "codex -c model_reasoning_effort=xhigh"
        );
        assert_eq!(
            Pi.with(
                "pi",
                None,
                None,
                s("anthropic/claude-opus-5-5"),
                s("medium")
            ),
            "pi --model 'anthropic/claude-opus-5-5' --thinking medium"
        );
        // a launcher that already sets them keeps its own
        assert_eq!(
            Claude.with(
                "claude --model opus --effort low",
                None,
                None,
                s("y"),
                s("high")
            ),
            "claude --model opus --effort low"
        );
        assert_eq!(
            Codex.with(
                "codex -m gpt-6 -c model_reasoning_effort=low",
                None,
                None,
                s("y"),
                s("high")
            ),
            "codex -m gpt-6 -c model_reasoning_effort=low"
        );
        assert_eq!(
            Pi.with("pi --thinking=low", None, None, None, s("high")),
            "pi --thinking=low"
        );
        // a picked model is still added to a launcher with its own --model (the CLI's last one wins)
        assert_eq!(
            Claude.with("claude --model opus", Some("x"), None, None, None),
            "claude --model opus --model 'x'"
        );
        // a picked effort wins over the default one, and is added to a launcher with its own
        assert_eq!(
            Claude.with("claude", None, Some("max"), None, s("high")),
            "claude --effort max"
        );
        assert_eq!(
            Codex.with("codex", Some("gpt-6-luna"), Some("low"), None, s("xhigh")),
            "codex --model 'gpt-6-luna' -c model_reasoning_effort=low"
        );
        assert_eq!(
            Codex.with(
                "codex -c model_reasoning_effort=high",
                None,
                Some("low"),
                None,
                None
            ),
            "codex -c model_reasoning_effort=high -c model_reasoning_effort=low"
        );
        assert_eq!(
            Pi.with("pi", None, Some("off"), None, None),
            "pi --thinking off"
        );
        // an empty pick is no pick
        assert_eq!(
            Claude.with("claude", None, Some(""), None, s("high")),
            "claude --effort high"
        );
    }

    /// The fixture cache (the real one's ten models) in a temp CODEX_HOME.
    fn codex_home_with_fixture(config: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../testdata/codex/models_cache.json"
            ),
            dir.path().join("models_cache.json"),
        )
        .unwrap();
        std::fs::write(dir.path().join("config.toml"), config).unwrap();
        dir
    }

    #[test]
    fn codex_models_carry_the_effort_levels_each_takes() {
        let lv = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let six = lv(&["low", "medium", "high", "xhigh", "max", "ultra"]);
        let five = lv(&["low", "medium", "high", "xhigh", "max"]);
        let dir = codex_home_with_fixture(
            "model = \"gpt-6-luna\"\n[profiles.x]\nmodel = \"gpt-6.1-sol\"\n",
        );
        let models = super::codex_models(dir.path(), None);
        let efforts: Vec<(&str, &Vec<String>)> =
            models.iter().map(|m| (m.id.as_str(), &m.efforts)).collect();
        assert_eq!(
            efforts,
            vec![
                // Default starts config.toml's top-level model: Luna, which has no `ultra`
                ("", &five),
                ("gpt-6.1-sol", &six),
                ("gpt-6.1-terra", &six),
                ("gpt-6-astra", &six),
                ("gpt-6-luna", &five),
            ]
        );
        // overmind's own default (Settings → Models) is what Default starts when set
        assert_eq!(
            super::codex_models(dir.path(), Some("gpt-6.1-sol"))[0].efforts,
            six
        );
        // per model, then the default, then nothing known (a custom slug, no cache)
        let e = |m: Option<&str>, d: Option<&str>| super::codex_model_efforts(dir.path(), m, d);
        assert_eq!(e(Some("gpt-6-luna"), Some("gpt-6.1-sol")), five);
        assert_eq!(
            e(Some("gpt-reserve"), None),
            five,
            "a hidden model typed by hand"
        );
        assert_eq!(e(None, None), five);
        assert_eq!(e(Some(""), Some("gpt-6-astra")), six);
        assert!(e(Some("my-own-model"), None).is_empty());
        assert!(
            super::codex_model_efforts(&dir.path().join("missing"), Some("gpt-6-luna"), None)
                .is_empty()
        );
        // no config.toml model, no overmind default: nothing to look up
        let bare = codex_home_with_fixture("# no model\n");
        assert!(super::codex_model_efforts(bare.path(), None, None).is_empty());
        assert!(super::codex_models(bare.path(), None)[0].efforts.is_empty());
        // the JSON keeps `efforts` off entries without them (Claude's, pi's)
        assert_eq!(
            serde_json::to_value(super::opt("opus", "Opus 5.5")).unwrap(),
            serde_json::json!({ "id": "opus", "label": "Opus 5.5" })
        );
    }

    #[test]
    fn a_picked_effort_must_be_one_the_model_takes() {
        let five: Vec<String> = ["low", "medium", "high", "xhigh", "max"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let c = |m: Option<&str>, e: &str| super::check_effort_in(&five, Harness::Codex, m, e);
        assert_eq!(c(Some("gpt-6-luna"), "max"), Ok(()));
        assert_eq!(
            c(Some("gpt-6-luna"), "ultra"),
            Err("effort \"ultra\" is not one Codex model gpt-6-luna takes — pick one of: low, medium, high, xhigh, max".into())
        );
        assert!(
            c(None, "ultra")
                .unwrap_err()
                .contains("Codex's default model")
        );
        assert!(c(None, "HIGH").is_err(), "not a level");
        assert!(c(None, "").is_err());
    }

    #[test]
    fn codex_efforts_come_from_the_model_cache_in_order() {
        let dir = std::env::temp_dir().join(format!("overmind-codex-eff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("models_cache.json"),
            r#"{"models":[{"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"BAD ONE"}]}]}"#,
        )
        .unwrap();
        assert_eq!(super::codex_efforts(&dir), vec!["low", "high", "medium"]);
        assert!(super::codex_efforts(&dir.join("missing")).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn ids(models: &[ModelOption]) -> Vec<(&str, &str)> {
        models
            .iter()
            .map(|m| (m.id.as_str(), m.label.as_str()))
            .collect()
    }

    #[test]
    fn codex_models_are_the_newest_of_each_listed_family_in_codex_order() {
        let m = |slug: &str, name: &str, vis: &str, prio: i64| serde_json::json!({"slug": slug, "display_name": name, "visibility": vis, "priority": prio});
        // the real cache's ten models (client 0.166.0), hidden ones included
        let cache = serde_json::json!({"models": [
            m("gpt-6.1-sol", "GPT-6.1-Sol", "list", 1),
            m("gpt-6.1-terra", "GPT-6.1 Terra", "list", 2),
            m("gpt-6-astra", "GPT-6-Astra", "list", 3),
            m("gpt-6-sol", "GPT-6-Sol", "list", 4),
            m("gpt-reserve", "GPT-Reserve", "hide", 5),
            m("gpt-6-luna", "GPT-6-Luna", "list", 6),
            m("gpt-5.6-sol", "GPT-5.6-Sol", "list", 7),
            m("gpt-5.6-terra", "GPT-5.6-Terra", "list", 8),
            m("gpt-5.6-luna", "GPT-5.6-Luna", "list", 9),
            m("codex-auto-review", "Codex Auto Review", "hide", 10),
        ]});
        assert_eq!(
            ids(&super::codex_models_from(&cache)),
            vec![
                ("", "Default"),
                ("gpt-6.1-sol", "GPT-6.1 Sol"),
                ("gpt-6.1-terra", "GPT-6.1 Terra"),
                ("gpt-6-astra", "GPT-6 Astra"),
                ("gpt-6-luna", "GPT-6 Luna"),
            ]
        );

        // a slug without a version is its own family; a listed one is shown, never wins
        // over a versioned sibling; a hidden newer model does not suppress a listed older one
        let cache = serde_json::json!({"models": [
            m("o3", "o3", "list", 5),
            m("gpt-7-sol", "GPT-7-Sol", "hide", 1),
            m("gpt-6-sol", "GPT-6-Sol", "list", 4),
            {"slug": "gpt-5.2", "visibility": "list", "priority": 3},
            m("gpt-6.2-sol-mini", "GPT-6.2-Sol-Mini", "list", 2),
        ]});
        assert_eq!(
            ids(&super::codex_models_from(&cache)),
            vec![
                ("", "Default"),
                ("gpt-6.2-sol-mini", "GPT-6.2 Sol-Mini"),
                ("gpt-5.2", "gpt-5.2"),
                ("gpt-6-sol", "GPT-6 Sol"),
                ("o3", "o3"),
            ]
        );

        // the same version twice in one family: Codex's lower priority wins
        let cache = serde_json::json!({"models": [
            m("gpt-6-sol", "B", "list", 7),
            m("GPT-6.0-sol", "A", "list", 2),
        ]});
        assert_eq!(
            ids(&super::codex_models_from(&cache)),
            vec![("", "Default"), ("GPT-6.0-sol", "A")]
        );

        assert_eq!(
            ids(&super::codex_models_from(&Value::Null)),
            vec![("", "Default")]
        );
    }

    #[test]
    fn codex_slugs_parse_into_prefix_version_and_family() {
        let v = |s: &str| super::codex_model_version(s);
        assert_eq!(
            v("gpt-6.1-sol"),
            Some(("gpt".into(), (6, Some(1)), "sol".into()))
        );
        assert_eq!(
            v("gpt-6-astra"),
            Some(("gpt".into(), (6, None), "astra".into()))
        );
        assert_eq!(v("gpt-5.2"), Some(("gpt".into(), (5, Some(2)), "".into())));
        assert_eq!(
            v("gpt-6.2-sol-mini"),
            Some(("gpt".into(), (6, Some(2)), "sol-mini".into()))
        );
        for bad in [
            "gpt-reserve",
            "codex-auto-review",
            "o3",
            "codex-mini-latest",
            "gpt-6.x-sol",
            "-6-sol",
        ] {
            assert_eq!(v(bad), None, "{bad}");
        }
    }

    #[test]
    fn codex_labels_put_a_space_between_version_and_family() {
        let l = super::codex_label;
        assert_eq!(l("GPT-6.1-Sol"), "GPT-6.1 Sol");
        assert_eq!(l("GPT-6-Astra"), "GPT-6 Astra");
        assert_eq!(l("GPT-6.2-Sol-Mini"), "GPT-6.2 Sol-Mini");
        for verbatim in [
            "GPT-6.1 Terra",
            "Codex Auto Review",
            "GPT-Reserve",
            "GPT-6.1",
            "GPT-6.1-",
            "gpt-6-sol",
            "GPT-x-Sol",
        ] {
            assert_eq!(l(verbatim), verbatim);
        }
    }

    #[test]
    fn codex_is_logged_in_with_an_auth_json_or_a_keyring_store() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let with = |config: &str| {
            std::fs::write(h.join("config.toml"), config).unwrap();
            codex_login(h)
        };
        assert_eq!(codex_login(h), CodexLogin::None);
        assert_eq!(with("model = \"gpt-6.1-sol\"\n"), CodexLogin::None);
        // credentials in the OS keyring: overmind can't look, so it takes them as there
        for store in [
            "cli_auth_credentials_store = \"keyring\"\n",
            "cli_auth_credentials_store = 'keyring'\n",
            "cli_auth_credentials_store=\"auto\"   # keyring when there is one\n",
            "  cli_auth_credentials_store = 'auto' #x\n[profiles.a]\n",
            // a nested array's rows start with `[` but are not a table
            "grid = [\n  [1, 2],\n  [3, 4]\n]\ncli_auth_credentials_store = \"keyring\"\n",
            "x = [[1], [2]]\ncli_auth_credentials_store = \"keyring\"\n",
        ] {
            assert_eq!(with(store), CodexLogin::Keyring, "{store}");
        }
        for not in [
            "cli_auth_credentials_store = \"file\"\n",
            "cli_auth_credentials_store = \"keyring\" trailing\n",
            "cli_auth_credentials_store = \"keyring'\n",
            "[profiles.a]\ncli_auth_credentials_store = \"keyring\"\n",
            "[[mcp]]\ncli_auth_credentials_store = \"keyring\"\n",
            "[ \"quoted.table\" ] # c\ncli_auth_credentials_store = \"keyring\"\n",
        ] {
            assert_eq!(with(not), CodexLogin::None, "{not}");
        }
        assert!(!CodexLogin::None.logged_in() && CodexLogin::Keyring.logged_in());
        std::fs::write(h.join("auth.json"), "{}").unwrap();
        assert_eq!(
            with("cli_auth_credentials_store = \"auto\"\n"),
            CodexLogin::File
        );
    }

    // A launcher killed on timeout takes its whole process group with it: a `#!/bin/sh`
    // wrapper that runs `codex …` without `exec` must not leave that Codex behind.
    #[test]
    fn a_timed_out_command_leaves_no_grandchild_behind() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let start = std::time::Instant::now();
        let out = run_with_timeout(
            Command::new("sh").arg("-c").arg(format!(
                "sleep 20 & echo $! > {}; cat; wait",
                pidfile.display()
            )),
            Duration::from_secs(1),
        );
        assert_eq!(out, None);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
        let pid = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .to_string();
        std::thread::sleep(Duration::from_millis(200));
        let alive = Command::new("kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        if alive {
            let _ = Command::new("kill").args(["-9", &pid]).status();
        }
        assert!(!alive, "grandchild {pid} survived the timeout");
    }

    // A launcher that exits but leaves a background process holding its stdout: the output is
    // returned without waiting for that process.
    #[test]
    fn a_leftover_holding_stdout_does_not_outlast_the_timeout() {
        let start = std::time::Instant::now();
        let out = run_with_timeout(
            Command::new("sh").arg("-c").arg("echo v1.0; sleep 20 &"),
            Duration::from_secs(2),
        );
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(out.as_deref().map(str::trim), Some("v1.0"));
        // plain cases still work
        assert_eq!(
            run_with_timeout(
                Command::new("sh").arg("-c").arg("echo ok"),
                Duration::from_secs(5)
            ),
            Some("ok\n".into())
        );
        assert_eq!(
            run_with_timeout(
                Command::new("sh").arg("-c").arg("echo no; exit 3"),
                Duration::from_secs(5)
            ),
            None
        );
    }

    #[test]
    fn a_harness_that_cannot_run_says_why_and_the_fix() {
        let dirs = [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/x/.volta/bin"),
        ];
        let home = tempfile::tempdir().unwrap();
        let none = home.path().join("absent");

        let p = problem(Harness::Codex, "codex", false, || dirs.to_vec(), &none).unwrap();
        assert!(p.starts_with("not found"), "{p}");
        for want in [
            "$PATH",
            "/opt/homebrew/bin",
            "/x/.volta/bin",
            "npm i -g @openai/codex",
            "harnesses.codex.command",
        ] {
            assert!(p.contains(want), "{want}: {p}");
        }
        let p = problem(
            Harness::Codex,
            "~/wrap/codex -a on-request",
            false,
            || dirs.to_vec(),
            &none,
        )
        .unwrap();
        assert!(
            p.contains("~/wrap/codex") && p.contains("not an executable"),
            "{p}"
        );
        assert!(!p.contains("/opt/homebrew/bin"), "{p}");
        let p = problem(Harness::Claude, "claude", false, || dirs.to_vec(), &none).unwrap();
        assert!(
            p.contains("OVERMIND_CMD") && p.contains("config `claude`"),
            "{p}"
        );
        let p = problem(Harness::Pi, "pi", false, || dirs.to_vec(), &none).unwrap();
        assert!(p.contains("harnesses.pi.command"), "{p}");

        // installed Codex: never run here, then not logged in, then fine
        let p = problem(Harness::Codex, "codex", true, || dirs.to_vec(), &none).unwrap();
        assert!(
            p.contains("never run here") && p.contains("codex login"),
            "{p}"
        );
        let p = problem(Harness::Codex, "codex", true, || dirs.to_vec(), home.path()).unwrap();
        assert_eq!(p, "not logged in — run `codex login`");
        std::fs::write(home.path().join("auth.json"), "{}").unwrap();
        assert_eq!(
            problem(Harness::Codex, "codex", true, || dirs.to_vec(), home.path()),
            None
        );
        // the lookup dirs are only listed (and read) when the harness is not found
        let p = problem(Harness::Pi, "pi", true, || unreachable!(), &none);
        assert_eq!(p, None);
        // the others have no login overmind can see
        assert_eq!(
            problem(Harness::Claude, "claude", true, || dirs.to_vec(), &none),
            None
        );
        assert_eq!(
            problem(Harness::Pi, "pi", true, || dirs.to_vec(), &none),
            None
        );
    }

    #[test]
    fn codex_models_read_the_cache_from_codex_home_and_default_stays_plain() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../testdata/codex/models_cache.json"
            ),
            dir.path().join("models_cache.json"),
        )
        .unwrap();
        // a configured model does not rename the chip: Default reads "Default", as Claude's
        std::fs::write(dir.path().join("config.toml"), "model = \"gpt-6.1-sol\"\n").unwrap();
        assert_eq!(
            ids(&super::codex_models(dir.path(), None)),
            vec![
                ("", "Default"),
                ("gpt-6.1-sol", "GPT-6.1 Sol"),
                ("gpt-6.1-terra", "GPT-6.1 Terra"),
                ("gpt-6-astra", "GPT-6 Astra"),
                ("gpt-6-luna", "GPT-6 Luna"),
            ]
        );
        assert_eq!(
            ids(&super::codex_models(&dir.path().join("missing"), None)),
            vec![("", "Default")]
        );
    }

    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn interactive_processes_are_told_from_the_rest() {
        assert_eq!(classify(&argv("codex")), Some(Harness::Codex));
        assert_eq!(
            classify(&argv("/opt/homebrew/bin/codex -m gpt-6 hi")),
            Some(Harness::Codex)
        );
        assert_eq!(classify(&argv("codex resume abc")), Some(Harness::Codex));
        assert_eq!(classify(&argv("codex exec hi")), None);
        assert_eq!(classify(&argv("codex app-server --listen unix://")), None);
        assert_eq!(classify(&argv("pi")), Some(Harness::Pi));
        assert_eq!(
            classify(&argv("pi --model openai/gpt-5.5 fix it")),
            Some(Harness::Pi)
        );
        assert_eq!(classify(&argv("pi -p hi")), None);
        assert_eq!(classify(&argv("pi --mode rpc")), None);
        assert_eq!(classify(&argv("pi install x")), None);
        assert_eq!(classify(&argv("claude")), None);
        assert_eq!(classify(&argv("spindump")), None);
    }

    #[test]
    fn ps_lines_become_processes() {
        let p = parse_ps_line("  4242 01:02:03 ttys004 codex -m gpt-6", 10_000_000).unwrap();
        assert_eq!(p.pid, 4242);
        assert_eq!(p.tty, "ttys004");
        assert_eq!(p.start_ms, 10_000_000 - 3723 * 1000);
        assert_eq!(p.model_arg().as_deref(), Some("gpt-6"));
        assert!(parse_ps_line("1 00:01 ?? codex", 0).is_none());
        assert_eq!(parse_etime("2-00:00:01"), Some(172_801));
        assert_eq!(parse_etime("05:07"), Some(307));
    }

    #[test]
    fn explicit_ids_come_from_resume_flags() {
        assert_eq!(
            explicit_session(Harness::Codex, &argv("codex resume abc-1")).as_deref(),
            Some("abc-1")
        );
        assert_eq!(
            explicit_session(Harness::Codex, &argv("codex fork abc")),
            None
        );
        assert_eq!(
            explicit_session(Harness::Pi, &argv("pi --session-id x9")).as_deref(),
            Some("x9")
        );
    }

    #[test]
    fn pi_session_dirs_encode_the_cwd() {
        assert_eq!(pi_dir_name("/Users/me/Code/app"), "--Users-me-Code-app--");
    }

    #[test]
    fn resume_commands_per_harness() {
        assert_eq!(
            Harness::Claude.resume_command("claude", None, "s1"),
            "claude --resume s1"
        );
        assert_eq!(
            Harness::Codex.resume_command("codex", Some("gpt-6"), "s1"),
            "codex --model 'gpt-6' resume s1"
        );
        assert_eq!(
            Harness::Pi.resume_command("pi", None, "s1"),
            "pi --session s1"
        );
    }

    fn proc_(pid: i64, cwd: &str, start: i64) -> Proc {
        Proc {
            pid,
            tty: "ttys001".into(),
            harness: Harness::Pi,
            start_ms: start,
            argv: argv("pi"),
            cwd: Some(cwd.into()),
        }
    }

    fn tref(id: &str, cwd: &str, created: i64, mtime: i64) -> TranscriptRef {
        TranscriptRef {
            path: PathBuf::from(format!("/t/{id}.jsonl")),
            session_id: id.into(),
            cwd: cwd.into(),
            created_ms: created,
            mtime_ms: mtime,
            headless: false,
        }
    }

    #[test]
    fn two_sessions_in_one_cwd_get_their_own_transcripts() {
        let a = proc_(1, "/w", 1_000_000);
        let b = proc_(2, "/w", 2_000_000);
        let ts = vec![
            tref("old", "/w", 10, 900_000),
            tref("a", "/w", 1_000_500, 2_500_000),
            tref("b", "/w", 2_000_400, 2_400_000),
            tref("elsewhere", "/x", 2_000_400, 3_000_000),
        ];
        let got = assign(&[&a, &b], &ts);
        assert_eq!(got[&1].session_id, "a");
        assert_eq!(got[&2].session_id, "b");
    }

    #[test]
    fn a_resumed_session_falls_back_to_a_transcript_written_since_start() {
        let a = proc_(1, "/w", 1_000_000);
        let ts = vec![tref("old", "/w", 10, 1_500_000), tref("older", "/w", 5, 20)];
        assert_eq!(assign(&[&a], &ts)[&1].session_id, "old");
        let idle = proc_(2, "/w", 2_000_000);
        assert!(assign(&[&idle], &ts).is_empty());
    }

    #[test]
    fn codex_status_follows_the_turn_events() {
        let ev = |t: &str| format!(r#"{{"type":"event_msg","payload":{{"type":"{t}"}}}}"#);
        let busy = [ev("task_started"), ev("item_completed")].join("\n");
        assert_eq!(codex_state(&busy).status, "busy");
        let done = [ev("task_started"), ev("task_complete")].join("\n");
        assert_eq!(codex_state(&done).status, "idle");
        let wait = [ev("task_started"), ev("exec_approval_request")].join("\n");
        let st = codex_state(&wait);
        assert_eq!(st.status, "waiting");
        assert_eq!(st.waiting_for.as_deref(), Some("exec approval"));
        let tc = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":25840},"model_context_window":258400}}}"#;
        let ctx = r#"{"type":"turn_context","payload":{"model":"gpt-6"}}"#;
        let st = codex_state(&[ctx, tc].join("\n"));
        let c = st.context.unwrap();
        assert_eq!((c.used, c.window, c.pct), (25840, 258400, 10));
        assert_eq!(st.model.as_deref(), Some("gpt-6"));
    }

    /// A Codex 0.166 `session_meta` line, shaped like a real one (instructions dropped,
    /// ids and names synthetic). `src` is the JSON after `"source":`, so a test can
    /// write any `source` / `thread_source` pair.
    fn codex_meta_src(id: &str, cwd: &str, ts: &str, src: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","session_id":"{id}","timestamp":"{ts}","cwd":"{cwd}","originator":"codex-tui","cli_version":"0.166.0","source":{src},"history_mode":"paginated","model_provider":"openai"}}}}"#
        )
    }

    const CODEX_USER: &str = r#""cli","thread_source":"user""#;

    /// A `spawn_agent` child's `source`, with or without 0.166's `thread_source`.
    fn codex_child_src(parent: &str, thread_source: bool) -> String {
        let ts = if thread_source {
            r#","thread_source":"subagent""#
        } else {
            ""
        };
        format!(
            r#"{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{parent}","depth":1,"agent_path":"/root/worker","agent_nickname":"Child","agent_role":null}}}}}}{ts}"#
        )
    }

    fn codex_meta(id: &str, cwd: &str, ts: &str, child_of: Option<&str>) -> String {
        match child_of {
            None => codex_meta_src(id, cwd, ts, CODEX_USER),
            Some(parent) => codex_meta_src(id, cwd, ts, &codex_child_src(parent, true)),
        }
    }

    fn codex_turn(ts: &str, kind: &str, turn: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"{kind}","turn_id":"{turn}","root_turn_id":"{turn}","started_at":1700000000,"model_context_window":475000}}}}"#
        )
    }

    fn codex_tool_call(ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"response_item","payload":{{"type":"custom_tool_call","name":"exec","call_id":"c1","input":"sleep 45"}}}}"#
        )
    }

    fn write_at(path: &Path, lines: &[String], mtime_ms: i64) {
        std::fs::write(path, lines.join("\n") + "\n").unwrap();
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::from_millis(mtime_ms as u64))
            .unwrap();
    }

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    const PARENT_ID: &str = "00000000-0000-7000-8000-00000000a001";
    const CHILD_ID: &str = "00000000-0000-7000-8000-00000000c001";

    #[test]
    fn a_codex_subagent_child_in_the_parents_cwd_is_never_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("sessions/2026/11/04");
        std::fs::create_dir_all(&day).unwrap();
        let now = now_ms();
        let start = now - 120_000;
        let parent = day.join(format!("rollout-2026-11-04T10-00-00-{PARENT_ID}.jsonl"));
        let child = day.join(format!("rollout-2026-11-04T10-01-40-{CHILD_ID}.jsonl"));
        write_at(
            &parent,
            &[
                codex_meta(PARENT_ID, "/w/repo", &iso(start + 1_000), None),
                codex_turn(&iso(start + 40_000), "task_started", "t2"),
            ],
            now - 30_000,
        );
        // The child is newer on both counts: created mid-turn, written last.
        write_at(
            &child,
            &[
                codex_meta(CHILD_ID, "/w/repo", &iso(start + 100_000), Some(PARENT_ID)),
                codex_turn(&iso(start + 100_000), "task_started", "t2"),
            ],
            now - 1_000,
        );
        let mut p = proc_(7, "/w/repo", start);
        p.harness = Harness::Codex;
        let ts = transcripts(Harness::Codex, dir.path(), &[&p]);
        assert_eq!(
            ts.iter().map(|t| t.session_id.as_str()).collect::<Vec<_>>(),
            [PARENT_ID]
        );
        assert_eq!(assign(&[&p], &ts)[&7].session_id, PARENT_ID);
    }

    #[test]
    fn either_codex_subagent_marker_alone_drops_a_rollout_and_nothing_else_does() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("rollout.jsonl");
        let ts = "2026-11-04T10:00:00.000Z";
        let kept = |src: &str| {
            std::fs::write(&f, codex_meta_src(CHILD_ID, "/w", ts, src) + "\n").unwrap();
            transcript_ref(Harness::Codex, &f).is_some()
        };
        // Codex before 0.166: only `source.subagent`, in each of its serialised forms.
        assert!(!kept(&codex_child_src(PARENT_ID, false)));
        assert!(!kept(r#"{"subagent":"review"}"#));
        // Only 0.166's `thread_source`, whatever `source` says.
        assert!(!kept(r#""cli","thread_source":"subagent""#));
        // User threads: a pre-0.166 / desktop import with no thread_source, a desktop
        // onboarding thread, a `codex exec` run, and a 0.166 TUI thread.
        assert!(kept(r#""vscode""#));
        assert!(kept(
            r#""vscode","thread_source":"conversational_onboarding""#
        ));
        // A `codex exec` run is kept as a transcript — `codex resume <exec-id>` names it —
        // but marked headless, so cwd + start-time matching never hands it a TUI's row
        // (see a_codex_exec_rollout_never_takes_a_tui_row_by_cwd).
        assert!(kept(r#""exec""#));
        assert!(kept(CODEX_USER));
        let headless = |src: &str, originator: &str| {
            let line = codex_meta_src(CHILD_ID, "/w", ts, src)
                .replace(r#""originator":"codex-tui""#, originator);
            std::fs::write(&f, line + "\n").unwrap();
            transcript_ref(Harness::Codex, &f).unwrap().headless
        };
        assert!(headless(r#""exec""#, r#""originator":"codex_exec""#));
        assert!(headless(r#""exec""#, r#""originator":"codex-tui""#));
        assert!(headless(CODEX_USER, r#""originator":"codex_exec""#));
        assert!(!headless(CODEX_USER, r#""originator":"codex-tui""#));
        assert!(!headless(r#""vscode""#, r#""originator":"codex_cli_rs""#));
    }

    #[test]
    fn a_codex_exec_rollout_never_takes_a_tui_row_by_cwd() {
        // Live test F2: a TUI idle in /w, then a `codex exec` in /w — created after the
        // TUI started and written last, it won both passes and the row showed its turns.
        let tui = proc_(1, "/w", 1_000_000);
        let exec = |id: &str, created, mtime| TranscriptRef {
            headless: true,
            ..tref(id, "/w", created, mtime)
        };
        let ts = vec![
            tref("tui", "/w", 1_000_500, 1_500_000),
            exec("exec", 1_600_000, 1_700_000),
        ];
        assert_eq!(assign(&[&tui], &ts)[&1].session_id, "tui");
        // A fresh TUI before its first prompt has no rollout: no row data from the exec.
        assert!(assign(&[&tui], &ts[1..]).is_empty());
        // `codex resume <exec-id>` names it: that still finds it.
        let mut resumed = proc_(2, "/w", 2_000_000);
        resumed.harness = Harness::Codex;
        resumed.argv = vec!["codex".into(), "resume".into(), "exec".into()];
        assert_eq!(assign(&[&resumed], &ts)[&2].session_id, "exec");
    }

    #[test]
    fn a_codex_turn_left_open_by_a_crashed_tui_is_idle() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("rollout.jsonl");
        let now = now_ms();
        let crash = now - 600_000;
        let lines = [
            codex_meta("s1", "/w", &iso(crash - 60_000), None),
            codex_turn(&iso(crash - 50_000), "task_started", "t1"),
            codex_turn(&iso(crash - 40_000), "task_complete", "t1"),
            // Killed mid-turn: the rollout ends at a tool call, never closed.
            codex_turn(&iso(crash - 5_000), "task_started", "t2"),
            codex_tool_call(&iso(crash - 4_000)),
        ];
        write_at(&f, &lines, crash);
        let t = transcript_ref(Harness::Codex, &f).unwrap();
        // `codex resume s1` a minute after the crash.
        assert_eq!(state(Harness::Codex, &t, crash + 60_000).status, "idle");
        // The process that wrote the turn is still the one running: busy.
        assert_eq!(state(Harness::Codex, &t, crash - 70_000).status, "busy");
        // A daemon-mode turn the new TUI reattached to keeps writing: busy.
        let mut more = lines.to_vec();
        more.push(codex_tool_call(&iso(now - 3_000)));
        write_at(&f, &more, now);
        let t = transcript_ref(Harness::Codex, &f).unwrap();
        assert_eq!(state(Harness::Codex, &t, crash + 60_000).status, "busy");
        // A new turn in the resumed process is busy, then idle when it ends.
        let mut more = lines.to_vec();
        more.push(codex_turn(&iso(now - 2_000), "task_started", "t3"));
        write_at(&f, &more, now);
        let t = transcript_ref(Harness::Codex, &f).unwrap();
        assert_eq!(state(Harness::Codex, &t, crash + 60_000).status, "busy");
        more.push(codex_turn(&iso(now - 1_000), "task_complete", "t3"));
        write_at(&f, &more, now);
        let t = transcript_ref(Harness::Codex, &f).unwrap();
        assert_eq!(state(Harness::Codex, &t, crash + 60_000).status, "idle");
    }

    /// "Written since the process started" is the newest line stamp, not mtime.
    #[test]
    fn a_stale_codex_turn_is_judged_by_its_newest_line_stamp_not_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("rollout.jsonl");
        let now = now_ms();
        let old = now - 3_600_000;
        let open_turn = |at: i64| {
            vec![
                codex_meta("s1", "/w", &iso(at - 10_000), None),
                codex_turn(&iso(at - 5_000), "task_started", "t1"),
                codex_tool_call(&iso(at)),
            ]
        };
        let status = |lines: &[String], mtime: i64, start: i64| {
            write_at(&f, lines, mtime);
            let t = transcript_ref(Harness::Codex, &f).unwrap();
            state(Harness::Codex, &t, start).status
        };
        // A branch cut mid-turn: the synthetic rollout was written just now, but every
        // line keeps the original turn's old stamp. Nothing ran in this process: idle.
        assert_eq!(status(&open_turn(old), now, now - 1_000), "idle");
        // The reverse: lines this process wrote, in a file whose mtime is old (copied
        // with its times kept). Still busy.
        assert_eq!(status(&open_turn(now - 1_000), old, now - 60_000), "busy");
        // No line has a stamp: mtime decides.
        let bare: Vec<String> = [
            r#"{"type":"session_meta","payload":{"id":"s1","cwd":"/w"}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(status(&bare, old, now - 60_000), "idle");
        assert_eq!(status(&bare, now - 1_000, now - 60_000), "busy");
    }

    /// A single turn whose tool output outgrows the tail still reads busy.
    #[test]
    fn a_codex_turn_longer_than_the_tail_stays_busy() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("rollout.jsonl");
        let now = now_ms();
        let start = now - 600_000;
        let output = "x".repeat(64 * 1024);
        let mut lines = vec![
            codex_meta("s1", "/w", &iso(start), None),
            r#"{"type":"turn_context","payload":{"model":"gpt-6"}}"#.to_string(),
            codex_turn(&iso(start + 1_000), "task_started", "t1"),
        ];
        for i in 0..12 {
            lines.push(format!(
                r#"{{"timestamp":"{}","type":"response_item","payload":{{"type":"function_call_output","call_id":"c{i}","output":"{output}"}}}}"#,
                iso(now - 60_000 + i)
            ));
        }
        write_at(&f, &lines, now);
        assert!(std::fs::metadata(&f).unwrap().len() > TAIL_BYTES);
        let t = transcript_ref(Harness::Codex, &f).unwrap();
        let st = state(Harness::Codex, &t, start);
        assert_eq!(st.status, "busy");
        assert_eq!(st.model.as_deref(), Some("gpt-6"));
        // Closed further back than the tail: idle.
        lines.insert(3, codex_turn(&iso(start + 2_000), "task_complete", "t1"));
        write_at(&f, &lines, now);
        assert_eq!(state(Harness::Codex, &t, start).status, "idle");
    }

    #[test]
    fn pi_status_follows_the_last_message() {
        let m = |role: &str, stop: &str| {
            format!(
                r#"{{"type":"message","message":{{"role":"{role}","stopReason":"{stop}","model":"gpt-5.5"}}}}"#
            )
        };
        assert_eq!(pi_state(&m("user", "")).status, "busy");
        assert_eq!(
            pi_state(&[m("user", ""), m("assistant", "toolUse")].join("\n")).status,
            "busy"
        );
        let st = pi_state(&[m("user", ""), m("assistant", "stop")].join("\n"));
        assert_eq!(st.status, "idle");
        assert_eq!(st.model.as_deref(), Some("gpt-5.5"));
        let named = [
            m("user", ""),
            r#"{"type":"session_info","name":"auth-fix"}"#.to_string(),
        ];
        assert_eq!(
            pi_state(&named.join("\n")).name.as_deref(),
            Some("auth-fix")
        );
    }

    #[test]
    fn codex_names_keep_the_last_entry_per_thread() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("session_index.jsonl"),
            concat!(
                r#"{"id":"a","thread_name":"Reply pong"}"#,
                "\n",
                r#"{"id":"b","thread_name":"Other"}"#,
                "\n",
                r#"{"id":"a","thread_name":"codex-probe"}"#,
                "\n"
            ),
        )
        .unwrap();
        let n = codex_names(dir.path());
        assert_eq!(n["a"], "codex-probe");
        assert_eq!(n["b"], "Other");
    }

    #[test]
    fn transcripts_are_read_from_their_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let pdir = root.join("sessions").join(pi_dir_name("/w/app"));
        std::fs::create_dir_all(&pdir).unwrap();
        let f = pdir.join("2026-10-11T19-50-44-044Z_p1.jsonl");
        std::fs::write(
            &f,
            concat!(
                r#"{"type":"session","version":3,"id":"p1","timestamp":"2026-10-11T19:50:44.044Z","cwd":"/w/app"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"fix the bug"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        let p = proc_(1, "/w/app", 0);
        let ts = transcripts(Harness::Pi, root, &[&p]);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].session_id, "p1");
        assert_eq!(ts[0].created_ms, 1_791_748_244_044);
        assert_eq!(
            first_prompt(Harness::Pi, &f).as_deref(),
            Some("fix the bug")
        );

        let cdir = root.join("codex/sessions/2026/10/11");
        std::fs::create_dir_all(&cdir).unwrap();
        let cf = cdir.join("rollout-2026-10-11T21-50-53-c1.jsonl");
        std::fs::write(
            &cf,
            concat!(
                r#"{"timestamp":"2026-10-11T19:50:53.000Z","type":"session_meta","payload":{"id":"c1","timestamp":"2026-10-11T19:50:53.000Z","cwd":"/w/app"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"reply pong"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        let mut cp = proc_(2, "/w/app", now_ms() - 10_000);
        cp.harness = Harness::Codex;
        let ts = transcripts(Harness::Codex, &root.join("codex"), &[&cp]);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].session_id, "c1");
        assert_eq!(
            first_prompt(Harness::Codex, &cf).as_deref(),
            Some("reply pong")
        );
    }

    #[test]
    fn pi_models_parse_the_table() {
        let t = "provider  model     context\nopenai    gpt-5.5   272K\nanthropic claude-x  1M\n";
        let m = parse_pi_models(t);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "openai/gpt-5.5");
        assert_eq!(m[1].label, "claude-x (anthropic)");
    }

    #[test]
    fn pi_models_without_a_login_are_empty() {
        let t = "No models available. Use /login to log into a provider. See:\n  /x/docs/providers.md\n";
        assert!(parse_pi_models(t).is_empty());
    }

    #[test]
    fn pi_enabled_models_narrow_the_picker() {
        let pats = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(pi_model_enabled("openai/gpt-4o", &[]));
        let p = pats(&["openai/gpt-6*", "gpt-5.6-sol:high", "Anthropic/claude-?"]);
        assert!(pi_model_enabled("openai/gpt-6.1-sol", &p));
        assert!(pi_model_enabled("openai/gpt-5.6-sol", &p));
        assert!(pi_model_enabled("anthropic/claude-x", &p));
        assert!(!pi_model_enabled("openai/gpt-4o", &p));
        assert!(!pi_model_enabled("openai/gpt-5.6-sol-pro", &p));
        assert!(!pi_model_enabled("other/gpt-6", &pats(&["openai/gpt-6"])));
    }
}
