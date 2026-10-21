//! `overmind repos`: keep the git checkouts under a few root directories fresh — fetch, then
//! fast-forward whatever can be fast-forwarded. Never stashes, resets, rebases or merges:
//! anything that isn't a clean fast-forward is reported and left alone.
//!
//! Config (`repos` in config.json — per machine, read leniently):
//!
//! ```json
//! "repos": {
//!   "roots": ["~/Code", "~/Code/project/repos"],
//!   "every": "24h",
//!   "overrides": { "app": "30m", "~/Code/project/repos/api": "30m" },
//!   "exclude": ["scratch"]
//! }
//! ```
//!
//! A repo is any directory directly under a root that has a `.git` (dir or file). Override
//! and exclude keys match the directory name or the `~/…` path. `every` (and each override)
//! is how often a repo is synced by `overmind repos sync --due` — what the launchd agent runs
//! every [`TICK_SECS`]. A daily (or longer) interval is also due on the first tick of a new
//! local day, so "once a day" means "once each day", not "24h after yesterday's sync".
//!
//! State (`$OVERMIND_REPOS_STATE`, else `${XDG_STATE_HOME:-~/.local/state}/overmind/repos.json`):
//! the last attempt and outcome per repo path.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::tools;
use crate::error::{Error, Result};

pub const DEFAULT_ROOT: &str = "~/Code";
pub const DEFAULT_EVERY: &str = "24h";
/// How often the launchd agent wakes up to run `sync --due`.
pub const TICK_SECS: u64 = 600;
/// A repo is due this much before its interval is up, so tick jitter can't push a 30m
/// interval to 40m.
const SLACK_SECS: i64 = 120;
/// Generous: a checkout that is weeks behind pulls a big pack, and a killed fetch keeps nothing.
const FETCH_TIMEOUT: Duration = Duration::from_secs(600);
const PARALLEL: usize = 8;
/// Consecutive failed fetches before a notification (one failure is usually just offline).
pub const NOTIFY_AFTER_FAILS: u32 = 3;

/// The `repos` config section, parsed.
#[derive(Debug, Clone)]
pub struct Settings {
    pub roots: Vec<String>,
    pub every: i64,
    /// (key, seconds) — key is a directory name or a `~/…` path.
    pub overrides: Vec<(String, i64)>,
    pub exclude: Vec<String>,
    /// What was wrong with the section; the bad parts fall back to defaults.
    pub problems: Vec<String>,
}

impl Settings {
    pub fn from_value(v: &Value) -> Settings {
        let mut problems = Vec::new();
        let strings = |key: &str, problems: &mut Vec<String>| -> Vec<String> {
            match v.get(key) {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| {
                        let s = x.as_str().map(str::trim).filter(|s| !s.is_empty());
                        if s.is_none() {
                            problems.push(format!("repos.{key}: {x} is not a string"));
                        }
                        s.map(String::from)
                    })
                    .collect(),
                Some(other) => {
                    problems.push(format!("repos.{key} must be a list, not {other}"));
                    Vec::new()
                }
            }
        };
        let mut roots = strings("roots", &mut problems);
        if roots.is_empty() {
            roots.push(DEFAULT_ROOT.into());
        }
        let exclude = strings("exclude", &mut problems);
        let mut span = |key: String, raw: &Value| -> Option<i64> {
            let parsed = raw
                .as_str()
                .ok_or_else(|| format!("{raw} is not a duration string"))
                .and_then(crate::core::tmux::parse_span)
                .and_then(|s| {
                    if s >= 60 {
                        Ok(s)
                    } else {
                        Err("intervals under 1m are not supported".into())
                    }
                });
            parsed
                .map_err(|e| problems.push(format!("{key}: {e}")))
                .ok()
        };
        let default_every = crate::core::tmux::parse_span(DEFAULT_EVERY).unwrap_or(86_400);
        let every = v
            .get("every")
            .filter(|x| !x.is_null())
            .and_then(|x| span("repos.every".into(), x))
            .unwrap_or(default_every);
        let overrides = match v.get("overrides") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Object(m)) => m
                .iter()
                .filter_map(|(k, x)| {
                    span(format!("repos.overrides.{k}"), x).map(|s| (k.clone(), s))
                })
                .collect(),
            Some(other) => {
                problems.push(format!("repos.overrides must be an object, not {other}"));
                Vec::new()
            }
        };
        Settings {
            roots,
            every,
            overrides,
            exclude,
            problems,
        }
    }

    pub fn load() -> Settings {
        Settings::from_value(&crate::core::config::load().raw["repos"])
    }

    /// The sync interval for a repo: the first matching override, else `every`.
    pub fn every_for(&self, name: &str, path: &Path) -> i64 {
        self.overrides
            .iter()
            .find(|(k, _)| matches(k, name, path))
            .map(|(_, s)| *s)
            .unwrap_or(self.every)
    }

    pub fn excluded(&self, name: &str, path: &Path) -> bool {
        self.exclude.iter().any(|k| matches(k, name, path))
    }
}

