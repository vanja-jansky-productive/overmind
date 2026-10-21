//! `overmind tasks`: your open Productive tasks — assigned to you, in projects that are not archived —
//! sorted into columns by due date and workflow status, cached, with each workflow's statuses so
//! a task can be moved along.
//!
//! Productive is reached over its REST API (`api.productive.io/api/v2`, JSON:API) with `curl`;
//! the token goes in on stdin, never on the command line. Token: `$OVERMIND_PRODUCTIVE_TOKEN`, then
//! config `tasks.token`, then the macOS keychain item named by `tasks.keychain` (its service),
//! then `$PRODUCTIVE_API_TOKEN`. A fetch is:
//!
//! - `organization_memberships?include=person.organization` → you (a person per organization)
//!   and the organization (`tasks.organization`; may be left out when you belong to one)
//! - `tasks?filter[assignee_id]=<you>&filter[status]=1` (open), with the project, the workflow
//!   status (and its workflow) and the task list
//! - `workflow_statuses?filter[workflow_id]=<id>` for every workflow seen, in parallel
//!
//! Columns are set at read time (the date moves, the cache doesn't): [`Column::Due`] (due within
//! [`DUE_SOON_DAYS`] days, or overdue), else by the status's category — [`Column::InProgress`]
//! (started) or [`Column::ToDo`] (not started).
//!
//! Config (`tasks` in config.json — per machine, read leniently):
//!
//! ```json
//! "tasks": { "organization": "1", "projects": ["42"], "refresh": "5m", "keychain": "PRODUCTIVE_TOKEN" }
//! ```
//!
//! Cache (`$OVERMIND_TASKS_CACHE`, else `${XDG_CACHE_HOME:-~/.cache}/overmind/tasks.json`): the last
//! successful fetch. A failed fetch keeps serving it, with the error alongside.
//!
//! Nothing in here prints.

use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::core::tools;
use crate::error::{Error, Result};

pub const DEFAULT_REFRESH: &str = "5m";
pub const DEFAULT_API: &str = "https://api.productive.io/api/v2";
pub const APP_URL: &str = "https://app.productive.io";
/// A due date this close (or past) puts the task in [`Column::Due`].
pub const DUE_SOON_DAYS: i64 = 3;
const PAGE: usize = 200;
const MAX_PAGES: usize = 5;
/// How much of the description [`Task::description`] keeps.
const DESCRIPTION_CHARS: usize = 600;

// ---------- config ----------

/// The `tasks` config section, parsed.
#[derive(Debug, Clone)]
pub struct Settings {
    /// The organization id; `None` = the only one you belong to.
    pub organization: Option<String>,
    /// Only tasks in these projects (ids); empty = all.
    pub projects: Vec<String>,
    /// Max cache age in seconds.
    pub refresh: i64,
    pub token: Option<String>,
    /// A macOS keychain item (its service name) that holds the token.
    pub keychain: Option<String>,
    /// What was wrong with the section; the bad parts fall back to defaults.
    pub problems: Vec<String>,
}

fn id_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s)
            if !s.trim().is_empty() && s.trim().chars().all(|c| c.is_ascii_digit()) =>
        {
            Some(s.trim().to_string())
        }
        Value::Number(n) => n.as_u64().map(|n| n.to_string()),
        _ => None,
    }
}

