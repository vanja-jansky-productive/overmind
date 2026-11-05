//! Lessons: what sessions learn about doing their work (docs/lessons.md).
//!
//! A lesson is one `agent-memory` schema-1 record (rule, consequence, evidence quote, tier,
//! scope, …), kept per host in `$OVERMIND_LESSONS_FILE`, else
//! `${XDG_STATE_HOME:-~/.local/state}/overmind/lessons.json`, together with the proposal queue
//! (mined, waiting for consent), the rejections and the ids ever imported — the memory that
//! keeps rejected, retired and adopted lessons from coming back.
//!
//! This module is the store, the ranking that picks what a session gets
//! ([`select`]), and the JSONL interop ([`parse_jsonl`], [`export_line`]). Mining lives in
//! `core::lessons_mine`; rendering in `cli::lessons`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::tools;
use crate::error::{Error, Result};

/// The agent-memory line format this reads and writes.
pub const SCHEMA: u64 = 1;
/// Lessons a session gets at start.
pub const INJECT_LIMIT: usize = 5;
/// More lessons on a session's first prompt (never one it already has).
pub const PROMPT_LIMIT: usize = 3;
/// Confidence of a lesson learned on purpose / accepted from mining / imported.
pub const CONF_LEARNED: f64 = 0.7;
pub const CONF_MINED: f64 = 0.5;
pub const CONF_IMPORTED: f64 = 0.3;
/// `confirm` adds this much confidence, up to [`CONF_MAX`].
pub const CONF_STEP: f64 = 0.05;
pub const CONF_MAX: f64 = 0.95;
/// Two lessons whose title+rule words overlap this much (Jaccard) are the same lesson.
pub const SAME_LESSON: f64 = 0.5;

// ------------------------------------------------------------------ record

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    /// `session`, `confirm` or `manual`.
    pub kind: String,
    pub quote: String,
    /// ISO 8601 UTC.
    pub at: String,
    /// The Claude session the quote came from (overmind's addition: the link back).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// One lesson: the schema-1 fields (minus `schema`, added on export) plus overmind's
/// `origin` / `adopted_from`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lesson {
    pub id: String,
    #[serde(default = "default_persona")]
    pub persona: String,
    #[serde(default)]
    pub persona_hash: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub title: String,
    pub rule: String,
    #[serde(default)]
    pub consequence: String,
    /// `global` or `repo`.
    #[serde(default = "default_scope")]
    pub scope: String,
    /// `owner/name` when `scope` is `repo`.
    #[serde(default)]
    pub repo: Option<String>,
    /// 0 always injected, 1 injected when it fits, 2 search only.
    #[serde(default = "default_tier")]
    pub tier: u8,
    /// `active` or `retired`.
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_conf")]
    pub confidence: f64,
    #[serde(default = "one")]
    pub occurrences: u64,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub first_seen_at: String,
    #[serde(default)]
    pub last_confirmed_at: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub retired_at: Option<String>,
    #[serde(default)]
    pub retired_reason: Option<String>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// `manual`, `mined` or `imported`.
    #[serde(default = "default_origin")]
    pub origin: String,
    /// The file an imported lesson came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopted_from: Option<String>,
}

fn default_persona() -> String {
    "claude".into()
}
fn default_kind() -> String {
    "approach".into()
}
fn default_scope() -> String {
    "global".into()
}
fn default_tier() -> u8 {
    1
}
fn default_status() -> String {
    "active".into()
}
fn default_conf() -> f64 {
    CONF_MINED
}
fn one() -> u64 {
    1
}
fn default_origin() -> String {
    "manual".into()
}

impl Lesson {
    pub fn is_active(&self) -> bool {
        self.status == "active"
    }

    /// Holds for a session in `repo` (`owner/name`, or none outside a GitHub checkout).
    pub fn in_scope(&self, repo: Option<&str>) -> bool {
        match self.scope.as_str() {
            "repo" => self.repo.as_deref().is_some_and(|r| Some(r) == repo),
            _ => true,
        }
    }

    pub fn is_mine(&self) -> bool {
        self.origin != "imported"
    }