/// Does a config key name this repo? A bare name matches the directory name; anything with
/// a `/` is a path (`~` allowed).
pub fn matches(key: &str, name: &str, path: &Path) -> bool {
    if key.contains('/') {
        Path::new(&tools::expand_tilde(key.trim_end_matches('/'))) == path
    } else {
        key == name
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Repo {
    /// The directory name.
    pub name: String,
    pub path: PathBuf,
    /// Sync interval in seconds.
    pub every: i64,
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// Every repo directly under the configured roots, in root order then by name. A repo
/// reachable from two roots (or via a symlink) is listed once. Excluded repos are left out.
pub fn discover(s: &Settings) -> Vec<Repo> {
    discover_all(s)
        .into_iter()
        .filter_map(|(r, excluded)| (!excluded).then_some(r))
        .collect()
}

/// [`discover`], keeping the excluded repos (flagged `true`).
pub fn discover_all(s: &Settings) -> Vec<(Repo, bool)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in &s.roots {
        let root = PathBuf::from(tools::expand_tilde(root));
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.path())
            .filter(|p| p.is_dir() && is_repo(p))
            .collect();
        dirs.sort();
        for path in dirs {
            let canon = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen.insert(canon) {
                continue;
            }
            let name = path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            let excluded = s.excluded(&name, &path);
            let every = s.every_for(&name, &path);
            out.push((Repo { name, path, every }, excluded));
        }
    }
    out
}

// ---------- git ----------

pub(crate) fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new("git");
    c.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    // An ssh remote must fail, not wait for a passphrase or a host-key prompt nobody sees.
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        c.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=15",
        );
    }
    c
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let o = git_cmd(dir, args).output().ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// The last meaningful stderr line, for a one-line reason.
fn reason(o: &Output) -> String {
    let err = String::from_utf8_lossy(&o.stderr);
    let lines: Vec<&str> = err
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    lines
        .iter()
        .find(|l| l.starts_with("error:") || l.starts_with("fatal:"))
        .or(lines.first())
        .map(|l| l.to_string())
        .unwrap_or_else(|| format!("git exited with {}", o.status))
}

pub(crate) fn output_with_timeout(mut c: Command, timeout: Duration) -> std::io::Result<Output> {
    let child = c.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(_) => {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("timed out after {}s", timeout.as_secs()),
            ))
        }
    }
}

/// An operation in progress (rebase, merge, …) — a repo in that state is never touched.
fn busy(dir: &Path) -> Option<&'static str> {
    let gd = PathBuf::from(git(dir, &["rev-parse", "--absolute-git-dir"])?);
    [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .iter()
    .find(|(f, _)| gd.join(f).exists())
    .map(|(_, what)| *what)
}

/// Local facts about a repo, as of its last fetch. No network.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspect {
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// Changed + untracked paths.
    pub dirty: usize,
    pub busy: Option<String>,
}

