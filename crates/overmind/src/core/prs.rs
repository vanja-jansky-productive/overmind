//! `overmind prs`: the open GitHub pull requests that need you — yours, the ones waiting on your
//! review, and the ones you reviewed that wait on their author — sorted into columns, cached,
//! and joined with the local checkouts (`overmind repos`) and their worktrees.
//!
//! GitHub is reached only through the `gh` CLI (`gh api graphql`): its auth, its host, no token
//! handling here. Three searches, run in parallel:
//!
//! - `author:@me` → [`Column::DraftMine`], [`Column::ReadyToMergeMine`] (approved) or
//!   [`Column::ReviewMine`]
//! - `user-review-requested:@me` (asked of you by name, not via a team) → [`Column::WaitingOnMe`]
//! - `reviewed-by:@me -author:@me`, your latest review not an approval → [`Column::WaitingOnAuthor`]
//! - `mentions:@me` → [`Pr::mention`], the latest `@you` by someone else in the PR's description,
//!   comments or reviews. Until you answer it (comment or review after it) or mark it seen
//!   (`overmind pr seen`, kept in `$OVERMIND_PRS_SEEN`, else
//!   `${XDG_STATE_HOME:-~/.local/state}/overmind/prs-seen.json`), the PR shows in
//!   [`Column::UnseenMentions`] instead of its own column.
//!
//! Config (`prs` in config.json — per machine, read leniently):
//!
//! ```json
//! "prs": { "orgs": ["acme"], "repos": ["someone/tool"], "refresh": "5m", "worktrees": "~/Code/worktrees" }
//! ```
//!
//! `orgs` / `repos` scope the searches (any of them; none = all of GitHub). `refresh` is how old
//! the cache may get before a plain `overmind prs` fetches again. `worktrees` is where
//! [`checkout`] puts new worktrees (default [`DEFAULT_WORKTREES`]).
//!
//! Cache (`$OVERMIND_PRS_CACHE`, else `${XDG_CACHE_HOME:-~/.cache}/overmind/prs.json`): the last
//! successful fetch. A failed fetch keeps serving it, with the error alongside.
//!
//! Nothing in here prints.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::{repos, tools};
use crate::error::{Error, Result};

pub const DEFAULT_REFRESH: &str = "5m";
pub const DEFAULT_WORKTREES: &str = "~/Code/worktrees";
const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(180);
/// One search page; GitHub's gateway gives up on bigger ones (~10 s) with all the fields below.
const PAGE: usize = 50;
/// The mentions search fetches the PR's comments and reviews too: a smaller page.
const MENTIONS_PAGE: usize = 25;
/// How much of the line with the mention [`Mention::excerpt`] keeps.
const EXCERPT_CHARS: usize = 140;
const MAX_PAGES: usize = 4;
const GH_TIMEOUT: Duration = Duration::from_secs(60);

// ---------- config ----------

/// The `prs` config section, parsed.
#[derive(Debug, Clone)]
pub struct Settings {
    pub orgs: Vec<String>,
    /// `owner/name`.
    pub repos: Vec<String>,
    /// Max cache age in seconds.
    pub refresh: i64,
    /// Where `overmind pr checkout` puts new worktrees (`~` allowed).
    pub worktrees: String,
    /// What was wrong with the section; the bad parts fall back to defaults.
    pub problems: Vec<String>,
}

impl Settings {
    pub fn from_value(v: &Value) -> Settings {
        let mut problems = Vec::new();
        let mut strings = |key: &str| -> Vec<String> {
            match v.get(key) {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| {
                        let s = x
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty() && !s.contains(char::is_whitespace));
                        if s.is_none() {
                            problems.push(format!("prs.{key}: {x} is not a name"));
                        }
                        s.map(String::from)
                    })
                    .collect(),
                Some(other) => {
                    problems.push(format!("prs.{key} must be a list, not {other}"));
                    Vec::new()
                }
            }
        };
        let orgs = strings("orgs");
        let repos = strings("repos");
        let default_refresh = crate::core::tmux::parse_span(DEFAULT_REFRESH).unwrap_or(300);
        let refresh = match v.get("refresh").filter(|x| !x.is_null()) {
            None => default_refresh,
            Some(x) => match x.as_str().map(crate::core::tmux::parse_span) {
                Some(Ok(s)) if s >= 60 => s,
                _ => {
                    problems.push(format!("prs.refresh: {x} is not a duration of at least 1m"));
                    default_refresh
                }
            },
        };
        let worktrees = match v.get("worktrees").filter(|x| !x.is_null()) {
            None => DEFAULT_WORKTREES.to_string(),
            Some(x) => match x.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                Some(s) => s.to_string(),
                None => {
                    problems.push(format!("prs.worktrees: {x} is not a path"));
                    DEFAULT_WORKTREES.to_string()
                }
            },
        };
        Settings {
            orgs,
            repos,
            refresh,
            worktrees,
            problems,
        }
    }

    pub fn load() -> Settings {
        Settings::from_value(&crate::core::config::load().raw["prs"])
    }

    /// The search qualifiers every query shares: `org:a org:b repo:o/n` (GitHub ORs them).
    pub fn scope(&self) -> String {
        self.orgs
            .iter()
            .map(|o| format!("org:{o}"))
            .chain(self.repos.iter().map(|r| format!("repo:{r}")))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

// ---------- model ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Column {
    UnseenMentions,
    DraftMine,
    ReviewMine,
    ReadyToMergeMine,
    WaitingOnMe,
    WaitingOnAuthor,
}

impl Column {
    pub const ALL: [Column; 6] = [
        Column::UnseenMentions,
        Column::WaitingOnMe,
        Column::ReviewMine,
        Column::ReadyToMergeMine,
        Column::DraftMine,
        Column::WaitingOnAuthor,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Column::UnseenMentions => "unseenMentions",
            Column::DraftMine => "draftMine",
            Column::ReviewMine => "reviewMine",
            Column::ReadyToMergeMine => "readyToMergeMine",
            Column::WaitingOnMe => "waitingOnMe",
            Column::WaitingOnAuthor => "waitingOnAuthor",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Column::UnseenMentions => "Unseen mentions",
            Column::DraftMine => "My drafts",
            Column::ReviewMine => "Mine, in review",
            Column::ReadyToMergeMine => "Mine, ready to merge",
            Column::WaitingOnMe => "Waiting on me",
            Column::WaitingOnAuthor => "Waiting on author",
        }
    }

    /// `draftMine`, `draft-mine` or `draft_mine`.
    pub fn parse(s: &str) -> Option<Column> {
        let key: String = s
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        Column::ALL
            .into_iter()
            .find(|c| c.id().to_ascii_lowercase() == key)
    }
}

/// How long a PR has waited, for its column ([`rotting`]): from fresh to critical.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Rotting {
    #[default]
    Fresh,
    Warming,
    Stale,
    Rotting,
    Critical,
}

/// Hours at which a PR in `column` stops being fresh, warming, stale and rotting. Someone
/// waiting on you (a review, a mention) rots fastest; your own drafts slowest.
fn rot_hours(column: Column) -> [i64; 4] {
    match column {
        Column::UnseenMentions | Column::WaitingOnMe => [4, 24, 2 * 24, 4 * 24],
        Column::ReviewMine | Column::ReadyToMergeMine => [24, 3 * 24, 7 * 24, 14 * 24],
        Column::WaitingOnAuthor => [2 * 24, 5 * 24, 10 * 24, 14 * 24],
        Column::DraftMine => [3 * 24, 7 * 24, 14 * 24, 30 * 24],
    }
}

/// Since when `pr` has waited in its column (ms): since it was opened, or in Unseen mentions
/// since the mention.
pub fn waiting_since(pr: &Pr) -> i64 {
    match (&pr.mention, pr.column) {
        (Some(m), Column::UnseenMentions) => m.at,
        _ => pr.created_at,
    }
}

/// How long `pr` has waited ([`waiting_since`]), by its column's thresholds.
pub fn rotting(pr: &Pr, now_ms: i64) -> Rotting {
    let hours = (now_ms - waiting_since(pr)).max(0) / 3_600_000;
    let t = rot_hours(pr.column);
    match t.iter().position(|h| hours < *h) {
        Some(0) => Rotting::Fresh,
        Some(1) => Rotting::Warming,
        Some(2) => Rotting::Stale,
        Some(_) => Rotting::Rotting,
        None => Rotting::Critical,
    }
}