impl Settings {
    pub fn from_value(v: &Value) -> Settings {
        let mut problems = Vec::new();
        let organization = match v.get("organization").filter(|x| !x.is_null()) {
            None => None,
            Some(x) => {
                let id = id_of(x);
                if id.is_none() {
                    problems.push(format!("tasks.organization: {x} is not an id"));
                }
                id
            }
        };
        let projects = match v.get("projects") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|x| {
                    let id = id_of(x);
                    if id.is_none() {
                        problems.push(format!("tasks.projects: {x} is not an id"));
                    }
                    id
                })
                .collect(),
            Some(other) => {
                problems.push(format!("tasks.projects must be a list, not {other}"));
                Vec::new()
            }
        };
        let default_refresh = crate::core::tmux::parse_span(DEFAULT_REFRESH).unwrap_or(300);
        let refresh = match v.get("refresh").filter(|x| !x.is_null()) {
            None => default_refresh,
            Some(x) => match x.as_str().map(crate::core::tmux::parse_span) {
                Some(Ok(s)) if s >= 60 => s,
                _ => {
                    problems.push(format!(
                        "tasks.refresh: {x} is not a duration of at least 1m"
                    ));
                    default_refresh
                }
            },
        };
        let text = |k: &str| {
            v[k].as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
        };
        let token = text("token");
        let keychain = text("keychain");
        Settings {
            organization,
            projects,
            refresh,
            token,
            keychain,
            problems,
        }
    }

    pub fn load() -> Settings {
        Settings::from_value(&crate::core::config::load().raw["tasks"])
    }

    /// What the cache was fetched for: `org:1 projects:2,3` (`org:?` = the only one).
    pub fn scope(&self) -> String {
        let mut s = format!("org:{}", self.organization.as_deref().unwrap_or("?"));
        if !self.projects.is_empty() {
            s.push_str(&format!(" projects:{}", self.projects.join(",")));
        }
        s
    }

    /// `$OVERMIND_PRODUCTIVE_TOKEN`, config `tasks.token`, the keychain item `tasks.keychain`,
    /// `$PRODUCTIVE_API_TOKEN`.
    pub fn token(&self) -> Result<String> {
        let env = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
        };
        env("OVERMIND_PRODUCTIVE_TOKEN")
            .or_else(|| self.token.clone())
            .or_else(|| self.keychain.as_deref().and_then(keychain_token))
            .or_else(|| env("PRODUCTIVE_API_TOKEN"))
            .ok_or_else(|| {
                Error::exit(
                    1,
                    "no Productive API token: run `overmind config set tasks.token <token>` (Productive → Settings → API integrations), or `overmind config set tasks.keychain <service>` for a macOS keychain item that holds it, or set $PRODUCTIVE_API_TOKEN",
                )
            })
    }
}

/// `security find-generic-password -s <service> -w`: the item's secret, from the default
/// keychain search list. `None` when there is no such item (or no `security`).
fn keychain_token(service: &str) -> Option<String> {
    let o = Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|t| !t.is_empty())
}

// ---------- model ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Column {
    Due,
    InProgress,
    #[default]
    ToDo,
    /// Only on a task that was just closed (`overmind task status`); never in a list.
    Closed,
}

impl Column {
    /// The columns a list shows, in order.
    pub const ALL: [Column; 3] = [Column::Due, Column::InProgress, Column::ToDo];

    pub fn id(self) -> &'static str {
        match self {
            Column::Due => "due",
            Column::InProgress => "inProgress",
            Column::ToDo => "toDo",
            Column::Closed => "closed",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Column::Due => "Due soon / overdue",
            Column::InProgress => "In progress",
            Column::ToDo => "To do",
            Column::Closed => "Closed",
        }
    }

    /// `inProgress`, `in-progress` or `in_progress`.
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

/// A workflow status's category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    #[default]
    NotStarted,
    Started,
    Closed,
}