pub fn inspect(dir: &Path) -> Inspect {
    let branch = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let upstream = git(
        dir,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    let (ahead, behind) = if upstream.is_some() {
        counts(dir, "HEAD", "@{u}")
    } else {
        (0, 0)
    };
    let dirty = git(dir, &["status", "--porcelain"])
        .map(|s| s.lines().count())
        .unwrap_or(0);
    Inspect {
        branch,
        upstream,
        ahead,
        behind,
        dirty,
        busy: busy(dir).map(String::from),
    }
}

/// (commits only in `a`, commits only in `b`).
fn counts(dir: &Path, a: &str, b: &str) -> (usize, usize) {
    git(
        dir,
        &["rev-list", "--left-right", "--count", &format!("{a}...{b}")],
    )
    .and_then(|s| {
        let mut it = s.split_whitespace().map(|n| n.parse::<usize>().ok());
        Some((it.next()??, it.next()??))
    })
    .unwrap_or((0, 0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Fast-forwarded the checked-out branch.
    Updated,
    /// Nothing new upstream.
    Current,
    /// Local commits not pushed yet; nothing new upstream.
    Ahead,
    /// Local and upstream both moved: needs a human.
    Diverged,
    /// A fast-forward was possible but git refused (local changes in the way).
    Blocked,
    /// A rebase/merge/… is in progress; fetched only.
    Busy,
    /// Detached HEAD or a branch without an upstream; fetched only.
    NoUpstream,
    NoRemote,
    FetchFailed,
}

impl Outcome {
    /// Something only a human can resolve.
    pub fn needs_attention(self) -> bool {
        matches!(self, Outcome::Diverged | Outcome::Blocked)
    }
    pub fn label(self) -> &'static str {
        match self {
            Outcome::Updated => "updated",
            Outcome::Current => "current",
            Outcome::Ahead => "ahead",
            Outcome::Diverged => "diverged",
            Outcome::Blocked => "blocked",
            Outcome::Busy => "busy",
            Outcome::NoUpstream => "no upstream",
            Outcome::NoRemote => "no remote",
            Outcome::FetchFailed => "fetch failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub outcome: Outcome,
    /// Commits fast-forwarded into the checked-out branch.
    pub pulled: usize,
    /// The remote's default branch, fast-forwarded while not checked out: (branch, commits).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<DefaultBranch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DefaultBranch {
    pub branch: String,
    pub pulled: usize,
}

/// Fetch one repo and fast-forward what can be.
pub fn sync_one(repo: &Repo) -> SyncResult {
    let mut r = SyncResult {
        name: repo.name.clone(),
        path: tools::tildify(&repo.path.display().to_string()),
        branch: None,
        outcome: Outcome::Current,
        pulled: 0,
        default_branch: None,
        detail: None,
    };
    let dir = repo.path.as_path();
    if git(dir, &["remote"]).is_none_or(|s| s.is_empty()) {
        r.outcome = Outcome::NoRemote;
        return r;
    }
    match output_with_timeout(
        git_cmd(dir, &["fetch", "--all", "--prune", "--quiet"]),
        FETCH_TIMEOUT,
    ) {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            r.outcome = Outcome::FetchFailed;
            r.detail = Some(reason(&o));
            return r;
        }
        Err(e) => {
            r.outcome = Outcome::FetchFailed;
            r.detail = Some(e.to_string());
            return r;
        }
    }
    let info = inspect(dir);
    r.branch = info.branch.clone();
    if let Some(what) = &info.busy {
        r.outcome = Outcome::Busy;
        r.detail = Some(format!("{what} in progress"));
        return r;
    }
    r.outcome = match (&info.upstream, info.ahead, info.behind) {
        (None, _, _) => Outcome::NoUpstream,
        (Some(_), 0, 0) => Outcome::Current,
        (Some(_), _, 0) => Outcome::Ahead,
        (Some(_), a, b) if a > 0 => {
            r.detail = Some(format!("{a} local, {b} upstream"));
            Outcome::Diverged
        }
        (Some(_), _, b) => {
            match git_cmd(dir, &["merge", "--ff-only", "--quiet", "@{u}"]).output() {
                Ok(o) if o.status.success() => {
                    r.pulled = b;
                    Outcome::Updated
                }
                Ok(o) => {
                    r.detail = Some(reason(&o));
                    Outcome::Blocked
                }
                Err(e) => {
                    r.detail = Some(e.to_string());
                    Outcome::Blocked
                }
            }
        }
    };
    r.default_branch = advance_default_branch(dir, info.branch.as_deref());
    r
}

/// Fast-forward the local copy of the remote's default branch (`origin/HEAD`) when it isn't
/// checked out anywhere — keeps `main`/`develop` fresh for new worktrees while you sit on a
/// feature branch.
fn advance_default_branch(dir: &Path, current: Option<&str>) -> Option<DefaultBranch> {
    let remote_ref = git(
        dir,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )?;
    let branch = remote_ref.strip_prefix("origin/")?.to_string();
    if current == Some(branch.as_str()) {
        return None;
    }
    let local_ref = format!("refs/heads/{branch}");
    let old = git(dir, &["rev-parse", "--verify", "--quiet", &local_ref])?;
    let new = git(dir, &["rev-parse", "--verify", "--quiet", &remote_ref])?;
    if old == new {
        return None;
    }
    let checked_out = git(dir, &["worktree", "list", "--porcelain"])
        .is_some_and(|s| s.lines().any(|l| l == format!("branch {local_ref}")));
    if checked_out {
        return None;
    }
    git(dir, &["merge-base", "--is-ancestor", &old, &new])?;
    let (_, pulled) = counts(dir, &old, &new);
    git(
        dir,
        &[
            "update-ref",
            "-m",
            "overmind repos: fast-forward",
            &local_ref,
            &new,
            &old,
        ],
    )?;
    Some(DefaultBranch { branch, pulled })
}

/// Sync `repos` in parallel; results in input order.
pub fn sync_all(repos: &[Repo]) -> Vec<SyncResult> {
    let next = AtomicUsize::new(0);
    let slots: Mutex<Vec<Option<SyncResult>>> = Mutex::new(vec![None; repos.len()]);
    std::thread::scope(|s| {
        for _ in 0..PARALLEL.min(repos.len()) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(repo) = repos.get(i) else { break };
                    let r = sync_one(repo);
                    slots.lock().unwrap()[i] = Some(r);
                }
            });
        }
    });
    slots.into_inner().unwrap().into_iter().flatten().collect()
}

