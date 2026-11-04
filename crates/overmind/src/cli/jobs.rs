//! `overmind jobs`: scheduled agent sessions (see `core::jobs`) — list, show, run now, the
//! launchd tick that fires them, pause/resume, and the service itself.

use std::path::Path;

use chrono::{DateTime, Local, TimeZone};
use colored::Colorize;
use serde_json::{Value, json};

use crate::cli::commands::clean_model;
use crate::cli::render::{ago, home_rel};
use crate::cli::web::{self, ServiceOpts};
use crate::core::backend::{self, Prompt};
use crate::core::config;
use crate::core::discovery::{self, Backend, Session};
use crate::core::gh_watch::{self, Branch, Fetched, Tracked, WatchError, WatchState};
use crate::core::jobs::{self, Due, Job, PromptSrc, Run, Settings, Subject, Tag};
use crate::core::tools;
use crate::error::{Error, Result};

pub const LAUNCHD_LABEL: &str = "overmind.jobs";
pub const SERVICE_LOG: &str = "Library/Logs/overmind.jobs.log";
/// A session is closed by `keep` only once it has also been quiet this long — someone
/// may have picked the conversation up.
const QUIET_BEFORE_CLOSE_MS: i64 = 3600 * 1000;

/// A triggered run's session name when the bot sets no `sessionName`.
const DEFAULT_SESSION_NAME: &str = "{bot} {branch}";
/// A triggered run's prompt when the bot sets none.
const DEFAULT_TRIGGER_PROMPT: &str = "New branch {branch} in {repo} (head {sha}): {url}";

fn warn_problems(s: &Settings) {
    for p in &s.problems {
        eprintln!("{} {p}", "warning:".yellow());
    }
}

fn job<'a>(s: &'a Settings, name: &str) -> Result<&'a Job> {
    s.get(name).ok_or_else(|| {
        let names: Vec<&str> = s.jobs.iter().map(|j| j.name.as_str()).collect();
        Error::Other(if names.is_empty() {
            format!("no bot `{name}` — none configured (config `bots`)")
        } else {
            format!("no bot `{name}` — configured: {}", names.join(", "))
        })
    })
}

fn local(ms: i64) -> DateTime<Local> {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Local::now)
}

pub(crate) fn when(t: DateTime<Local>) -> String {
    let now = Local::now();
    if t.date_naive() == now.date_naive() {
        t.format("today %H:%M").to_string()
    } else if t.date_naive() == now.date_naive().succ_opt().unwrap_or_default() {
        t.format("tomorrow %H:%M").to_string()
    } else {
        t.format("%a %d.%m. %H:%M").to_string()
    }
}

/// The live sessions of a job, from one discovery pass.
fn live_of<'a>(rows: &'a [Session], job: &str) -> Vec<&'a Session> {
    rows.iter()
        .filter(|r| r.origin.as_ref().is_some_and(|o| o.job == job))
        .collect()
}

fn job_json(j: &Job, st: &jobs::JobState, rows: &[Session], runs: usize) -> Value {
    let live: Vec<Value> = live_of(rows, &j.name)
        .into_iter()
        .map(|r| {
            json!({
                "run": r.origin.as_ref().map(|o| o.run.clone()),
                "sessionId": r.session_id,
                "tmuxSession": r.tmux_session,
                "status": r.status,
                "title": r.headline(),
            })
        })
        .collect();
    let prompt = match &j.prompt {
        PromptSrc::None => json!(null),
        PromptSrc::Inline(p) => json!({ "inline": p }),
        PromptSrc::File(f) => json!({ "file": f }),
    };
    let take = st.runs.len().saturating_sub(runs);
    json!({
        "name": j.name,
        "schedule": j.schedule,
        "scheduleText": j.trigger_text(),
        "on": j.github.as_ref().map(|g| json!({ "github": {
            "repo": g.repo, "branch": g.branch, "every": g.every, "backfill": g.backfill,
        } })),
        "sessionName": j.session_name,
        "github": st.github,
        "enabled": j.enabled,
        "dir": j.dir,
        "harness": j.harness.id(),
        "model": j.model,
        "command": j.command,
        "keep": j.keep,
        "pull": j.pull,
        "prompt": prompt,
        "nextRun": j.enabled.then(|| j.next_run(Local::now()).map(|t| t.timestamp_millis())).flatten(),
        "lastSlot": st.last_slot,
        "runs": st.runs[take..].iter().rev().collect::<Vec<&Run>>(),
        "live": live,
    })
}