impl Category {
    fn from_id(id: Option<u64>) -> Category {
        match id {
            Some(2) => Category::Started,
            Some(3) => Category::Closed,
            _ => Category::NotStarted,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub name: String,
    pub category: Category,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    /// `<id>-<name>`: the organization's part of app URLs.
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Set at read time ([`column`]).
    #[serde(default)]
    pub column: Column,
    pub id: String,
    /// The project's task number (`#123`).
    pub number: String,
    pub title: String,
    pub url: String,
    pub project: Named,
    pub task_list: Option<String>,
    pub status: Status,
    pub workflow_id: Option<String>,
    /// `YYYY-MM-DD`.
    pub due_date: Option<String>,
    pub start_date: Option<String>,
    /// ms epoch.
    pub created_at: i64,
    pub updated_at: i64,
    pub last_activity_at: Option<i64>,
    pub todos: u64,
    pub open_todos: u64,
    pub tags: Vec<String>,
    /// Plain text, shortened.
    pub description: String,
}

// ---------- parsing ----------

fn ms(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn count(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// `Acme Ltd.` → `acme-ltd`.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

pub fn org_slug(id: &str, name: &str) -> String {
    let s = slug(name);
    if s.is_empty() {
        id.to_string()
    } else {
        format!("{id}-{s}")
    }
}

pub fn task_url(org: &Organization, id: &str) -> String {
    format!("{APP_URL}/{}/tasks/{id}", org.slug)
}

/// HTML (or plain text) → one paragraph of plain text, at most `max` chars.
fn plain_text(html: &str, max: usize) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let words: Vec<&str> = text.split_whitespace().collect();
    let joined = words.join(" ");
    if joined.chars().count() <= max {
        return joined;
    }
    let cut: String = joined.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// `included` → by (type, id).
fn index(included: &[Value]) -> BTreeMap<(String, String), &Value> {
    included
        .iter()
        .filter_map(|i| {
            Some((
                (
                    i["type"].as_str()?.to_string(),
                    i["id"].as_str()?.to_string(),
                ),
                i,
            ))
        })
        .collect()
}

fn rel_id<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    v["relationships"][name]["data"]["id"].as_str()
}

fn parse_status(v: &Value) -> Option<Status> {
    let a = &v["attributes"];
    Some(Status {
        id: v["id"].as_str()?.to_string(),
        name: a["name"].as_str()?.to_string(),
        category: Category::from_id(a["category_id"].as_u64()),
        position: a["position"].as_i64().unwrap_or(0),
    })
}

/// One `tasks` resource (with `included`) → a [`Task`]; `None` when its project is archived or
/// something essential is missing.
fn parse_task(
    t: &Value,
    inc: &BTreeMap<(String, String), &Value>,
    org: &Organization,
) -> Option<Task> {
    let id = t["id"].as_str()?.to_string();
    let a = &t["attributes"];
    let get = |kind: &str, rel: &str| {
        rel_id(t, rel).and_then(|i| inc.get(&(kind.to_string(), i.to_string())).copied())
    };
    let project = get("projects", "project")?;
    if !project["attributes"]["archived_at"].is_null() {
        return None;
    }
    let ws = get("workflow_statuses", "workflow_status")?;
    let status = parse_status(ws)?;
    let workflow_id = rel_id(ws, "workflow").map(String::from);
    let task_list = get("task_lists", "task_list")
        .and_then(|l| l["attributes"]["name"].as_str())
        .map(String::from);
    let date = |k: &str| a[k].as_str().filter(|s| !s.is_empty()).map(String::from);
    Some(Task {
        column: Column::ToDo,
        url: task_url(org, &id),
        number: a["task_number"]
            .as_str()
            .or(a["number"].as_str())
            .unwrap_or_default()
            .to_string(),
        title: a["title"].as_str().unwrap_or_default().trim().to_string(),
        project: Named {
            id: project["id"].as_str().unwrap_or_default().to_string(),
            name: project["attributes"]["name"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string(),
        },
        task_list,
        status,
        workflow_id,
        due_date: date("due_date"),
        start_date: date("start_date"),
        created_at: ms(&a["created_at"]).unwrap_or(0),
        updated_at: ms(&a["updated_at"]).unwrap_or(0),
        last_activity_at: ms(&a["last_activity_at"]),
        todos: count(&a["todo_count"]),
        open_todos: count(&a["open_todo_count"]),
        tags: a["tag_list"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        description: plain_text(
            a["description"].as_str().unwrap_or_default(),
            DESCRIPTION_CHARS,
        ),
        id,
    })
}

/// A `tasks` answer (`data` a list or one task) → its tasks.
pub fn parse_tasks(doc: &Value, org: &Organization) -> Vec<Task> {
    let included = doc["included"].as_array().cloned().unwrap_or_default();
    let inc = index(&included);
    let data = match &doc["data"] {
        Value::Array(a) => a.clone(),
        d @ Value::Object(_) => vec![d.clone()],
        _ => Vec::new(),
    };
    data.iter()
        .filter_map(|t| parse_task(t, &inc, org))
        .collect()
}

/// The column `t` belongs in on `today`.
pub fn column(t: &Task, today: chrono::NaiveDate) -> Column {
    if t.status.category == Category::Closed {
        return Column::Closed;
    }
    let due = t
        .due_date
        .as_deref()
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    if due.is_some_and(|d| (d - today).num_days() <= DUE_SOON_DAYS) {
        return Column::Due;
    }
    match t.status.category {
        Category::Started => Column::InProgress,
        _ => Column::ToDo,
    }
}

/// Due ones by date; the rest by the latest activity first.
fn sort(tasks: &mut [Task]) {
    tasks.sort_by(|a, b| {
        a.column
            .cmp_order()
            .cmp(&b.column.cmp_order())
            .then_with(|| match a.column {
                Column::Due => a.due_date.cmp(&b.due_date),
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| {
                let at = |t: &Task| t.last_activity_at.unwrap_or(t.updated_at);
                at(b).cmp(&at(a))
            })
    });
}

impl Column {
    fn cmp_order(self) -> usize {
        Column::ALL.iter().position(|c| *c == self).unwrap_or(9)
    }
}

/// Productive task ids linked from `text`: `app.productive.io/<org>/tasks/<id>` (or `/task/`).
pub fn task_ids_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in text.match_indices("app.productive.io/") {
        let rest = &text[i + "app.productive.io/".len()..];
        let path: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
            .collect();
        let parts: Vec<&str> = path.split('/').collect();
        for w in parts.windows(2) {
            if (w[0] == "tasks" || w[0] == "task")
                && !w[1].is_empty()
                && w[1].chars().all(|c| c.is_ascii_digit())
                && !out.iter().any(|x| x == w[1])
            {
                out.push(w[1].to_string());
            }
        }
    }
    out
}

/// A task id, or a task URL → its id.
pub fn parse_ref(s: &str) -> Option<String> {
    let s = s.trim().trim_start_matches('#');
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
        return Some(s.to_string());
    }
    task_ids_in(s).into_iter().next()
}

/// The first prompt of a session started on the task. The URL comes early: a session links to
/// the task by it, and session lists carry only the first ~300 chars of the first prompt.
pub fn context_line(t: &Task) -> String {
    format!(
        "Productive task #{} {} — “{}” ({}, {}).",
        t.number, t.url, t.title, t.project.name, t.status.name
    )
}

/// A status of `statuses` by id, or by name (case-insensitive; exact, else a unique prefix).
pub fn find_status<'a>(statuses: &'a [Status], want: &str) -> Result<&'a Status> {
    let w = want.trim().to_lowercase();
    if let Some(s) = statuses.iter().find(|s| s.id == want.trim()) {
        return Ok(s);
    }
    let exact: Vec<&Status> = statuses
        .iter()
        .filter(|s| s.name.to_lowercase() == w)
        .collect();
    let hits = if exact.is_empty() {
        statuses
            .iter()
            .filter(|s| s.name.to_lowercase().starts_with(&w))
            .collect()
    } else {
        exact
    };
    let names = |l: &[&Status]| {
        l.iter()
            .map(|s| format!("{} ({})", s.name, s.id))
            .collect::<Vec<_>>()
            .join(", ")
    };
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err(Error::exit(
            2,
            format!(
                "no status '{want}' in the task's workflow (one of: {})",
                names(&statuses.iter().collect::<Vec<_>>())
            ),
        )),
        many => Err(Error::exit(
            2,
            format!("'{want}' matches several statuses: {}", names(many)),
        )),
    }
}

// ---------- HTTP ----------

fn api_base() -> String {
    std::env::var("OVERMIND_PRODUCTIVE_API")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_API.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn curl_bin() -> String {
    match std::env::var_os("OVERMIND_CURL").filter(|p| !p.is_empty()) {
        Some(p) => p.to_string_lossy().into_owned(),
        None => tools::resolve_binary("curl", None),
    }
}

/// The token, and the organization requests are made in (absent for the membership lookup).
pub struct Api {
    token: String,
    org: Option<String>,
}

impl Api {
    pub fn new(s: &Settings) -> Result<Api> {
        Ok(Api {
            token: s.token()?,
            org: None,
        })
    }

    /// One request; `body` is JSON:API. → the answer's JSON.
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let url = format!("{}/{}", api_base(), path.trim_start_matches('/'));
        let mut c = Command::new(curl_bin());
        c.args([
            "-gsS",
            "--max-time",
            "30",
            "-K",
            "-",
            "-w",
            "\n%{http_code}",
            "-X",
            method,
        ]);
        if let Some(b) = body {
            c.arg("--data-binary").arg(b.to_string());
        }
        c.arg(&url)
            .env("PATH", tools::search_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().map_err(|e| Error::Other(format!("curl: {e}")))?;
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| Error::Other("curl: no stdin".into()))?;
            let mut cfg = format!(
                "header = \"X-Auth-Token: {}\"\n\
                 header = \"Content-Type: application/vnd.api+json\"\n\
                 header = \"User-Agent: overmind/{}\"\n",
                self.token,
                env!("CARGO_PKG_VERSION")
            );
            if let Some(o) = &self.org {
                cfg.push_str(&format!("header = \"X-Organization-Id: {o}\"\n"));
            }
            stdin
                .write_all(cfg.as_bytes())
                .map_err(|e| Error::Other(format!("curl: {e}")))?;
        }
        let out = child
            .wait_with_output()
            .map_err(|e| Error::Other(format!("curl: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(Error::Other(format!(
                "Productive request failed: {}",
                err.trim()
            )));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let (body, code) = text.rsplit_once('\n').unwrap_or(("", &text));
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let why = || {
            v["errors"][0]["detail"]
                .as_str()
                .or(v["errors"][0]["title"].as_str())
                .map(|d| format!(": {d}"))
                .unwrap_or_default()
        };
        match code.trim() {
            "200" | "201" => Ok(v),
            "401" => Err(Error::Other(format!(
                "Productive refused the token (HTTP 401){}",
                why()
            ))),
            "403" => Err(Error::Other(format!(
                "Productive: not allowed (HTTP 403){}",
                why()
            ))),
            "404" => Err(Error::Other(format!(
                "Productive: not found (HTTP 404){}",
                why()
            ))),
            "429" => Err(Error::Other(
                "Productive is rate-limiting (HTTP 429)".into(),
            )),
            c => Err(Error::Other(format!(
                "Productive answered HTTP {c}{}",
                why()
            ))),
        }
    }