/// Your latest review of someone else's PR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyReview {
    /// `approved` · `changesRequested` · `commented` · `dismissed` · `pending`
    pub state: String,
    /// ms epoch.
    pub at: Option<i64>,
    /// The head moved since that review.
    pub new_commits: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub column: Column,
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub draft: bool,
    /// ms epoch.
    pub created_at: i64,
    pub updated_at: i64,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    /// `XS` · `S` · `M` · `L` · `XL` by lines changed.
    pub size: String,
    pub base_branch: String,
    pub head_branch: String,
    /// The head branch lives in a fork; its local branch is `pr-<number>`.
    #[serde(default)]
    pub cross_repository: bool,
    pub head_oid: Option<String>,
    /// `approved` · `changesRequested` · `reviewRequired`; `None` when the repo requires none.
    pub review_decision: Option<String>,
    /// Combined CI state of the head commit: `success` · `failure` · `error` · `pending` ·
    /// `expected`; `None` when nothing reports.
    pub checks: Option<String>,
    pub comments: u64,
    /// Users and teams (`@org/slug`) asked to review.
    pub requested_reviewers: Vec<String>,
    pub my_review: Option<MyReview>,
    /// The latest time someone else @mentioned you on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mention: Option<Mention>,
    /// Productive tasks the title or description links to (`app.productive.io/…/tasks/<id>`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<String>,
    /// How long it has waited for its column. Set at read time ([`rotting`]).
    #[serde(default)]
    pub rotting: Rotting,
    /// Joined at read time, never cached: where the repo and the head branch are checked out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<Local>,
}

/// Someone's `@you` on a PR (its description, a comment, a review or a review comment).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    /// ms epoch.
    pub at: i64,
    pub author: String,
    /// Where it was said.
    pub url: String,
    /// The line with the mention, shortened.
    pub excerpt: String,
    /// You commented or reviewed on the PR after it.
    pub answered: bool,
    /// Answered, or marked seen after it. Set at read time ([`resolve_mentions`]).
    #[serde(default)]
    pub seen: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    /// The checkout under the `overmind repos` roots.
    pub repo_path: String,
    /// The worktree (or the main checkout) that has the head branch checked out.
    pub worktree: Option<String>,
}

/// The local branch a PR is checked out on: its head branch, or `pr-<n>` for a fork's.
pub fn local_branch(cross_repository: bool, head: &str, number: u64) -> String {
    if cross_repository {
        format!("pr-{number}")
    } else {
        head.to_string()
    }
}

pub fn size_label(lines: u64) -> &'static str {
    match lines {
        0..=10 => "XS",
        11..=100 => "S",
        101..=500 => "M",
        501..=1000 => "L",
        _ => "XL",
    }
}

/// `CHANGES_REQUESTED` → `changesRequested`.
fn camel(s: &str) -> String {
    let mut out = String::new();
    for (i, part) in s.split('_').filter(|p| !p.is_empty()).enumerate() {
        let lower = part.to_ascii_lowercase();
        if i == 0 {
            out.push_str(&lower);
        } else {
            let mut c = lower.chars();
            if let Some(f) = c.next() {
                out.push(f.to_ascii_uppercase());
                out.extend(c);
            }
        }
    }
    out
}

fn ms(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

/// One search node → a [`Pr`] in `column`. `None` for anything that isn't a pull request.
fn parse_node(n: &Value, column: Column, me: &str) -> Option<Pr> {
    let number = n.get("number")?.as_u64()?;
    let additions = n["additions"].as_u64().unwrap_or(0);
    let deletions = n["deletions"].as_u64().unwrap_or(0);
    let head = n["commits"]["nodes"]
        .as_array()
        .and_then(|a| a.last())
        .map(|c| &c["commit"]);
    let head_oid = head.and_then(|c| c["oid"].as_str()).map(String::from);
    let checks = head
        .and_then(|c| c["statusCheckRollup"]["state"].as_str())
        .map(camel);
    let requested_reviewers = n["reviewRequests"]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let r = &r["requestedReviewer"];
                    r["login"]
                        .as_str()
                        .map(String::from)
                        .or_else(|| r["slug"].as_str().map(|s| format!("@{s}")))
                })
                .collect()
        })
        .unwrap_or_default();
    let my_review = n["latestReviews"]["nodes"].as_array().and_then(|a| {
        a.iter()
            .find(|r| str_at(r, &["author", "login"]).is_some_and(|l| l.eq_ignore_ascii_case(me)))
            .map(|r| MyReview {
                state: camel(r["state"].as_str().unwrap_or("")),
                at: ms(&r["submittedAt"]),
                new_commits: match (str_at(r, &["commit", "oid"]), head_oid.as_deref()) {
                    (Some(seen), Some(now)) => seen != now,
                    _ => false,
                },
            })
    });
    Some(Pr {
        column,
        owner: str_at(n, &["repository", "owner", "login"])?.to_string(),
        repo: str_at(n, &["repository", "name"])?.to_string(),
        number,
        title: n["title"].as_str().unwrap_or("").to_string(),
        url: n["url"].as_str().unwrap_or("").to_string(),
        author: str_at(n, &["author", "login"])
            .unwrap_or("ghost")
            .to_string(),
        draft: n["isDraft"].as_bool().unwrap_or(false),
        created_at: ms(&n["createdAt"]).unwrap_or(0),
        updated_at: ms(&n["updatedAt"]).unwrap_or(0),
        additions,
        deletions,
        changed_files: n["changedFiles"].as_u64().unwrap_or(0),
        size: size_label(additions + deletions).into(),
        base_branch: n["baseRefName"].as_str().unwrap_or("").to_string(),
        head_branch: n["headRefName"].as_str().unwrap_or("").to_string(),
        cross_repository: n["isCrossRepository"].as_bool().unwrap_or(false),
        head_oid,
        review_decision: n["reviewDecision"].as_str().map(camel),
        checks,
        comments: n["comments"]["totalCount"].as_u64().unwrap_or(0),
        requested_reviewers,
        my_review,
        mention: None,
        tasks: crate::core::tasks::task_ids_in(&format!(
            "{} {}",
            n["title"].as_str().unwrap_or(""),
            n["body"].as_str().unwrap_or("")
        )),
        rotting: Rotting::Fresh,
        local: None,
    })
}

/// `@login` in `text` (whole handle, any case; not an email or a path) → that line, shortened.
fn mention_in(text: &str, login: &str) -> Option<String> {
    if login.is_empty() {
        return None;
    }
    let needle = format!("@{}", login.to_ascii_lowercase());
    let handle = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    text.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let hit = lower.match_indices(&needle).any(|(i, _)| {
            let before = lower[..i].chars().next_back();
            let after = lower[i + needle.len()..].chars().next();
            !before.is_some_and(|c| handle(c) || c == '/' || c == '.') && !after.is_some_and(handle)
        });
        hit.then(|| {
            let t = line.trim();
            if t.chars().count() > EXCERPT_CHARS {
                let cut: String = t.chars().take(EXCERPT_CHARS - 1).collect();
                format!("{}…", cut.trim_end())
            } else {
                t.to_string()
            }
        })
    })
}

/// A mentions-search node → the latest `@me` by someone else, and whether you spoke after it.
fn mention_of(n: &Value, me: &str) -> Option<Mention> {
    // (at, author, body, url) of everything said on the PR.
    type Said<'a> = Vec<(i64, &'a str, &'a str, &'a str)>;
    fn add<'a>(said: &mut Said<'a>, v: &'a Value, at_key: &str) {
        if let Some(at) = ms(&v[at_key]) {
            said.push((
                at,
                str_at(v, &["author", "login"]).unwrap_or(""),
                v["body"].as_str().unwrap_or(""),
                v["url"].as_str().unwrap_or(""),
            ));
        }
    }
    let mut said: Said = Vec::new();
    add(&mut said, n, "createdAt");
    for c in n["mentionComments"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        add(&mut said, c, "createdAt");
    }
    for r in n["mentionReviews"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        add(&mut said, r, "submittedAt");
        for c in r["comments"]["nodes"].as_array().into_iter().flatten() {
            add(&mut said, c, "createdAt");
        }
    }
    let mine = |a: &str| a.eq_ignore_ascii_case(me);
    let (at, author, excerpt, url) = said
        .iter()
        .filter(|s| !mine(s.1))
        .filter_map(|s| mention_in(s.2, me).map(|e| (s.0, s.1, e, s.3)))
        .max_by_key(|m| m.0)?;
    Some(Mention {
        at,
        author: author.to_string(),
        url: url.to_string(),
        excerpt,
        answered: said.iter().any(|s| mine(s.1) && s.0 > at),
        seen: false,
    })
}

/// The searches' nodes → one list, each PR once, in its column. A PR in several searches goes
/// to the first that claims it: yours, then asked of you, then reviewed by you. A mention
/// attaches to the PR; a PR only mentioned goes to [`Column::UnseenMentions`].
pub fn classify(
    me: &str,
    mine: &[Value],
    requested: &[Value],
    reviewed: &[Value],
    mentioned: &[Value],
) -> Vec<Pr> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |pr: Pr, out: &mut Vec<Pr>| {
        if seen.insert(pr.url.clone()) {
            out.push(pr);
        }
    };
    for n in mine {
        if let Some(mut pr) = parse_node(n, Column::DraftMine, me) {
            pr.column = if pr.draft {
                Column::DraftMine
            } else if pr.review_decision.as_deref() == Some("approved") {
                Column::ReadyToMergeMine
            } else {
                Column::ReviewMine
            };
            push(pr, &mut out);
        }
    }
    for n in requested {
        if let Some(pr) = parse_node(n, Column::WaitingOnMe, me) {
            push(pr, &mut out);
        }
    }
    for n in reviewed {
        if let Some(pr) = parse_node(n, Column::WaitingOnAuthor, me) {
            // Approved by you: nothing left for you to do or wait on.
            if pr.my_review.as_ref().is_some_and(|r| r.state == "approved") {
                continue;
            }
            push(pr, &mut out);
        }
    }
    for n in mentioned {
        let Some(m) = mention_of(n, me) else { continue };
        let url = n["url"].as_str().unwrap_or("");
        if let Some(pr) = out.iter_mut().find(|p| p.url == url) {
            pr.mention = Some(m);
        } else if let Some(mut pr) = parse_node(n, Column::UnseenMentions, me) {
            pr.mention = Some(m);
            push(pr, &mut out);
        }
    }
    sort(&mut out);
    out
}

