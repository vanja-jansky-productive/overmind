//! Smart grouping: sort every Claude session of the overmind into a handful of
//! work-stream groups (the web UI's Board view), without anyone maintaining them.
//!
//! **Stability first.** A board that reshuffles every run is worse than none, so
//! the pass is incremental and the state is persisted
//! (`$OVERMIND_GROUPS_STATE`, else `${XDG_STATE_HOME:-~/.local/state}/overmind/groups.json`):
//! - a session keeps its group for as long as its *fingerprint* (name, generated
//!   title, cwd, first prompt) is unchanged — no model call is spent on it;
//! - only new sessions, sessions whose fingerprint changed, and sessions parked
//!   in a fallback group while the model was down are classified, into the
//!   existing groups or a new one — one `claude -p` call per batch;
//! - a *consolidation* pass (at most every [`CONSOLIDATE_EVERY_MS`], and only when
//!   assignments changed since the last one) may merge groups that are clearly the
//!   same work and fix a clearly wrong label — capped, so it can't redraw the board;
//! - sessions of a host that did not answer keep their assignment; sessions that
//!   are gone from a host that did answer are dropped; empty groups disappear.
//!
//! **Fallback.** With the model disabled, unavailable or answering garbage, the
//! sessions that need a group get a deterministic one: their repository (the cwd,
//! worktree-aware). Those assignments are marked `fallback` and re-classified by
//! the model once it's back.
//!
//! The pass itself ([`run_pass`]) is pure apart from the model call, which is a
//! parameter, so the tests never spawn `claude`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::discovery::{Session, is_fixture};
use crate::core::naming::{ask_claude, input_hash, slugify};
use crate::error::Result;

pub const STATE_VERSION: u32 = 1;

/// Characters of a session's first prompt the model sees. Enough to tell work
/// streams apart; the full prompt routinely runs to thousands of characters.
pub const PROMPT_EXCERPT: usize = 160;

/// Ceiling on one classification prompt. Sessions beyond it go to the next
/// batch (another call), up to [`MAX_CALLS`] per run.
pub const PROMPT_CAP: usize = 12_000;

/// Model calls one run may make, classification and consolidation together.
/// Anything left over is parked in a fallback group and retried next run.
pub const MAX_CALLS: usize = 4;

/// How often the consolidation pass may run (it also needs changes since the
/// last one). An hour: groups should drift, not jump.
pub const CONSOLIDATE_EVERY_MS: i64 = 60 * 60 * 1000;

/// A group label is 2–4 words; this is the character cap on top.
pub const MAX_LABEL: usize = 32;
pub const MAX_DESCRIPTION: usize = 120;

/// Most merges one consolidation may do, whatever the model suggests.
const MAX_MERGES: usize = 2;
const MAX_RENAMES: usize = 2;

/// Per-call wall clock. A grouping prompt is bigger than a naming one.
pub const DEADLINE: Duration = Duration::from_secs(90);

// --- state -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `llm`, `fallback` or `manual` (made on the board).
    pub source: String,
    #[serde(default)]
    pub created_at: i64,
    /// Named by the user: consolidation never renames it nor merges it away.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub host: String,
    pub id: String,
    pub group: String,
    pub fingerprint: String,
    /// `llm`, `fallback` or `manual` (moved on the board: kept whatever the fingerprint).
    pub source: String,
    #[serde(default)]
    pub assigned_at: i64,
    /// Display name when assigned — for the consolidation prompt and `--cached`.
    #[serde(default)]
    pub name: Option<String>,
}

/// What one run did. `lastRun` in the state file and in `--json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub at: i64,
    pub ms: i64,
    /// `noop`, `incremental`, `full`, `consolidate` or `fallback`.
    pub mode: String,
    pub ok: bool,
    pub model_calls: usize,
    /// Sessions placed by this run (model or fallback).
    pub classified: usize,
    pub kept: usize,
    pub pruned: usize,
    pub created: usize,
    pub merged: usize,
    pub renamed: usize,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub last_consolidated_at: Option<i64>,
    /// Assignments changed since the last consolidation.
    #[serde(default)]
    pub dirty: bool,
    #[serde(default)]
    pub groups: Vec<Group>,
    /// `host/id` → assignment.
    #[serde(default)]
    pub assignments: BTreeMap<String, Assignment>,
    #[serde(default)]
    pub last_run: Option<RunSummary>,
}

pub fn state_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OVERMIND_GROUPS_STATE").filter(|p| !p.is_empty()) {
        return PathBuf::from(crate::core::tools::expand_tilde(&p.to_string_lossy()));
    }
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(crate::core::tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("state")
        });
    base.join("overmind").join("groups.json")
}

impl State {
    /// Load from `path`; a missing or corrupt file is an empty state.
    pub fn load_from(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// Atomic write (temp file + rename).
    pub fn save_to(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, path)
    }

    fn group(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }

    fn members_of(&self, id: &str) -> Vec<&Assignment> {
        self.assignments
            .values()
            .filter(|a| a.group == id)
            .collect()
    }
}

// --- input -------------------------------------------------------------------

/// One session as the pass sees it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Item {
    pub host: String,
    /// sessionId, else the pid.
    pub id: String,
    pub name: Option<String>,
    pub gen_title: Option<String>,
    /// The session's one title (`display_title` in `list --json`), when known.
    pub display_title: Option<String>,
    pub cwd: Option<String>,
    /// The first prompt (any length; the prompt builder truncates).
    pub title: Option<String>,
}

impl Item {
    pub fn key(&self) -> String {
        format!("{}/{}", self.host, self.id)
    }

    pub fn from_session(s: &Session, host: &str) -> Self {
        Item {
            host: s.host.clone().unwrap_or_else(|| host.to_string()),
            id: s.key(),
            name: s.name.clone(),
            gen_title: s.gen_title.clone(),
            display_title: Some(s.headline()),
            cwd: s.cwd.clone(),
            title: s.title.clone(),
        }
    }

    /// From a `list --json` row (a JSON object) — tolerant of extra and missing
    /// fields, so a web server's merged snapshot can be fed in as it is.
    pub fn from_json(v: &Value, host: Option<&str>) -> Option<Self> {
        let s = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|x| !x.trim().is_empty())
        };
        let host = s("host").or_else(|| host.map(str::to_string))?;
        let id = s("session_id")
            .or_else(|| v.get("pid").and_then(Value::as_i64).map(|p| p.to_string()))?;
        Some(Item {
            host,
            id,
            name: s("name"),
            gen_title: s("gen_title"),
            display_title: s("display_title"),
            cwd: s("cwd"),
            title: s("title"),
        })
    }

    /// What the display calls this session.
    pub fn display(&self) -> String {
        self.display_title
            .clone()
            .or_else(|| self.gen_title.clone())
            .or_else(|| self.name.clone())
            .unwrap_or_else(|| self.id.chars().take(8).collect())
    }

    /// Changes when the work visibly changed: renamed, retitled, moved, or a
    /// first prompt arrived.
    pub fn fingerprint(&self) -> String {
        input_hash(&format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            self.name.as_deref().unwrap_or(""),
            self.gen_title.as_deref().unwrap_or(""),
            self.cwd.as_deref().unwrap_or(""),
            excerpt(self.title.as_deref().unwrap_or(""), PROMPT_EXCERPT),
        ))
    }
}

/// What one run observed: the live sessions, and which hosts answered at all.
/// Assignments of a host that didn't answer are left alone.
#[derive(Debug, Clone, Default)]
pub struct Observed {
    pub hosts_ok: BTreeSet<String>,
    pub items: Vec<Item>,
    /// `host/sessionId` of sessions dormant on their host (recorded before a reboot, not
    /// resumed yet — `core::snapshot`): they keep their assignment, are never classified.
    pub dormant: BTreeSet<String>,
}

impl Observed {
    /// Record `host`'s dormant session ids. `None` = its dormant list couldn't be read: like
    /// a host that didn't answer, none of its assignments are pruned this run.
    pub fn add_dormant<'a, I>(&mut self, host: &str, ids: Option<I>)
    where
        I: IntoIterator<Item = &'a String>,
    {
        match ids {
            Some(ids) => self
                .dormant
                .extend(ids.into_iter().map(|id| format!("{host}/{id}"))),
            None => {
                self.hosts_ok.remove(host);
            }
        }
    }