    fn get(&self, path: &str) -> Result<Value> {
        self.call("GET", path, None)
    }

    /// You and the organization (`want`, or the only one you belong to); sets the organization
    /// header for every later request.
    pub fn whoami(&mut self, want: Option<&str>) -> Result<(Named, Organization)> {
        let v = self.get("organization_memberships?include=person.organization&page[size]=200")?;
        let included = v["included"].as_array().cloned().unwrap_or_default();
        let inc = index(&included);
        let mut found: Vec<(Named, Organization)> = Vec::new();
        for p in included.iter().filter(|i| i["type"] == "people") {
            let Some(org_id) = rel_id(p, "organization") else {
                continue;
            };
            let org_name = inc
                .get(&("organizations".to_string(), org_id.to_string()))
                .and_then(|o| o["attributes"]["name"].as_str())
                .unwrap_or_default();
            let a = &p["attributes"];
            let name = format!(
                "{} {}",
                a["first_name"].as_str().unwrap_or_default(),
                a["last_name"].as_str().unwrap_or_default()
            );
            found.push((
                Named {
                    id: p["id"].as_str().unwrap_or_default().to_string(),
                    name: name.trim().to_string(),
                },
                Organization {
                    id: org_id.to_string(),
                    name: org_name.to_string(),
                    slug: org_slug(org_id, org_name),
                },
            ));
        }
        let list = |f: &[(Named, Organization)]| {
            f.iter()
                .map(|(_, o)| format!("{} ({})", o.id, o.name))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let pick = match want {
            Some(w) => found
                .iter()
                .find(|(_, o)| o.id == w)
                .cloned()
                .ok_or_else(|| {
                    Error::exit(
                        1,
                        format!(
                            "tasks.organization {w} is not one of yours: {}",
                            list(&found)
                        ),
                    )
                })?,
            None if found.len() == 1 => found[0].clone(),
            None if found.is_empty() => {
                return Err(Error::exit(1, "the token belongs to no organization"));
            }
            None => {
                return Err(Error::exit(
                    1,
                    format!(
                        "you are in several organizations: run `overmind config set tasks.organization <id>` with one of {}",
                        list(&found)
                    ),
                ));
            }
        };
        self.org = Some(pick.1.id.clone());
        Ok(pick)
    }

    /// Requests go to this organization from now on (no membership lookup).
    pub fn in_org(&mut self, org: &str) {
        self.org = Some(org.to_string());
    }

    /// Your open tasks (every page, up to [`MAX_PAGES`]). → (raw pages, truncated).
    fn my_tasks(&self, person: &str, projects: &[String]) -> Result<(Vec<Value>, bool)> {
        let mut pages = Vec::new();
        for n in 1..=MAX_PAGES {
            let mut path = format!(
                "tasks?filter[assignee_id]={person}&filter[status]=1&include={TASK_INCLUDE}&page[size]={PAGE}&page[number]={n}"
            );
            if !projects.is_empty() {
                path.push_str(&format!("&filter[project_id]={}", projects.join(",")));
            }
            let v = self.get(&path)?;
            let total = v["meta"]["total_pages"].as_u64().unwrap_or(1) as usize;
            pages.push(v);
            if n >= total {
                return Ok((pages, false));
            }
        }
        Ok((pages, true))
    }

    /// One task by id (open or not).
    pub fn task(&self, id: &str, org: &Organization) -> Result<Task> {
        let v = self.get(&format!("tasks/{id}?include={TASK_INCLUDE}"))?;
        parse_tasks(&v, org).into_iter().next().ok_or_else(|| {
            Error::exit(
                1,
                format!("task {id} is in an archived project, or has no status"),
            )
        })
    }

    /// Every status of a workflow, in order.
    pub fn statuses(&self, workflow: &str) -> Result<Vec<Status>> {
        let v = self.get(&format!(
            "workflow_statuses?filter[workflow_id]={workflow}&page[size]=200"
        ))?;
        let mut l: Vec<Status> = v["data"]
            .as_array()
            .map(|a| a.iter().filter_map(parse_status).collect())
            .unwrap_or_default();
        l.sort_by_key(|s| (s.category == Category::Closed, s.position));
        Ok(l)
    }

    /// Move the task to `status`.
    pub fn set_status(&self, id: &str, status: &str) -> Result<()> {
        let body = json!({ "data": { "type": "tasks", "id": id, "relationships": {
            "workflow_status": { "data": { "type": "workflow_statuses", "id": status } }
        } } });
        self.call("PATCH", &format!("tasks/{id}"), Some(&body))?;
        Ok(())
    }
}

const TASK_INCLUDE: &str = "project,workflow_status.workflow,task_list";

// ---------- snapshot & cache ----------

/// What one fetch produced (also the cache file's shape).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub version: u32,
    pub scope: String,
    /// ms epoch.
    pub fetched_at: i64,
    /// More than [`MAX_PAGES`] pages of tasks; some are missing.
    pub truncated: bool,
    pub user: Option<Named>,
    pub organization: Option<Organization>,
    pub tasks: Vec<Task>,
    /// Workflow id → its statuses, in order (closed ones last).
    pub statuses: BTreeMap<String, Vec<Status>>,
}