/// By column, then newest first: by mention in [`Column::UnseenMentions`], else by update.
fn sort(prs: &mut [Pr]) {
    prs.sort_by_key(|p| {
        let at = match (&p.mention, p.column) {
            (Some(m), Column::UnseenMentions) => m.at,
            _ => p.updated_at,
        };
        (
            Column::ALL.iter().position(|c| *c == p.column),
            std::cmp::Reverse(at),
        )
    });
}

/// `owner/repo#12`: the key a PR is marked seen under.
pub fn seen_key(owner: &str, repo: &str, number: u64) -> String {
    format!(
        "{}/{}#{number}",
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase()
    )
}

/// Read time: a mention you answered or marked seen (`seen`: key → ms) after it is seen; an
/// unseen one moves its PR to [`Column::UnseenMentions`], and a PR there only for a seen
/// mention goes.
pub fn resolve_mentions(prs: &mut Vec<Pr>, seen: &HashMap<String, i64>) {
    for p in prs.iter_mut() {
        let key = seen_key(&p.owner, &p.repo, p.number);
        if let Some(m) = &mut p.mention {
            m.seen = m.answered || seen.get(&key).is_some_and(|t| *t >= m.at);
            if !m.seen {
                p.column = Column::UnseenMentions;
            }
        }
    }
    prs.retain(|p| {
        p.column != Column::UnseenMentions || p.mention.as_ref().is_some_and(|m| !m.seen)
    });
    sort(prs);
}

// ---------- fetch ----------

const FIELDS: &str = r#"
fragment pr on PullRequest {
  number title body url isDraft createdAt updatedAt additions deletions changedFiles
  baseRefName headRefName isCrossRepository reviewDecision
  repository { name owner { login } }
  author { login }
  comments { totalCount }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  latestReviews(first: 20) { nodes { author { login } state submittedAt commit { oid } } }
}"#;

/// What the mentions search needs on top: who said what, when.
const MENTION_FIELDS: &str = r#"
fragment mentions on PullRequest {
  body
  mentionComments: comments(last: 30) { nodes { author { login } createdAt body url } }
  mentionReviews: reviews(last: 20) { nodes { author { login } submittedAt body url
    comments(last: 10) { nodes { author { login } createdAt body url } } } }
}"#;

fn query(mentions: bool) -> String {
    let (spread, extra) = if mentions {
        (" ...mentions", MENTION_FIELDS)
    } else {
        ("", "")
    };
    format!(
        "query($q: String!, $first: Int!, $after: String) {{
  viewer {{ login }}
  search(query: $q, type: ISSUE, first: $first, after: $after) {{
    issueCount
    pageInfo {{ hasNextPage endCursor }}
    nodes {{ ...pr{spread} }}
  }}
}}{FIELDS}{extra}"
    )
}

/// `$OVERMIND_GH`, then config `gh`, then PATH + fallbacks.
pub fn gh_bin() -> String {
    if let Some(p) = std::env::var_os("OVERMIND_GH").filter(|p| !p.is_empty()) {
        return p.to_string_lossy().into_owned();
    }
    let cfg = crate::core::config::load().raw["gh"]
        .as_str()
        .map(String::from);
    tools::resolve_binary("gh", cfg.as_deref())
}

/// One search, every page (up to [`MAX_PAGES`]); `mentions` adds [`MENTION_FIELDS`].
/// → (viewer login, nodes, truncated).
fn search(gh: &str, q: &str, mentions: bool) -> Result<(String, Vec<Value>, bool)> {
    let query = query(mentions);
    let page = if mentions { MENTIONS_PAGE } else { PAGE };
    let mut nodes = Vec::new();
    let mut after: Option<String> = None;
    let mut login = String::new();
    for _ in 0..MAX_PAGES {
        let mut c = Command::new(gh);
        c.args(["api", "graphql", "-f"])
            .arg(format!("query={query}"))
            .arg("-f")
            .arg(format!("q={q}"))
            .arg("-F")
            .arg(format!("first={page}"))
            .env("PATH", tools::search_path())
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(std::process::Stdio::null());
        if let Some(a) = &after {
            c.arg("-f").arg(format!("after={a}"));
        }
        let o = repos::output_with_timeout(c, GH_TIMEOUT).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::exit(
                    1,
                    "gh not found: install the GitHub CLI and run `gh auth login`",
                )
            } else {
                Error::Other(format!("gh: {e}"))
            }
        })?;
        if !o.status.success() {
            let err = String::from_utf8_lossy(&o.stderr);
            let line = err.lines().map(str::trim).find(|l| !l.is_empty());
            return Err(Error::Other(format!(
                "gh api graphql failed: {}",
                line.unwrap_or("no output")
            )));
        }
        let v: Value = serde_json::from_slice(&o.stdout)?;
        if let Some(e) = v["errors"].as_array().and_then(|a| a.first()) {
            return Err(Error::Other(format!(
                "GitHub: {}",
                e["message"].as_str().unwrap_or("query failed")
            )));
        }
        login = v["data"]["viewer"]["login"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let s = &v["data"]["search"];
        nodes.extend(s["nodes"].as_array().cloned().unwrap_or_default());
        if !s["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
            return Ok((login, nodes, false));
        }
        after = s["pageInfo"]["endCursor"].as_str().map(String::from);
    }
    Ok((login, nodes, true))
}

/// What one fetch produced (also the cache file's shape).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub version: u32,
    /// Your GitHub login.
    pub user: String,
    /// The search scope this was fetched with ([`Settings::scope`]).
    pub scope: String,
    /// ms epoch.
    pub fetched_at: i64,
    /// A search hit [`MAX_PAGES`] pages; some PRs are missing.
    pub truncated: bool,
    pub prs: Vec<Pr>,
}

/// Run the four searches (in parallel) and classify.
pub fn fetch(s: &Settings, now_ms: i64) -> Result<Snapshot> {
    let gh = gh_bin();
    let scope = s.scope();
    let base = "is:pr is:open archived:false";
    let qs = [
        format!("{base} author:@me {scope}"),
        format!("{base} user-review-requested:@me {scope}"),
        format!("{base} reviewed-by:@me -author:@me {scope}"),
        format!("{base} mentions:@me {scope}"),
    ];
    let results: Vec<Result<(String, Vec<Value>, bool)>> = std::thread::scope(|sc| {
        let hs: Vec<_> = qs
            .iter()
            .enumerate()
            .map(|(i, q)| {
                let gh = &gh;
                sc.spawn(move || search(gh, q.trim(), i == 3))
            })
            .collect();
        hs.into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err(Error::Other("search thread panicked".into())))
            })
            .collect()
    });
    let mut parts = Vec::new();
    for r in results {
        parts.push(r?);
    }
    let user = parts[0].0.clone();
    let truncated = parts.iter().any(|p| p.2);
    let prs = classify(&user, &parts[0].1, &parts[1].1, &parts[2].1, &parts[3].1);
    Ok(Snapshot {
        version: 1,
        user,
        scope,
        fetched_at: now_ms,
        truncated,
        prs,
    })
}

// ---------- cache ----------

pub fn cache_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OVERMIND_PRS_CACHE").filter(|p| !p.is_empty()) {
        return PathBuf::from(tools::expand_tilde(&p.to_string_lossy()));
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".cache"));
    base.join("overmind").join("prs.json")
}

pub fn load_cache(path: &Path) -> Option<Snapshot> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

pub fn save_cache(path: &Path, snap: &Snapshot) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string(snap)? + "\n")?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    /// Fetch when the cache is older than `prs.refresh` (or missing, or for another scope).
    #[default]
    Auto,
    /// Always fetch.
    Refresh,
    /// Never fetch.
    Cached,
}

/// What `overmind prs` shows: a snapshot, how it was obtained, and what went wrong.
#[derive(Debug, Clone)]
pub struct View {
    pub snap: Snapshot,
    /// Older than `prs.refresh` (a fetch failed, or `Mode::Cached`).
    pub stale: bool,
    /// The fetch that failed, when the cache is served instead.
    pub error: Option<String>,
}

/// Cache-or-fetch per `mode`, mentions resolved against what you marked seen, rotting as of
/// `now_ms`. Errors only when
/// there is nothing to show.
pub fn get(s: &Settings, mode: Mode, now_ms: i64) -> Result<View> {
    let mut v = get_snapshot(s, mode, now_ms)?;
    resolve_mentions(&mut v.snap.prs, &load_seen(&seen_path()));
    for p in &mut v.snap.prs {
        p.rotting = rotting(p, now_ms);
    }
    Ok(v)
}

