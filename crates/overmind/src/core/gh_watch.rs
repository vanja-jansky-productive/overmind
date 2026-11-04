//! GitHub triggers for bots (`bots.<name>.on.github`): a bot that starts a run when a branch
//! matching a pattern appears in a repository, instead of on a cron schedule.
//!
//! ```json
//! "bots": {
//!   "release-bot": {
//!     "on": { "github": { "repo": "owner/repo", "branch": "release/*", "every": "60s" } },
//!     "name": "release-bot {branch}",
//!     "dir": "~/Code/project",
//!     "promptFile": "~/notes/release-bot.md",
//!     "ghIdentity": "bot"
//!   }
//! }
//! ```
//!
//! The machines are not reachable from the internet, so there are no webhooks: `overmind bots
//! tick` (launchd, every minute) polls each GitHub bot every `every` (default and minimum 60 s)
//! with one `gh api repos/<repo>/git/matching-refs/heads/<prefix>` call, sent with the ETag of
//! the last answer — a `304 Not Modified` costs no rate limit. It runs as the bot's
//! `ghIdentity` (its `command`) when it has one, else as the machine's own `gh`.
//!
//! It works on state, not on events: each poll is the set of matching branches now, compared
//! with the set the bot remembers (`github` in its state file). A branch new to it starts one
//! run; a remembered branch never starts another (a restart, a reboot or a missed poll cannot
//! double-spawn); a branch that is gone is dropped from the set and its run is marked
//! `branchGone` (its session stays). The first poll only remembers what is already there
//! (`backfill: true` runs those too), the way a cron bot never fires on the tick that first
//! sees it.

use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::tools;

/// Polls are at most this frequent (the tick runs every minute).
pub const MIN_EVERY: i64 = 60;
/// A rate-limited or failing poll waits at least this long before the next one.
const ERROR_BACKOFF: i64 = 5 * 60;
/// Stop polling while the remaining rate limit is below this, until it resets.
const LOW_RATE: i64 = 50;
const GH_TIMEOUT: Duration = Duration::from_secs(30);

/// `on.github` of a bot.
#[derive(Debug, Clone, PartialEq)]
pub struct GithubOn {
    /// `owner/repo`.
    pub repo: String,
    /// Branch pattern: `*` matches within one path segment, `**` across them.
    pub branch: String,
    /// Seconds between polls.
    pub every: i64,
    /// Start runs for the branches already there on the first poll.
    pub backfill: bool,
}

impl GithubOn {
    pub fn parse(v: &Value) -> std::result::Result<GithubOn, String> {
        let o = v.as_object().ok_or("on.github must be an object")?;
        for k in o.keys() {
            if !["repo", "branch", "every", "backfill"].contains(&k.as_str()) {
                return Err(format!(
                    "on.github.{k}: unknown key (repo, branch, every, backfill)"
                ));
            }
        }
        let text = |k: &str| -> std::result::Result<Option<String>, String> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
                Some(other) => Err(format!("on.github.{k} must be a string, not {other}")),
            }
        };
        let repo = text("repo")?.ok_or("on.github.repo is required (owner/repo)")?;
        if !valid_repo(&repo) {
            return Err(format!("on.github.repo `{repo}` is not owner/repo"));
        }
        let branch = text("branch")?.ok_or("on.github.branch is required (e.g. release/*)")?;
        let branch = branch.trim_start_matches("refs/heads/").to_string();
        if branch.is_empty() || branch.starts_with('/') || branch.contains(char::is_whitespace) {
            return Err(format!(
                "on.github.branch `{branch}` is not a branch pattern"
            ));
        }
        let every = match o.get("every") {
            None | Some(Value::Null) => MIN_EVERY,
            Some(Value::Number(n)) => n.as_i64().ok_or("on.github.every: whole seconds")?,
            Some(Value::String(s)) => match s.trim().strip_suffix('s') {
                Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => n
                    .parse()
                    .map_err(|_| format!("on.github.every: bad duration '{s}'"))?,
                _ => crate::core::tmux::parse_span(s)
                    .map_err(|e| format!("on.github.every: {e} (or 90s)"))?,
            },
            Some(other) => return Err(format!("on.github.every: a duration, not {other}")),
        };
        let backfill = match o.get("backfill") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(other) => {
                return Err(format!(
                    "on.github.backfill must be true or false, not {other}"
                ));
            }
        };
        Ok(GithubOn {
            repo,
            branch,
            every: every.max(MIN_EVERY),
            backfill,
        })
    }

    /// "New branch release/* in owner/repo".
    pub fn describe(&self) -> String {
        format!("New branch {} in {}", self.branch, self.repo)
    }

    /// The `matching-refs` path: every ref under the pattern's literal directory.
    pub fn api_path(&self) -> String {
        format!(
            "repos/{}/git/matching-refs/heads/{}",
            self.repo,
            ref_prefix(&self.branch)
        )
    }
}