/// `overmind jobs [list]`.
pub fn list(json_out: bool) -> Result<()> {
    let s = Settings::load();
    warn_problems(&s);
    let rows = if s.jobs.is_empty() {
        Vec::new()
    } else {
        discovery::discover()
    };
    if json_out {
        let v: Vec<Value> = s
            .jobs
            .iter()
            .map(|j| job_json(j, &jobs::load_state(&j.name), &rows, 1))
            .collect();
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    if s.jobs.is_empty() {
        println!(
            "no bots — add one under `bots` in {}",
            home_rel(&config::path().display().to_string())
        );
        return Ok(());
    }
    let now = Local::now();
    for j in &s.jobs {
        let st = jobs::load_state(&j.name);
        let next = if !j.enabled {
            "paused".into()
        } else if j.github.is_some() {
            poll_words(st.github.as_ref())
        } else {
            j.next_run(now).map(when).unwrap_or_else(|| "never".into())
        };
        let last = st
            .runs
            .last()
            .map(|r| format!("{} {}", r.outcome, ago(Some(r.started_at))))
            .unwrap_or_else(|| "never ran".into());
        let live = live_of(&rows, &j.name);
        let busy = live.iter().filter(|r| r.status == "busy").count();
        let waiting = live.iter().filter(|r| r.status == "waiting").count();
        let mut live_s = format!("{} live", live.len());
        if busy + waiting > 0 {
            live_s.push_str(&format!(" ({busy} working, {waiting} need you)"));
        }
        let name = if j.enabled {
            j.name.bold()
        } else {
            j.name.dimmed()
        };
        let next_label = if j.github.is_some() { "poll" } else { "next" };
        println!(
            "{:<24} {:<28} {next_label} {:<18} last {:<20} {}",
            name,
            j.trigger_text(),
            next,
            last,
            live_s.dimmed()
        );
        if let Some(w) = &st.github {
            print_branches(w, &st, &rows, "    ", false);
        }
    }
    Ok(())
}

/// `overmind jobs show <name>`.
pub fn show(name: &str, json_out: bool) -> Result<()> {
    let s = Settings::load();
    warn_problems(&s);
    let j = job(&s, name)?;
    let st = jobs::load_state(&j.name);
    let rows = discovery::discover();
    if json_out {
        let v = job_json(j, &st, &rows, jobs::KEEP_RUNS);
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    println!(
        "{}  {}",
        j.name.bold(),
        if j.enabled {
            "enabled".green()
        } else {
            "paused".yellow()
        }
    );
    match &j.github {
        Some(g) => {
            println!(
                "  trigger   {} (every {})",
                g.describe(),
                crate::cli::repos::span(g.every)
            );
            println!("  polled    {}", poll_words(st.github.as_ref()));
            println!(
                "  session   {}",
                j.session_name.as_deref().unwrap_or(DEFAULT_SESSION_NAME)
            );
        }
        None => println!(
            "  schedule  {}  ({})  next: {}",
            j.trigger_text(),
            j.schedule,
            j.next_run(Local::now())
                .map(when)
                .unwrap_or_else(|| "never".into())
        ),
    }
    println!(
        "  dir       {}{}",
        j.dir,
        if j.pull {
            "  (pulled before each run)"
        } else {
            ""
        }
    );
    match &j.prompt {
        PromptSrc::None => println!("  prompt    (none)"),
        PromptSrc::Inline(p) => println!("  prompt    {}", crate::cli::render::fit(p, 80)),
        PromptSrc::File(f) => println!("  prompt    {f}"),
    }
    let launcher = j.command.clone().unwrap_or_else(|| j.harness.command());
    println!(
        "  launcher  {}{}",
        launcher,
        j.model
            .as_deref()
            .map(|m| format!(" --model {m}"))
            .unwrap_or_default()
    );
    if let Some(g) = &j.gh_identity {
        println!("  github    as {g} (ghIdentity)");
    }
    println!(
        "  keep      {}",
        j.keep
            .map(crate::cli::repos::span)
            .unwrap_or_else(|| "never".into())
    );
    if let Some(w) = &st.github {
        println!("\n  branches");
        print_branches(w, &st, &rows, "    ", true);
    }
    if st.runs.is_empty() {
        println!("\n  never ran");
        return Ok(());
    }
    println!();
    for r in st.runs.iter().rev().take(10) {
        let outcome = match r.outcome.as_str() {
            "spawned" => r.outcome.green(),
            "failed" => r.outcome.red(),
            _ => r.outcome.yellow(),
        };
        let about = r
            .subject
            .as_ref()
            .map(|s| {
                let gone = if s.gone_at.is_some() {
                    ", branch gone"
                } else {
                    ""
                };
                format!("  ({}{gone})", s.branch)
            })
            .unwrap_or_default();
        println!(
            "  {}  {:<8} {}{}{}",
            r.id.bold(),
            r.trigger.dimmed(),
            outcome,
            r.reason
                .as_deref()
                .map(|x| format!(" — {x}"))
                .unwrap_or_default(),
            about.dimmed()
        );
        if let Some(p) = &r.pull {
            match &p.warning {
                Some(w) => println!("    {} {}", "! not pulled:".yellow(), w),
                None if p.pulled > 0 => {
                    println!("    {}", format!("pulled {} commits", p.pulled).dimmed())
                }
                None => {}
            }
        }
        for sess in &r.sessions {
            let live: Vec<&Session> = rows
                .iter()
                .filter(|x| x.tmux_session.as_deref() == Some(sess.tmux_session.as_str()))
                .collect();
            let state = match (live.first(), sess.closed_at) {
                (Some(x), _) => x.status.clone(),
                (None, Some(_)) => "closed".into(),
                (None, None) => "gone".into(),
            };
            let indent = if sess.parent.is_some() {
                "      └ "
            } else {
                "    · "
            };
            println!("{indent}{:<32} {}", sess.tmux_session, state.dimmed());
        }
    }
    Ok(())
}

/// Whether any session of `job` is still working (a new run would overlap it).
fn busy_reason(rows: &[Session], job: &str) -> Option<String> {
    let busy: Vec<String> = live_of(rows, job)
        .into_iter()
        .filter(|r| r.status == "busy")
        .filter_map(|r| r.tmux_session.clone())
        .collect();
    (!busy.is_empty()).then(|| format!("still working: {}", busy.join(", ")))
}

fn push_run(job: &str, run: Run) -> Result<()> {
    let mut st = jobs::load_state(job);
    st.runs.push(run);
    jobs::save_state(job, &st)
}

fn read_prompt(j: &Job) -> std::result::Result<String, String> {
    match &j.prompt {
        PromptSrc::None => Ok(String::new()),
        PromptSrc::Inline(p) => Ok(p.clone()),
        PromptSrc::File(f) => {
            let path = tools::expand_tilde(f);
            std::fs::read_to_string(&path)
                .map(|t| strip_frontmatter(&t).to_string())
                .map_err(|e| format!("cannot read promptFile {f}: {e}"))
        }
    }
}

/// The recipe's prompt with a run's task (`bots run --prompt`) after it.
fn with_task(base: &str, task: &str) -> String {
    let base = base.trim_end();
    if base.is_empty() {
        return task.to_string();
    }
    format!("{base}\n\n{task}")
}

/// A prompt file may be a note with YAML frontmatter (`---` … `---`): the agent gets the body.
fn strip_frontmatter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---\n") else {
        return text;
    };
    match rest.find("\n---\n") {
        Some(end) => rest[end + 5..].trim_start_matches('\n'),
        None => text,
    }
}