fn get_snapshot(s: &Settings, mode: Mode, now_ms: i64) -> Result<View> {
    let path = cache_path();
    let cached = load_cache(&path).filter(|c| c.version == 1 && c.scope == s.scope());
    let fresh = |c: &Snapshot| now_ms - c.fetched_at < s.refresh * 1000;
    let want = match (&cached, mode) {
        (_, Mode::Refresh) | (None, Mode::Auto) => true,
        (Some(c), Mode::Auto) => !fresh(c),
        (_, Mode::Cached) => false,
    };
    if want {
        match fetch(s, now_ms) {
            Ok(snap) => {
                save_cache(&path, &snap)?;
                return Ok(View {
                    snap,
                    stale: false,
                    error: None,
                });
            }
            Err(e) => match cached {
                Some(c) => {
                    return Ok(View {
                        snap: c,
                        stale: true,
                        error: Some(e.to_string()),
                    });
                }
                None => return Err(e),
            },
        }
    }
    match cached {
        Some(c) => Ok(View {
            stale: !fresh(&c),
            snap: c,
            error: None,
        }),
        None => Err(Error::exit(
            1,
            "no cached pull requests yet: run `overmind prs` without --cached",
        )),
    }
}

// ---------- seen mentions ----------

/// How long a mark is kept: past this, the PR is long merged or the mention long answered.
const SEEN_KEEP_MS: i64 = 180 * 24 * 3600 * 1000;

pub fn seen_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OVERMIND_PRS_SEEN").filter(|p| !p.is_empty()) {
        return PathBuf::from(tools::expand_tilde(&p.to_string_lossy()));
    }
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"));
    base.join("overmind").join("prs-seen.json")
}

/// [`seen_key`] → when it was marked seen (ms).
pub fn load_seen(path: &Path) -> HashMap<String, i64> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Mark the PR's mentions up to `now_ms` seen (and forget marks older than [`SEEN_KEEP_MS`]).
pub fn mark_seen(path: &Path, key: &str, now_ms: i64) -> Result<()> {
    let mut seen = load_seen(path);
    seen.retain(|_, t| now_ms - *t < SEEN_KEEP_MS);
    seen.insert(key.to_string(), now_ms);
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&seen)? + "\n")?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// The owner of `r` (its own, or from the cache).
pub fn owner_of(r: &PrRef) -> Result<String> {
    match &r.owner {
        Some(o) => Ok(o.clone()),
        None => owner_from_cache(r),
    }
}

// ---------- local ----------

/// `git worktree list --porcelain` → (branch, path) for every worktree on a branch.
fn worktrees(repo: &Path) -> Vec<(String, String)> {
    let Some(out) = repos::git(repo, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    let mut res = Vec::new();
    let mut path: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/")
            && let Some(p) = &path
        {
            res.push((b.to_string(), p.clone()));
        }
    }
    res
}

/// Does `repo`'s `origin` point at `owner/name` on some host?
fn origin_is(repo: &Path, owner: &str, name: &str) -> bool {
    let Some(url) = repos::git(repo, &["remote", "get-url", "origin"]) else {
        return false;
    };
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let want = format!("{owner}/{name}").to_ascii_lowercase();
    let url = url.to_ascii_lowercase();
    url.ends_with(&format!("/{want}")) || url.ends_with(&format!(":{want}"))
}

/// A repo's path and its (branch, worktree path) pairs.
type RepoCheckout = (PathBuf, Vec<(String, String)>);

/// The checkout of `owner/name` among `all`: the directory named `name`, by `origin` when two are.
fn find_repo<'a>(all: &'a [repos::Repo], owner: &str, name: &str) -> Option<&'a repos::Repo> {
    let named: Vec<&repos::Repo> = all
        .iter()
        .filter(|r| r.name.eq_ignore_ascii_case(name))
        .collect();
    match named.len() {
        0 => None,
        1 => Some(named[0]),
        _ => named
            .iter()
            .copied()
            .find(|r| origin_is(&r.path, owner, name)),
    }
}

/// Fill in [`Pr::local`] from the `overmind repos` checkouts: the repo whose directory name is
/// the PR's repo name (and, when two share it, whose `origin` is the PR's repo), and the
/// worktree that has the head branch. Repos are matched once each, not once per PR.
pub fn link_local(prs: &mut [Pr], roots: &repos::Settings) {
    let all = repos::discover(roots);
    let mut found: HashMap<(String, String), Option<RepoCheckout>> = HashMap::new();
    for pr in prs.iter_mut() {
        let key = (pr.owner.clone(), pr.repo.clone());
        let hit = found.entry(key).or_insert_with(|| {
            let repo = find_repo(&all, &pr.owner, &pr.repo)?;
            Some((repo.path.clone(), worktrees(&repo.path)))
        });
        if let Some((path, wts)) = hit {
            let branch = local_branch(pr.cross_repository, &pr.head_branch, pr.number);
            pr.local = Some(Local {
                repo_path: path.display().to_string(),
                worktree: wts
                    .iter()
                    .find(|(b, _)| *b == branch)
                    .map(|(_, p)| p.clone()),
            });
        }
    }
}

// ---------- checkout ----------

/// `owner/repo#12`, `repo#12` or a pull request URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrRef {
    pub owner: Option<String>,
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    pub fn parse(s: &str) -> Option<PrRef> {
        let s = s.trim().trim_end_matches('/');
        // Goes into a GitHub API path: no `.`/`..`, nothing that could start another segment.
        let ok = |x: &str| {
            !x.is_empty()
                && !x.starts_with('.')
                && x.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        if let Some(rest) = s.split_once("github.com/").map(|(_, r)| r) {
            // owner/repo/pull/12[/files…]
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() >= 4 && parts[2] == "pull" && ok(parts[0]) && ok(parts[1]) {
                return Some(PrRef {
                    owner: Some(parts[0].into()),
                    repo: parts[1].into(),
                    number: parts[3].parse().ok()?,
                });
            }
            return None;
        }
        let (left, num) = s.rsplit_once('#')?;
        let number = num.parse().ok().filter(|n| *n > 0)?;
        match left.split_once('/') {
            Some((o, r)) if ok(o) && ok(r) => Some(PrRef {
                owner: Some(o.into()),
                repo: r.into(),
                number,
            }),
            None if ok(left) => Some(PrRef {
                owner: None,
                repo: left.into(),
                number,
            }),
            _ => None,
        }
    }
}

impl std::fmt::Display for PrRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.owner {
            Some(o) => write!(f, "{o}/{}#{}", self.repo, self.number),
            None => write!(f, "{}#{}", self.repo, self.number),
        }
    }
}

/// What `overmind pr checkout` needs to know about a PR.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrHead {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub cross_repository: bool,
}

/// The owner of a `repo#12` ref, from the cache — an error naming the candidates when two
/// owners have a PR with that repo name and number.
fn owner_from_cache(r: &PrRef) -> Result<String> {
    let cache = load_cache(&cache_path()).unwrap_or_default();
    let mut owners: Vec<String> = cache
        .prs
        .iter()
        .filter(|p| p.repo.eq_ignore_ascii_case(&r.repo) && p.number == r.number)
        .map(|p| p.owner.clone())
        .collect();
    owners.dedup();
    match owners.len() {
        1 => Ok(owners.remove(0)),
        0 => Err(Error::exit(
            1,
            format!("{r} is not among your cached PRs: name its owner (owner/{r}) or pass its URL"),
        )),
        _ => Err(Error::exit(
            1,
            format!(
                "{r} is ambiguous: {}",
                owners
                    .iter()
                    .map(|o| format!("{o}/{}#{}", r.repo, r.number))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// The PR's head, fresh from GitHub (`gh api repos/O/R/pulls/N`).
pub fn head(r: &PrRef) -> Result<PrHead> {
    let owner = owner_of(r)?;
    let mut c = Command::new(gh_bin());
    c.args([
        "api",
        &format!("repos/{owner}/{}/pulls/{}", r.repo, r.number),
    ])
    .env("PATH", tools::search_path())
    .env("GH_PROMPT_DISABLED", "1")
    .stdin(std::process::Stdio::null());
    let o = repos::output_with_timeout(c, GH_TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::exit(
                1,
                "gh not found: install the GitHub CLI and run `gh auth login`",
            )
        } else {
            Error::Other(format!("gh: {e}"))
        }
    })?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        let line = err.lines().map(str::trim).find(|l| !l.is_empty());
        return Err(Error::exit(
            1,
            format!(
                "{owner}/{}#{}: {}",
                r.repo,
                r.number,
                line.unwrap_or("gh api failed")
            ),
        ));
    }
    let v: Value = serde_json::from_slice(&o.stdout)?;
    let head_branch = str_at(&v, &["head", "ref"]).unwrap_or("").to_string();
    if head_branch.is_empty() {
        return Err(Error::Other(format!(
            "{owner}/{}#{}: GitHub returned no head branch",
            r.repo, r.number
        )));
    }
    let base_full = str_at(&v, &["base", "repo", "full_name"]);
    let head_full = str_at(&v, &["head", "repo", "full_name"]);
    Ok(PrHead {
        owner,
        repo: r.repo.clone(),
        number: r.number,
        title: v["title"].as_str().unwrap_or("").to_string(),
        url: v["html_url"].as_str().unwrap_or("").to_string(),
        head_branch,
        base_branch: str_at(&v, &["base", "ref"]).unwrap_or("").to_string(),
        // A deleted fork has no head repo: still not the base's branch.
        cross_repository: head_full.is_none() || head_full != base_full,
    })
}

/// A PR checked out in a worktree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    #[serde(flatten)]
    pub pr: PrHead,
    /// The local branch (the head branch, or `pr-<n>` for a fork's).
    pub branch: String,
    /// The worktree.
    pub path: String,
    /// The main checkout it belongs to.
    pub repo_path: String,
    /// Made by this call (false: it was already checked out).
    pub created: bool,
    /// The first line a session spawned there gets.
    pub context_line: String,
}

/// `fix/login-form` → `fix-login-form`.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

pub fn context_line(pr: &PrHead, branch: &str, path: &str) -> String {
    let title = pr.title.replace(['\n', '\r'], " ");
    format!(
        "You're working on pull request {}/{}#{} \"{}\" ({}): branch `{branch}` (into `{}`), checked out in the worktree {path} — work there. `gh pr view {}` and `gh pr diff {}` show its description, review comments, CI and diff.",
        pr.owner, pr.repo, pr.number, title, pr.url, pr.base_branch, pr.number, pr.number
    )
}

fn git_run(dir: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let o = repos::output_with_timeout(repos::git_cmd(dir, args), timeout)
        .map_err(|e| Error::Other(format!("git {}: {e}", args.join(" "))))?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        let line = err
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("fatal:") || l.starts_with("error:"))
            .or_else(|| err.lines().map(str::trim).find(|l| !l.is_empty()))
            .unwrap_or("failed")
            .to_string();
        return Err(Error::exit(1, format!("git {}: {line}", args.join(" "))));
    }
    Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Check `pr` out in a worktree of its repo (found under the `overmind repos` roots): the