    /// One more sighting: occurrences + 1, confidence + [`CONF_STEP`], evidence kept.
    pub fn confirm(&mut self, ev: Option<Evidence>, now: &str) {
        self.occurrences += 1;
        self.confidence = round2(
            (self.confidence + CONF_STEP)
                .min(CONF_MAX)
                .max(self.confidence),
        );
        self.last_confirmed_at = Some(now.to_string());
        if let Some(e) = ev {
            self.evidence.push(e);
        }
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// The fields a person (or the miner) supplies for a new lesson.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub title: String,
    pub rule: String,
    #[serde(default)]
    pub consequence: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub tier: Option<u8>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

/// Changes `edit` / `accept` apply; `None` leaves a field alone.
#[derive(Debug, Clone, Default)]
pub struct Changes {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub rule: Option<String>,
    pub consequence: Option<String>,
    pub scope: Option<String>,
    pub repo: Option<String>,
    pub tier: Option<u8>,
    pub confidence: Option<f64>,
}

impl Changes {
    pub fn apply(&self, l: &mut Lesson) -> Result<()> {
        if let Some(v) = &self.kind {
            l.kind = clean_word(v, "kind")?;
        }
        if let Some(v) = &self.title {
            l.title = nonempty(v, "title")?;
        }
        if let Some(v) = &self.rule {
            l.rule = nonempty(v, "rule")?;
        }
        if let Some(v) = &self.consequence {
            l.consequence = nonempty(v, "consequence")?;
        }
        if let Some(v) = &self.repo {
            l.repo = Some(check_repo(v)?);
        }
        if let Some(v) = &self.scope {
            l.scope = check_scope(v)?;
        }
        if l.scope == "repo" && l.repo.is_none() {
            return Err(Error::Other("scope repo needs --repo owner/name".into()));
        }
        if l.scope == "global" {
            l.repo = None;
        }
        if let Some(t) = self.tier {
            l.tier = check_tier(t)?;
        }
        if let Some(c) = self.confidence {
            if !(0.0..=1.0).contains(&c) {
                return Err(Error::Other("confidence must be between 0 and 1".into()));
            }
            l.confidence = c;
        }
        Ok(())
    }
}

fn nonempty(v: &str, what: &str) -> Result<String> {
    let v = v.trim();
    if v.is_empty() {
        return Err(Error::Other(format!("{what} must not be empty")));
    }
    Ok(v.to_string())
}

fn clean_word(v: &str, what: &str) -> Result<String> {
    let v = v.trim().to_lowercase();
    if v.is_empty()
        || !v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::Other(format!("{what} must be one word: {v:?}")));
    }
    Ok(v)
}

pub fn check_scope(v: &str) -> Result<String> {
    match v.trim() {
        s @ ("global" | "repo") => Ok(s.to_string()),
        other => Err(Error::Other(format!(
            "scope must be global or repo, not {other:?}"
        ))),
    }
}

pub fn check_tier(t: u8) -> Result<u8> {
    if t > 2 {
        return Err(Error::Other("tier must be 0, 1 or 2".into()));
    }
    Ok(t)
}

pub fn check_repo(v: &str) -> Result<String> {
    let v = v.trim().trim_end_matches(".git");
    match v.split_once('/') {
        Some((o, n)) if !o.is_empty() && !n.is_empty() && !n.contains('/') => Ok(v.to_string()),
        _ => Err(Error::Other(format!("repo must be owner/name, not {v:?}"))),
    }
}

/// A short title from a rule: its first clause, at most 8 words.
pub fn title_from(rule: &str) -> String {
    let first = rule
        .split(['.', ';', ':', '\n'])
        .find(|s| !s.trim().is_empty())
        .unwrap_or(rule);
    let words: Vec<&str> = first.split_whitespace().take(8).collect();
    let mut t = words.join(" ");
    if first.split_whitespace().count() > 8 {
        t.push('…');
    }
    t
}

// ------------------------------------------------------------------ store

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    /// `p<n>`.
    pub pid: String,
    pub created_at: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub draft: Draft,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rejected {
    pub title: String,
    pub rule: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub version: u32,
    /// The next number for this host's own ids (`<handle>/<persona>#<n>`) and proposals.
    #[serde(default)]
    pub next: u64,
    #[serde(default)]
    pub lessons: Vec<Lesson>,
    #[serde(default)]
    pub proposals: Vec<Proposal>,
    #[serde(default)]
    pub rejected: Vec<Rejected>,
    /// Every id ever imported.
    #[serde(default)]
    pub adopted: Vec<String>,
    /// Session id → transcript bytes already mined.
    #[serde(default)]
    pub mined: BTreeMap<String, u64>,
}

pub fn path() -> PathBuf {
    if let Some(p) = std::env::var_os("OVERMIND_LESSONS_FILE").filter(|p| !p.is_empty()) {
        return PathBuf::from(tools::expand_tilde(&p.to_string_lossy()));
    }
    tools::state_dir().join("lessons.json")
}

/// The store as on disk (empty when there is none). A file that does not parse is an error:
/// writing over it would lose every lesson.
pub fn load() -> Result<Store> {
    load_from(&path())
}