/// Start one run of `j` now: its record first (so the spawn lands in it), then the session.
/// `branch`: the branch a GitHub trigger starts it for — `{branch}` & co. in the prompt and the
/// session name are filled from it, and the run records it as its `subject`.
fn start(j: &Job, trigger: &str, slot: Option<i64>, branch: Option<&Branch>) -> Result<Run> {
    let now = Local::now();
    let id = match branch {
        Some(b) => jobs::trigger_run_id(now, &b.name),
        None => jobs::run_id(now, trigger != "schedule"),
    };
    let repo = j
        .github
        .as_ref()
        .map(|g| g.repo.as_str())
        .unwrap_or_default();
    let mut run = Run {
        id: id.clone(),
        trigger: trigger.into(),
        started_at: now.timestamp_millis(),
        slot,
        outcome: "spawned".into(),
        subject: branch.map(|b| Subject {
            kind: "branch".into(),
            repo: repo.into(),
            branch: b.name.clone(),
            sha: b.sha.clone(),
            url: gh_watch::render("{url}", &j.name, repo, b),
            gone_at: None,
        }),
        ..Default::default()
    };
    let fail = |mut run: Run, why: String| -> Result<Run> {
        run.outcome = "failed".into();
        run.reason = Some(why.clone());
        let mut st = jobs::load_state(&j.name);
        match st.runs.iter_mut().rev().find(|r| r.id == run.id) {
            Some(r) => {
                r.outcome = run.outcome.clone();
                r.reason = run.reason.clone();
            }
            None => st.runs.push(run.clone()),
        }
        jobs::save_state(&j.name, &st)?;
        Err(Error::Other(format!("{}: {why}", j.name)))
    };
    let dir = tools::expand_tilde(&j.dir);
    if !Path::new(&dir).is_dir() {
        return fail(run, format!("dir does not exist: {}", j.dir));
    }
    let model = match j.model.as_deref().map(clean_model).transpose() {
        Ok(m) => m.flatten(),
        Err(e) => return fail(run, e.to_string()),
    };
    // `pull: true`: before the prompt is read — a promptFile in `dir` is read fresh.
    let pull_note = if j.pull && !crate::core::hosts::dry_run() {
        let p = jobs::pull_dir(Path::new(&dir));
        let note = p
            .warning
            .as_deref()
            .map(|w| jobs::pull_warning_line(&j.dir, w));
        run.pull = Some(p);
        note
    } else {
        None
    };
    let text = match read_prompt(j) {
        Ok(t) => t,
        Err(e) => return fail(run, e),
    };
    let text = match branch {
        Some(b) if text.trim().is_empty() => {
            gh_watch::render(DEFAULT_TRIGGER_PROMPT, &j.name, repo, b)
        }
        Some(b) => gh_watch::render(&text, &j.name, repo, b),
        None => text,
    };
    let text = match pull_note {
        Some(n) if !text.trim().is_empty() => format!("{n}\n\n{text}"),
        _ => text,
    };
    // A bot session closes itself once its work is done and nothing waits on the user.
    let text = if text.trim().is_empty() {
        text
    } else {
        crate::core::done::with_instruction(&text)
    };
    let prompt_file = jobs::prompt_path(&j.name, &id);
    if !text.trim().is_empty() {
        if let Some(d) = prompt_file.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&prompt_file, &text)?;
        run.prompt_file = Some(tools::tildify(&prompt_file.display().to_string()));
    }
    let tag = Tag {
        run: format!("{}/{id}", j.name),
        command: j.command.clone(),
    };
    let launcher = j.harness.with_defaults(
        j.command
            .as_deref()
            .map(String::from)
            .unwrap_or_else(|| j.harness.command())
            .as_str(),
        model.as_deref(),
    );
    let launcher =
        match crate::core::gh_identity::wrap(&launcher, j.harness, j.gh_identity.as_deref()) {
            Ok(l) => l,
            Err(e) => return fail(run, e.to_string()),
        };
    let name = match branch {
        Some(b) => session_name_for(j, b),
        None => jobs::session_name(&j.name, &id),
    };
    let path_s = prompt_file.display().to_string();
    let prompt = if run.prompt_file.is_some() {
        Prompt::File(&path_s)
    } else {
        Prompt::None
    };
    if crate::core::hosts::dry_run() {
        let line = backend::launch_command(&dir, prompt, Some(&name), &launcher, j.harness);
        if j.pull {
            println!(
                "dry-run: would pull {} first (fetch, fast-forward only)",
                j.dir
            );
        }
        println!("dry-run: would start {} ({}): {line}", j.name, tag.run);
        return Ok(run);
    }
    push_run(&j.name, run.clone())?;
    match backend::spawn_tagged(
        Backend::Tmux,
        &dir,
        prompt,
        Some(&name),
        None,
        false,
        &launcher,
        j.harness,
        Some(&tag),
    ) {
        Ok(_) => Ok(jobs::load_state(&j.name)
            .runs
            .into_iter()
            .rev()
            .find(|r| r.id == id)
            .unwrap_or(run)),
        Err(e) => fail(run, e.to_string()),
    }
}