// ---------- state ----------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoState {
    /// ms epoch of the last sync attempt.
    pub last_attempt: Option<i64>,
    /// ms epoch of the last successful fetch.
    pub last_fetch: Option<i64>,
    pub outcome: Option<Outcome>,
    pub detail: Option<String>,
    /// Consecutive failed fetches.
    pub fails: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub version: u32,
    /// Keyed by the repo's absolute path.
    pub repos: BTreeMap<String, RepoState>,
}

pub fn state_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OVERMIND_REPOS_STATE").filter(|p| !p.is_empty()) {
        return PathBuf::from(tools::expand_tilde(&p.to_string_lossy()));
    }
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"));
    base.join("overmind").join("repos.json")
}

pub fn load_state(path: &Path) -> State {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_state(path: &Path, st: &State) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(st)? + "\n")?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Fold one run's results into the state. Returns the results worth a notification: newly
/// needing attention, or a fetch that has now failed [`NOTIFY_AFTER_FAILS`] times running.
pub fn record(st: &mut State, results: &[SyncResult], now_ms: i64) -> Vec<SyncResult> {
    st.version = 1;
    let mut alerts = Vec::new();
    for r in results {
        let key = tools::expand_tilde(&r.path);
        let e = st.repos.entry(key).or_default();
        let before = e.outcome;
        e.last_attempt = Some(now_ms);
        if r.outcome == Outcome::FetchFailed {
            e.fails += 1;
            if e.fails == NOTIFY_AFTER_FAILS {
                alerts.push(r.clone());
            }
        } else {
            e.fails = 0;
            e.last_fetch = Some(now_ms);
            if r.outcome.needs_attention() && before != Some(r.outcome) {
                alerts.push(r.clone());
            }
        }
        e.outcome = Some(r.outcome);
        e.detail = r.detail.clone();
    }
    alerts
}

/// Is a repo with interval `every` due, given when it was last fetched?
pub fn is_due<Tz: TimeZone>(
    every: i64,
    last_fetch: Option<i64>,
    now: &chrono::DateTime<Tz>,
) -> bool {
    let Some(last) = last_fetch else {
        return true;
    };
    let now_ms = now.timestamp_millis();
    if (now_ms - last) / 1000 >= every - SLACK_SECS {
        return true;
    }
    // Daily or longer: also due once the local date has changed.
    every >= 86_400
        && Local
            .timestamp_millis_opt(last)
            .single()
            .is_some_and(|l| l.date_naive() < now.with_timezone(&Local).date_naive())
}

/// [`is_due`] for a repo's recorded state, with failing fetches backing off: retried after
/// 1, 2, 4, … ticks (never later than `every`), so a dead remote doesn't run every tick.
pub fn is_due_state<Tz: TimeZone>(
    every: i64,
    e: Option<&RepoState>,
    now: &chrono::DateTime<Tz>,
) -> bool {
    let Some(e) = e else {
        return true;
    };
    if e.fails > 0
        && let Some(attempt) = e.last_attempt
    {
        let backoff = (TICK_SECS as i64) << (e.fails - 1).min(8);
        return (now.timestamp_millis() - attempt) / 1000 >= backoff.min(every) - SLACK_SECS;
    }
    is_due(every, e.last_fetch, now)
}