fn valid_repo(r: &str) -> bool {
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    matches!(r.split_once('/'), Some((o, n)) if ok(o) && ok(n))
}

/// The pattern's literal leading directories (`release/` of `release/*`; `` of `*-rc`).
pub fn ref_prefix(pattern: &str) -> String {
    let lit = pattern
        .find(['*', '?', '['])
        .map_or(pattern, |i| &pattern[..i]);
    match lit.rfind('/') {
        Some(i) => lit[..=i].to_string(),
        // No glob at all: the branch itself (matching-refs matches by prefix).
        None if lit.len() == pattern.len() => lit.to_string(),
        None => String::new(),
    }
}

/// Glob match for branch names: `*` = any run of characters except `/`, `**` = any run,
/// `?` = one character except `/`.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => (0..=n.len()).any(|i| go(&p[2..], &n[i..])),
            Some('*') => {
                for i in 0..=n.len() {
                    if go(&p[1..], &n[i..]) {
                        return true;
                    }
                    if n.get(i) == Some(&'/') {
                        break;
                    }
                }
                false
            }
            Some('?') => matches!(n.first(), Some(c) if *c != '/') && go(&p[1..], &n[1..]),
            Some(c) => n.first() == Some(c) && go(&p[1..], &n[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    go(&p, &n)
}

// --- polling -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Branch {
    pub name: String,
    pub sha: String,
}

/// One HTTP answer from `gh api -i`.
#[derive(Debug, Default, PartialEq)]
pub struct Http {
    pub status: u16,
    /// Lower-cased names.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Http {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    fn header_i64(&self, name: &str) -> Option<i64> {
        self.header(name).and_then(|v| v.trim().parse().ok())
    }
}

/// Parse `gh api -i` output: a status line, headers, a blank line, the body.
pub fn parse_http(raw: &str) -> Option<Http> {
    let raw = raw.trim_start();
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
        .unwrap_or((raw, ""));
    let mut lines = head.lines();
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some(Http {
        status,
        headers,
        body: body.to_string(),
    })
}

/// What a poll found.
#[derive(Debug, PartialEq)]
pub enum Fetched {
    /// 304: same as last time.
    NotModified,
    /// The matching branches now, and the answer's ETag.
    Branches(Vec<Branch>, Option<String>),
}