    /// Parse a sessions document: a `list --json` array (every host present in
    /// it counts as answered) or a `/api/overmind`-shaped `{ hosts: [{ name, ok,
    /// sessions }] }` (hosts with `ok: false` are not observed).
    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        let mut obs = Observed::default();
        if let Some(rows) = v.as_array() {
            for r in rows {
                if let Some(it) = Item::from_json(r, None) {
                    obs.hosts_ok.insert(it.host.clone());
                    obs.items.push(it);
                }
            }
            return Ok(obs);
        }
        let hosts = v
            .get("hosts")
            .and_then(Value::as_array)
            .ok_or("expected a session array or an object with `hosts`")?;
        for h in hosts {
            let Some(name) = h.get("name").and_then(Value::as_str) else {
                continue;
            };
            if h.get("ok").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            obs.hosts_ok.insert(name.to_string());
            for r in h
                .get("sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(it) = Item::from_json(r, Some(name)) {
                    obs.items.push(it);
                }
            }
        }
        Ok(obs)
    }
}

// --- text helpers ------------------------------------------------------------

/// First `n` characters, whitespace collapsed to single spaces.
fn excerpt(s: &str, n: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= n {
        flat
    } else {
        let mut out: String = flat.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// The repository a cwd belongs to, worktree-aware: `…/app/.worktrees/fix-x`
/// and `…/app/.claude/worktrees/fix-x` are both `app`.
pub fn repo_of(cwd: &str) -> Option<String> {
    let parts: Vec<&str> = cwd.split('/').filter(|p| !p.is_empty()).collect();
    let mut end = parts.len();
    if let Some(i) = parts
        .iter()
        .position(|p| *p == ".worktrees" || *p == "worktrees")
    {
        end = i;
        if i > 0 && parts[i - 1] == ".claude" {
            end = i - 1;
        }
    }
    parts[..end].last().map(|s| s.to_string())
}

/// A model-written label reduced to 2–4 plain words, or rejected.
pub fn sanitize_label(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let cleaned: String = line
        .chars()
        .filter(|c| !matches!(c, '"' | '`' | '*' | '#'))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    if words.is_empty() || words.len() > 6 {
        return None;
    }
    let mut out = String::new();
    for w in words.iter().take(4) {
        let next = if out.is_empty() {
            w.to_string()
        } else {
            format!("{out} {w}")
        };
        if next.chars().count() > MAX_LABEL {
            break;
        }
        out = next;
    }
    let out = out.trim_end_matches([',', '.', ':', ';', '-']).to_string();
    if out.is_empty() || !out.chars().any(char::is_alphanumeric) {
        None
    } else {
        Some(out)
    }
}

fn sanitize_description(raw: &str) -> Option<String> {
    let d = excerpt(raw.trim().trim_matches('"'), MAX_DESCRIPTION);
    if d.is_empty() { None } else { Some(d) }
}

/// Pull the JSON object out of a model answer: code fences and prose around it
/// are tolerated.
pub fn extract_json(raw: &str) -> Option<Value> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str(&raw[start..=end]).ok()
}

fn new_group_id(label: &str, now: i64, taken: &HashSet<String>) -> String {
    let mut n = 0u32;
    loop {
        let h = input_hash(&format!("{label}\u{1f}{now}\u{1f}{n}"));
        let id = format!("g-{}", &h[..8]);
        if !taken.contains(&id) {
            return id;
        }
        n += 1;
    }
}

// --- prompts -----------------------------------------------------------------

const CLASSIFY_INSTRUCTION: &str = "You sort a developer's running Claude Code sessions into work-stream groups for a Kanban board.\n\
A group is a project or a stream of related work (a feature, an investigation, a review cycle, a tool being built) — not a single task, and not just a repository name.\n\
Rules:\n\
- Put each session into the existing group whose work it continues. Existing groups are stable: never rename them.\n\
- Create a new group only when no existing group fits. Several similar sessions belong in ONE group.\n\
- New group labels: 2-4 words, Title Case, no emoji, no quotes. Description: one short plain line.\n\
Reply with JSON only, no prose, exactly this shape:\n\
{\"assign\":{\"S1\":\"G1\",\"S2\":\"N1\"},\"new\":{\"N1\":{\"label\":\"Short Label\",\"description\":\"one line\"}}}\n";

const CONSOLIDATE_INSTRUCTION: &str = "You maintain the groups of a developer's Kanban board of Claude Code sessions. The board must stay stable: change as little as possible.\n\
- Merge two groups only when they are clearly the same stream of work.\n\
- Rename a group only when its label is clearly wrong or too vague for its members (2-4 words, Title Case).\n\
- Otherwise change nothing — that is the expected answer most of the time.\n\
Reply with JSON only, no prose, exactly this shape:\n\
{\"merge\":[{\"into\":\"G1\",\"from\":[\"G3\"]}],\"rename\":{\"G2\":{\"label\":\"Better Label\",\"description\":\"one line\"}}}\n\
Nothing to change: {\"merge\":[],\"rename\":{}}\n";

fn session_line(i: usize, it: &Item) -> String {
    let shown = it.display();
    let mut line = format!("S{}: {}", i + 1, excerpt(&shown, 60));
    if let Some(n) = it
        .name
        .as_deref()
        .filter(|n| *n != shown && Some(*n) != it.gen_title.as_deref())
    {
        line.push_str(&format!(" (name: {})", excerpt(n, 40)));
    }
    if let Some(cwd) = it.cwd.as_deref() {
        let tail: Vec<&str> = cwd.rsplit('/').filter(|p| !p.is_empty()).take(2).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        line.push_str(&format!(" | dir: {}", tail.join("/")));
    }
    line.push_str(&format!(" | host: {}", it.host));
    if let Some(t) = it.title.as_deref().filter(|t| !t.trim().is_empty()) {
        line.push_str(&format!(" | asked: {}", excerpt(t, PROMPT_EXCERPT)));
    }
    line.push('\n');
    line
}

fn groups_block(
    state: &State,
    names: &HashMap<String, String>,
    per_group: usize,
) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut refs = Vec::new();
    for (i, g) in state.groups.iter().enumerate() {
        refs.push(g.id.clone());
        let mut members: Vec<String> = state
            .members_of(&g.id)
            .iter()
            .map(|a| {
                names
                    .get(&format!("{}/{}", a.host, a.id))
                    .cloned()
                    .or_else(|| a.name.clone())
                    .unwrap_or_else(|| a.id.chars().take(8).collect())
            })
            .collect();
        members.sort();
        members.truncate(per_group);
        out.push_str(&format!("G{}: \"{}\"", i + 1, g.label));
        if let Some(d) = &g.description {
            out.push_str(&format!(" — {d}"));
        }
        if !members.is_empty() {
            out.push_str(&format!(" | e.g. {}", members.join("; ")));
        }
        out.push('\n');
    }
    (out, refs)
}

/// The classification prompt for one batch, and how many of `items` it holds
/// (the rest go to the next batch). Always holds at least one.
pub fn build_classify_prompt(
    state: &State,
    names: &HashMap<String, String>,
    items: &[Item],
) -> (String, Vec<String>, usize) {
    let (groups, refs) = groups_block(state, names, 4);
    let mut prompt = format!("{CLASSIFY_INSTRUCTION}\nExisting groups:\n");
    if groups.is_empty() {
        prompt.push_str("(none yet)\n");
    } else {
        prompt.push_str(&groups);
    }
    prompt.push_str("\nSessions to place:\n");
    let mut n = 0;
    for (i, it) in items.iter().enumerate() {
        let line = session_line(i, it);
        if n > 0 && prompt.len() + line.len() > PROMPT_CAP {
            break;
        }
        prompt.push_str(&line);
        n += 1;
    }
    (prompt, refs, n)
}

pub fn build_consolidate_prompt(
    state: &State,
    names: &HashMap<String, String>,
) -> (String, Vec<String>) {
    let (groups, refs) = groups_block(state, names, 8);
    (
        format!("{CONSOLIDATE_INSTRUCTION}\nGroups:\n{groups}"),
        refs,
    )
}