pub fn fetch(s: &Settings, now_ms: i64) -> Result<Snapshot> {
    let mut api = Api::new(s)?;
    let (me, org) = api.whoami(s.organization.as_deref())?;
    let (pages, truncated) = api.my_tasks(&me.id, &s.projects)?;
    let tasks: Vec<Task> = pages.iter().flat_map(|p| parse_tasks(p, &org)).collect();
    let workflows: Vec<String> = tasks
        .iter()
        .filter_map(|t| t.workflow_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let api = &api;
    let results: Vec<(String, Result<Vec<Status>>)> = std::thread::scope(|sc| {
        let hs: Vec<_> = workflows
            .iter()
            .map(|w| sc.spawn(move || (w.clone(), api.statuses(w))))
            .collect();
        hs.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut statuses = BTreeMap::new();
    for (w, r) in results {
        statuses.insert(w, r?);
    }
    Ok(Snapshot {
        version: 1,
        scope: s.scope(),
        fetched_at: now_ms,
        truncated,
        user: Some(me),
        organization: Some(org),
        tasks,
        statuses,
    })
}

pub fn cache_path() -> PathBuf {
    if let Some(p) = std::env::var_os("OVERMIND_TASKS_CACHE").filter(|p| !p.is_empty()) {
        return PathBuf::from(tools::expand_tilde(&p.to_string_lossy()));
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(tools::expand_tilde(&p.to_string_lossy())))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".cache"));
    base.join("overmind").join("tasks.json")
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

pub use crate::core::prs::Mode;

/// What `overmind tasks` shows: a snapshot, how it was obtained, and what went wrong.
#[derive(Debug, Clone)]
pub struct View {
    pub snap: Snapshot,
    /// Older than `tasks.refresh` (a fetch failed, or `Mode::Cached`).
    pub stale: bool,
    /// The fetch that failed, when the cache is served instead.
    pub error: Option<String>,
}

fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

/// Cache-or-fetch per `mode`, columns as of today, sorted. Errors only when there is nothing to
/// show.
pub fn get(s: &Settings, mode: Mode, now_ms: i64) -> Result<View> {
    let mut v = get_snapshot(s, mode, now_ms)?;
    let today = today();
    for t in &mut v.snap.tasks {
        t.column = column(t, today);
    }
    v.snap.tasks.retain(|t| t.column != Column::Closed);
    sort(&mut v.snap.tasks);
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
            "no cached tasks yet: run `overmind tasks` without --cached",
        )),
    }
}