/// Rate-limit headers of an answer.
#[derive(Debug, Default, PartialEq)]
pub struct Limits {
    pub remaining: Option<i64>,
    /// Epoch seconds.
    pub reset: Option<i64>,
    pub retry_after: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub struct PollError {
    pub message: String,
    /// `auth` | `rate-limit` | `not-found` | `gh` | `other`.
    pub kind: &'static str,
}

/// Turn one answer into branches (pure — what [`fetch`] does after running gh).
pub fn interpret(on: &GithubOn, http: &Http) -> (std::result::Result<Fetched, PollError>, Limits) {
    let limits = Limits {
        remaining: http.header_i64("x-ratelimit-remaining"),
        reset: http.header_i64("x-ratelimit-reset"),
        retry_after: http.header_i64("retry-after"),
    };
    let err = |kind, message: String| Err(PollError { message, kind });
    let gh_message = || {
        serde_json::from_str::<Value>(&http.body)
            .ok()
            .and_then(|v| v["message"].as_str().map(String::from))
            .unwrap_or_else(|| http.body.trim().chars().take(200).collect())
    };
    let res = match http.status {
        304 => Ok(Fetched::NotModified),
        200 => match serde_json::from_str::<Value>(&http.body) {
            Ok(Value::Array(refs)) => {
                let mut out: Vec<Branch> = refs
                    .iter()
                    .filter_map(|r| {
                        let name = r["ref"].as_str()?.strip_prefix("refs/heads/")?;
                        let sha = r["object"]["sha"].as_str().unwrap_or_default();
                        glob_match(&on.branch, name).then(|| Branch {
                            name: name.to_string(),
                            sha: sha.to_string(),
                        })
                    })
                    .collect();
                out.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(Fetched::Branches(
                    out,
                    http.header("etag").map(String::from),
                ))
            }
            // A pattern without a glob, for a branch that is not there, answers a single
            // object in some API versions; treat anything else as no matches.
            Ok(Value::Object(_)) => Ok(Fetched::Branches(
                Vec::new(),
                http.header("etag").map(String::from),
            )),
            _ => err(
                "other",
                format!("GitHub answered 200 without a list: {}", gh_message()),
            ),
        },
        401 => err("auth", format!("not authenticated (401): {}", gh_message())),
        403 | 429
            if limits.remaining == Some(0)
                || limits.retry_after.is_some()
                || http.status == 429 =>
        {
            err(
                "rate-limit",
                format!("rate limited ({}): {}", http.status, gh_message()),
            )
        }
        403 => err("auth", format!("forbidden (403): {}", gh_message())),
        404 => err(
            "not-found",
            format!(
                "{} not found (404) — no such repo, or this identity cannot see it",
                on.repo
            ),
        ),
        s => err("other", format!("GitHub answered {s}: {}", gh_message())),
    };
    (res, limits)
}

/// The gh to poll with: the identity's `command` when the bot has one, else the machine's gh.
pub fn gh_for(identity: Option<&str>) -> std::result::Result<String, String> {
    match identity {
        None => Ok(crate::core::prs::gh_bin()),
        Some(name) => {
            let id = crate::core::gh_identity::get(name).map_err(|e| e.to_string())?;
            let first = id.command.split_whitespace().next().unwrap_or_default();
            if first.contains('/') {
                return Ok(tools::expand_tilde(first));
            }
            Ok(tools::resolve_binary(first, None))
        }
    }
}

/// Poll once: `gh api -i <matching-refs>` with `If-None-Match: <etag>`.
pub fn fetch(
    gh: &str,
    on: &GithubOn,
    etag: Option<&str>,
) -> (std::result::Result<Fetched, PollError>, Limits) {
    if let Some(rows) = fixture(on) {
        return rows;
    }
    let mut c = Command::new(gh);
    c.args(["api", "-i", "-H", "Accept: application/vnd.github+json"])
        .env("PATH", tools::search_path())
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null());
    if let Some(e) = etag {
        c.arg("-H").arg(format!("If-None-Match: {e}"));
    }
    c.arg(on.api_path());
    let out = match crate::core::repos::output_with_timeout(c, GH_TIMEOUT) {
        Ok(o) => o,
        Err(e) => {
            return (
                Err(PollError {
                    kind: "gh",
                    message: format!("cannot run {gh}: {e}"),
                }),
                Limits::default(),
            );
        }
    };
    // gh exits 1 on a 304 and on errors, but still prints the answer with -i.
    let stdout = String::from_utf8_lossy(&out.stdout);
    match parse_http(&stdout) {
        Some(h) => interpret(on, &h),
        None => {
            let err = String::from_utf8_lossy(&out.stderr);
            let line = err
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("no output");
            let kind = if line.contains("auth login") || line.contains("authentication") {
                "auth"
            } else {
                "gh"
            };
            (
                Err(PollError {
                    kind,
                    message: format!("{gh} api failed: {line}"),
                }),
                Limits::default(),
            )
        }
    }
}