// --- parsing model answers ---------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Existing(String),
    New(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Classification {
    /// index into the batch → target
    pub assign: BTreeMap<usize, Target>,
    /// new-group ref (`N1`) → (label, description)
    pub new: BTreeMap<String, (String, Option<String>)>,
}

fn norm_ref(s: &str) -> String {
    s.trim().trim_matches('"').to_ascii_uppercase()
}

/// `G3` → the id of the third existing group.
fn resolve_existing(r: &str, refs: &[String], state: &State) -> Option<String> {
    let r = norm_ref(r);
    if let Some(n) = r.strip_prefix('G').and_then(|n| n.parse::<usize>().ok()) {
        return refs.get(n.checked_sub(1)?).cloned();
    }
    // A model that answers with the label instead of the ref.
    state
        .groups
        .iter()
        .find(|g| g.label.eq_ignore_ascii_case(r.trim()))
        .map(|g| g.id.clone())
}

/// Parse a classification answer. Anything unusable for a session simply leaves
/// that session out; `None` means the whole answer is unusable.
pub fn parse_classification(
    raw: &str,
    n: usize,
    refs: &[String],
    state: &State,
) -> Option<Classification> {
    let v = extract_json(raw)?;
    let mut out = Classification::default();
    if let Some(new) = v.get("new").and_then(Value::as_object) {
        for (k, g) in new {
            let (label, desc) = match g {
                Value::String(s) => (s.as_str(), None),
                Value::Object(_) => (
                    g.get("label").and_then(Value::as_str).unwrap_or(""),
                    g.get("description").and_then(Value::as_str),
                ),
                _ => continue,
            };
            if let Some(label) = sanitize_label(label) {
                out.new
                    .insert(norm_ref(k), (label, desc.and_then(sanitize_description)));
            }
        }
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    match v.get("assign") {
        Some(Value::Object(m)) => {
            for (k, g) in m {
                if let Some(g) = g.as_str() {
                    pairs.push((k.clone(), g.to_string()));
                }
            }
        }
        Some(Value::Array(a)) => {
            for e in a {
                let s = e.get("s").or_else(|| e.get("session")).and_then(|x| {
                    x.as_str()
                        .map(str::to_string)
                        .or_else(|| x.as_u64().map(|n| format!("S{n}")))
                });
                let g = e
                    .get("g")
                    .or_else(|| e.get("group"))
                    .and_then(Value::as_str);
                if let (Some(s), Some(g)) = (s, g) {
                    pairs.push((s, g.to_string()));
                }
            }
        }
        _ => return None,
    }
    for (s, g) in pairs {
        let s = norm_ref(&s);
        let Some(i) = s
            .strip_prefix('S')
            .unwrap_or(&s)
            .parse::<usize>()
            .ok()
            .and_then(|i| i.checked_sub(1))
            .filter(|i| *i < n)
        else {
            continue;
        };
        let gr = norm_ref(&g);
        let target = if out.new.contains_key(&gr) {
            Some(Target::New(gr))
        } else {
            resolve_existing(&g, refs, state).map(Target::Existing)
        };
        if let Some(t) = target {
            out.assign.insert(i, t);
        }
    }
    Some(out)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Consolidation {
    /// (into, from)
    pub merge: Vec<(String, String)>,
    /// id → (label, description)
    pub rename: Vec<(String, String, Option<String>)>,
}

pub fn parse_consolidation(raw: &str, refs: &[String], state: &State) -> Option<Consolidation> {
    let v = extract_json(raw)?;
    let mut out = Consolidation::default();
    for m in v
        .get("merge")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(into) = m
            .get("into")
            .and_then(Value::as_str)
            .and_then(|r| resolve_existing(r, refs, state))
        else {
            continue;
        };
        let froms: Vec<String> = match m.get("from") {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            Some(Value::String(s)) => vec![s.clone()],
            _ => vec![],
        };
        for f in froms {
            if let Some(from) = resolve_existing(&f, refs, state)
                && from != into
            {
                out.merge.push((into.clone(), from));
            }
        }
    }
    if let Some(r) = v.get("rename").and_then(Value::as_object) {
        for (k, g) in r {
            let Some(id) = resolve_existing(k, refs, state) else {
                continue;
            };
            let (label, desc) = match g {
                Value::String(s) => (s.as_str(), None),
                _ => (
                    g.get("label").and_then(Value::as_str).unwrap_or(""),
                    g.get("description").and_then(Value::as_str),
                ),
            };
            if let Some(label) = sanitize_label(label) {
                out.rename
                    .push((id, label, desc.and_then(sanitize_description)));
            }
        }
    }
    Some(out)
}

// --- the pass ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Consolidate {
    /// When due: hourly, and only after changes.
    #[default]
    Auto,
    Force,
    Never,
}

#[derive(Debug, Clone, Default)]
pub struct PassOpts {
    /// May the model be called at all (`grouping.enabled`, not a fixture).
    pub allow_llm: bool,
    /// Forget every group and assignment first.
    pub refresh: bool,
    pub consolidate: Consolidate,
    /// Build the prompts, count them, call nothing (`-n`).
    pub dry_run: bool,
    pub now: i64,
    pub consolidate_every_ms: i64,
}

fn fallback_group_for(it: &Item) -> (String, String) {
    match it.cwd.as_deref().and_then(repo_of) {
        Some(repo) => {
            let slug = slugify(&repo, 40);
            let slug = if slug.is_empty() {
                "other".into()
            } else {
                slug
            };
            (format!("repo-{slug}"), repo)
        }
        None => ("repo-other".into(), "Other".into()),
    }
}

fn assign(state: &mut State, it: &Item, group: &str, source: &str, now: i64) {
    state.assignments.insert(
        it.key(),
        Assignment {
            host: it.host.clone(),
            id: it.id.clone(),
            group: group.to_string(),
            fingerprint: it.fingerprint(),
            source: source.into(),
            assigned_at: now,
            name: Some(it.display()),
        },
    );
    state.dirty = true;
}

fn assign_fallback(state: &mut State, it: &Item, now: i64) {
    let (id, label) = fallback_group_for(it);
    if state.group(&id).is_none() {
        state.groups.push(Group {
            id: id.clone(),
            label,
            description: Some("Grouped by repository (model unavailable)".into()),
            source: "fallback".into(),
            created_at: now,
            locked: false,
        });
    }
    assign(state, it, &id, "fallback", now);
}

/// Run one grouping pass over `obs`, mutating `state`. `ask` is the model call
/// (`prompt → raw answer`).
pub fn run_pass<F>(state: &mut State, obs: &Observed, opts: &PassOpts, mut ask: F) -> RunSummary
where
    F: FnMut(&str) -> Result<String>,
{
    let now = opts.now;
    let mut sum = RunSummary {
        at: now,
        ok: true,
        ..Default::default()
    };
    let mut notes: Vec<String> = Vec::new();
    let mut would_call: Vec<usize> = Vec::new();

    if opts.refresh {
        state.groups.clear();
        state.assignments.clear();
        state.last_consolidated_at = Some(now);
    }
    if state.last_consolidated_at.is_none() {
        // A new state: the first consolidation is due an interval from now.
        state.last_consolidated_at = Some(now);
    }
    state.version = STATE_VERSION;

    let live: HashMap<String, &Item> = obs.items.iter().map(|i| (i.key(), i)).collect();
    let names: HashMap<String, String> = obs.items.iter().map(|i| (i.key(), i.display())).collect();

    // Drop what's gone (from hosts that answered) or points at a missing group. A dormant
    // session (waiting for `overmind restore` after a reboot) isn't gone.
    let group_ids: HashSet<String> = state.groups.iter().map(|g| g.id.clone()).collect();
    let before = state.assignments.len();
    state.assignments.retain(|k, a| {
        group_ids.contains(&a.group)
            && (!obs.hosts_ok.contains(&a.host) || live.contains_key(k) || obs.dormant.contains(k))
    });
    sum.pruned = before - state.assignments.len();
    if sum.pruned > 0 {
        state.dirty = true;
    }

    // Who needs a group.
    let mut todo: Vec<Item> = Vec::new();
    for it in &obs.items {
        match state.assignments.get(&it.key()) {
            Some(a) if a.source == MANUAL => sum.kept += 1,
            // Parked by repository while the model was down: reclassified, unless the
            // user has since named that group.
            Some(a)
                if a.fingerprint == it.fingerprint()
                    && !(opts.allow_llm
                        && a.source == "fallback"
                        && !state.group(&a.group).is_some_and(|g| g.locked)) =>
            {
                sum.kept += 1
            }
            _ => todo.push(it.clone()),
        }
    }
    // Stable order: the prompt (and so the answer) doesn't depend on discovery order.
    todo.sort_by_key(Item::key);

    let mut placed_by_model = 0usize;
    let mut remaining: &[Item] = &todo;
    let mut model_failed = false;
    if opts.allow_llm {
        while !remaining.is_empty() && sum.model_calls + would_call.len() < MAX_CALLS {
            let (prompt, refs, n) = build_classify_prompt(state, &names, remaining);
            let batch = &remaining[..n];
            remaining = &remaining[n..];
            if opts.dry_run {
                would_call.push(prompt.len());
                continue;
            }
            // One retry on an unusable answer; a failed call is not retried
            // (logged out / rate-limited doesn't fix itself in a second).
            let mut parsed = None;
            for _ in 0..2 {
                sum.model_calls += 1;
                match ask(&prompt) {
                    Ok(raw) => {
                        parsed = parse_classification(&raw, n, &refs, state);
                        if parsed.is_some() {
                            break;
                        }
                        notes.push(format!(
                            "model answer unusable ({:?})",
                            excerpt(raw.trim(), 60)
                        ));
                    }
                    Err(e) => {
                        notes.push(e.to_string());
                        break;
                    }
                }
            }
            let Some(c) = parsed else {
                model_failed = true;
                for it in batch {
                    assign_fallback(state, it, now);
                    sum.classified += 1;
                }
                break;
            };
            // Materialise the new groups that got members — dedupe by label.
            let mut new_ids: HashMap<String, String> = HashMap::new();
            for (r, (label, desc)) in &c.new {
                if !c.assign.values().any(|t| *t == Target::New(r.clone())) {
                    continue;
                }
                if let Some(g) = state
                    .groups
                    .iter()
                    .find(|g| g.label.eq_ignore_ascii_case(label))
                {
                    new_ids.insert(r.clone(), g.id.clone());
                    continue;
                }
                let taken: HashSet<String> = state.groups.iter().map(|g| g.id.clone()).collect();
                let id = new_group_id(label, now, &taken);
                state.groups.push(Group {
                    id: id.clone(),
                    label: label.clone(),
                    description: desc.clone(),
                    source: "llm".into(),
                    created_at: now,
                    locked: false,
                });
                sum.created += 1;
                new_ids.insert(r.clone(), id);
            }
            for (i, it) in batch.iter().enumerate() {
                let gid = match c.assign.get(&i) {
                    Some(Target::Existing(id)) => Some(id.clone()),
                    Some(Target::New(r)) => new_ids.get(r).cloned(),
                    None => None,
                };
                match gid {
                    Some(g) => {
                        assign(state, it, &g, "llm", now);
                        placed_by_model += 1;
                    }
                    None => assign_fallback(state, it, now),
                }
                sum.classified += 1;
            }
        }
    }
    // Whatever the model didn't get to (disabled, failed, over the call cap).
    for it in remaining {
        if opts.dry_run {
            continue;
        }
        // A kept-but-fallback session stays where it is rather than churn.
        if let Some(a) = state.assignments.get(&it.key())
            && a.fingerprint == it.fingerprint()
        {
            continue;
        }
        assign_fallback(state, it, now);
        sum.classified += 1;
    }
    if opts.dry_run {
        sum.classified = todo.len();
    }

    // Consolidation.
    let llm_groups = state.groups.iter().filter(|g| g.source == "llm").count();
    let due = match opts.consolidate {
        Consolidate::Force => true,
        Consolidate::Never => false,
        Consolidate::Auto => {
            state.dirty
                && now - state.last_consolidated_at.unwrap_or(now) >= opts.consolidate_every_ms
        }
    };
    let mut consolidated = false;
    if opts.allow_llm && !model_failed && due && sum.model_calls + would_call.len() < MAX_CALLS {
        drop_empty(state);
        if llm_groups >= 2 {
            let (prompt, refs) = build_consolidate_prompt(state, &names);
            if opts.dry_run {
                would_call.push(prompt.len());
            } else {
                sum.model_calls += 1;
                match ask(&prompt).map(|raw| parse_consolidation(&raw, &refs, state)) {
                    Ok(Some(c)) => {
                        apply_consolidation(state, &c, &mut sum);
                        consolidated = true;
                    }
                    Ok(None) => notes.push("consolidation answer unusable".into()),
                    Err(e) => notes.push(e.to_string()),
                }
            }
        }
        if !opts.dry_run {
            state.last_consolidated_at = Some(now);
            state.dirty = false;
        }
    }

    drop_empty(state);

    sum.mode = if opts.dry_run {
        "dry-run".into()
    } else if opts.refresh && sum.model_calls > 0 {
        "full".into()
    } else if consolidated {
        "consolidate".into()
    } else if sum.model_calls > 0 && placed_by_model > 0 {
        "incremental".into()
    } else if sum.classified > 0 {
        "fallback".into()
    } else {
        "noop".into()
    };
    if model_failed {
        sum.ok = false;
        sum.error = notes.last().cloned();
    }
    if opts.dry_run {
        let chars: usize = would_call.iter().sum();
        notes.push(format!(
            "dry run: {} session(s) to classify, would make {} model call(s) ({chars} prompt chars)",
            todo.len(),
            would_call.len()
        ));
    } else if !opts.allow_llm && !todo.is_empty() {
        notes
            .push("model off (grouping.enabled = false or fixture) — grouped by repository".into());
    }
    if !notes.is_empty() {
        sum.note = Some(notes.join("; "));
    }
    if !opts.dry_run {
        state.updated_at = Some(now);
    }
    sum
}

/// Drop groups nobody is in — except the user's own (`manual`): those stay until deleted.
fn drop_empty(state: &mut State) {
    let used: HashSet<String> = state
        .assignments
        .values()
        .map(|a| a.group.clone())
        .collect();
    state
        .groups
        .retain(|g| g.source == MANUAL || used.contains(&g.id));
}

fn apply_consolidation(state: &mut State, c: &Consolidation, sum: &mut RunSummary) {
    let mut gone: HashSet<String> = HashSet::new();
    for (into, from) in &c.merge {
        if sum.merged >= MAX_MERGES || gone.contains(into) || gone.contains(from) {
            continue;
        }
        if state.group(into).is_none() || state.group(from).is_none() || pinned(state, from) {
            continue;
        }
        for a in state.assignments.values_mut() {
            if a.group == *from {
                a.group = into.clone();
            }
        }
        gone.insert(from.clone());
        sum.merged += 1;
    }
    state.groups.retain(|g| !gone.contains(&g.id));
    for (id, label, desc) in &c.rename {
        if sum.renamed >= MAX_RENAMES {
            break;
        }
        // Never rename onto another group's label.
        if state
            .groups
            .iter()
            .any(|g| g.id != *id && g.label.eq_ignore_ascii_case(label))
        {
            continue;
        }
        if let Some(g) = state.groups.iter_mut().find(|g| g.id == *id)
            && !g.locked
            && g.label != *label
        {
            g.label = label.clone();
            if desc.is_some() {
                g.description = desc.clone();
            }
            sum.renamed += 1;
        }
    }
}

/// A group the user shaped: renamed, or holding a session they moved there.
fn pinned(state: &State, id: &str) -> bool {
    state.group(id).is_some_and(|g| g.locked)
        || state
            .assignments
            .values()
            .any(|a| a.group == id && a.source == MANUAL)
}

// --- edits from the board ------------------------------------------------------

/// Source of a group or assignment the user made on the board.
pub const MANUAL: &str = "manual";

/// Characters of a user-written group label.
pub const MAX_USER_LABEL: usize = 48;

/// A user-written label: one line, whitespace collapsed, capped; `None` when blank.
pub fn clean_user_label(raw: &str) -> Option<String> {
    let words: Vec<&str> = raw.split_whitespace().collect();
    let out: String = words.join(" ").chars().take(MAX_USER_LABEL).collect();
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

fn label_taken(state: &State, label: &str, except: Option<&str>) -> bool {
    state
        .groups
        .iter()
        .any(|g| Some(g.id.as_str()) != except && g.label.eq_ignore_ascii_case(label))
}

/// Rename a group; the label is then the user's (never renamed, never merged away).
pub fn rename_group(
    state: &mut State,
    id: &str,
    label: &str,
    now: i64,
) -> std::result::Result<(), String> {
    let label = clean_user_label(label).ok_or("the label is empty")?;
    if label_taken(state, &label, Some(id)) {
        return Err(format!("another group is already called \"{label}\""));
    }
    let g = state
        .groups
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| format!("no group {id}"))?;
    g.label = label;
    g.locked = true;
    if g.source == "fallback" {
        // Named by the user, it is no longer "grouped by repository".
        g.source = MANUAL.into();
        g.description = None;
    }
    state.updated_at = Some(now);
    Ok(())
}

/// A new, empty group of the user's (`manual`, locked): it stays, empty or not, until deleted.
pub fn create_group(
    state: &mut State,
    label: &str,
    now: i64,
) -> std::result::Result<String, String> {
    let label = clean_user_label(label).ok_or("the label is empty")?;
    if label_taken(state, &label, None) {
        return Err(format!("a group is already called \"{label}\""));
    }
    let taken: HashSet<String> = state.groups.iter().map(|g| g.id.clone()).collect();
    let id = new_group_id(&label, now, &taken);
    state.groups.push(Group {
        id: id.clone(),
        label,
        description: None,
        source: MANUAL.into(),
        created_at: now,
        locked: true,
    });
    state.updated_at = Some(now);
    Ok(id)
}

/// Delete an empty group (one with sessions is refused: move them out first).
pub fn delete_group(state: &mut State, id: &str, now: i64) -> std::result::Result<(), String> {
    state.group(id).ok_or_else(|| format!("no group {id}"))?;
    let n = state.members_of(id).len();
    if n > 0 {
        return Err(format!(
            "the group still has {n} session(s) — move them out first"
        ));
    }
    state.groups.retain(|g| g.id != id);
    state.updated_at = Some(now);
    Ok(())
}

/// Where [`move_session`] puts a session.
#[derive(Debug, Clone, PartialEq)]
pub enum MoveTo {
    Group(String),
    /// A new group with this label (an existing group of that name is reused).
    New(String),
}

/// Move the session `host/id` into a group, for good: later passes keep it
/// there whatever changes about the session. Returns the group's id.
pub fn move_session(
    state: &mut State,
    host: &str,
    id: &str,
    to: &MoveTo,
    now: i64,
) -> std::result::Result<String, String> {
    let gid = match to {
        MoveTo::Group(g) => {
            state.group(g).ok_or_else(|| format!("no group {g}"))?;
            g.clone()
        }
        MoveTo::New(label) => {
            let label = clean_user_label(label).ok_or("the label is empty")?;
            match state
                .groups
                .iter()
                .find(|g| g.label.eq_ignore_ascii_case(&label))
            {
                Some(g) => g.id.clone(),
                None => {
                    let taken: HashSet<String> =
                        state.groups.iter().map(|g| g.id.clone()).collect();
                    let gid = new_group_id(&label, now, &taken);
                    state.groups.push(Group {
                        id: gid.clone(),
                        label,
                        description: None,
                        source: MANUAL.into(),
                        created_at: now,
                        locked: true,
                    });
                    gid
                }
            }
        }
    };
    let key = format!("{host}/{id}");
    let prev = state.assignments.remove(&key);
    state.assignments.insert(
        key,
        Assignment {
            host: host.into(),
            id: id.into(),
            group: gid.clone(),
            fingerprint: prev
                .as_ref()
                .map(|a| a.fingerprint.clone())
                .unwrap_or_default(),
            source: MANUAL.into(),
            assigned_at: now,
            name: prev.and_then(|a| a.name),
        },
    );
    drop_empty(state);
    state.dirty = true;
    state.updated_at = Some(now);
    Ok(gid)
}

// --- the view ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Member {
    pub host: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Not running: dormant on its host after a reboot (`overmind restore`). Present (and
    /// `true`) only then, and only in a pass's report (not `--cached`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dormant: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub source: String,
    pub members: Vec<Member>,
}

/// `overmind group --json`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub applied: bool,
    pub updated_at: Option<i64>,
    pub last_run: Option<RunSummary>,
    pub groups: Vec<GroupView>,
    /// Live sessions with no group (only with a dry run or an empty state).
    pub ungrouped: Vec<Member>,
    /// host → `ok` or why it didn't answer.
    pub hosts: BTreeMap<String, String>,
}