fn describe(r: &Run) -> String {
    let sess = r
        .sessions
        .first()
        .map(|s| format!(" in tmux session {}", s.tmux_session))
        .unwrap_or_default();
    format!("run {}{sess}", r.id)
}

/// `overmind jobs run <name>`: start a run now, whatever the schedule says.
/// `overmind bots run <name> [--prompt <text>]`: a run now; `--prompt` is added after the recipe's
/// prompt — a task for this run (e.g. acting on the bot's own report), with the recipe's context.
pub fn run_now(name: &str, force: bool, prompt: Option<String>) -> Result<()> {
    let s = Settings::load();
    warn_problems(&s);
    let recipe = job(&s, name)?;
    let custom = match prompt.filter(|p| !p.trim().is_empty()) {
        Some(task) => {
            let base = read_prompt(recipe).map_err(|e| Error::Other(format!("{name}: {e}")))?;
            Some(Job {
                prompt: PromptSrc::Inline(with_task(&base, &task)),
                ..recipe.clone()
            })
        }
        None => None,
    };
    let j = custom.as_ref().unwrap_or(recipe);
    if !force && let Some(why) = busy_reason(&discovery::discover(), &j.name) {
        return Err(Error::Other(format!(
            "{}: {why} — pass --force to start another run anyway",
            j.name
        )));
    }
    if j.github.is_some() {
        return Err(Error::Other(format!(
            "{}: a GitHub bot runs once per branch, when a poll finds it — see `overmind bots check {0}`; \
`overmind bots forget {0} <branch>` makes the next poll start that branch again",
            j.name
        )));
    }
    let r = start(j, "manual", None, None)?;
    println!("{} {} — {}", "→".cyan(), j.name.bold(), describe(&r));
    Ok(())
}

fn log(quiet: bool, line: &str) {
    if quiet {
        println!("{} {line}", Local::now().format("%Y-%m-%d %H:%M:%S"));
    } else {
        println!("{line}");
    }
}

/// `overmind jobs tick`: what the launchd agent runs every minute — fire due jobs, record missed
/// slots, close the idle sessions of runs past their `keep`; then the scheduled sessions
/// (`overmind schedule`).
pub fn tick(quiet: bool) -> Result<()> {
    let s = Settings::load();
    if !quiet {
        warn_problems(&s);
    }
    let now = Local::now();
    // One discovery pass, only when something needs it.
    let mut rows: Option<Vec<Session>> = None;
    let rows_now = |rows: &mut Option<Vec<Session>>| -> Vec<Session> {
        rows.get_or_insert_with(discovery::discover).clone()
    };
    let mut failed = 0;
    for j in &s.jobs {
        let Some(cron) = &j.cron else {
            match github_tick(j, now, quiet, false) {
                Ok(t) => {
                    failed += t.failed;
                    if t.started > 0 {
                        rows = None;
                    }
                }
                Err(e) => {
                    failed += 1;
                    log(quiet, &format!("{}: {e}", j.name));
                }
            }
            cleanup(j, now, quiet, &mut rows)?;
            continue;
        };
        let mut st = jobs::load_state(&j.name);
        let (d, last) = jobs::due(cron, j.enabled, st.last_slot, now);
        let changed = st.last_slot != Some(last);
        st.last_slot = Some(last);
        match d {
            Due::Nothing | Due::Arm => {
                if changed {
                    jobs::save_state(&j.name, &st)?;
                }
            }
            Due::Missed(slot) => {
                st.runs.push(Run {
                    id: jobs::run_id(local(slot), false),
                    trigger: "schedule".into(),
                    started_at: now.timestamp_millis(),
                    slot: Some(slot),
                    outcome: "missed".into(),
                    reason: Some(format!(
                        "{} was too long ago (machine off or asleep?)",
                        when(local(slot))
                    )),
                    ..Default::default()
                });
                jobs::save_state(&j.name, &st)?;
                log(
                    quiet,
                    &format!("{}: missed the {} run", j.name, when(local(slot))),
                );
            }
            Due::Fire(slot) => {
                jobs::save_state(&j.name, &st)?;
                if let Some(why) = busy_reason(&rows_now(&mut rows), &j.name) {
                    push_run(
                        &j.name,
                        Run {
                            id: jobs::run_id(now, false),
                            trigger: "schedule".into(),
                            started_at: now.timestamp_millis(),
                            slot: Some(slot),
                            outcome: "skipped".into(),
                            reason: Some(why.clone()),
                            ..Default::default()
                        },
                    )?;
                    log(quiet, &format!("{}: skipped — {why}", j.name));
                    continue;
                }
                match start(j, "schedule", Some(slot), None) {
                    Ok(r) => {
                        rows = None; // a new session exists now
                        log(quiet, &format!("{}: started {}", j.name, describe(&r)));
                    }
                    Err(e) => {
                        failed += 1;
                        log(quiet, &format!("{}: failed — {e}", j.name));
                    }
                }
            }
        }
        cleanup(j, now, quiet, &mut rows)?;
    }
    if !crate::core::done::load().marks.is_empty() {
        for line in crate::core::done::prune(&rows_now(&mut rows))? {
            log(quiet, &line);
        }
    }
    failed += crate::cli::schedule::tick(quiet)?;
    if failed > 0 {
        return Err(Error::exit(
            1,
            format!("{failed} bot(s) or scheduled session(s) failed to start"),
        ));
    }
    Ok(())
}

// --- GitHub triggers -------------------------------------------------------------

/// The session name of `j`'s run for `b`.
fn session_name_for(j: &Job, b: &Branch) -> String {
    let repo = j
        .github
        .as_ref()
        .map(|g| g.repo.as_str())
        .unwrap_or_default();
    gh_watch::render(
        j.session_name.as_deref().unwrap_or(DEFAULT_SESSION_NAME),
        &j.name,
        repo,
        b,
    )
}