/// One task for `overmind task show|status|spawn`: from the cache when it is there, else fetched.
/// → the task, its workflow's statuses, and an [`Api`] set to its organization.
pub fn lookup(
    s: &Settings,
    id: &str,
    fresh: bool,
) -> Result<(Task, Vec<Status>, Api, Organization)> {
    let mut api = Api::new(s)?;
    let cached = load_cache(&cache_path()).filter(|c| c.version == 1 && c.scope == s.scope());
    let org = match cached.as_ref().and_then(|c| c.organization.clone()) {
        Some(o) => {
            api.in_org(&o.id);
            o
        }
        None => api.whoami(s.organization.as_deref())?.1,
    };
    let hit = cached
        .as_ref()
        .and_then(|c| c.tasks.iter().find(|t| t.id == id).cloned());
    let mut task = match hit {
        Some(t) if !fresh => t,
        _ => api.task(id, &org)?,
    };
    task.column = column(&task, today());
    let statuses = match (
        task.workflow_id.as_ref(),
        cached.as_ref().map(|c| &c.statuses),
    ) {
        (Some(w), Some(m)) if m.contains_key(w) => m[w].clone(),
        (Some(w), _) => api.statuses(w)?,
        (None, _) => Vec::new(),
    };
    Ok((task, statuses, api, org))
}