/// existing one when its branch is already checked out somewhere, else a new one under
/// `prs.worktrees`, named `<repo>-<branch>`. Fetches the head first. A same-repo PR gets its
/// real branch (tracking `origin/<branch>`, or the local branch when there is one); a fork's
/// PR gets `pr-<n>` from `pull/<n>/head`. Never resets or moves an existing branch.
/// `dry_run`: change nothing; `created: true` then means "would be made at `path`".
pub fn checkout(
    s: &Settings,
    roots: &repos::Settings,
    pr: PrHead,
    dry_run: bool,
) -> Result<Worktree> {
    let all = repos::discover(roots);
    let repo = find_repo(&all, &pr.owner, &pr.repo).ok_or_else(|| {
        Error::exit(
            1,
            format!(
                "no checkout of {}/{} under the repos roots ({}) — clone it there first",
                pr.owner,
                pr.repo,
                roots.roots.join(", ")
            ),
        )
    })?;
    let branch = local_branch(pr.cross_repository, &pr.head_branch, pr.number);
    let done = |path: String, created: bool| {
        let context_line = context_line(&pr, &branch, &path);
        Worktree {
            pr: pr.clone(),
            branch: branch.clone(),
            path,
            repo_path: repo.path.display().to_string(),
            created,
            context_line,
        }
    };
    if let Some((_, p)) = worktrees(&repo.path)
        .into_iter()
        .find(|(b, _)| *b == branch)
    {
        return Ok(done(p, false));
    }

    let root = PathBuf::from(tools::expand_tilde(&s.worktrees));
    let base = format!("{}-{}", repo.name, slug(&branch));
    let mut path = root.join(&base);
    if path.exists() {
        path = root.join(format!("{base}-pr{}", pr.number));
    }
    if path.exists() {
        return Err(Error::exit(
            1,
            format!("{} already exists and is not on {branch}", path.display()),
        ));
    }
    let path_s = path.display().to_string();
    if dry_run {
        return Ok(done(path_s, true));
    }

    if pr.cross_repository {
        // `+`: a force-push to the fork moves pr-<n> too — it is ours, nobody commits to it.
        let spec = format!("+pull/{}/head:refs/heads/{branch}", pr.number);
        git_run(
            &repo.path,
            &["fetch", "--quiet", "origin", &spec],
            GIT_FETCH_TIMEOUT,
        )?;
    } else {
        git_run(
            &repo.path,
            &["fetch", "--quiet", "origin", &pr.head_branch],
            GIT_FETCH_TIMEOUT,
        )?;
    }

    std::fs::create_dir_all(&root)?;
    let has_local = repos::git(
        &repo.path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_some();
    let t = Duration::from_secs(120);
    if has_local {
        git_run(
            &repo.path,
            &["worktree", "add", "--quiet", &path_s, &branch],
            t,
        )?;
    } else {
        let upstream = format!("origin/{}", pr.head_branch);
        git_run(
            &repo.path,
            &[
                "worktree", "add", "--quiet", "--track", "-b", &branch, &path_s, &upstream,
            ],
            t,
        )?;
    }
    Ok(done(path_s, true))
}

// ---------- cleanup ----------

/// What GitHub says about the PR of a worktree's branch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrState {
    pub number: u64,
    /// `open` · `merged` · `closed`
    pub state: String,
    pub url: String,
    pub head_oid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupAction {
    Remove,
    Keep,
}

/// One worktree under `prs.worktrees` and what `cleanup-worktrees` does with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRow {
    pub path: String,
    pub repo_path: String,
    /// `None`: detached HEAD.
    pub branch: Option<String>,
    pub pr: Option<PrState>,
    pub action: CleanupAction,
    /// Why it is kept, or what removing it involves.
    pub reason: String,
    /// The local branch goes too (its PR merged, nothing local beyond what was pushed).
    pub delete_branch: bool,
    /// Set by [`apply_cleanup`]: what went wrong removing it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `owner/name` from `origin` (`git@github.com:o/n.git`, `https://github.com/o/n`).
pub fn origin_slug(repo: &Path) -> Option<(String, String)> {
    let url = repos::git(repo, &["remote", "get-url", "origin"])?;
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = url.rsplit(['/', ':']);
    let name = parts.next()?.to_string();
    let owner = parts.next()?.to_string();
    (!owner.is_empty() && !name.is_empty()).then_some((owner, name))
}

/// The PR whose head is `branch` (`pr-<n>`: PR n, a fork's), newest first; `None` when GitHub
/// has none. `gh pr list --head` / `gh pr view`.
pub fn pr_for_branch(owner: &str, name: &str, branch: &str) -> Result<Option<PrState>> {
    let repo = format!("{owner}/{name}");
    let fork_pr = branch
        .strip_prefix("pr-")
        .and_then(|n| n.parse::<u64>().ok());
    let mut c = Command::new(gh_bin());
    match fork_pr {
        Some(n) => c.args(["pr", "view", &n.to_string(), "--repo", &repo]),
        None => c.args([
            "pr", "list", "--repo", &repo, "--head", branch, "--state", "all", "--limit", "1",
        ]),
    };
    c.args(["--json", "number,state,url,headRefOid"])
        .env("PATH", tools::search_path())
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null());
    let o =
        repos::output_with_timeout(c, GH_TIMEOUT).map_err(|e| Error::Other(format!("gh: {e}")))?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        if fork_pr.is_some() && err.contains("Could not resolve") {
            return Ok(None);
        }
        let line = err.lines().map(str::trim).find(|l| !l.is_empty());
        return Err(Error::Other(format!("gh: {}", line.unwrap_or("failed"))));
    }
    let v: Value = serde_json::from_slice(&o.stdout)?;
    let pr = if v.is_array() {
        v.get(0).cloned()
    } else {
        Some(v)
    };
    Ok(pr.and_then(|p| {
        Some(PrState {
            number: p["number"].as_u64()?,
            state: p["state"].as_str()?.to_ascii_lowercase(),
            url: p["url"].as_str().unwrap_or("").to_string(),
            head_oid: p["headRefOid"].as_str().map(String::from),
        })
    }))
}

/// Is everything on `HEAD` of `wt` published: `HEAD` is the PR's head (or behind it), or every
/// commit is on some remote branch.
fn pushed(wt: &Path, pr_head: Option<&str>) -> bool {
    if let Some(h) = pr_head {
        if repos::git(wt, &["rev-parse", "HEAD"]).as_deref() == Some(h) {
            return true;
        }
        if repos::git_cmd(wt, &["merge-base", "--is-ancestor", "HEAD", h])
            .status()
            .is_ok_and(|s| s.success())
        {
            return true;
        }
    }
    repos::git(wt, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).as_deref() == Some("0")
}

/// `(owner, name, branch)` → the PR of that branch ([`pr_for_branch`] outside tests).
pub type PrLookup<'a> = dyn Fn(&str, &str, &str) -> Result<Option<PrState>> + Sync + 'a;