/// Load the bot's state, change its `github` part, save it.
fn update_watch(job: &str, f: impl FnOnce(&mut WatchState, &mut Vec<Run>)) -> Result<()> {
    let mut st = jobs::load_state(job);
    let mut w = st.github.take().unwrap_or_default();
    f(&mut w, &mut st.runs);
    st.github = Some(w);
    jobs::save_state(job, &st)
}

/// "30s ago, ok" / "2m ago — auth: …" / "never".
fn poll_words(w: Option<&WatchState>) -> String {
    let Some(w) = w.filter(|w| w.last_poll.is_some()) else {
        return "never polled".into();
    };
    match &w.error {
        Some(e) => format!("{} ago — {}", ago(w.last_poll), e.kind),
        None => format!("{} ago, ok", ago(w.last_poll)),
    }
}

/// The branches a GitHub bot remembers, with their sessions' state.
fn print_branches(w: &WatchState, st: &jobs::JobState, rows: &[Session], indent: &str, all: bool) {
    if let Some(e) = &w.error {
        println!("{indent}{} {}", "poll failed:".red(), e.message);
    }
    let tmux = backend::tmux_session_names();
    let mut existing = 0;
    for (name, t) in &w.branches {
        if t.outcome == "existing" && !all {
            existing += 1;
            continue;
        }
        let session = t.tmux_session.as_deref().map(|ts| {
            let live = rows
                .iter()
                .find(|x| x.tmux_session.as_deref() == Some(ts))
                .map(|x| x.status.clone());
            let state = match live {
                Some(s) => s,
                None if tmux.iter().any(|x| x == ts) => "open".into(),
                None => "closed".into(),
            };
            format!("{ts} ({state})")
        });
        let outcome = match t.outcome.as_str() {
            "spawned" | "adopted" => t.outcome.green(),
            "failed" => t.outcome.red(),
            _ => t.outcome.dimmed(),
        };
        println!(
            "{indent}{:<24} {:<9} {}{}",
            name,
            outcome,
            session.unwrap_or_default(),
            t.reason
                .as_deref()
                .map(|r| format!(" — {r}"))
                .unwrap_or_default()
                .dimmed()
        );
    }
    if existing > 0 {
        println!(
            "{indent}{}",
            format!("+{existing} branch(es) that were there before the bot (not run)").dimmed()
        );
    }
    let gone: Vec<&str> = st
        .runs
        .iter()
        .rev()
        .filter_map(|r| r.subject.as_ref())
        .filter(|s| s.gone_at.is_some())
        .map(|s| s.branch.as_str())
        .take(5)
        .collect();
    if all && !gone.is_empty() {
        println!(
            "{indent}{}",
            format!("deleted since their run: {}", gone.join(", ")).dimmed()
        );
    }
}

/// What one GitHub bot's tick did.
#[derive(Default)]
struct TriggerTick {
    started: usize,
    /// Runs that failed to start.
    failed: usize,
    /// The poll itself failed (logged, recorded in the state for `bots` and `doctor`).
    poll_failed: bool,
}