/// Move a task to `status` (an id or a name in its workflow) and update the cache. → the task
/// as it is now.
pub fn set_status(s: &Settings, id: &str, status: &str, dry: bool) -> Result<Task> {
    let (task, statuses, api, org) = lookup(s, id, false)?;
    let target = find_status(&statuses, status)?.clone();
    if dry {
        let mut t = task;
        t.status = target;
        t.column = column(&t, today());
        return Ok(t);
    }
    api.set_status(id, &target.id)?;
    let mut now = api.task(id, &org)?;
    now.column = column(&now, today());
    let path = cache_path();
    if let Some(mut c) = load_cache(&path).filter(|c| c.version == 1 && c.scope == s.scope()) {
        c.tasks.retain(|t| t.id != id);
        if now.column != Column::Closed {
            c.tasks.push(now.clone());
        }
        save_cache(&path, &c)?;
    }
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org() -> Organization {
        Organization {
            id: "1".into(),
            name: "Acme".into(),
            slug: "1-acme".into(),
        }
    }

    fn doc() -> Value {
        json!({
            "data": [
                { "id": "1001", "type": "tasks",
                  "attributes": { "title": " Fix login ", "task_number": "12", "due_date": "2026-10-18",
                    "created_at": "2026-10-01T10:00:00+02:00", "updated_at": "2026-10-02T10:00:00+02:00",
                    "last_activity_at": "2026-10-03T10:00:00+02:00", "todo_count": 3, "open_todo_count": 1,
                    "tag_list": ["bug"], "description": "<p>Users can&#39;t <b>log in</b>.</p>" },
                  "relationships": { "project": { "data": { "type": "projects", "id": "7" } },
                    "workflow_status": { "data": { "type": "workflow_statuses", "id": "21" } },
                    "task_list": { "data": { "type": "task_lists", "id": "5" } } } },
                { "id": "1002", "type": "tasks",
                  "attributes": { "title": "Old", "task_number": "3", "created_at": "2022-01-01T00:00:00Z" },
                  "relationships": { "project": { "data": { "type": "projects", "id": "8" } },
                    "workflow_status": { "data": { "type": "workflow_statuses", "id": "20" } } } }
            ],
            "included": [
                { "id": "7", "type": "projects", "attributes": { "name": "App", "archived_at": null } },
                { "id": "8", "type": "projects", "attributes": { "name": "Gone", "archived_at": "2023-01-01T00:00:00Z" } },
                { "id": "5", "type": "task_lists", "attributes": { "name": "Sprint 4" } },
                { "id": "21", "type": "workflow_statuses", "attributes": { "name": "Working", "category_id": 2, "position": 3 },
                  "relationships": { "workflow": { "data": { "type": "workflows", "id": "9" } } } },
                { "id": "20", "type": "workflow_statuses", "attributes": { "name": "Open", "category_id": 1, "position": 1 } }
            ]
        })
    }

    #[test]
    fn parses_tasks_and_skips_archived_projects() {
        let t = parse_tasks(&doc(), &org());
        assert_eq!(t.len(), 1);
        let t = &t[0];
        assert_eq!(t.id, "1001");
        assert_eq!(t.number, "12");
        assert_eq!(t.title, "Fix login");
        assert_eq!(t.url, "https://app.productive.io/1-acme/tasks/1001");
        assert_eq!(t.project.name, "App");
        assert_eq!(t.task_list.as_deref(), Some("Sprint 4"));
        assert_eq!(t.status.name, "Working");
        assert_eq!(t.status.category, Category::Started);
        assert_eq!(t.workflow_id.as_deref(), Some("9"));
        assert_eq!((t.todos, t.open_todos), (3, 1));
        assert_eq!(t.description, "Users can't log in .");
    }

    #[test]
    fn columns_by_due_date_then_category() {
        let mut t = parse_tasks(&doc(), &org()).remove(0);
        let day = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(column(&t, day("2026-10-15")), Column::Due);
        assert_eq!(column(&t, day("2026-10-25")), Column::Due);
        assert_eq!(column(&t, day("2026-10-01")), Column::InProgress);
        t.due_date = None;
        t.status.category = Category::NotStarted;
        assert_eq!(column(&t, day("2026-10-01")), Column::ToDo);
        t.status.category = Category::Closed;
        assert_eq!(column(&t, day("2026-10-01")), Column::Closed);
    }

    #[test]
    fn finds_task_links() {
        let body = "Task: https://app.productive.io/1-acme/tasks/1001) and \
                    [x](https://app.productive.io/1-acme/task/1002?foo) again https://app.productive.io/1-acme/tasks/1001";
        assert_eq!(task_ids_in(body), vec!["1001", "1002"]);
        assert!(task_ids_in("https://app.productive.io/1-acme/tasks/TASK_ID").is_empty());
        assert_eq!(parse_ref("#1001").as_deref(), Some("1001"));
        assert_eq!(
            parse_ref("https://app.productive.io/1-acme/tasks/1003").as_deref(),
            Some("1003")
        );
        assert_eq!(parse_ref("nope"), None);
    }

    #[test]
    fn finds_statuses_by_name_or_id() {
        let l = vec![
            Status {
                id: "1".into(),
                name: "Open".into(),
                category: Category::NotStarted,
                position: 1,
            },
            Status {
                id: "2".into(),
                name: "Peer Review".into(),
                category: Category::Started,
                position: 2,
            },
            Status {
                id: "3".into(),
                name: "Paused".into(),
                category: Category::Started,
                position: 3,
            },
        ];
        assert_eq!(find_status(&l, "peer review").unwrap().id, "2");
        assert_eq!(find_status(&l, "3").unwrap().name, "Paused");
        assert_eq!(find_status(&l, "pe").unwrap().id, "2");
        assert!(find_status(&l, "p").is_err());
        assert!(find_status(&l, "done").is_err());
    }

    #[test]
    fn settings_are_read_leniently() {
        let s = Settings::from_value(
            &json!({ "organization": 1, "projects": ["2", "x"], "refresh": "10s" }),
        );
        assert_eq!(s.organization.as_deref(), Some("1"));
        assert_eq!(s.projects, vec!["2"]);
        assert_eq!(s.refresh, 300);
        assert_eq!(s.problems.len(), 2);
        assert_eq!(s.scope(), "org:1 projects:2");
    }

    #[test]
    fn org_slugs() {
        assert_eq!(org_slug("1", "Acme Ltd."), "1-acme-ltd");
        assert_eq!(org_slug("2", ""), "2");
    }
}