/// Groups in board order (biggest first, then label), members sorted by name.
pub fn view(state: &State, obs: Option<&Observed>) -> (Vec<GroupView>, Vec<Member>) {
    let names: HashMap<String, String> = obs
        .map(|o| o.items.iter().map(|i| (i.key(), i.display())).collect())
        .unwrap_or_default();
    let dormant = |k: &str| obs.is_some_and(|o| o.dormant.contains(k)) && !names.contains_key(k);
    let mut groups: Vec<GroupView> = state
        .groups
        .iter()
        .map(|g| {
            let mut members: Vec<Member> = state
                .members_of(&g.id)
                .into_iter()
                .map(|a| {
                    let key = format!("{}/{}", a.host, a.id);
                    Member {
                        host: a.host.clone(),
                        id: a.id.clone(),
                        name: names.get(&key).cloned().or_else(|| a.name.clone()),
                        dormant: dormant(&key),
                    }
                })
                .collect();
            members.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
            GroupView {
                id: g.id.clone(),
                label: g.label.clone(),
                description: g.description.clone(),
                source: g.source.clone(),
                members,
            }
        })
        .filter(|g| !g.members.is_empty() || g.source == MANUAL)
        .collect();
    groups.sort_by(|a, b| {
        b.members
            .len()
            .cmp(&a.members.len())
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    let ungrouped = obs
        .map(|o| {
            o.items
                .iter()
                .filter(|i| !state.assignments.contains_key(&i.key()))
                .map(|i| Member {
                    host: i.host.clone(),
                    id: i.id.clone(),
                    name: Some(i.display()),
                    dormant: false,
                })
                .collect()
        })
        .unwrap_or_default();
    (groups, ungrouped)
}

/// The real model call, with the grouping deadline.
pub fn ask_model(prompt: &str, model: &str) -> Result<String> {
    let cancel = AtomicBool::new(false);
    ask_claude(prompt, model, DEADLINE, &cancel)
}

/// No model in fixture mode — a demo must not spend calls.
pub fn llm_allowed(enabled: bool) -> bool {
    enabled && !is_fixture()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use std::cell::RefCell;

    const NOW: i64 = 1_000_000_000;

    fn item(host: &str, id: &str, name: &str, cwd: &str, title: &str) -> Item {
        Item {
            host: host.into(),
            id: id.into(),
            name: Some(name.into()),
            gen_title: None,
            display_title: None,
            cwd: Some(cwd.into()),
            title: Some(title.into()),
        }
    }

    fn obs(items: Vec<Item>) -> Observed {
        Observed {
            hosts_ok: items.iter().map(|i| i.host.clone()).collect(),
            items,
            ..Default::default()
        }
    }

    fn opts() -> PassOpts {
        PassOpts {
            allow_llm: true,
            now: NOW,
            consolidate_every_ms: CONSOLIDATE_EVERY_MS,
            ..Default::default()
        }
    }

    fn overmind_items() -> Vec<Item> {
        vec![
            item(
                "laptop",
                "a1",
                "board-view",
                "~/Code/project",
                "add a kanban board to the web ui",
            ),
            item(
                "laptop",
                "a2",
                "group-api",
                "~/Code/project",
                "serve groups over http",
            ),
            item(
                "workstation",
                "b1",
                "review-alice",
                "~/Code/notes",
                "prepare the review for alice",
            ),
        ]
    }

    const ANSWER: &str = r#"{"assign":{"S1":"N1","S2":"N1","S3":"N2"},"new":{"N1":{"label":"Overmind Board","description":"Kanban board for sessions"},"N2":{"label":"Team Reviews","description":"Review prep"}}}"#;

    #[test]
    fn repo_is_worktree_aware() {
        assert_eq!(repo_of("~/Code/app").as_deref(), Some("app"));
        assert_eq!(
            repo_of("~/Code/app/.worktrees/fix-x").as_deref(),
            Some("app")
        );
        assert_eq!(
            repo_of("~/Code/app/.claude/worktrees/fix-x").as_deref(),
            Some("app")
        );
        assert_eq!(repo_of("/").as_deref(), None);
    }

    #[test]
    fn labels_are_short_plain_words() {
        assert_eq!(
            sanitize_label("\"Overmind Board\"").as_deref(),
            Some("Overmind Board")
        );
        assert_eq!(
            sanitize_label("**Team Reviews**").as_deref(),
            Some("Team Reviews")
        );
        assert_eq!(
            sanitize_label("One Two Three Four Five").as_deref(),
            Some("One Two Three Four")
        );
        assert!(sanitize_label("").is_none());
        assert!(sanitize_label("I think this group should be called something nice").is_none());
        assert!(sanitize_label("--").is_none());
    }

    #[test]
    fn prompt_carries_groups_and_sessions_and_stays_capped() {
        let mut state = State::default();
        state.groups.push(Group {
            id: "g-1".into(),
            label: "Overmind Board".into(),
            description: Some("desc".into()),
            source: "llm".into(),
            created_at: 0,
            locked: false,
        });
        let long = "x".repeat(5000);
        let items: Vec<Item> = (0..200)
            .map(|i| {
                item(
                    "laptop",
                    &format!("s{i}"),
                    &format!("task-{i}"),
                    "~/Code/project",
                    &long,
                )
            })
            .collect();
        let (p, refs, n) = build_classify_prompt(&state, &HashMap::new(), &items);
        assert!(p.contains("G1: \"Overmind Board\" — desc"));
        assert!(p.contains("S1: task-0"));
        assert!(p.contains("dir: Code/project"));
        assert_eq!(refs, vec!["g-1".to_string()]);
        assert!(n > 1 && n < 200, "batched: {n}");
        assert!(p.len() <= PROMPT_CAP + 400);
        // The first prompt is truncated, not pasted whole.
        assert!(!p.contains(&"x".repeat(PROMPT_EXCERPT + 1)));
    }

    #[test]
    fn classification_parsing_is_robust() {
        let state = State {
            groups: vec![Group {
                id: "g-1".into(),
                label: "Overmind Board".into(),
                description: None,
                source: "llm".into(),
                created_at: 0,
                locked: false,
            }],
            ..Default::default()
        };
        let refs = vec!["g-1".to_string()];
        // Fenced, with prose, lower-case refs, label instead of ref, out of range.
        let raw = "Sure!\n```json\n{\"assign\":{\"s1\":\"g1\",\"S2\":\"Overmind Board\",\"S3\":\"n1\",\"S9\":\"G1\",\"S4\":\"G7\"},\"new\":{\"N1\":{\"label\":\"Team Reviews\"}}}\n```";
        let c = parse_classification(raw, 4, &refs, &state).unwrap();
        assert_eq!(c.assign.get(&0), Some(&Target::Existing("g-1".into())));
        assert_eq!(c.assign.get(&1), Some(&Target::Existing("g-1".into())));
        assert_eq!(c.assign.get(&2), Some(&Target::New("N1".into())));
        assert_eq!(c.assign.get(&3), None);
        assert_eq!(c.assign.len(), 3);
        // Array form.
        let c = parse_classification(r#"{"assign":[{"s":1,"g":"G1"}]}"#, 1, &refs, &state).unwrap();
        assert_eq!(c.assign.get(&0), Some(&Target::Existing("g-1".into())));
        // Garbage.
        assert!(parse_classification("I cannot help with that.", 1, &refs, &state).is_none());
        assert!(parse_classification("{\"foo\":1}", 1, &refs, &state).is_none());
    }

    #[test]
    fn first_run_creates_groups_with_one_call() {
        let mut state = State::default();
        let calls = RefCell::new(0);
        let sum = run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            *calls.borrow_mut() += 1;
            Ok(ANSWER.into())
        });
        assert_eq!(*calls.borrow(), 1);
        assert_eq!(sum.model_calls, 1);
        assert_eq!(sum.classified, 3);
        assert_eq!(sum.created, 2);
        assert_eq!(sum.mode, "incremental");
        let (groups, ungrouped) = view(&state, None);
        assert_eq!(groups[0].label, "Overmind Board");
        assert_eq!(groups[0].members.len(), 2);
        assert_eq!(groups[1].label, "Team Reviews");
        assert!(ungrouped.is_empty());
    }

    #[test]
    fn an_unchanged_overmind_costs_no_model_call_and_keeps_ids() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let before = state.groups.clone();
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                now: NOW + 1000,
                ..opts()
            },
            |_| panic!("no call expected"),
        );
        assert_eq!(sum.model_calls, 0);
        assert_eq!(sum.kept, 3);
        assert_eq!(sum.mode, "noop");
        assert_eq!(state.groups, before);
    }

    #[test]
    fn a_new_session_joins_an_existing_group_without_reshuffling() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let board_id = state.assignments["laptop/a1"].group.clone();
        let mut items = overmind_items();
        items.push(item(
            "laptop",
            "a3",
            "board-cards",
            "~/Code/project",
            "cards for the board",
        ));
        let seen = RefCell::new(String::new());
        let sum = run_pass(
            &mut state,
            &obs(items),
            &PassOpts {
                now: NOW + 1000,
                ..opts()
            },
            |p| {
                *seen.borrow_mut() = p.to_string();
                // Overmind Board is G1 or G2 depending on order; answer with the label.
                Ok(r#"{"assign":{"S1":"Overmind Board"},"new":{}}"#.into())
            },
        );
        let p = seen.borrow();
        assert!(p.contains("S1: board-cards"));
        assert!(!p.contains("S2:"), "only the new session is classified");
        assert_eq!(sum.classified, 1);
        assert_eq!(sum.kept, 3);
        assert_eq!(state.assignments["laptop/a3"].group, board_id);
        assert_eq!(state.assignments["laptop/a1"].group, board_id);
    }

    #[test]
    fn gone_sessions_are_pruned_and_empty_groups_disappear() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let items: Vec<Item> = overmind_items()
            .into_iter()
            .filter(|i| i.host == "laptop")
            .collect();
        // workstation answered with no sessions.
        let mut o = obs(items);
        o.hosts_ok.insert("workstation".into());
        let sum = run_pass(
            &mut state,
            &o,
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |_| panic!(),
        );
        assert_eq!(sum.pruned, 1);
        assert_eq!(state.groups.len(), 1);
        assert_eq!(state.groups[0].label, "Overmind Board");
    }

    #[test]
    fn an_unreachable_host_keeps_its_assignments() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let items: Vec<Item> = overmind_items()
            .into_iter()
            .filter(|i| i.host == "laptop")
            .collect();
        let sum = run_pass(
            &mut state,
            &obs(items),
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |_| panic!(),
        );
        assert_eq!(sum.pruned, 0);
        assert_eq!(state.groups.len(), 2);
    }

    #[test]
    fn dormant_sessions_keep_their_group_and_are_flagged() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        // After a reboot: the workstation answers with nothing live, b1 is dormant there;
        // the laptop's a2 is gone for good.
        let items: Vec<Item> = overmind_items()
            .into_iter()
            .filter(|i| i.id == "a1")
            .collect();
        let mut o = obs(items);
        o.hosts_ok.insert("workstation".into());
        let b1 = vec!["b1".to_string()];
        o.add_dormant("workstation", Some(&b1));
        o.add_dormant("laptop", Some(&Vec::new()));
        let sum = run_pass(
            &mut state,
            &o,
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |_| panic!("a dormant session is not classified"),
        );
        assert_eq!(sum.pruned, 1, "only a2");
        assert_eq!(sum.classified, 0);
        assert!(state.assignments.contains_key("workstation/b1"));
        assert_eq!(state.groups.len(), 2, "Team Reviews survives");
        let (groups, ungrouped) = view(&state, Some(&o));
        assert!(ungrouped.is_empty());
        let reviews = groups.iter().find(|g| g.label == "Team Reviews").unwrap();
        assert!(reviews.members[0].dormant);
        assert_eq!(reviews.members[0].name.as_deref(), Some("review-alice"));
        let v = serde_json::to_value(&groups).unwrap();
        let board = v
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["label"] == "Overmind Board")
            .unwrap();
        assert!(
            board["members"][0].get("dormant").is_none(),
            "only when true"
        );
        assert_eq!(
            serde_json::to_value(&reviews.members[0]).unwrap()["dormant"],
            true
        );
        // Without a pass (`--cached`) nothing is flagged.
        assert!(
            !view(&state, None)
                .0
                .iter()
                .flat_map(|g| &g.members)
                .any(|m| m.dormant)
        );
    }

    #[test]
    fn a_host_whose_dormant_list_is_unknown_prunes_nothing() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let mut o = obs(vec![]);
        o.hosts_ok.insert("laptop".into());
        o.hosts_ok.insert("workstation".into());
        o.add_dormant::<&Vec<String>>("workstation", None);
        let sum = run_pass(
            &mut state,
            &o,
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |_| panic!(),
        );
        assert_eq!(sum.pruned, 2, "the laptop's two, not the workstation's");
        assert!(state.assignments.contains_key("workstation/b1"));
    }

    #[test]
    fn a_changed_session_is_reclassified() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let mut items = overmind_items();
        items[1].name = Some("review-bob".into());
        let sum = run_pass(
            &mut state,
            &obs(items),
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |p| {
                assert!(p.contains("S1: review-bob"));
                Ok(r#"{"assign":{"S1":"Team Reviews"}}"#.into())
            },
        );
        assert_eq!(sum.classified, 1);
        assert_eq!(
            state
                .group(&state.assignments["laptop/a2"].group)
                .unwrap()
                .label,
            "Team Reviews"
        );
    }

    #[test]
    fn without_a_model_sessions_are_grouped_by_repository() {
        let mut state = State::default();
        let mut items = overmind_items();
        items.push(item(
            "laptop",
            "a9",
            "fix",
            "~/Code/project/.worktrees/fix",
            "",
        ));
        let sum = run_pass(
            &mut state,
            &obs(items),
            &PassOpts {
                allow_llm: false,
                ..opts()
            },
            |_| panic!("model is off"),
        );
        assert_eq!(sum.mode, "fallback");
        assert_eq!(sum.model_calls, 0);
        let (groups, _) = view(&state, None);
        assert_eq!(groups[0].id, "repo-project");
        assert_eq!(groups[0].members.len(), 3);
        assert_eq!(groups[1].label, "notes");
        assert!(groups.iter().all(|g| g.source == "fallback"));
    }

    #[test]
    fn a_failing_model_falls_back_then_recovers_next_run() {
        let mut state = State::default();
        let sum = run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Err(Error::Other("`claude -p` failed: not logged in".into()))
        });
        assert!(!sum.ok);
        assert_eq!(sum.model_calls, 1, "a failed call is not retried");
        assert!(sum.error.as_deref().unwrap().contains("not logged in"));
        assert!(state.groups.iter().all(|g| g.source == "fallback"));
        // Next run: the model is back, the fallback assignments are reclassified.
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |_| Ok(ANSWER.into()),
        );
        assert_eq!(sum.classified, 3);
        assert!(state.groups.iter().all(|g| g.source == "llm"));
    }

    #[test]
    fn an_unusable_answer_is_retried_once() {
        let mut state = State::default();
        let n = RefCell::new(0);
        let sum = run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            *n.borrow_mut() += 1;
            Ok(if *n.borrow() == 1 {
                "Here you go!".into()
            } else {
                ANSWER.into()
            })
        });
        assert_eq!(sum.model_calls, 2);
        assert!(sum.ok);
        assert_eq!(state.groups.len(), 2);
    }

    #[test]
    fn sessions_the_model_skips_get_a_fallback_group() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(r#"{"assign":{"S1":"N1"},"new":{"N1":"Overmind Board"}}"#.into())
        });
        assert_eq!(state.assignments.len(), 3);
        assert_eq!(state.assignments["laptop/a2"].source, "fallback");
    }

    #[test]
    fn duplicate_new_labels_reuse_the_existing_group() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let mut items = overmind_items();
        items.push(item("laptop", "a4", "x", "~/Code/project", "y"));
        run_pass(
            &mut state,
            &obs(items),
            &PassOpts {
                now: NOW + 1,
                ..opts()
            },
            |_| Ok(r#"{"assign":{"S1":"N1"},"new":{"N1":{"label":"overmind board"}}}"#.into()),
        );
        assert_eq!(state.groups.len(), 2);
        assert_eq!(
            state.assignments["laptop/a4"].group,
            state.assignments["laptop/a1"].group
        );
    }

    #[test]
    fn consolidation_is_hourly_after_changes_and_capped() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        // Not due yet: no second call.
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                now: NOW + 10,
                ..opts()
            },
            |_| panic!(),
        );
        assert_eq!(sum.model_calls, 0);
        // Due (an hour later, dirty from the first run): one consolidation call.
        let later = NOW + CONSOLIDATE_EVERY_MS + 1;
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                now: later,
                ..opts()
            },
            |p| {
                assert!(p.contains("Groups:"));
                Ok(r#"{"merge":[{"into":"Overmind Board","from":["Team Reviews"]}],"rename":{"Overmind Board":{"label":"Overmind Tooling"}}}"#.into())
            },
        );
        assert_eq!(sum.model_calls, 1);
        assert_eq!(sum.merged, 1);
        assert_eq!(sum.renamed, 1);
        assert_eq!(sum.mode, "consolidate");
        assert_eq!(state.groups.len(), 1);
        assert_eq!(state.groups[0].label, "Overmind Tooling");
        assert!(!state.dirty);
        // Nothing changed since: not due again even much later.
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                now: later + 2 * CONSOLIDATE_EVERY_MS,
                ..opts()
            },
            |_| panic!(),
        );
        assert_eq!(sum.model_calls, 0);
    }

    #[test]
    fn consolidation_never_merges_more_than_the_cap() {
        let mut state = State::default();
        for i in 0..5 {
            state.groups.push(Group {
                id: format!("g-{i}"),
                label: format!("Group {i}"),
                description: None,
                source: "llm".into(),
                created_at: 0,
                locked: false,
            });
            let it = item("laptop", &format!("s{i}"), "n", "~/Code/p", "t");
            assign(&mut state, &it, &format!("g-{i}"), "llm", 0);
        }
        let refs: Vec<String> = state.groups.iter().map(|g| g.id.clone()).collect();
        let c = parse_consolidation(
            r#"{"merge":[{"into":"G1","from":["G2","G3","G4","G5"]}]}"#,
            &refs,
            &state,
        )
        .unwrap();
        let mut sum = RunSummary::default();
        apply_consolidation(&mut state, &c, &mut sum);
        assert_eq!(sum.merged, MAX_MERGES);
        assert_eq!(state.groups.len(), 5 - MAX_MERGES);
    }

    #[test]
    fn dry_run_calls_nothing_and_counts_the_prompts() {
        let mut state = State::default();
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                dry_run: true,
                ..opts()
            },
            |_| panic!("dry run"),
        );
        assert_eq!(sum.model_calls, 0);
        assert_eq!(sum.mode, "dry-run");
        assert!(sum.note.unwrap().contains("would make 1 model call"));
        assert!(state.assignments.is_empty());
    }

    #[test]
    fn refresh_starts_over() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let old: Vec<String> = state.groups.iter().map(|g| g.id.clone()).collect();
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                refresh: true,
                now: NOW + 5,
                ..opts()
            },
            |_| Ok(ANSWER.into()),
        );
        assert_eq!(sum.mode, "full");
        assert_eq!(sum.classified, 3);
        assert!(state.groups.iter().all(|g| !old.contains(&g.id)));
    }

    #[test]
    fn observed_parses_both_input_shapes() {
        let arr = serde_json::json!([
            {"host":"laptop","session_id":"a","name":"x","cwd":"/p","extra":1},
            {"host":"laptop","pid":42}
        ]);
        let o = Observed::from_json(&arr).unwrap();
        assert_eq!(o.items.len(), 2);
        assert_eq!(o.items[1].id, "42");
        let overmind = serde_json::json!({"hosts":[
            {"name":"laptop","ok":true,"sessions":[{"session_id":"a"}]},
            {"name":"workstation","ok":false,"error":"unreachable","sessions":[]}
        ]});
        let o = Observed::from_json(&overmind).unwrap();
        assert_eq!(o.items[0].host, "laptop");
        assert!(o.hosts_ok.contains("laptop"));
        assert!(!o.hosts_ok.contains("workstation"));
        assert!(Observed::from_json(&serde_json::json!({"x":1})).is_err());
    }

    #[test]
    fn state_round_trips_and_a_corrupt_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub/groups.json");
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        state.save_to(&p).unwrap();
        assert_eq!(State::load_from(&p), state);
        std::fs::write(&p, "{nope").unwrap();
        assert_eq!(State::load_from(&p), State::default());
    }

    fn gid(state: &State, label: &str) -> String {
        state
            .groups
            .iter()
            .find(|g| g.label == label)
            .unwrap()
            .id
            .clone()
    }

    #[test]
    fn a_renamed_group_is_never_renamed_or_merged_away() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let reviews = gid(&state, "Team Reviews");
        rename_group(&mut state, &reviews, "  Reviews\n  Q3 ", NOW).unwrap();
        assert_eq!(state.group(&reviews).unwrap().label, "Reviews Q3");
        assert!(state.group(&reviews).unwrap().locked);
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                consolidate: Consolidate::Force,
                ..opts()
            },
            |_| {
                Ok(r#"{"merge":[{"into":"Overmind Board","from":["Reviews Q3"]}],"rename":{"Reviews Q3":{"label":"Other Name"}}}"#.into())
            },
        );
        assert_eq!(sum.model_calls, 1);
        assert_eq!(sum.merged + sum.renamed, 0);
        assert_eq!(state.groups.len(), 2);
        assert_eq!(state.group(&reviews).unwrap().label, "Reviews Q3");
    }

    #[test]
    fn a_renamed_fallback_group_keeps_its_sessions_when_the_model_is_back() {
        let mut state = State::default();
        let off = PassOpts {
            allow_llm: false,
            ..opts()
        };
        run_pass(&mut state, &obs(overmind_items()), &off, |_| panic!());
        let notes = state.assignments["workstation/b1"].group.clone();
        rename_group(&mut state, &notes, "Reviews", NOW).unwrap();
        let g = state.group(&notes).unwrap();
        assert_eq!(
            (g.source.as_str(), g.description.as_deref()),
            (MANUAL, None)
        );
        // The model is back: the project sessions are reclassified, the named one is not.
        run_pass(&mut state, &obs(overmind_items()), &opts(), |p| {
            assert!(p.contains("S2:") && !p.contains("S3:"));
            Ok(
                r#"{"assign":{"S1":"N1","S2":"N1"},"new":{"N1":{"label":"Overmind Board"}}}"#
                    .into(),
            )
        });
        assert_eq!(state.assignments["workstation/b1"].group, notes);
        assert_eq!(state.assignments["laptop/a1"].source, "llm");
    }

    #[test]
    fn rename_refuses_blank_duplicate_and_unknown() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let board = gid(&state, "Overmind Board");
        assert!(rename_group(&mut state, &board, "   ", NOW).is_err());
        assert!(rename_group(&mut state, &board, "team reviews", NOW).is_err());
        assert!(rename_group(&mut state, "g-nope", "X", NOW).is_err());
        // Same label, other case: its own label is fine.
        rename_group(&mut state, &board, "overmind board", NOW).unwrap();
    }

    #[test]
    fn a_moved_session_stays_put_and_empty_groups_vanish() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let board = gid(&state, "Overmind Board");
        let reviews = gid(&state, "Team Reviews");
        // The only review session moves to the board: its old group is gone.
        let to = move_session(
            &mut state,
            "workstation",
            "b1",
            &MoveTo::Group(board.clone()),
            NOW,
        )
        .unwrap();
        assert_eq!(to, board);
        assert!(state.group(&reviews).is_none());
        let a = &state.assignments["workstation/b1"];
        assert_eq!(
            (a.group.as_str(), a.source.as_str()),
            (board.as_str(), MANUAL)
        );
        // Retitled later: kept, no model call.
        let mut items = overmind_items();
        items[2].title = Some("something else entirely".into());
        let sum = run_pass(&mut state, &obs(items), &opts(), |_| panic!());
        assert_eq!(sum.model_calls, 0);
        assert_eq!(state.assignments["workstation/b1"].group, board);
        assert!(
            move_session(
                &mut state,
                "laptop",
                "a1",
                &MoveTo::Group("g-nope".into()),
                NOW
            )
            .is_err()
        );
    }

    #[test]
    fn a_session_can_start_a_new_group() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let g = move_session(
            &mut state,
            "laptop",
            "a2",
            &MoveTo::New("Group API".into()),
            NOW,
        )
        .unwrap();
        let grp = state.group(&g).unwrap();
        assert_eq!(
            (grp.label.as_str(), grp.source.as_str(), grp.locked),
            ("Group API", MANUAL, true)
        );
        // A label that exists (any case) reuses that group.
        let again = move_session(
            &mut state,
            "laptop",
            "a2",
            &MoveTo::New("group api".into()),
            NOW,
        )
        .unwrap();
        assert_eq!(again, g);
        assert!(move_session(&mut state, "laptop", "a1", &MoveTo::New(" ".into()), NOW).is_err());
        // A group holding a moved session is never merged away.
        let sum = run_pass(
            &mut state,
            &obs(overmind_items()),
            &PassOpts {
                consolidate: Consolidate::Force,
                ..opts()
            },
            |_| {
                Ok(
                    r#"{"merge":[{"into":"Overmind Board","from":["Group API"]}],"rename":{}}"#
                        .into(),
                )
            },
        );
        assert_eq!(sum.model_calls, 1);
        assert_eq!(sum.merged, 0);
        assert!(state.group(&g).is_some());
    }

    #[test]
    fn a_created_group_stays_empty_until_deleted() {
        let mut state = State::default();
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| {
            Ok(ANSWER.into())
        });
        let g = create_group(&mut state, " Spikes ", NOW).unwrap();
        assert!(create_group(&mut state, "spikes", NOW).is_err());
        assert!(create_group(&mut state, "  ", NOW).is_err());
        // Empty, it survives passes and is in the view (a drop target on the board).
        run_pass(&mut state, &obs(overmind_items()), &opts(), |_| panic!());
        let (groups, _) = view(&state, None);
        let v = groups.iter().find(|x| x.id == g).unwrap();
        assert_eq!((v.label.as_str(), v.members.len()), ("Spikes", 0));
        // Its last session leaving doesn't drop it either.
        move_session(&mut state, "laptop", "a1", &MoveTo::Group(g.clone()), NOW).unwrap();
        let board = state.assignments["laptop/a2"].group.clone();
        move_session(&mut state, "laptop", "a1", &MoveTo::Group(board), NOW).unwrap();
        assert!(state.group(&g).is_some());
        // Deleting: refused while it has sessions, fine once empty.
        move_session(&mut state, "laptop", "a1", &MoveTo::Group(g.clone()), NOW).unwrap();
        assert!(delete_group(&mut state, &g, NOW).is_err());
        move_session(
            &mut state,
            "laptop",
            "a1",
            &MoveTo::New("Overmind Board".into()),
            NOW,
        )
        .unwrap();
        delete_group(&mut state, &g, NOW).unwrap();
        assert!(state.group(&g).is_none());
        assert!(delete_group(&mut state, &g, NOW).is_err());
    }
}