/// Poll one GitHub bot if it is due (or `force`), and act on what changed: start a run for each
/// new branch, remember the rest, drop deleted branches and mark their runs.
fn github_tick(j: &Job, now: DateTime<Local>, quiet: bool, force: bool) -> Result<TriggerTick> {
    let Some(on) = &j.github else {
        return Ok(TriggerTick::default());
    };
    let now_ms = now.timestamp_millis();
    let st = jobs::load_state(&j.name);
    let w = st.github.clone().unwrap_or_default();
    if !j.enabled {
        // Paused: re-arm, so what appears meanwhile is remembered, not run, on re-enable.
        if w.armed {
            update_watch(&j.name, |w, _| {
                w.armed = false;
                w.etag = None;
            })?;
        }
        return Ok(TriggerTick::default());
    }
    if !force && !gh_watch::poll_due(on, &w, now_ms) {
        return Ok(TriggerTick::default());
    }
    let key = WatchState::key(on);
    let same = w.watch == key && w.armed;
    let fetched = gh_watch::gh_for(j.gh_identity.as_deref())
        .map_err(|message| gh_watch::PollError {
            kind: "auth",
            message,
        })
        .map(|gh| gh_watch::fetch(&gh, on, w.etag.as_deref().filter(|_| same)));
    let (res, limits) = match fetched {
        Ok((r, l)) => (r, l),
        Err(e) => (Err(e), Default::default()),
    };
    let branches = match res {
        Err(e) => {
            let retry = gh_watch::retry_at(&e, &limits, now_ms);
            log(
                quiet,
                &format!("{}: poll failed ({}) — {}", j.name, e.kind, e.message),
            );
            update_watch(&j.name, |w, _| {
                if w.watch != key {
                    *w = WatchState {
                        watch: key.clone(),
                        ..Default::default()
                    };
                }
                w.last_poll = Some(now_ms);
                w.next_poll = Some(retry);
                w.rate_remaining = limits.remaining.or(w.rate_remaining);
                w.error = Some(WatchError {
                    kind: e.kind.into(),
                    message: e.message.clone(),
                    at: now_ms,
                });
            })?;
            return Ok(TriggerTick {
                poll_failed: true,
                ..Default::default()
            });
        }
        Ok(Fetched::NotModified) => {
            update_watch(&j.name, |w, _| {
                w.last_poll = Some(now_ms);
                w.last_ok = Some(now_ms);
                w.next_poll = gh_watch::throttle_until(&limits, now_ms);
                w.rate_remaining = limits.remaining.or(w.rate_remaining);
                w.error = None;
            })?;
            return Ok(TriggerTick::default());
        }
        Ok(Fetched::Branches(b, etag)) => {
            let plan = gh_watch::plan(on, &w, &b);
            // Everything but the starts first: a crash mid-spawn must not lose what was learned.
            update_watch(&j.name, |w, runs| {
                if w.watch != key {
                    *w = WatchState {
                        watch: key.clone(),
                        ..Default::default()
                    };
                }
                w.last_poll = Some(now_ms);
                w.last_ok = Some(now_ms);
                w.next_poll = gh_watch::throttle_until(&limits, now_ms);
                w.rate_remaining = limits.remaining.or(w.rate_remaining);
                w.error = None;
                w.etag = etag.clone();
                for r in &plan.remember {
                    w.branches.insert(
                        r.name.clone(),
                        Tracked {
                            sha: r.sha.clone(),
                            first_seen: now_ms,
                            outcome: "existing".into(),
                            ..Default::default()
                        },
                    );
                }
                for (name, sha) in &plan.moved {
                    if let Some(t) = w.branches.get_mut(name) {
                        t.sha = sha.clone();
                    }
                }
                for name in &plan.gone {
                    if let Some(t) = w.branches.remove(name) {
                        mark_gone(runs, &on.repo, name, t.run.as_deref(), now_ms);
                    }
                }
                w.armed = true;
            })?;
            if !plan.remember.is_empty() {
                log(
                    quiet,
                    &format!(
                        "{}: first poll — remembered {} existing branch(es), not run",
                        j.name,
                        plan.remember.len()
                    ),
                );
            }
            for name in &plan.gone {
                log(
                    quiet,
                    &format!(
                        "{}: {name} was deleted — dropped (its session stays)",
                        j.name
                    ),
                );
            }
            plan.start
        }
    };
    let mut out = TriggerTick::default();
    for b in &branches {
        let name = session_name_for(j, b);
        let tmux_name = crate::core::tmux::sanitize_name(&name);
        // A session for this branch is already open (state lost, or `forget` while it runs).
        let tracked = if backend::tmux_session_names().contains(&tmux_name) {
            log(
                quiet,
                &format!(
                    "{}: {} — session {tmux_name} is already open, not starting another",
                    j.name, b.name
                ),
            );
            Tracked {
                sha: b.sha.clone(),
                first_seen: now_ms,
                outcome: "adopted".into(),
                tmux_session: Some(tmux_name),
                ..Default::default()
            }
        } else {
            // Claim the branch before the spawn: a tick that dies mid-spawn finds it claimed.
            update_watch(&j.name, |w, _| {
                w.branches.insert(
                    b.name.clone(),
                    Tracked {
                        sha: b.sha.clone(),
                        first_seen: now_ms,
                        outcome: "starting".into(),
                        ..Default::default()
                    },
                );
            })?;
            match start(j, "github", None, Some(b)) {
                Ok(r) => {
                    out.started += 1;
                    log(
                        quiet,
                        &format!("{}: {} — started {}", j.name, b.name, describe(&r)),
                    );
                    Tracked {
                        sha: b.sha.clone(),
                        first_seen: now_ms,
                        outcome: "spawned".into(),
                        run: Some(r.id.clone()),
                        tmux_session: r.sessions.first().map(|s| s.tmux_session.clone()),
                        reason: None,
                    }
                }
                Err(e) => {
                    out.failed += 1;
                    log(quiet, &format!("{}: {} — failed: {e}", j.name, b.name));
                    Tracked {
                        sha: b.sha.clone(),
                        first_seen: now_ms,
                        outcome: "failed".into(),
                        reason: Some(format!(
                            "{e} — `overmind bots forget {} {}` retries",
                            j.name, b.name
                        )),
                        ..Default::default()
                    }
                }
            }
        };
        update_watch(&j.name, |w, _| {
            w.branches.insert(b.name.clone(), tracked);
        })?;
    }
    Ok(out)
}

/// Mark the run for a deleted branch (its own, else the newest about that branch).
fn mark_gone(runs: &mut [Run], repo: &str, branch: &str, run: Option<&str>, now_ms: i64) {
    let found = runs.iter_mut().rev().find(|r| {
        r.subject
            .as_ref()
            .is_some_and(|s| s.repo == repo && s.branch == branch && s.gone_at.is_none())
            && run.is_none_or(|id| r.id == id)
    });
    if let Some(s) = found.and_then(|r| r.subject.as_mut()) {
        s.gone_at = Some(now_ms);
    }
}