/// An exclusive lock for one sync run; `None` when another run holds it.
pub fn lock() -> Result<Option<std::fs::File>> {
    let p = state_path().with_extension("lock");
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&p)?;
    match f.try_lock() {
        Ok(()) => Ok(Some(f)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(Error::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_defaults_and_overrides() {
        let s = Settings::from_value(&Value::Null);
        assert_eq!(s.roots, vec![DEFAULT_ROOT.to_string()]);
        assert_eq!(s.every, 86_400);
        assert!(s.problems.is_empty());

        let s = Settings::from_value(&json!({
            "roots": ["~/a", "~/b"],
            "every": "12h",
            "overrides": { "app": "30m", "~/b/api": "1h", "bad": "soon", "tiny": "0m" },
            "exclude": ["junk"]
        }));
        assert_eq!(s.every, 12 * 3600);
        assert_eq!(s.overrides.len(), 2);
        assert_eq!(s.problems.len(), 2, "{:?}", s.problems);
        let home = dirs::home_dir().unwrap();
        assert_eq!(s.every_for("app", &home.join("a/app")), 1800);
        assert_eq!(s.every_for("api", &home.join("b/api")), 3600);
        assert_eq!(s.every_for("api", &home.join("a/api")), 12 * 3600);
        assert!(s.excluded("junk", &home.join("a/junk")));
        assert!(!s.excluded("app", &home.join("a/app")));
    }

    #[test]
    fn bad_section_falls_back() {
        let s = Settings::from_value(&json!({ "roots": "~/x", "every": 5, "overrides": [] }));
        assert_eq!(s.roots, vec![DEFAULT_ROOT.to_string()]);
        assert_eq!(s.every, 86_400);
        assert_eq!(s.problems.len(), 3, "{:?}", s.problems);
    }

    #[test]
    fn due() {
        let now = Local::now();
        let ms = now.timestamp_millis();
        assert!(is_due(1800, None, &now));
        assert!(!is_due(1800, Some(ms - 10 * 60_000), &now));
        assert!(is_due(1800, Some(ms - 29 * 60_000), &now), "slack");
        assert!(is_due(86_400, Some(ms - 25 * 3_600_000), &now));
        // Yesterday's sync is due today, even if less than 24h ago.
        let yesterday = (now - chrono::Duration::days(1))
            .date_naive()
            .and_hms_opt(23, 59, 0)
            .unwrap()
            .and_local_timezone(Local)
            .single()
            .unwrap();
        assert!(is_due(86_400, Some(yesterday.timestamp_millis()), &now));
        // Earlier today, inside the interval: not due.
        let today = now.date_naive().and_hms_opt(0, 0, 1).unwrap();
        let today = today.and_local_timezone(Local).single().unwrap();
        if (ms - today.timestamp_millis()) / 1000 < 86_400 - SLACK_SECS {
            assert!(!is_due(86_400, Some(today.timestamp_millis()), &now));
        }
    }

    #[test]
    fn failing_fetches_back_off() {
        let now = Local::now();
        let ms = now.timestamp_millis();
        let tick = TICK_SECS as i64 * 1000;
        let st = |fails, ago_ms| RepoState {
            last_attempt: Some(ms - ago_ms),
            last_fetch: None,
            fails,
            ..Default::default()
        };
        assert!(is_due_state(86_400, Some(&st(1, tick)), &now));
        assert!(!is_due_state(86_400, Some(&st(3, tick)), &now));
        assert!(is_due_state(86_400, Some(&st(3, 4 * tick)), &now));
        // Never later than the interval itself.
        assert!(is_due_state(1800, Some(&st(8, 30 * 60_000)), &now));
        assert!(is_due_state(1800, None, &now));
    }

    fn result(path: &str, outcome: Outcome) -> SyncResult {
        SyncResult {
            name: "x".into(),
            path: path.into(),
            branch: Some("main".into()),
            outcome,
            pulled: 0,
            default_branch: None,
            detail: None,
        }
    }

    #[test]
    fn record_alerts_on_transitions_only() {
        let mut st = State::default();
        let a = record(&mut st, &[result("/r", Outcome::Diverged)], 1);
        assert_eq!(a.len(), 1);
        let a = record(&mut st, &[result("/r", Outcome::Diverged)], 2);
        assert!(a.is_empty(), "same problem again: no alert");
        for i in 1..NOTIFY_AFTER_FAILS {
            assert!(
                record(&mut st, &[result("/r", Outcome::FetchFailed)], 2 + i as i64).is_empty()
            );
        }
        let a = record(&mut st, &[result("/r", Outcome::FetchFailed)], 10);
        assert_eq!(a.len(), 1, "third failure in a row alerts");
        let e = &st.repos["/r"];
        assert_eq!(
            e.last_fetch,
            Some(2),
            "failed fetches keep the last good one"
        );
        record(&mut st, &[result("/r", Outcome::Current)], 11);
        assert_eq!(st.repos["/r"].fails, 0);
    }

    fn sh(dir: &Path, cmd: &str) {
        let st = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            st.status.success(),
            "{cmd}: {}",
            String::from_utf8_lossy(&st.stderr)
        );
    }

    /// origin (bare) with `main` + `develop`, a clone on `feature` tracking origin/feature.
    fn fixture() -> (tempfile::TempDir, Repo) {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        sh(
            d,
            "git init -q -b main seed && cd seed && git commit -q --allow-empty -m one \
               && git branch develop && git branch feature \
               && git clone -q --bare . ../origin.git \
               && git -C ../origin.git symbolic-ref HEAD refs/heads/develop",
        );
        sh(
            d,
            "git clone -q origin.git clone && cd clone && git checkout -q -b feature origin/feature \
               && git branch -q main origin/main",
        );
        let repo = Repo {
            name: "clone".into(),
            path: d.join("clone"),
            every: 60,
        };
        (t, repo)
    }

    #[test]
    fn fast_forwards_branch_and_default_branch() {
        let (t, repo) = fixture();
        let d = t.path();
        sh(
            d,
            "cd seed && git checkout -q feature && git commit -q --allow-empty -m f1 \
               && git checkout -q develop && git commit -q --allow-empty -m d1 && git commit -q --allow-empty -m d2 \
               && git push -q ../origin.git feature develop",
        );
        let r = sync_one(&repo);
        assert_eq!(r.outcome, Outcome::Updated, "{r:?}");
        assert_eq!(r.pulled, 1);
        let db = r.default_branch.expect("develop advanced");
        assert_eq!((db.branch.as_str(), db.pulled), ("develop", 2));
        assert_eq!(sync_one(&repo).outcome, Outcome::Current);
    }

    #[test]
    fn diverged_and_busy_are_left_alone() {
        let (t, repo) = fixture();
        let d = t.path();
        sh(
            d,
            "cd seed && git checkout -q feature && git commit -q --allow-empty -m up \
               && git push -q ../origin.git feature",
        );
        sh(d, "cd clone && git commit -q --allow-empty -m local");
        let head = git(&repo.path, &["rev-parse", "HEAD"]);
        let r = sync_one(&repo);
        assert_eq!(r.outcome, Outcome::Diverged, "{r:?}");
        assert_eq!(git(&repo.path, &["rev-parse", "HEAD"]), head);

        sh(d, "cd clone && touch .git/MERGE_HEAD");
        assert_eq!(sync_one(&repo).outcome, Outcome::Busy);
    }

    #[test]
    fn blocked_by_local_changes() {
        let (t, repo) = fixture();
        let d = t.path();
        sh(
            d,
            "cd seed && git checkout -q feature && echo up > f && git add f && git commit -q -m up \
               && git push -q ../origin.git feature",
        );
        sh(d, "cd clone && echo mine > f");
        let r = sync_one(&repo);
        assert_eq!(r.outcome, Outcome::Blocked, "{r:?}");
        assert!(r.detail.is_some());
        assert_eq!(
            std::fs::read_to_string(repo.path.join("f")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn discover_dedupes_and_excludes() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        for p in [
            "a/one/.git",
            "a/two/.git",
            "a/plain",
            "a/.hidden/.git",
            "b/three/.git",
        ] {
            std::fs::create_dir_all(d.join(p)).unwrap();
        }
        let root = |p: &str| d.join(p).display().to_string();
        let s = Settings::from_value(&json!({
            "roots": [root("a"), root("b"), root("a")],
            "exclude": ["two"],
            "overrides": { "three": "30m" }
        }));
        let names: Vec<(String, i64)> = discover(&s)
            .into_iter()
            .map(|r| (r.name, r.every))
            .collect();
        assert_eq!(names, vec![("one".into(), 86_400), ("three".into(), 1800)]);
    }
}