/// `p` with symlinks resolved (`/var` → `/private/var`), also when its tail does not exist (a
/// session's cwd that was removed): the deepest existing ancestor is resolved, the rest kept.
fn canonical(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(c) = std::fs::canonicalize(cur) {
            return rest.iter().rev().fold(c, |acc, part| acc.join(part));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// Every worktree under `prs.worktrees` (of the repos under the `overmind repos` roots), each
/// with a verdict. Removed: its PR is merged or closed, it has no local changes, nothing on it
/// is unpublished, and no live session runs in it (`live_cwds`). `lookup` asks GitHub for the
/// PR of `(owner, name, branch)` — [`pr_for_branch`] outside tests. Changes nothing.
pub fn plan_cleanup(
    s: &Settings,
    roots: &repos::Settings,
    live_cwds: &[String],
    lookup: &PrLookup<'_>,
) -> Vec<CleanupRow> {
    let root = PathBuf::from(tools::expand_tilde(&s.worktrees));
    let Ok(root) = std::fs::canonicalize(&root) else {
        return Vec::new();
    };
    let canon = |p: &str| canonical(Path::new(p));
    let live: Vec<PathBuf> = live_cwds.iter().map(|c| canon(c)).collect();
    // (repo, worktree path, branch)
    let mut found: Vec<(PathBuf, PathBuf, Option<String>)> = Vec::new();
    for repo in repos::discover(roots) {
        let Some(out) = repos::git(&repo.path, &["worktree", "list", "--porcelain"]) else {
            continue;
        };
        for block in out.split("\n\n") {
            let mut path = None;
            let mut branch = None;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(canon(p));
                } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(b.to_string());
                }
            }
            if let Some(p) = path.filter(|p| p.starts_with(&root) && *p != root)
                && !found.iter().any(|(_, q, _)| *q == p)
            {
                found.push((repo.path.clone(), p, branch));
            }
        }
    }
    let rows: Vec<CleanupRow> = std::thread::scope(|sc| {
        let hs: Vec<_> = found
            .iter()
            .map(|(repo, wt, branch)| {
                let live = &live;
                sc.spawn(move || judge(repo, wt, branch.as_deref(), live, lookup))
            })
            .collect();
        hs.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut rows = rows;
    rows.sort_by(|a, b| {
        (a.action == CleanupAction::Keep, &a.path).cmp(&(b.action == CleanupAction::Keep, &b.path))
    });
    rows
}

fn judge(
    repo: &Path,
    wt: &Path,
    branch: Option<&str>,
    live: &[PathBuf],
    lookup: &PrLookup<'_>,
) -> CleanupRow {
    let mut row = CleanupRow {
        path: wt.display().to_string(),
        repo_path: repo.display().to_string(),
        branch: branch.map(String::from),
        pr: None,
        action: CleanupAction::Keep,
        reason: String::new(),
        delete_branch: false,
        error: None,
    };
    let keep = |mut r: CleanupRow, why: &str| {
        r.reason = why.to_string();
        r
    };
    let Some(branch) = branch else {
        return keep(row, "detached HEAD");
    };
    let Some((owner, name)) = origin_slug(repo) else {
        return keep(row, "no origin remote");
    };
    match lookup(&owner, &name, branch) {
        Ok(pr) => row.pr = pr,
        Err(e) => return keep(row, &format!("could not ask GitHub: {e}")),
    }
    let Some(pr) = row.pr.clone() else {
        return keep(row, "no PR for this branch");
    };
    if pr.state == "open" {
        return keep(row, "PR still open");
    }
    if live.iter().any(|c| c.starts_with(wt)) {
        return keep(row, "a session is running in it");
    }
    let dirty = repos::git(wt, &["status", "--porcelain"])
        .map(|s| s.lines().count())
        .unwrap_or(0);
    if dirty > 0 {
        return keep(row, &format!("{dirty} uncommitted change(s)"));
    }
    if !pushed(wt, pr.head_oid.as_deref()) {
        return keep(row, "commits that were never pushed");
    }
    row.action = CleanupAction::Remove;
    row.delete_branch = pr.state == "merged";
    row.reason = format!(
        "PR #{} {}{}",
        pr.number,
        pr.state,
        if row.delete_branch {
            " — branch deleted too"
        } else {
            " — branch kept"
        }
    );
    row
}

/// Remove what [`plan_cleanup`] marked: `git worktree remove` (never forced), then the branch
/// (`-D`: a squash merge leaves it unmerged as far as git knows; the PR says it merged).
pub fn apply_cleanup(rows: &mut [CleanupRow]) {
    for r in rows
        .iter_mut()
        .filter(|r| r.action == CleanupAction::Remove)
    {
        let repo = PathBuf::from(&r.repo_path);
        if let Err(e) = git_run(
            &repo,
            &["worktree", "remove", &r.path],
            Duration::from_secs(60),
        ) {
            r.error = Some(e.to_string());
            continue;
        }
        if r.delete_branch
            && let Some(b) = &r.branch
            && let Err(e) = git_run(&repo, &["branch", "-D", b], Duration::from_secs(30))
        {
            r.error = Some(format!("worktree removed; {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(repo: &str, number: u64, extra: Value) -> Value {
        let mut n = json!({
            "number": number,
            "title": format!("PR {number}"),
            "url": format!("https://github.com/acme/{repo}/pull/{number}"),
            "isDraft": false,
            "createdAt": "2026-10-01T10:00:00Z",
            "updatedAt": "2026-10-02T10:00:00Z",
            "additions": 40, "deletions": 20, "changedFiles": 3,
            "baseRefName": "main", "headRefName": format!("feat-{number}"),
            "reviewDecision": "REVIEW_REQUIRED",
            "repository": { "name": repo, "owner": { "login": "acme" } },
            "author": { "login": "someone" },
            "comments": { "totalCount": 2 },
            "commits": { "nodes": [ { "commit": { "oid": "head1", "statusCheckRollup": { "state": "SUCCESS" } } } ] },
            "reviewRequests": { "nodes": [] },
            "latestReviews": { "nodes": [] }
        });
        if let (Some(o), Some(e)) = (n.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                o.insert(k.clone(), v.clone());
            }
        }
        n
    }

    #[test]
    fn settings_scope_and_problems() {
        let s = Settings::from_value(&Value::Null);
        assert_eq!(s.scope(), "");
        assert_eq!(s.refresh, 300);
        let s = Settings::from_value(&json!({
            "orgs": ["acme", "has space", 3], "repos": ["x/y"], "refresh": "10s"
        }));
        assert_eq!(s.scope(), "org:acme repo:x/y");
        assert_eq!(s.refresh, 300);
        assert_eq!(s.problems.len(), 3, "{:?}", s.problems);
    }

    #[test]
    fn columns_parse_any_spelling() {
        assert_eq!(Column::parse("draft-mine"), Some(Column::DraftMine));
        assert_eq!(Column::parse("waiting_on_me"), Some(Column::WaitingOnMe));
        assert_eq!(
            Column::parse("readyToMergeMine"),
            Some(Column::ReadyToMergeMine)
        );
        assert_eq!(Column::parse("nope"), None);
    }

    #[test]
    fn classify_sorts_mine_requested_and_reviewed() {
        let me = "me";
        let mine = vec![
            node(
                "app",
                1,
                json!({ "isDraft": true, "author": { "login": "me" } }),
            ),
            node("app", 2, json!({ "author": { "login": "me" } })),
            node(
                "app",
                3,
                json!({ "author": { "login": "me" }, "reviewDecision": "APPROVED" }),
            ),
        ];
        let requested = vec![
            node(
                "api",
                10,
                json!({
                    "reviewRequests": { "nodes": [
                        { "requestedReviewer": { "login": "me" } },
                        { "requestedReviewer": { "slug": "backend" } }
                    ] }
                }),
            ),
            // Also yours: stays in your column.
            node("app", 2, json!({ "author": { "login": "me" } })),
        ];
        let reviewed = vec![
            node(
                "api",
                20,
                json!({ "latestReviews": { "nodes": [
                { "author": { "login": "ME" }, "state": "CHANGES_REQUESTED",
                  "submittedAt": "2026-10-02T09:00:00Z", "commit": { "oid": "old" } }
            ] } }),
            ),
            node(
                "api",
                21,
                json!({ "latestReviews": { "nodes": [
                { "author": { "login": "me" }, "state": "APPROVED", "commit": { "oid": "head1" } }
            ] } }),
            ),
            // Re-requested after your review: waiting on you, not the author.
            node("api", 10, json!({})),
        ];
        let prs = classify(me, &mine, &requested, &reviewed, &[]);
        let cols: Vec<(u64, Column)> = prs.iter().map(|p| (p.number, p.column)).collect();
        assert_eq!(
            cols,
            vec![
                (10, Column::WaitingOnMe),
                (2, Column::ReviewMine),
                (3, Column::ReadyToMergeMine),
                (1, Column::DraftMine),
                (20, Column::WaitingOnAuthor),
            ]
        );
        let p10 = &prs[0];
        assert_eq!(p10.requested_reviewers, vec!["me", "@backend"]);
        assert_eq!(p10.checks.as_deref(), Some("success"));
        assert_eq!(p10.review_decision.as_deref(), Some("reviewRequired"));
        assert_eq!(p10.size, "S");
        let p20 = prs.iter().find(|p| p.number == 20).unwrap();
        let r = p20.my_review.as_ref().unwrap();
        assert_eq!(r.state, "changesRequested");
        assert!(r.new_commits);
    }

    #[test]
    fn mentions_match_whole_handles_only() {
        assert_eq!(
            mention_in("hey @Me, look", "me").as_deref(),
            Some("hey @Me, look")
        );
        assert_eq!(
            mention_in("first\n  cc @me  \nlast", "me").as_deref(),
            Some("cc @me")
        );
        for no in ["@meh", "a@me.com", "org/@me", "@me-too", "@me_x", "me", ""] {
            assert_eq!(mention_in(no, "me"), None, "{no}");
        }
        let long = format!("@me {}", "x".repeat(300));
        let e = mention_in(&long, "me").unwrap();
        assert_eq!(e.chars().count(), EXCERPT_CHARS);
        assert!(e.ends_with('…'));
    }

    fn said(author: &str, at: &str, body: &str, url: &str) -> Value {
        json!({ "author": { "login": author }, "createdAt": at, "submittedAt": at, "body": body, "url": url })
    }

    fn mentioned(repo: &str, number: u64, comments: Vec<Value>, reviews: Vec<Value>) -> Value {
        node(
            repo,
            number,
            json!({
                "body": "no mention here",
                "mentionComments": { "nodes": comments },
                "mentionReviews": { "nodes": reviews },
            }),
        )
    }

    #[test]
    fn mentions_attach_answer_and_resolve() {
        let me = "me";
        let requested = vec![node("api", 10, json!({}))];
        let mentioned = vec![
            // On a PR in another column, unanswered: moves to unseen mentions.
            mentioned(
                "api",
                10,
                vec![
                    said("ana", "2026-10-02T08:00:00Z", "@me thoughts?", "u/c1"),
                    said("bo", "2026-10-02T09:00:00Z", "ping @me", "u/c2"),
                    said("me", "2026-10-02T08:30:00Z", "will look", "u/c3"),
                ],
                vec![],
            ),
            // Only mentioned, answered in a review comment: gone.
            mentioned(
                "app",
                11,
                vec![said("ana", "2026-10-02T08:00:00Z", "@me?", "u/c4")],
                vec![json!({
                    "author": { "login": "bo" }, "submittedAt": "2026-10-02T07:00:00Z", "body": "", "url": "u/r1",
                    "comments": { "nodes": [ said("me", "2026-10-02T09:00:00Z", "done", "u/rc1") ] }
                })],
            ),
            // Only mentioned, unanswered: shows.
            mentioned(
                "app",
                12,
                vec![said("ana", "2026-10-02T08:00:00Z", "cc @me", "u/c5")],
                vec![],
            ),
            // Mentions only you made yourself, or none at all: nothing.
            mentioned(
                "app",
                13,
                vec![said(
                    "me",
                    "2026-10-02T08:00:00Z",
                    "@me note to self",
                    "u/c6",
                )],
                vec![],
            ),
        ];
        let mut prs = classify(me, &[], &requested, &[], &mentioned);
        assert_eq!(prs.len(), 3);
        let p10 = prs.iter().find(|p| p.number == 10).unwrap();
        assert_eq!(p10.column, Column::WaitingOnMe);
        let m = p10.mention.as_ref().unwrap();
        assert_eq!(
            (m.author.as_str(), m.url.as_str(), m.excerpt.as_str()),
            ("bo", "u/c2", "ping @me")
        );
        assert!(!m.answered);
        assert!(
            prs.iter()
                .find(|p| p.number == 11)
                .unwrap()
                .mention
                .as_ref()
                .unwrap()
                .answered
        );

        let mut seen = HashMap::new();
        resolve_mentions(&mut prs, &seen);
        let cols: Vec<(u64, Column)> = prs.iter().map(|p| (p.number, p.column)).collect();
        assert_eq!(
            cols,
            vec![(10, Column::UnseenMentions), (12, Column::UnseenMentions)]
        );

        // Marked seen after the mention: back to its column, or gone.
        let mut prs = classify(me, &[], &requested, &[], &mentioned);
        let at = ms(&json!("2026-10-02T09:00:00Z")).unwrap();
        seen.insert(seen_key("acme", "API", 10), at);
        // Marked before its mention: still unseen.
        let before = ms(&json!("2026-10-02T07:59:00Z")).unwrap();
        seen.insert(seen_key("acme", "app", 12), before);
        resolve_mentions(&mut prs, &seen);
        let cols: Vec<(u64, Column)> = prs.iter().map(|p| (p.number, p.column)).collect();
        assert_eq!(
            cols,
            vec![(12, Column::UnseenMentions), (10, Column::WaitingOnMe)]
        );
        assert!(prs[1].mention.as_ref().unwrap().seen);
    }

    #[test]
    fn rotting_is_per_column_and_from_the_mention() {
        let mut p = parse_node(&node("app", 1, json!({})), Column::WaitingOnMe, "me").unwrap();
        let h = |n: i64| p.created_at + n * 3_600_000;
        assert_eq!(rotting(&p, h(1)), Rotting::Fresh);
        assert_eq!(rotting(&p, h(5)), Rotting::Warming);
        assert_eq!(rotting(&p, h(36)), Rotting::Stale);
        assert_eq!(rotting(&p, h(60)), Rotting::Rotting);
        assert_eq!(rotting(&p, h(120)), Rotting::Critical);
        assert_eq!(rotting(&p, p.created_at - 1), Rotting::Fresh);
        p.column = Column::DraftMine;
        assert_eq!(rotting(&p, h(48)), Rotting::Fresh);
        assert_eq!(rotting(&p, h(29 * 24)), Rotting::Rotting);
        assert_eq!(rotting(&p, h(40 * 24)), Rotting::Critical);
        // Unseen mentions: as old as the mention.
        p.column = Column::UnseenMentions;
        p.mention = Some(Mention {
            at: h(100),
            author: "ana".into(),
            url: String::new(),
            excerpt: String::new(),
            answered: false,
            seen: false,
        });
        assert_eq!(rotting(&p, h(101)), Rotting::Fresh);
    }

    #[test]
    fn seen_marks_persist_and_expire() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state/prs-seen.json");
        assert!(load_seen(&path).is_empty());
        mark_seen(&path, "acme/app#1", 1000).unwrap();
        mark_seen(&path, "acme/app#2", 2000).unwrap();
        assert_eq!(load_seen(&path).len(), 2);
        mark_seen(&path, "acme/app#3", 1500 + SEEN_KEEP_MS).unwrap();
        let s = load_seen(&path);
        assert_eq!(s.keys().len(), 2);
        assert!(!s.contains_key("acme/app#1"));
    }

    #[test]
    fn non_pr_nodes_are_skipped() {
        let prs = classify("me", &[json!({}), json!({ "number": 1 })], &[], &[], &[]);
        assert!(prs.is_empty());
    }

    #[test]
    fn sizes() {
        assert_eq!(size_label(0), "XS");
        assert_eq!(size_label(100), "S");
        assert_eq!(size_label(500), "M");
        assert_eq!(size_label(1000), "L");
        assert_eq!(size_label(1001), "XL");
    }

    #[test]
    fn pr_refs() {
        let r = |owner: Option<&str>, repo: &str, number| PrRef {
            owner: owner.map(String::from),
            repo: repo.into(),
            number,
        };
        assert_eq!(
            PrRef::parse("acme/app#12"),
            Some(r(Some("acme"), "app", 12))
        );
        assert_eq!(PrRef::parse(" app#7 "), Some(r(None, "app", 7)));
        assert_eq!(
            PrRef::parse("https://github.com/acme/app/pull/12/files"),
            Some(r(Some("acme"), "app", 12))
        );
        for bad in [
            "app",
            "app#",
            "app#0",
            "a b#1",
            "https://github.com/acme/app/issues/3",
            "../x#1",
        ] {
            assert_eq!(PrRef::parse(bad), None, "{bad}");
        }
        assert_eq!(r(Some("acme"), "app", 12).to_string(), "acme/app#12");
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("fix/login form"), "fix-login-form");
        assert_eq!(slug("feat//x_y.z"), "feat-x_y.z");
    }

    fn git(dir: &Path, args: &[&str]) {
        let o = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            o.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }

    /// A bare "GitHub" with `main`, a PR branch `feat/login` and a fork PR at `pull/7/head`,
    /// and a clone of it named `app` under a repos root. → (tmp, root, clone).
    fn origin_and_clone() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        let commit = [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
        ];
        git(&seed, &["init", "-q", "-b", "main"]);
        git(&seed, &[&commit[..], &["base"]].concat());
        git(&seed, &["checkout", "-q", "-b", "feat/login"]);
        git(&seed, &[&commit[..], &["login"]].concat());
        git(&seed, &["checkout", "-q", "-b", "fork-work", "main"]);
        git(&seed, &[&commit[..], &["fork"]].concat());
        let bare = tmp.path().join("origin.git");
        git(
            tmp.path(),
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        git(
            &bare,
            &["update-ref", "refs/pull/7/head", "refs/heads/fork-work"],
        );
        git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&bare, &["branch", "-D", "fork-work"]);
        let root = tmp.path().join("code");
        std::fs::create_dir_all(&root).unwrap();
        let clone = root.join("app");
        git(&root, &["clone", "-q", bare.to_str().unwrap(), "app"]);
        (tmp, root, clone)
    }

    fn head_of(branch: &str, number: u64, cross: bool) -> PrHead {
        PrHead {
            owner: "acme".into(),
            repo: "app".into(),
            number,
            title: "Login".into(),
            url: format!("https://github.com/acme/app/pull/{number}"),
            head_branch: branch.into(),
            base_branch: "main".into(),
            cross_repository: cross,
        }
    }

    #[test]
    fn checkout_makes_a_tracking_worktree_once() {
        let (tmp, root, clone) = origin_and_clone();
        let s =
            Settings::from_value(&json!({ "worktrees": tmp.path().join("wt").to_str().unwrap() }));
        let roots = repos::Settings::from_value(&json!({ "roots": [root.to_str().unwrap()] }));

        let plan = checkout(&s, &roots, head_of("feat/login", 12, false), true).unwrap();
        assert!(plan.created);
        assert!(
            !Path::new(&plan.path).exists(),
            "dry run made {}",
            plan.path
        );

        let wt = checkout(&s, &roots, head_of("feat/login", 12, false), false).unwrap();
        assert!(wt.created);
        assert_eq!(
            wt.path,
            tmp.path().join("wt/app-feat-login").display().to_string()
        );
        assert_eq!(wt.branch, "feat/login");
        let up = repos::git(Path::new(&wt.path), &["rev-parse", "--abbrev-ref", "@{u}"]);
        assert_eq!(up.as_deref(), Some("origin/feat/login"));
        assert!(wt.context_line.contains(&wt.path));
        assert!(wt.context_line.contains("acme/app#12"));

        let again = checkout(&s, &roots, head_of("feat/login", 12, false), false).unwrap();
        assert!(!again.created);
        assert_eq!(
            std::fs::canonicalize(&again.path).unwrap(),
            std::fs::canonicalize(&wt.path).unwrap()
        );
        assert_eq!(again.repo_path, clone.display().to_string());
    }

    #[test]
    fn checkout_of_a_fork_pr_uses_pull_head() {
        let (tmp, root, _clone) = origin_and_clone();
        let s =
            Settings::from_value(&json!({ "worktrees": tmp.path().join("wt").to_str().unwrap() }));
        let roots = repos::Settings::from_value(&json!({ "roots": [root.to_str().unwrap()] }));
        let wt = checkout(&s, &roots, head_of("fork-work", 7, true), false).unwrap();
        assert_eq!(wt.branch, "pr-7");
        assert!(wt.path.ends_with("app-pr-7"));
        let msg = repos::git(Path::new(&wt.path), &["log", "-1", "--format=%s"]);
        assert_eq!(msg.as_deref(), Some("fork"));
    }

    #[test]
    fn checkout_without_a_local_repo_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Settings::from_value(&Value::Null);
        let roots =
            repos::Settings::from_value(&json!({ "roots": [tmp.path().to_str().unwrap()] }));
        let e = checkout(&s, &roots, head_of("x", 1, false), true).unwrap_err();
        assert!(e.to_string().contains("no checkout of acme/app"), "{e}");
    }

    #[test]
    fn cleanup_removes_only_finished_clean_unused_worktrees() {
        let (tmp, root, clone) = origin_and_clone();
        let wt_root = tmp.path().join("wt");
        let bare = tmp.path().join("origin.git");
        let s = Settings::from_value(&json!({ "worktrees": wt_root.to_str().unwrap() }));
        let roots = repos::Settings::from_value(&json!({ "roots": [root.to_str().unwrap()] }));
        let merged = checkout(&s, &roots, head_of("feat/login", 12, false), false).unwrap();
        let fork = checkout(&s, &roots, head_of("fork-work", 7, true), false).unwrap();
        // Outside prs.worktrees: never looked at.
        let elsewhere = tmp.path().join("other-wt");
        git(
            &clone,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "side",
                elsewhere.to_str().unwrap(),
            ],
        );

        let state = std::sync::Mutex::new(std::collections::HashMap::from([
            ("feat/login".to_string(), "merged".to_string()),
            ("pr-7".to_string(), "open".to_string()),
        ]));
        let lookup = |_o: &str, _n: &str, b: &str| -> Result<Option<PrState>> {
            Ok(state.lock().unwrap().get(b).map(|st| PrState {
                number: 1,
                state: st.clone(),
                url: String::new(),
                // GitHub's head: the branch on the "GitHub" side (a fork PR's under pull/<n>/head).
                head_oid: repos::git(
                    &bare,
                    &[
                        "rev-parse",
                        if b == "pr-7" {
                            "refs/pull/7/head"
                        } else {
                            "refs/heads/feat/login"
                        },
                    ],
                ),
            }))
        };
        let plan = |live: &[String]| plan_cleanup(&s, &roots, live, &lookup);
        let by_branch = |rows: &[CleanupRow], b: &str| {
            rows.iter()
                .find(|r| r.branch.as_deref() == Some(b))
                .cloned()
                .unwrap()
        };

        let rows = plan(&[]);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(!rows.iter().any(|r| r.branch.as_deref() == Some("side")));
        let m = by_branch(&rows, "feat/login");
        assert_eq!(
            (m.action, m.delete_branch),
            (CleanupAction::Remove, true),
            "{m:?}"
        );
        assert_eq!(by_branch(&rows, "pr-7").reason, "PR still open");

        // A live session inside it keeps it.
        let rows = plan(&[format!("{}/src", merged.path)]);
        assert_eq!(
            by_branch(&rows, "feat/login").reason,
            "a session is running in it"
        );

        // Local changes keep it.
        std::fs::write(Path::new(&merged.path).join("notes.txt"), "wip").unwrap();
        assert!(
            by_branch(&plan(&[]), "feat/login")
                .reason
                .contains("uncommitted")
        );
        std::fs::remove_file(Path::new(&merged.path).join("notes.txt")).unwrap();

        // An unpushed commit keeps it.
        git(
            Path::new(&merged.path),
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "local",
            ],
        );
        assert_eq!(
            by_branch(&plan(&[]), "feat/login").reason,
            "commits that were never pushed"
        );
        git(
            Path::new(&merged.path),
            &["reset", "-q", "--hard", "HEAD~1"],
        );

        // Closed (not merged): the worktree goes, the branch stays.
        state.lock().unwrap().insert("pr-7".into(), "closed".into());
        let mut rows = plan(&[]);
        assert!(!by_branch(&rows, "pr-7").delete_branch);
        apply_cleanup(&mut rows);
        assert!(rows.iter().all(|r| r.error.is_none()), "{rows:?}");
        assert!(!Path::new(&merged.path).exists());
        assert!(!Path::new(&fork.path).exists());
        assert!(
            repos::git(
                &clone,
                &["rev-parse", "--verify", "--quiet", "refs/heads/feat/login"]
            )
            .is_none()
        );
        assert!(
            repos::git(
                &clone,
                &["rev-parse", "--verify", "--quiet", "refs/heads/pr-7"]
            )
            .is_some()
        );
        assert!(elsewhere.exists());
    }

    #[test]
    fn origin_slugs() {
        let tmp = tempfile::tempdir().unwrap();
        git(tmp.path(), &["init", "-q"]);
        for (url, want) in [
            ("git@github.com:acme/app.git", ("acme", "app")),
            ("https://github.com/acme/my.app/", ("acme", "my.app")),
        ] {
            let _ = Command::new("git")
                .current_dir(tmp.path())
                .args(["remote", "remove", "origin"])
                .output();
            git(tmp.path(), &["remote", "add", "origin", url]);
            assert_eq!(
                origin_slug(tmp.path()),
                Some((want.0.to_string(), want.1.to_string())),
                "{url}"
            );
        }
    }

    #[test]
    fn link_local_finds_repo_and_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("code");
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let ok = Command::new("git")
                .current_dir(dir)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "x",
            ],
        );
        let wt = tmp.path().join("wt-feat-2");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat-2",
                wt.to_str().unwrap(),
            ],
        );

        let roots = repos::Settings::from_value(&json!({ "roots": [root.to_str().unwrap()] }));
        let mut prs = classify(
            "me",
            &[node("app", 2, json!({})), node("other", 3, json!({}))],
            &[],
            &[],
            &[],
        );
        link_local(&mut prs, &roots);
        let p2 = prs.iter().find(|p| p.number == 2).unwrap();
        let local = p2.local.as_ref().unwrap();
        assert_eq!(local.repo_path, repo.display().to_string());
        let wt_real = std::fs::canonicalize(&wt).unwrap();
        let got = std::fs::canonicalize(local.worktree.as_ref().unwrap()).unwrap();
        assert_eq!(got, wt_real);
        assert!(prs.iter().find(|p| p.number == 3).unwrap().local.is_none());
    }
}