/// `overmind bots check <name> [--dry-run]`: poll a GitHub bot now; `--dry-run` prints what it
/// would start without starting anything or touching its state.
pub fn check(name: &str, dry_run: bool, json_out: bool) -> Result<()> {
    let s = Settings::load();
    warn_problems(&s);
    let j = job(&s, name)?;
    let Some(on) = &j.github else {
        return Err(Error::Other(format!(
            "{name} runs on a schedule, not on a GitHub trigger — nothing to check"
        )));
    };
    if !dry_run {
        if !j.enabled {
            return Err(Error::Other(format!(
                "{name} is paused — `overmind bots enable {name}`, or look with --dry-run"
            )));
        }
        let t = github_tick(j, Local::now(), false, true)?;
        let st = jobs::load_state(&j.name);
        if json_out {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "started": t.started, "failed": t.failed, "github": st.github,
                }))?
            );
        } else if let Some(w) = &st.github {
            println!("{} — {}", j.name.bold(), poll_words(Some(w)));
            print_branches(w, &st, &discovery::discover(), "  ", true);
        }
        if t.failed > 0 || t.poll_failed {
            return Err(Error::exit(1, format!("{name}: poll or start failed")));
        }
        return Ok(());
    }
    let gh = gh_watch::gh_for(j.gh_identity.as_deref()).map_err(Error::Other)?;
    let (res, _) = gh_watch::fetch(&gh, on, None);
    let branches = match res {
        Ok(Fetched::Branches(b, _)) => b,
        Ok(Fetched::NotModified) => Vec::new(),
        Err(e) => {
            return Err(Error::Other(format!(
                "{name}: poll failed ({}) — {}",
                e.kind, e.message
            )));
        }
    };
    let st = jobs::load_state(&j.name).github.unwrap_or_default();
    let plan = gh_watch::plan(on, &st, &branches);
    let tmux = backend::tmux_session_names();
    let rows: Vec<Value> = branches
        .iter()
        .map(|b| {
            let session = crate::core::tmux::sanitize_name(&session_name_for(j, b));
            let action = if plan.start.contains(b) {
                if tmux.contains(&session) {
                    "adopt"
                } else {
                    "start"
                }
            } else if plan.remember.contains(b) {
                "remember"
            } else {
                "known"
            };
            json!({ "branch": b.name, "sha": b.sha, "action": action, "session": session })
        })
        .collect();
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "branches": rows, "gone": plan.gone }))?
        );
        return Ok(());
    }
    println!(
        "{} — {} ({} matching now){}",
        j.name.bold(),
        on.describe(),
        branches.len(),
        if j.enabled { "" } else { " — paused" }
    );
    for r in &rows {
        let action = r["action"].as_str().unwrap_or_default();
        let what = match action {
            "start" => format!(
                "would start session {}",
                r["session"].as_str().unwrap_or_default()
            )
            .green(),
            "adopt" => format!(
                "session {} is open — would not start another",
                r["session"].as_str().unwrap_or_default()
            )
            .yellow(),
            "remember" => "first poll: would remember, not run".dimmed(),
            _ => "already handled".dimmed(),
        };
        println!("  {:<24} {what}", r["branch"].as_str().unwrap_or_default());
    }
    for g in &plan.gone {
        println!(
            "  {:<24} {}",
            g,
            "deleted — would drop it (session stays)".dimmed()
        );
    }
    Ok(())
}

/// `overmind bots forget <name> <branch>`: drop a branch from what a GitHub bot remembers — if it
/// still exists, the next poll starts a run for it again.
pub fn forget(name: &str, branch: &str) -> Result<()> {
    let s = Settings::load();
    let j = job(&s, name)?;
    if j.github.is_none() {
        return Err(Error::Other(format!("{name} has no GitHub trigger")));
    }
    let mut found = None;
    update_watch(&j.name, |w, _| {
        found = w.branches.remove(branch);
        if found.is_some() {
            // The next tick polls, with a full answer.
            w.etag = None;
            w.last_poll = None;
            w.next_poll = None;
        }
    })?;
    match found {
        Some(t) => {
            println!(
                "{name}: forgot {branch} ({}) — the next poll starts it again if it still exists{}",
                t.outcome,
                t.tmux_session
                    .map(|s| format!(" (not while session {s} is open)"))
                    .unwrap_or_default()
            );
            Ok(())
        }
        None => Err(Error::Other(format!("{name} does not remember {branch}"))),
    }
}

/// `overmind doctor`: the tick service, when any bot is enabled, and each GitHub bot's last poll.
pub fn health() -> Vec<crate::cli::hosts::BotHealth> {
    use crate::cli::hosts::BotHealth;
    let s = Settings::load();
    let mut out = Vec::new();
    if !s.jobs.iter().any(|j| j.enabled) {
        return out;
    }
    if cfg!(target_os = "macos")
        && let Some(home) = dirs::home_dir()
        && !home
            .join(format!("Library/LaunchAgents/{LAUNCHD_LABEL}.plist"))
            .exists()
    {
        out.push(BotHealth {
            name: String::new(),
            ok: false,
            line: "bots: the tick service is not installed — nothing runs them; run: overmind bots install-service".into(),
        });
    }
    let now_ms = Local::now().timestamp_millis();
    for j in s.jobs.iter().filter(|j| j.enabled) {
        let Some(on) = &j.github else { continue };
        let w = jobs::load_state(&j.name).github.unwrap_or_default();
        let (ok, what) = match (&w.error, w.last_ok) {
            (Some(e), _) => (
                false,
                format!(
                    "poll failed {} ago ({}): {}",
                    ago(Some(e.at)),
                    e.kind,
                    e.message
                ),
            ),
            (None, None) => (true, "not polled yet".to_string()),
            // Three missed polls in a row: the tick is not running.
            (None, Some(t)) if now_ms - t > (on.every * 3 + 120) * 1000 => (
                false,
                format!(
                    "last polled {} ago — is the tick service running?",
                    ago(Some(t))
                ),
            ),
            (None, Some(t)) => {
                let started = w
                    .branches
                    .values()
                    .filter(|t| t.outcome == "spawned")
                    .count();
                (
                    true,
                    format!(
                        "polled {} ago, {} branch(es) remembered, {started} started",
                        ago(Some(t)),
                        w.branches.len()
                    ),
                )
            }
        };
        let rate = w
            .rate_remaining
            .map(|r| format!(", rate limit left {r}"))
            .unwrap_or_default();
        out.push(BotHealth {
            name: j.name.clone(),
            ok,
            line: format!(
                "bot {} ({}): {what}{rate}",
                j.name,
                on.describe().to_lowercase()
            ),
        });
    }
    out
}