pub fn load_from(p: &Path) -> Result<Store> {
    match std::fs::read_to_string(p) {
        Ok(t) => serde_json::from_str(&t)
            .map_err(|e| Error::Other(format!("{}: not a lessons file: {e}", p.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.into()),
    }
}

fn save_to(p: &Path, s: &Store) -> Result<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut s = s.clone();
    s.version = 1;
    let tmp = p.with_extension(format!("json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&s)? + "\n")?;
    std::fs::rename(&tmp, p)?;
    Ok(())
}

/// Read, change and write the store under its lock (writers are short CLI runs, the
/// background miner and hooks: they wait for each other rather than lose a write).
pub fn update<T>(f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let p = path();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(p.with_extension("lock"))?;
    lock.lock()?;
    let mut s = load_from(&p)?;
    let out = f(&mut s)?;
    save_to(&p, &s)?;
    Ok(out)
}

/// UTC now, ISO 8601 to the second (the format's timestamps).
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Who owns the lessons learned here: `lessons.handle`, else `$USER`.
pub fn handle() -> String {
    setting("handle")
        .or_else(|| std::env::var("USER").ok().filter(|u| !u.trim().is_empty()))
        .unwrap_or_else(|| "me".into())
}

/// The persona new lessons belong to: `lessons.persona`, else `claude` (the generalist).
pub fn persona() -> String {
    setting("persona").unwrap_or_else(default_persona)
}

/// A string under `lessons` in the config.
pub fn setting(key: &str) -> Option<String> {
    crate::core::config::load().raw["lessons"][key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// `lessons.mine` (default true).
pub fn mining_on() -> bool {
    crate::core::config::load().raw["lessons"]["mine"].as_bool() != Some(false)
}

impl Store {
    fn bump(&mut self) -> u64 {
        // `next` starts past every number of ours already used, whatever the file says.
        let used = self
            .lessons
            .iter()
            .filter(|l| l.is_mine())
            .filter_map(|l| l.id.rsplit_once('#')?.1.parse::<u64>().ok())
            .chain(
                self.proposals
                    .iter()
                    .filter_map(|p| p.pid.strip_prefix('p')?.parse().ok()),
            )
            .max()
            .unwrap_or(0);
        self.next = self.next.max(used + 1).max(1);
        let n = self.next;
        self.next += 1;
        n
    }

    /// Find a lesson by id, or by a unique suffix (`#12`, `12`).
    pub fn find(&self, key: &str) -> Result<usize> {
        if let Some(i) = self.lessons.iter().position(|l| l.id == key) {
            return Ok(i);
        }
        let k = key.trim_start_matches('#');
        let hits: Vec<usize> = self
            .lessons
            .iter()
            .enumerate()
            .filter(|(_, l)| l.id.rsplit_once('#').is_some_and(|(_, n)| n == k))
            .map(|(i, _)| i)
            .collect();
        match hits.as_slice() {
            [i] => Ok(*i),
            [] => Err(Error::Other(format!("no lesson {key}"))),
            many => Err(Error::Other(format!(
                "{key} is ambiguous: {}",
                many.iter()
                    .map(|i| self.lessons[*i].id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    pub fn find_proposal(&self, pid: &str) -> Result<usize> {
        let want = if pid.starts_with('p') {
            pid.to_string()
        } else {
            format!("p{pid}")
        };
        self.proposals
            .iter()
            .position(|p| p.pid == want)
            .ok_or_else(|| Error::Other(format!("no proposal {pid}")))
    }

    /// A new lesson of this host's own, from a draft.
    pub fn add(
        &mut self,
        d: Draft,
        origin: &str,
        confidence: f64,
        handle: &str,
        persona: &str,
        now: &str,
    ) -> Result<&Lesson> {
        let mut l = lesson_from(d, origin, confidence, persona, now)?;
        l.id = format!("{handle}/{persona}#{}", self.bump());
        self.lessons.push(l);
        Ok(self.lessons.last().expect("just pushed"))
    }

    pub fn propose(
        &mut self,
        d: Draft,
        session: Option<&str>,
        cwd: Option<&str>,
        now: &str,
    ) -> String {
        let pid = format!("p{}", self.bump());
        self.proposals.push(Proposal {
            pid: pid.clone(),
            created_at: now.to_string(),
            session: session.map(String::from),
            cwd: cwd.map(String::from),
            draft: d,
        });
        pid
    }

    /// Where a candidate lesson stands against what the store already knows.
    pub fn known(&self, title: &str, rule: &str) -> Known {
        let want = words(&format!("{title} {rule}"));
        let same = |t: &str, r: &str| jaccard(&want, &words(&format!("{t} {r}"))) >= SAME_LESSON;
        if let Some(r) = self.rejected.iter().find(|r| same(&r.title, &r.rule)) {
            return Known::Rejected(r.title.clone());
        }
        for l in &self.lessons {
            if same(&l.title, &l.rule) {
                return if l.is_active() {
                    Known::Active(l.id.clone())
                } else {
                    Known::Retired(l.id.clone())
                };
            }
        }
        if let Some(p) = self
            .proposals
            .iter()
            .find(|p| same(&p.draft.title, &p.draft.rule))
        {
            return Known::Proposed(p.pid.clone());
        }
        Known::New
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Known {
    New,
    Active(String),
    Retired(String),
    Rejected(String),
    Proposed(String),
}

fn lesson_from(
    d: Draft,
    origin: &str,
    confidence: f64,
    persona: &str,
    now: &str,
) -> Result<Lesson> {
    let rule = nonempty(&d.rule, "rule")?;
    let title = if d.title.trim().is_empty() {
        title_from(&rule)
    } else {
        d.title.trim().to_string()
    };
    let mut l = Lesson {
        id: String::new(),
        persona: persona.to_string(),
        persona_hash: None,
        kind: clean_word(d.kind.as_deref().unwrap_or("approach"), "kind")?,
        title,
        rule,
        consequence: d.consequence.trim().to_string(),
        scope: "global".into(),
        repo: None,
        tier: 1,
        status: "active".into(),
        confidence,
        occurrences: 1,
        uses: 0,
        first_seen_at: now.to_string(),
        last_confirmed_at: Some(now.to_string()),
        last_used_at: None,
        retired_at: None,
        retired_reason: None,
        evidence: d.evidence,
        origin: origin.to_string(),
        adopted_from: None,
    };
    Changes {
        scope: d.scope,
        repo: d.repo,
        tier: d.tier,
        ..Default::default()
    }
    .apply(&mut l)?;
    Ok(l)
}

// ------------------------------------------------------------------ ranking

const STOP: &[&str] = &[
    "the", "and", "for", "that", "this", "with", "from", "are", "was", "were", "you", "your",
    "not", "but", "have", "has", "had", "its", "it's", "into", "when", "then", "than", "them",
    "they", "their", "there", "what", "which", "who", "will", "would", "should", "could", "can",
    "does", "did", "doing", "done", "all", "any", "each", "every", "one", "only", "also", "just",
    "out", "about", "before", "after", "over", "under", "again", "more", "most", "other", "some",
    "such", "very", "own", "same", "so", "too", "how", "why", "where", "here", "our", "ours",
    "use", "used", "using", "make", "made", "get", "got", "let", "via", "per", "both", "while",
    "these", "those", "been", "being", "because", "into", "onto", "off", "don't", "doesn't",
    "isn't", "never", "always", "first", "instead", "without", "within", "through", "now", "new",
    "please", "want", "need", "like", "see", "look", "way", "thing", "things", "agent", "user",
    "fix", "add", "open", "write", "run", "check", "change", "update", "work", "try", "keep",
    "find", "read", "show", "set", "start", "call", "put", "take", "give", "tell", "ask", "know",
    "think", "good", "bad", "right", "wrong", "sure", "feat", "chore", "session",
];

/// The words of `text` that carry meaning: lowercased, 3+ characters, stop words out,
/// a plural `s` dropped.
pub fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .map(|w| w.trim_matches('\'').to_lowercase())
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(&w.as_str()))
        .filter(|w| !w.chars().all(|c| c.is_ascii_digit()))
        .map(|w| {
            if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
                w[..w.len() - 1].to_string()
            } else {
                w
            }
        })
        .collect()
}

fn words(text: &str) -> HashSet<String> {
    tokens(text).into_iter().collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    a.intersection(b).count() as f64 / a.union(b).count() as f64
}

/// What a session is about, for [`select`].
#[derive(Debug, Clone, Default)]
pub struct Situation {
    /// `owner/name` of the cwd's checkout.
    pub repo: Option<String>,
    /// Free text: branch, brief, first prompt, `--task`.
    pub task: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pick {
    pub id: String,
    pub score: f64,
    /// Why it was picked: `tier0`, `repo`, `match`.
    pub why: String,
    /// Task words it matched.
    pub matched: Vec<String>,
}

/// Up to `limit` active lessons for `sit`, best first, none of `skip`: every tier-0 lesson in
/// distinct task words, one of them rare among the lessons), by score. Tier 2 never comes back
/// here (`search` finds it).
/// distinct task words), by score. Tier 2 never comes back here (`search` finds it).
pub fn select(
    lessons: &[Lesson],
    sit: &Situation,
    limit: usize,
    skip: &HashSet<String>,
) -> Vec<Pick> {
    let repo = sit.repo.as_deref();
    let pool: Vec<&Lesson> = lessons
        .iter()
        .filter(|l| l.is_active() && l.in_scope(repo) && l.tier <= 1 && !skip.contains(&l.id))
        .collect();
    let query: Vec<String> = {
        let mut seen = HashSet::new();
        // The repo's name counts as a task word ("overmind" in a lesson about overmind).
        let repo_words = repo.map(|r| r.replace('/', " ")).unwrap_or_default();
        tokens(&format!("{} {repo_words}", sit.task))
            .into_iter()
            .filter(|t| seen.insert(t.clone()))
            .collect()
    };
    let rel = Bm25::new(&pool);
    let mut picks: Vec<Pick> = pool
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let (r, matched) = rel.score(i, &query);
            let this_repo = l.scope == "repo";
            let why = if l.tier == 0 {
                "tier0"
            } else if this_repo {
                "repo"
            } else if matched.len() >= 2 && matched.iter().any(|w| rel.distinctive(w)) {
                "match"
            } else {
                return None;
            };
            let score = 2.0 * r / (r + 3.0)
                + if this_repo { 1.0 } else { 0.0 }
                + 0.5 * l.confidence
                + 0.1 * (1.0 + l.occurrences as f64).ln();
            Some(Pick {
                id: l.id.clone(),
                score: round2(score),
                why: why.into(),
                matched,
            })
        })
        .collect();
    picks.sort_by(|a, b| {
        (b.why == "tier0")
            .cmp(&(a.why == "tier0"))
            .then(b.score.total_cmp(&a.score))
            .then(a.id.cmp(&b.id))
    });
    picks.truncate(limit);
    picks
}

/// Every active lesson matching `query` (any tier), best first.
pub fn search(lessons: &[Lesson], query: &str, all: bool) -> Vec<(f64, usize)> {
    let pool: Vec<(usize, &Lesson)> = lessons
        .iter()
        .enumerate()
        .filter(|(_, l)| all || l.is_active())
        .collect();
    let only: Vec<&Lesson> = pool.iter().map(|(_, l)| *l).collect();
    let rel = Bm25::new(&only);
    let q: Vec<String> = tokens(query);
    let lower = query.trim().to_lowercase();
    let mut out: Vec<(f64, usize)> = pool
        .iter()
        .enumerate()
        .filter_map(|(k, (i, l))| {
            let (r, _) = rel.score(k, &q);
            let exact = !lower.is_empty()
                && (l.id.to_lowercase() == lower || doc_text(l).to_lowercase().contains(&lower));
            let s = r + if exact { 5.0 } else { 0.0 };
            (s > 0.0).then_some((round2(s), *i))
        })
        .collect();
    out.sort_by(|a, b| b.0.total_cmp(&a.0));
    out
}

fn doc_text(l: &Lesson) -> String {
    // The title counts twice: it names the situation.
    format!("{} {} {} {}", l.title, l.title, l.rule, l.consequence)
}

/// BM25 over a fixed set of lessons.
struct Bm25 {
    docs: Vec<HashMap<String, f64>>,
    lens: Vec<f64>,
    avg: f64,
    df: HashMap<String, f64>,
}

impl Bm25 {
    fn new(lessons: &[&Lesson]) -> Bm25 {
        let mut docs = Vec::new();
        let mut lens = Vec::new();
        let mut df: HashMap<String, f64> = HashMap::new();
        for l in lessons {
            let toks = tokens(&doc_text(l));
            lens.push(toks.len() as f64);
            let mut tf: HashMap<String, f64> = HashMap::new();
            for t in toks {
                *tf.entry(t).or_default() += 1.0;
            }
            for t in tf.keys() {
                *df.entry(t.clone()).or_default() += 1.0;
            }
            docs.push(tf);
        }
        let avg = if lens.is_empty() {
            1.0
        } else {
            (lens.iter().sum::<f64>() / lens.len() as f64).max(1.0)
        };
        Bm25 {
            docs,
            lens,
            avg,
            df,
        }
    }

    /// Is `word` rare enough here to tell a situation apart: in at most a tenth of the
    /// lessons (or just one)?
    fn distinctive(&self, word: &str) -> bool {
        let df = self.df.get(word).copied().unwrap_or(0.0);
        df > 0.0 && df <= (self.docs.len() as f64 * 0.1).max(1.0)
    }

    /// (score, the query words it matched).
    fn score(&self, i: usize, query: &[String]) -> (f64, Vec<String>) {
        let (k1, b) = (1.2, 0.75);
        let n = self.docs.len() as f64;
        let mut s = 0.0;
        let mut matched = Vec::new();
        for q in query {
            let Some(tf) = self.docs[i].get(q) else {
                continue;
            };
            let df = self.df.get(q).copied().unwrap_or(0.0);
            let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
            s += idf * tf * (k1 + 1.0) / (tf + k1 * (1.0 - b + b * self.lens[i] / self.avg));
            matched.push(q.clone());
        }
        (s, matched)
    }
}

/// The block a session gets: one line per lesson, and how to answer them.
pub fn context_block(lessons: &[&Lesson]) -> String {
    let mut out = String::from(
        "Lessons from earlier sessions (overmind). Apply them where they fit. \
`overmind lesson show <id>` has the evidence; run `overmind lesson confirm <id>` when one held \
and `overmind lesson retire <id> --reason \"…\"` when one misled you. To record a new one: \
`overmind lesson learn --rule \"…\" --consequence \"…\" --quote \"…\"`.\n",
    );
    for l in lessons {
        out.push_str(&format!("- [{}] {}: {}", l.id, l.title, l.rule));
        if !l.consequence.is_empty() {
            out.push_str(&format!(" (Why: {})", l.consequence));
        }
        out.push('\n');
    }
    out
}

// ------------------------------------------------------------------ interop

/// One line of an agent-memory file, parsed; `Err` says why the line is skipped.
pub fn parse_line(line: &str) -> std::result::Result<Lesson, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("not JSON: {e}"))?;
    match v.get("schema").and_then(Value::as_u64) {
        Some(SCHEMA) => {}
        Some(n) => return Err(format!("schema {n}, not {SCHEMA}")),
        None => return Err("no schema".into()),
    }
    let mut l: Lesson = serde_json::from_value(v).map_err(|e| format!("not a lesson: {e}"))?;
    if l.id.trim().is_empty() || l.rule.trim().is_empty() {
        return Err("no id or rule".into());
    }
    if l.title.trim().is_empty() {
        l.title = title_from(&l.rule);
    }
    Ok(l)
}

/// The reasons an import skips a line.
#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub adopted: Vec<String>,
    pub already: usize,
    pub retired: usize,
    pub other_repo: usize,
    pub invalid: Vec<String>,
}

/// Adopt the lines of an agent-memory file: active, `global` or scoped to one of `repos`,
/// never an id adopted before (or one of ours), at [`CONF_IMPORTED`] and never tier 0.
pub fn import(
    store: &mut Store,
    text: &str,
    source: &str,
    repos: &HashSet<String>,
    now: &str,
) -> ImportReport {
    let mut rep = ImportReport::default();
    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let mut l = match parse_line(line) {
            Ok(l) => l,
            Err(e) => {
                rep.invalid.push(format!("{source}:{}: {e}", n + 1));
                continue;
            }
        };
        if store.adopted.contains(&l.id) || store.lessons.iter().any(|x| x.id == l.id) {
            rep.already += 1;
            continue;
        }
        if !l.is_active() {
            rep.retired += 1;
            continue;
        }
        if l.scope == "repo" && !l.repo.as_ref().is_some_and(|r| repos.contains(r)) {
            rep.other_repo += 1;
            continue;
        }
        l.confidence = CONF_IMPORTED.min(l.confidence);
        l.tier = l.tier.max(1);
        l.origin = "imported".into();
        l.adopted_from = Some(source.to_string());
        l.uses = 0;
        l.last_used_at = None;
        if l.first_seen_at.is_empty() {
            l.first_seen_at = now.to_string();
        }
        store.adopted.push(l.id.clone());
        rep.adopted.push(l.id.clone());
        store.lessons.push(l);
    }
    rep
}

/// A lesson as one schema-1 line: `schema` first, overmind's `origin`/`adopted_from` left
/// out; `None` when its text looks like a secret or personal data. Quotes that do are
/// dropped, and home paths become `~`.
pub fn export_line(l: &Lesson) -> Option<String> {
    if [&l.title, &l.rule, &l.consequence]
        .iter()
        .any(|t| sensitive(t))
    {
        return None;
    }
    let mut l = l.clone();
    l.title = tildify_text(&l.title);
    l.rule = tildify_text(&l.rule);
    l.consequence = tildify_text(&l.consequence);
    l.retired_reason = l.retired_reason.map(|r| tildify_text(&r));
    l.evidence.retain(|e| !sensitive(&e.quote));
    for e in &mut l.evidence {
        e.quote = tildify_text(&e.quote);
    }
    let mut v = serde_json::to_value(&l).ok()?;
    let obj = v.as_object_mut()?;
    obj.remove("origin");
    obj.remove("adopted_from");
    let mut out = serde_json::Map::new();
    out.insert("schema".into(), SCHEMA.into());
    out.extend(std::mem::take(obj));
    serde_json::to_string(&Value::Object(out)).ok()
}

/// `/Users/<name>/…` and `/home/<name>/…` → `~/…`.
pub fn tildify_text(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut rest = t;
    loop {
        let at = ["/Users/", "/home/"]
            .iter()
            .filter_map(|p| rest.find(p).map(|i| (i, p.len())))
            .min();
        let Some((i, plen)) = at else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..i]);
        let after = &rest[i + plen..];
        let name_end = after
            .find(|c: char| !(c.is_alphanumeric() || "._-".contains(c)))
            .unwrap_or(after.len());
        if name_end == 0 {
            out.push_str(&rest[i..i + plen]);
            rest = after;
        } else {
            out.push('~');
            rest = &after[name_end..];
        }
    }
}

/// Text that looks like a secret or personal data: API tokens and keys, private keys,
/// email addresses, private or tailnet IPv4 addresses.
pub fn sensitive(text: &str) -> bool {
    if text.contains("-----BEGIN") {
        return true;
    }
    text.split(|c: char| c.is_whitespace() || "\"'`()[]{}<>,;=".contains(c))
        .any(sensitive_word)
}

fn sensitive_word(w: &str) -> bool {
    let w = w.trim_matches(|c: char| ".:!?".contains(c));
    let tail_len = |p: &str| {
        w.strip_prefix(p).map_or(0, |r| {
            r.chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .count()
        })
    };
    for (p, min) in [
        ("ghp_", 20),
        ("gho_", 20),
        ("ghs_", 20),
        ("github_pat_", 20),
        ("sk-", 20),
        ("xoxb-", 10),
        ("xoxp-", 10),
        ("xapp-", 10),
        ("AKIA", 16),
        ("glpat-", 16),
    ] {
        if tail_len(p) >= min {
            return true;
        }
    }
    // name@domain.tld
    if let Some((user, dom)) = w.split_once('@')
        && !user.is_empty()
        && !user.contains('/')
        && dom.contains('.')
        && dom
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
    {
        return true;
    }
    // Private / CGNAT (Tailscale) IPv4.
    let parts: Vec<&str> = w.split('.').collect();
    if parts.len() == 4
        && let Ok(o) = parts
            .iter()
            .map(|p| p.parse::<u8>())
            .collect::<std::result::Result<Vec<u8>, _>>()
    {
        return o[0] == 10
            || (o[0] == 192 && o[1] == 168)
            || (o[0] == 172 && (16..32).contains(&o[1]))
            || (o[0] == 100 && (64..128).contains(&o[1]));
    }
    false
}

/// The repos you work in: the GitHub `origin` of every repo under `repos.roots`, and every
/// repo one of your lessons names.
pub fn known_repos(store: &Store) -> HashSet<String> {
    let mut out: HashSet<String> = store
        .lessons
        .iter()
        .filter(|l| l.is_mine())
        .filter_map(|l| l.repo.clone())
        .collect();
    let settings = crate::core::repos::Settings::load();
    for r in crate::core::repos::discover(&settings) {
        if let Some(slug) = crate::core::git::head_of(&r.path).and_then(|h| h.repo) {
            out.insert(slug);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(title: &str, rule: &str) -> Draft {
        Draft {
            title: title.into(),
            rule: rule.into(),
            consequence: "it broke".into(),
            ..Default::default()
        }
    }

    fn store_with(rules: &[(&str, &str, &str, Option<&str>, u8)]) -> Store {
        let mut s = Store::default();
        for (title, rule, scope, repo, tier) in rules {
            let mut d = draft(title, rule);
            d.scope = Some(scope.to_string());
            d.repo = repo.map(String::from);
            d.tier = Some(*tier);
            s.add(
                d,
                "manual",
                CONF_LEARNED,
                "me",
                "claude",
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        }
        s
    }

    #[test]
    fn ids_count_up_past_anything_used() {
        let mut s = store_with(&[("a", "rule one", "global", None, 1)]);
        assert_eq!(s.lessons[0].id, "me/claude#1");
        let pid = s.propose(draft("b", "rule two"), None, None, "t");
        assert_eq!(pid, "p2");
        s.next = 0; // a hand-edited file
        let l = s
            .add(draft("c", "rule three"), "manual", 0.7, "me", "claude", "t")
            .unwrap();
        assert_eq!(l.id, "me/claude#3");
        assert_eq!(s.find("#3").unwrap(), 1);
        assert_eq!(s.find("3").unwrap(), 1);
        assert!(s.find("9").is_err());
        assert_eq!(s.find_proposal("2").unwrap(), 0);
    }

    #[test]
    fn repo_scope_needs_a_repo_and_global_drops_it() {
        let mut d = draft("t", "r");
        d.scope = Some("repo".into());
        assert!(lesson_from(d.clone(), "manual", 0.7, "claude", "t").is_err());
        d.repo = Some("o/n".into());
        let l = lesson_from(d.clone(), "manual", 0.7, "claude", "t").unwrap();
        assert!(l.in_scope(Some("o/n")) && !l.in_scope(Some("o/x")) && !l.in_scope(None));
        d.scope = Some("global".into());
        assert_eq!(
            lesson_from(d, "manual", 0.7, "claude", "t").unwrap().repo,
            None
        );
        assert!(check_repo("nope").is_err());
        assert!(check_tier(3).is_err());
    }

    #[test]
    fn titles_come_from_the_rule() {
        assert_eq!(
            title_from("Run the tests first. Then push."),
            "Run the tests first"
        );
        assert_eq!(
            title_from("one two three four five six seven eight nine"),
            "one two three four five six seven eight…"
        );
    }

    #[test]
    fn tokens_drop_noise() {
        assert_eq!(
            tokens("When the migrations fail, check the Rails logs"),
            vec!["migration", "fail", "rail", "log"]
        );
    }

    #[test]
    fn jaccard_is_overlap_over_union() {
        let a = words("alpha beta gamma");
        let b = words("alpha beta delta");
        assert!((jaccard(&a, &b) - 0.5).abs() < 1e-9);
        assert_eq!(jaccard(&a, &HashSet::new()), 0.0);
    }

    #[test]
    fn known_finds_rejected_retired_active_and_proposed() {
        let mut s = store_with(&[(
            "Run clippy before commit",
            "Run cargo clippy before every commit",
            "global",
            None,
            1,
        )]);
        assert_eq!(
            s.known(
                "Run clippy before commits",
                "Run cargo clippy before each commit"
            ),
            Known::Active("me/claude#1".into())
        );
        s.lessons[0].status = "retired".into();
        assert_eq!(
            s.known(
                "Run clippy before commits",
                "Run cargo clippy before each commit"
            ),
            Known::Retired("me/claude#1".into())
        );
        s.rejected.push(Rejected {
            title: "Prefer tabs".into(),
            rule: "Indent with tabs in shell scripts".into(),
            reason: None,
            at: "t".into(),
        });
        assert!(matches!(
            s.known("Prefer tabs", "Indent shell scripts with tabs"),
            Known::Rejected(_)
        ));
        s.propose(
            draft("Quote paths", "Quote every path in generated shell"),
            None,
            None,
            "t",
        );
        assert!(matches!(
            s.known("Quote paths", "Quote every path in generated shell lines"),
            Known::Proposed(_)
        ));
        assert_eq!(
            s.known("Something else", "Entirely unrelated advice here"),
            Known::New
        );
    }

    #[test]
    fn select_puts_tier0_first_then_repo_and_matches() {
        let s = store_with(&[
            (
                "Always answer briefly",
                "Keep replies short",
                "global",
                None,
                0,
            ),
            (
                "Billing migrations",
                "Run billing migrations with the lock flag",
                "repo",
                Some("o/app"),
                1,
            ),
            (
                "Other repo",
                "Something about deploys",
                "repo",
                Some("o/other"),
                1,
            ),
            (
                "Flaky e2e selectors",
                "When an e2e selector times out, check the aria label first",
                "global",
                None,
                1,
            ),
            ("Search only", "e2e selector aria trivia", "global", None, 2),
            ("Unrelated", "Prefer small commits", "global", None, 1),
        ]);
        let sit = Situation {
            repo: Some("o/app".into()),
            task: "fix the flaky e2e selector timeout".into(),
        };
        let picks = select(&s.lessons, &sit, 5, &HashSet::new());
        let ids: Vec<&str> = picks.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["me/claude#1", "me/claude#4", "me/claude#2"]);
        assert_eq!(
            (picks[1].why.as_str(), picks[2].why.as_str()),
            ("match", "repo")
        );
        // A bare start in a repo with nothing to match: tier 0 and the repo's own.
        let bare = Situation {
            repo: Some("o/app".into()),
            task: String::new(),
        };
        assert_eq!(select(&s.lessons, &bare, 5, &HashSet::new()).len(), 2);
        // Skips and the limit.
        let skip: HashSet<String> = ["me/claude#1".to_string()].into();
        let picks = select(&s.lessons, &sit, 1, &skip);
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].id, "me/claude#4");
    }

    #[test]
    fn search_finds_every_tier() {
        let s = store_with(&[
            ("Search only", "aria selectors in e2e", "global", None, 2),
            ("Unrelated", "Prefer small commits", "global", None, 1),
        ]);
        let hits = search(&s.lessons, "aria selector", false);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].1, 0);
    }

    const LINE: &str = r#"{"schema":1,"id":"someone/claude#7","persona":"claude","persona_hash":null,"kind":"friction","title":"Check tool access","rule":"Run ToolSearch before saying a tool is missing.","consequence":"A wrong claim cost two rounds.","scope":"global","repo":null,"tier":0,"status":"active","confidence":0.9,"occurrences":3,"uses":4,"first_seen_at":"2026-10-26T10:36:48Z","last_confirmed_at":"2026-10-26T10:36:48Z","last_used_at":null,"retired_at":null,"retired_reason":null,"evidence":[{"kind":"session","quote":"That is not correct.","at":"2026-10-26T10:36:48Z"}]}"#;

    #[test]
    fn import_adopts_once_at_low_confidence() {
        let mut s = Store::default();
        let repos: HashSet<String> = ["o/mine".to_string()].into();
        let other = LINE
            .replace("someone/claude#7", "someone/claude#8")
            .replace(
                r#""scope":"global","repo":null"#,
                r#""scope":"repo","repo":"o/theirs""#,
            );
        let mine = LINE
            .replace("someone/claude#7", "someone/claude#9")
            .replace(
                r#""scope":"global","repo":null"#,
                r#""scope":"repo","repo":"o/mine""#,
            );
        let retired = LINE
            .replace("someone/claude#7", "someone/claude#10")
            .replace(r#""status":"active""#, r#""status":"retired""#);
        let text = [LINE, &other, &mine, &retired, "{\"schema\":2}", "junk"].join("\n");
        let rep = import(&mut s, &text, "f.jsonl", &repos, "now");
        assert_eq!(rep.adopted, vec!["someone/claude#7", "someone/claude#9"]);
        assert_eq!((rep.other_repo, rep.retired, rep.invalid.len()), (1, 1, 2));
        let l = &s.lessons[0];
        assert_eq!((l.confidence, l.tier, l.uses), (CONF_IMPORTED, 1, 0));
        assert_eq!(l.origin, "imported");
        assert!(!l.is_mine());
        // Never twice, even after it is gone from the lessons.
        s.lessons.clear();
        let again = import(&mut s, LINE, "f.jsonl", &repos, "now");
        assert!(again.adopted.is_empty());
        assert_eq!(again.already, 1);
    }

    #[test]
    fn export_round_trips_the_format() {
        let l = parse_line(LINE).unwrap();
        let out = export_line(&l).unwrap();
        let a: Value = serde_json::from_str(LINE).unwrap();
        let b: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(a, b);
        assert!(out.starts_with("{\"schema\":1,\"id\":"));
    }

    #[test]
    fn export_scrubs_secrets_and_homes() {
        let mut l = parse_line(LINE).unwrap();
        l.evidence.push(Evidence {
            kind: "session".into(),
            quote: "token ghp_abcdefghijklmnopqrstuvwx".into(),
            at: "t".into(),
            session: None,
        });
        l.evidence.push(Evidence {
            kind: "session".into(),
            quote: "see /Users/someone/Code/x and /home/me".into(),
            at: "t".into(),
            session: Some("sid".into()),
        });
        let v: Value = serde_json::from_str(&export_line(&l).unwrap()).unwrap();
        let ev = v["evidence"].as_array().unwrap();
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[1]["quote"], "see ~/Code/x and ~");
        assert_eq!(ev[1]["session"], "sid");
        l.rule = "mail a@b.co".into();
        assert!(export_line(&l).is_none());
    }

    #[test]
    fn sensitive_spots_the_usual_suspects() {
        for s in [
            "key sk-ABCDEFGHIJKLMNOPQRSTUVWX",
            "AKIAABCDEFGHIJKLMNOP",
            "ping 100.101.1.2",
            "host 192.168.1.4.",
            "someone@example.com",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        ] {
            assert!(sensitive(s), "{s}");
        }
        for s in [
            "run sk-learn",
            "the 1.2.3 release",
            "git@github.com:o/n",
            "100.0.0.1",
            "@types/node",
        ] {
            assert!(!sensitive(s), "{s}");
        }
    }

    #[test]
    fn confirm_bumps_and_caps() {
        let mut l = parse_line(LINE).unwrap();
        l.confirm(None, "later");
        assert_eq!((l.occurrences, l.confidence), (4, 0.95));
        l.confirm(None, "later");
        assert_eq!(l.confidence, 0.95);
        assert_eq!(l.last_confirmed_at.as_deref(), Some("later"));
    }

    #[test]
    fn update_locks_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("l.json");
        save_to(&p, &store_with(&[("a", "rule", "global", None, 1)])).unwrap();
        let s = load_from(&p).unwrap();
        assert_eq!((s.version, s.lessons.len()), (1, 1));
        std::fs::write(&p, "not json").unwrap();
        assert!(load_from(&p).is_err());
        assert_eq!(
            load_from(&dir.path().join("none.json"))
                .unwrap()
                .lessons
                .len(),
            0
        );
    }
}