/// `OVERMIND_GH_WATCH_FIXTURE`: a JSON file `{ "<owner/repo>": [ { "name", "sha" } ] }` (or
/// `{ "<owner/repo>": { "error": "auth", "message": "…" } }`) used instead of GitHub — tests.
fn fixture(on: &GithubOn) -> Option<(std::result::Result<Fetched, PollError>, Limits)> {
    let path = std::env::var_os("OVERMIND_GH_WATCH_FIXTURE").filter(|p| !p.is_empty())?;
    let v: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let entry = &v[&on.repo];
    if let Some(kind) = entry["error"].as_str() {
        let kind = match kind {
            "auth" => "auth",
            "rate-limit" => "rate-limit",
            "not-found" => "not-found",
            _ => "other",
        };
        let message = entry["message"].as_str().unwrap_or(kind).to_string();
        return Some((Err(PollError { kind, message }), Limits::default()));
    }
    let mut branches: Vec<Branch> = entry
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|b| {
                    let name = b["name"].as_str()?;
                    glob_match(&on.branch, name).then(|| Branch {
                        name: name.into(),
                        sha: b["sha"].as_str().unwrap_or_default().into(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    branches.sort_by(|a, b| a.name.cmp(&b.name));
    Some((Ok(Fetched::Branches(branches, None)), Limits::default()))
}

// --- state ---------------------------------------------------------------------

/// `github` in a bot's state file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchState {
    /// The `on.github` the state belongs to (`repo branch`): a changed trigger starts over.
    pub watch: String,
    /// The first poll has run (what was there then is remembered, not run).
    pub armed: bool,
    /// Milliseconds: the last poll attempted, the last one that succeeded.
    pub last_poll: Option<i64>,
    pub last_ok: Option<i64>,
    /// Polling waits until then (an error, a rate limit).
    pub next_poll: Option<i64>,
    pub etag: Option<String>,
    /// The last poll's error, cleared by a successful one.
    pub error: Option<WatchError>,
    /// Remaining core rate limit after the last answer.
    pub rate_remaining: Option<i64>,
    /// Branch name → what the bot did with it.
    pub branches: BTreeMap<String, Tracked>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchError {
    pub kind: String,
    pub message: String,
    pub at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Tracked {
    /// The branch head when the bot last saw it.
    pub sha: String,
    pub first_seen: i64,
    /// `spawned` | `existing` (there before the first poll) | `adopted` (a session for it was
    /// already open) | `failed`.
    pub outcome: String,
    /// The run it started.
    pub run: Option<String>,
    pub tmux_session: Option<String>,
    pub reason: Option<String>,
}

impl WatchState {
    pub fn key(on: &GithubOn) -> String {
        format!("{} {}", on.repo, on.branch)
    }
}

/// Whether a poll is due at `now_ms`.
pub fn poll_due(on: &GithubOn, st: &WatchState, now_ms: i64) -> bool {
    if st.watch != WatchState::key(on) {
        return true;
    }
    if let Some(n) = st.next_poll
        && now_ms < n
    {
        return false;
    }
    // A few seconds of slack: the tick is every 60 s, and `every` is a multiple of that.
    st.last_poll
        .is_none_or(|l| now_ms - l >= on.every * 1000 - 5_000)
}

/// What one successful poll changes.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// New branches to start a run for.
    pub start: Vec<Branch>,
    /// New branches to remember without a run (the first poll, no backfill).
    pub remember: Vec<Branch>,
    /// Remembered branches no longer there.
    pub gone: Vec<String>,
    /// Remembered branches with a new head: (name, sha).
    pub moved: Vec<(String, String)>,
}

/// Pure: compare the branches now with what the bot remembers.
pub fn plan(on: &GithubOn, st: &WatchState, now: &[Branch]) -> Plan {
    let first = !st.armed || st.watch != WatchState::key(on);
    let known = |n: &str| !first && st.branches.contains_key(n);
    let mut p = Plan::default();
    for b in now {
        if known(&b.name) {
            if st.branches[&b.name].sha != b.sha {
                p.moved.push((b.name.clone(), b.sha.clone()));
            }
        } else if first && !on.backfill {
            p.remember.push(b.clone());
        } else {
            p.start.push(b.clone());
        }
    }
    if !first {
        p.gone = st
            .branches
            .keys()
            .filter(|k| !now.iter().any(|b| &b.name == *k))
            .cloned()
            .collect();
    }
    p
}

/// After an error: when to try again (ms), from the rate-limit headers.
pub fn retry_at(err: &PollError, limits: &Limits, now_ms: i64) -> i64 {
    let backoff = now_ms + ERROR_BACKOFF * 1000;
    match err.kind {
        "rate-limit" => {
            let by_retry = limits.retry_after.map(|s| now_ms + s * 1000);
            let by_reset = limits.reset.map(|s| s * 1000);
            by_retry
                .or(by_reset)
                .unwrap_or(backoff)
                .max(now_ms + 60_000)
        }
        _ => backoff,
    }
}

/// After a successful answer: hold off until the reset when the limit is nearly used up.
pub fn throttle_until(limits: &Limits, now_ms: i64) -> Option<i64> {
    match (limits.remaining, limits.reset) {
        (Some(r), Some(reset)) if r < LOW_RATE && reset * 1000 > now_ms => Some(reset * 1000),
        _ => None,
    }
}

/// `{repo}`, `{branch}`, `{sha}`, `{url}`, `{bot}` in a prompt or a session name.
pub fn render(template: &str, bot: &str, repo: &str, b: &Branch) -> String {
    template
        .replace("{repo}", repo)
        .replace("{branch}", &b.name)
        .replace("{sha}", &b.sha)
        .replace(
            "{url}",
            &format!("https://github.com/{repo}/tree/{}", b.name),
        )
        .replace("{bot}", bot)
}

/// A branch as part of a run id: `release/42` → `release-42`.
pub fn slug(branch: &str) -> String {
    let mut out = String::new();
    for c in branch.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn on(branch: &str) -> GithubOn {
        GithubOn {
            repo: "owner/repo".into(),
            branch: branch.into(),
            every: 60,
            backfill: false,
        }
    }

    fn b(name: &str, sha: &str) -> Branch {
        Branch {
            name: name.into(),
            sha: sha.into(),
        }
    }

    #[test]
    fn globs() {
        assert!(glob_match("release/*", "release/42"));
        assert!(!glob_match("release/*", "release/42/hotfix"));
        assert!(glob_match("release/**", "release/42/hotfix"));
        assert!(!glob_match("release/*", "releases/42"));
        assert!(!glob_match("release/*", "main"));
        assert!(glob_match("release/v?", "release/v1"));
        assert!(!glob_match("release/v?", "release/v10"));
        assert!(glob_match("*-rc", "1.2-rc"));
        assert!(!glob_match("*-rc", "x/1.2-rc"));
        assert!(glob_match("main", "main"));
        assert!(!glob_match("main", "main2"));
        assert!(glob_match("release/*", "release/"));
    }

    #[test]
    fn prefixes() {
        assert_eq!(ref_prefix("release/*"), "release/");
        assert_eq!(ref_prefix("a/b/v*"), "a/b/");
        assert_eq!(ref_prefix("*-rc"), "");
        assert_eq!(ref_prefix("main"), "main");
        assert_eq!(
            on("release/*").api_path(),
            "repos/owner/repo/git/matching-refs/heads/release/"
        );
    }

    #[test]
    fn config_parses_and_rejects() {
        let g =
            GithubOn::parse(&json!({ "repo": "o/r", "branch": "refs/heads/release/*" })).unwrap();
        assert_eq!(g.branch, "release/*");
        assert_eq!(g.every, 60);
        assert!(!g.backfill);
        let g = GithubOn::parse(
            &json!({ "repo": "o/r", "branch": "x", "every": "5m", "backfill": true }),
        )
        .unwrap();
        assert_eq!(g.every, 300);
        assert!(g.backfill);
        assert_eq!(
            GithubOn::parse(&json!({ "repo": "o/r", "branch": "x", "every": 10 }))
                .unwrap()
                .every,
            60
        );
        for bad in [
            json!({ "branch": "x" }),
            json!({ "repo": "o", "branch": "x" }),
            json!({ "repo": "o/r" }),
            json!({ "repo": "o/r", "branch": "a b" }),
            json!({ "repo": "o/r", "branch": "x", "every": "soon" }),
            json!({ "repo": "o/r", "branch": "x", "pattern": "y" }),
            json!("o/r"),
        ] {
            assert!(GithubOn::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn http_answers_parse() {
        let raw = "HTTP/2.0 304 Not Modified\nEtag: \"abc\"\nX-Ratelimit-Remaining: 4991\n\n";
        let h = parse_http(raw).unwrap();
        assert_eq!(h.status, 304);
        assert_eq!(h.header("etag"), Some("\"abc\""));
        let (r, l) = interpret(&on("release/*"), &h);
        assert_eq!(r, Ok(Fetched::NotModified));
        assert_eq!(l.remaining, Some(4991));

        let body = json!([
            { "ref": "refs/heads/release/42", "object": { "sha": "a1" } },
            { "ref": "refs/heads/release/41", "object": { "sha": "b2" } },
            { "ref": "refs/heads/release/42/fix", "object": { "sha": "c3" } }
        ]);
        let raw = format!("HTTP/2.0 200 OK\r\nEtag: W/\"e1\"\r\n\r\n{body}");
        let (r, _) = interpret(&on("release/*"), &parse_http(&raw).unwrap());
        assert_eq!(
            r,
            Ok(Fetched::Branches(
                vec![b("release/41", "b2"), b("release/42", "a1")],
                Some("W/\"e1\"".into())
            ))
        );
    }

    #[test]
    fn errors_are_classified() {
        let kind = |raw: &str| {
            interpret(&on("x"), &parse_http(raw).unwrap())
                .0
                .unwrap_err()
                .kind
        };
        assert_eq!(
            kind("HTTP/2.0 401 Unauthorized\n\n{\"message\":\"Bad credentials\"}"),
            "auth"
        );
        assert_eq!(
            kind("HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 100\n\n{}"),
            "rate-limit"
        );
        assert_eq!(
            kind("HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 10\n\n{}"),
            "auth"
        );
        assert_eq!(
            kind("HTTP/2.0 429 Too Many\nRetry-After: 30\n\n{}"),
            "rate-limit"
        );
        assert_eq!(kind("HTTP/2.0 404 Not Found\n\n{}"), "not-found");
        assert_eq!(kind("HTTP/2.0 502 Bad Gateway\n\n"), "other");
    }

    #[test]
    fn backoff_follows_rate_limit_headers() {
        let e = PollError {
            kind: "rate-limit",
            message: String::new(),
        };
        let l = Limits {
            reset: Some(2_000),
            ..Default::default()
        };
        assert_eq!(retry_at(&e, &l, 1_000_000), 2_000_000);
        let l = Limits {
            retry_after: Some(120),
            reset: Some(9_999),
            ..Default::default()
        };
        assert_eq!(retry_at(&e, &l, 1_000_000), 1_120_000);
        let other = PollError {
            kind: "auth",
            message: String::new(),
        };
        assert_eq!(retry_at(&other, &Limits::default(), 0), 300_000);
        let low = Limits {
            remaining: Some(3),
            reset: Some(500),
            retry_after: None,
        };
        assert_eq!(throttle_until(&low, 1_000), Some(500_000));
        assert_eq!(throttle_until(&Limits::default(), 1_000), None);
    }

    #[test]
    fn first_poll_remembers_then_new_branches_start_once() {
        let o = on("release/*");
        let mut st = WatchState::default();
        let p = plan(&o, &st, &[b("release/41", "a")]);
        assert_eq!(p.remember, vec![b("release/41", "a")]);
        assert!(p.start.is_empty() && p.gone.is_empty());

        st.watch = WatchState::key(&o);
        st.armed = true;
        st.branches.insert(
            "release/41".into(),
            Tracked {
                sha: "a".into(),
                outcome: "existing".into(),
                ..Default::default()
            },
        );
        let p = plan(&o, &st, &[b("release/41", "a"), b("release/42", "b")]);
        assert_eq!(p.start, vec![b("release/42", "b")]);
        assert!(p.remember.is_empty() && p.gone.is_empty() && p.moved.is_empty());

        // Remembered: never again, however often it is seen (restart, reboot, re-poll).
        st.branches.insert(
            "release/42".into(),
            Tracked {
                sha: "b".into(),
                outcome: "spawned".into(),
                ..Default::default()
            },
        );
        let p = plan(&o, &st, &[b("release/41", "a"), b("release/42", "c")]);
        assert!(p.start.is_empty());
        assert_eq!(p.moved, vec![("release/42".to_string(), "c".to_string())]);

        let p = plan(&o, &st, &[b("release/42", "c")]);
        assert_eq!(p.gone, vec!["release/41".to_string()]);
    }

    #[test]
    fn backfill_and_changed_trigger() {
        let mut o = on("release/*");
        o.backfill = true;
        let p = plan(&o, &WatchState::default(), &[b("release/41", "a")]);
        assert_eq!(p.start, vec![b("release/41", "a")]);

        // State of another trigger: start over (remember, do not run).
        let st = WatchState {
            watch: "other/repo main".into(),
            armed: true,
            ..Default::default()
        };
        let p = plan(&on("release/*"), &st, &[b("release/41", "a")]);
        assert_eq!(p.remember.len(), 1);
    }

    #[test]
    fn polls_are_spaced() {
        let o = GithubOn {
            every: 300,
            ..on("x")
        };
        let mut st = WatchState {
            watch: WatchState::key(&o),
            ..Default::default()
        };
        assert!(poll_due(&o, &st, 0));
        st.last_poll = Some(1_000_000);
        assert!(!poll_due(&o, &st, 1_000_000 + 240_000));
        assert!(poll_due(&o, &st, 1_000_000 + 298_000));
        st.next_poll = Some(1_000_000 + 900_000);
        assert!(!poll_due(&o, &st, 1_000_000 + 600_000));
    }

    #[test]
    fn templates_and_slugs() {
        let br = b("release/42", "abc");
        assert_eq!(
            render("{bot}: {branch}@{sha} in {repo} {url}", "rb", "o/r", &br),
            "rb: release/42@abc in o/r https://github.com/o/r/tree/release/42"
        );
        assert_eq!(slug("release/42"), "release-42");
        assert_eq!(slug("feat/a.b//c"), "feat-a-b-c");
    }
}