/// Close the sessions of `j`'s runs that are past `keep`, idle and quiet; mark the ones that
/// are already gone.
fn cleanup(
    j: &Job,
    now: DateTime<Local>,
    quiet: bool,
    rows: &mut Option<Vec<Session>>,
) -> Result<()> {
    let Some(keep) = j.keep else {
        return Ok(());
    };
    let now_ms = now.timestamp_millis();
    let mut st = jobs::load_state(&j.name);
    let due = |r: &Run| {
        r.started_at + keep * 1000 < now_ms && r.sessions.iter().any(|s| s.closed_at.is_none())
    };
    if !st.runs.iter().any(due) {
        return Ok(());
    }
    let live = rows.get_or_insert_with(discovery::discover).clone();
    let tmux = backend::tmux_session_names();
    let mut changed = false;
    for r in st.runs.iter_mut() {
        if !due(r) {
            continue;
        }
        for s in r.sessions.iter_mut().filter(|s| s.closed_at.is_none()) {
            if !tmux.contains(&s.tmux_session) {
                s.closed_at = Some(now_ms);
                changed = true;
                continue;
            }
            let agents: Vec<&Session> = live
                .iter()
                .filter(|x| x.tmux_session.as_deref() == Some(s.tmux_session.as_str()))
                .collect();
            // Idle and quiet, or the agent already exited and left a shell behind.
            let closable = agents.iter().all(|x| {
                x.status == "idle"
                    && x.updated_at
                        .is_none_or(|u| now_ms - u > QUIET_BEFORE_CLOSE_MS)
            });
            if !closable {
                continue;
            }
            match crate::core::tmux::kill_session(&s.tmux_session) {
                Ok(()) => {
                    s.closed_at = Some(now_ms);
                    changed = true;
                    log(
                        quiet,
                        &format!("{}: closed {} (run {})", j.name, s.tmux_session, r.id),
                    );
                }
                Err(e) => log(
                    quiet,
                    &format!("{}: could not close {}: {e}", j.name, s.tmux_session),
                ),
            }
        }
    }
    if changed {
        jobs::save_state(&j.name, &st)?;
        *rows = None;
    }
    Ok(())
}

/// `overmind bots enable|disable <name>`.
pub fn set_enabled(name: &str, enabled: bool) -> Result<()> {
    let s = Settings::load();
    let section = job(&s, name)?.section;
    config::patch(&format!("{section}.{name}.enabled"), Value::Bool(enabled))?;
    if enabled {
        let j = Settings::load();
        let j = j.get(name);
        if let Some(g) = j.and_then(|j| j.github.as_ref()) {
            println!(
                "{name}: enabled — watches {} (branches there now are remembered, not run)",
                g.describe().to_lowercase()
            );
        } else {
            let next = j
                .and_then(|j| j.next_run(Local::now()))
                .map(when)
                .unwrap_or_else(|| "never".into());
            println!("{name}: enabled — next run {next}");
        }
    } else {
        println!("{name}: paused");
    }
    Ok(())
}

pub fn launchd_plist(exe: &Path, config_path: &Path, path_env: &str, log: &Path) -> String {
    let e = |p: &Path| web::xml_escape(&p.display().to_string());
    // Interactive: a session the tick starts may be the first in a fresh tmux server, which
    // inherits this job's QoS — Low Power Mode throttles a Background/Standard one hard.
    // AbandonProcessGroup: that tmux server must outlive the tick.
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>--local</string>
    <string>jobs</string>
    <string>tick</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OVERMIND_CONFIG</key><string>{cfg}</string>
    <key>PATH</key><string>{path}</string>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>AbandonProcessGroup</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>{tick}</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        exe = e(exe),
        cfg = e(config_path),
        path = web::xml_escape(path_env),
        tick = jobs::TICK_SECS,
        log = e(log),
    )
}

/// `overmind jobs install-service`.
pub fn install_service(o: ServiceOpts) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(Error::exit(
            1,
            "install-service is macOS-only — elsewhere run `overmind bots tick --quiet` every minute from cron or a systemd timer",
        ));
    }
    let exe = crate::cli::hosts::current_exe()?;
    let home = dirs::home_dir().ok_or_else(|| Error::Other("no home directory".into()))?;
    let log = home.join(SERVICE_LOG);
    let tmux = tools::find_binary("tmux").unwrap_or_else(|| "/opt/homebrew/bin/tmux".into());
    let path = web::service_path(
        &tmux,
        &[tools::find_binary("claude"), tools::find_binary("node")],
    );
    let plist = launchd_plist(&exe, &config::path(), &path, &log);
    web::launchd_agent(LAUNCHD_LABEL, &plist, &log, &o)?;
    if !o.uninstall && !o.print && !o.no_load && !crate::core::hosts::dry_run() {
        println!("runs due bots every minute — see them with: overmind bots");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_task_follows_the_recipe_prompt() {
        assert_eq!(
            with_task("Deploy ctx.\n", "comment on: 1"),
            "Deploy ctx.\n\ncomment on: 1"
        );
        assert_eq!(with_task("  ", "comment on: 1"), "comment on: 1");
    }

    #[test]
    fn prompt_files_lose_their_frontmatter() {
        assert_eq!(
            strip_frontmatter("---\ntitle: x\n---\n\nDo it.\n"),
            "Do it.\n"
        );
        assert_eq!(strip_frontmatter("Do it.\n---\nmore"), "Do it.\n---\nmore");
        assert_eq!(strip_frontmatter("---\nunterminated"), "---\nunterminated");
    }

    #[test]
    fn plist_ticks_every_minute_and_outlives_itself() {
        let p = launchd_plist(
            Path::new("/x/overmind"),
            Path::new("/c.json"),
            "/usr/bin:/bin",
            Path::new("/l.log"),
        );
        assert!(p.contains("<string>jobs</string>"));
        assert!(p.contains("<string>tick</string>"));
        assert!(p.contains("<string>--local</string>"));
        assert!(p.contains("<integer>60</integer>"));
        assert!(p.contains("<key>AbandonProcessGroup</key><true/>"));
        assert!(p.contains(LAUNCHD_LABEL));
    }
}
