//! `overmind lesson …`: the lessons store (see `core::lessons` and docs/lessons.md) — learn,
//! list, recall, confirm, retire, the proposal queue, mining, JSONL import/export, and the
//! Claude Code hook that brings lessons back into sessions.

use std::collections::HashSet;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use colored::Colorize;
use serde_json::{Value, json};

use crate::core::lessons::{self, Changes, Draft, Evidence, Lesson, Situation};
use crate::core::lessons_mine;
use crate::error::{Error, Result};

#[derive(clap::Args, Debug, Clone, Default)]
pub struct ChangeArgs {
    /// approach, friction, intuition, style, … (one word)
    #[arg(long)]
    pub kind: Option<String>,
    /// A short name for the situation
    #[arg(long)]
    pub title: Option<String>,
    /// What holds: "When …, do …"
    #[arg(long)]
    pub rule: Option<String>,
    /// What goes wrong without it
    #[arg(long)]
    pub consequence: Option<String>,
    /// global, or repo (with --repo, default: this checkout's GitHub repo)
    #[arg(long, value_parser = ["global", "repo"])]
    pub scope: Option<String>,
    /// owner/name, for --scope repo
    #[arg(long)]
    pub repo: Option<String>,
    /// 0 always injected, 1 injected when it fits, 2 search only
    #[arg(long, value_parser = clap::value_parser!(u8).range(0..=2))]
    pub tier: Option<u8>,
    /// 0 to 1
    #[arg(long)]
    pub confidence: Option<f64>,
}

impl ChangeArgs {
    fn changes(&self) -> Changes {
        Changes {
            kind: self.kind.clone(),
            title: self.title.clone(),
            rule: self.rule.clone(),
            consequence: self.consequence.clone(),
            scope: self.scope.clone(),
            repo: self.repo.clone(),
            tier: self.tier,
            confidence: self.confidence,
        }
    }
}

#[derive(clap::Subcommand, Debug, Clone)]
pub enum LessonCmd {
    /// Record a lesson on purpose (active at once). Inside a Claude session the evidence links
    /// back to it ($CLAUDE_CODE_SESSION_ID)
    Learn {
        /// What holds: "When …, do …"
        #[arg(long)]
        rule: String,
        /// What goes wrong without it
        #[arg(long)]
        consequence: String,
        /// A short name (default: the rule's first words)
        #[arg(long)]
        title: Option<String>,
        /// approach (default), friction, intuition, style, …
        #[arg(long)]
        kind: Option<String>,
        /// global, or repo (default: repo inside a GitHub checkout, else global)
        #[arg(long, value_parser = ["global", "repo"])]
        scope: Option<String>,
        /// owner/name (default: this checkout's)
        #[arg(long)]
        repo: Option<String>,
        /// 0 always injected, 1 injected when it fits (default), 2 search only
        #[arg(long, value_parser = clap::value_parser!(u8).range(0..=2))]
        tier: Option<u8>,
        /// The words that taught it (evidence)
        #[arg(long)]
        quote: Option<String>,
        /// The Claude session it came from (default: $CLAUDE_CODE_SESSION_ID)
        #[arg(long)]
        session: Option<String>,
        /// 0 to 1 (default 0.7)
        #[arg(long)]
        confidence: Option<f64>,
        #[arg(long)]
        json: bool,
    },
    /// Active lessons (the default)
    #[command(visible_alias = "ls")]
    List {
        /// Retired ones too
        #[arg(long)]
        all: bool,
        /// Only lessons for this repo (owner/name) and global ones
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// One lesson with its evidence
    Show {
        /// The id, or its number (`12`, `#12`)
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Full-text search over every tier
    Search {
        query: String,
        /// Retired ones too
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// What a session here would be given, with scores
    Recall {
        /// What the session is about (default: just the repo and branch)
        #[arg(long)]
        task: Option<String>,
        /// The directory (default: the current one)
        #[arg(short = 'C', long)]
        dir: Option<String>,
        #[arg(long, default_value_t = lessons::INJECT_LIMIT)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// It held again: occurrences + 1, a little more confidence
    Confirm {
        id: String,
        /// The words that showed it (evidence)
        #[arg(long)]
        quote: Option<String>,
    },
    /// It misled: keep it, never inject or propose it again
    Retire {
        id: String,
        #[arg(long)]
        reason: String,
    },
    /// Change a lesson's fields
    Edit {
        id: String,
        #[command(flatten)]
        changes: ChangeArgs,
    },
    /// Lessons mined from finished sessions, waiting for accept or reject
    Proposals {
        #[arg(long)]
        json: bool,
    },
    /// Make a proposal a lesson (optionally changing it first)
    Accept {
        /// The proposal id (p12, or 12)
        pid: String,
        #[command(flatten)]
        changes: ChangeArgs,
    },
    /// Drop a proposal and remember it, so it is never proposed again
    Reject {
        pid: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Mine a session's transcript for lessons (the SessionEnd hook runs this in the background)
    Mine {
        /// A session id, or a transcript .jsonl path
        target: String,
        /// The session's directory (finds its transcript and repo)
        #[arg(short = 'C', long)]
        dir: Option<String>,
        /// Model for the miner (default: lessons.mineModel, else sonnet)
        #[arg(long)]
        model: Option<String>,
        /// From the start, not from where the last mine stopped
        #[arg(long)]
        again: bool,
        #[arg(long)]
        json: bool,
    },
    /// Adopt lessons from agent-memory JSONL files (schema 1): active ones scoped global or to a
    /// repo you work in, at low confidence, never twice by id
    Import {
        #[arg(required = true)]
        files: Vec<String>,
        /// Also count this repo (owner/name) as one you work in
        #[arg(long)]
        repo: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// Write your own lessons as agent-memory JSONL (schema 1): stdout, or one
    /// <persona>.jsonl per persona into --out <dir>
    Export {
        #[arg(short, long, value_name = "DIR")]
        out: Option<String>,
    },
    /// Claude Code hook (SessionStart, UserPromptSubmit, SessionEnd; reads the hook JSON on stdin)
    Hook {
        /// Print the settings.json snippet that installs it
        #[arg(long)]
        print_config: bool,
    },
}

pub fn run(cmd: LessonCmd) -> Result<()> {
    match cmd {
        LessonCmd::Learn {
            rule,
            consequence,
            title,
            kind,
            scope,
            repo,
            tier,
            quote,
            session,
            confidence,
            json,
        } => learn(
            Draft {
                kind,
                title: title.unwrap_or_default(),
                rule,
                consequence,
                scope,
                repo,
                tier,
                evidence: Vec::new(),
            },
            quote,
            session,
            confidence,
            json,
        ),
        LessonCmd::List { all, repo, json } => list(all, repo.as_deref(), json),
        LessonCmd::Show { id, json } => show(&id, json),
        LessonCmd::Search { query, all, json } => search(&query, all, json),
        LessonCmd::Recall {
            task,
            dir,
            limit,
            json,
        } => recall(task.as_deref(), dir.as_deref(), limit, json),
        LessonCmd::Confirm { id, quote } => confirm(&id, quote),
        LessonCmd::Retire { id, reason } => retire(&id, &reason),
        LessonCmd::Edit { id, changes } => edit(&id, &changes),
        LessonCmd::Proposals { json } => proposals(json),
        LessonCmd::Accept { pid, changes } => accept(&pid, &changes),
        LessonCmd::Reject { pid, reason } => reject(&pid, reason),
        LessonCmd::Mine {
            target,
            dir,
            model,
            again,
            json,
        } => mine(&target, dir.as_deref(), model.as_deref(), again, json),
        LessonCmd::Import { files, repo, json } => import(&files, &repo, json),
        LessonCmd::Export { out } => export(out.as_deref()),
        LessonCmd::Hook { print_config } => {
            if print_config {
                println!("{}", serde_json::to_string_pretty(&hook_config())?);
                Ok(())
            } else {
                hook();
                Ok(())
            }
        }
    }
}

fn cwd() -> Option<String> {
    std::env::current_dir()
        .ok()
        .map(|p| p.display().to_string())
}

fn repo_of(dir: &str) -> Option<String> {
    crate::core::git::head_of(Path::new(dir)).and_then(|h| h.repo)
}

fn evidence(
    kind: &str,
    quote: Option<String>,
    session: Option<String>,
    now: &str,
) -> Option<Evidence> {
    let quote = quote
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())?;
    Some(Evidence {
        kind: kind.into(),
        quote,
        at: now.to_string(),
        session,
    })
}

fn own_session() -> Option<String> {
    std::env::var("CLAUDE_CODE_SESSION_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

fn learn(
    mut d: Draft,
    quote: Option<String>,
    session: Option<String>,
    confidence: Option<f64>,
    json: bool,
) -> Result<()> {
    let here = cwd().as_deref().and_then(repo_of);
    if d.scope.as_deref() != Some("global") && d.repo.is_none() {
        d.repo = here.clone();
    }
    if d.scope.is_none() {
        d.scope = Some(if d.repo.is_some() { "repo" } else { "global" }.into());
    }
    if d.consequence.trim().is_empty() {
        return Err(Error::Other("--consequence must not be empty".into()));
    }
    let now = lessons::now_iso();
    let session = session.or_else(own_session);
    d.evidence.extend(evidence("manual", quote, session, &now));
    let conf = confidence.unwrap_or(lessons::CONF_LEARNED);
    if !(0.0..=1.0).contains(&conf) {
        return Err(Error::Other("confidence must be between 0 and 1".into()));
    }
    let (handle, persona) = (lessons::handle(), lessons::persona());
    let l = lessons::update(|s| {
        if let lessons::Known::Active(id) = s.known(&d.title, &d.rule) {
            eprintln!(
                "{} this looks like {id} — `overmind lesson confirm {id}` adds to that one instead",
                "note:".yellow()
            );
        }
        Ok(s.add(d, "manual", conf, &handle, &persona, &now)?.clone())
    })?;
    if json {
        println!("{}", serde_json::to_string_pretty(&l)?);
    } else {
        println!("learned {} {}", l.id.bold(), where_(&l).dimmed());
    }
    Ok(())
}

fn where_(l: &Lesson) -> String {
    let scope = match (&l.scope[..], &l.repo) {
        ("repo", Some(r)) => r.clone(),
        _ => "global".into(),
    };
    format!("({scope}, tier {}, {})", l.tier, l.kind)
}

fn line(l: &Lesson) -> String {
    let status = if l.is_active() {
        String::new()
    } else {
        format!(" [{}]", l.status).red().to_string()
    };
    format!(
        "{}{} {}  {}\n    {}",
        l.id.bold(),
        status,
        l.title,
        format!(
            "{} · conf {:.2} · seen {}",
            where_(l),
            l.confidence,
            l.occurrences
        )
        .dimmed(),
        l.rule
    )
}

fn list(all: bool, repo: Option<&str>, json: bool) -> Result<()> {
    let s = lessons::load()?;
    let rows: Vec<&Lesson> = s
        .lessons
        .iter()
        .filter(|l| all || l.is_active())
        .filter(|l| repo.is_none() || l.in_scope(repo))
        .collect();
    if json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("no lessons yet — `overmind lesson learn --rule … --consequence …`");
    }
    for l in &rows {
        println!("{}", line(l));
    }
    if !s.proposals.is_empty() {
        println!(
            "\n{} proposal(s) waiting: overmind lesson proposals",
            s.proposals.len()
        );
    }
    Ok(())
}

fn show(id: &str, json: bool) -> Result<()> {
    let now = lessons::now_iso();
    let l = lessons::update(|s| {
        let i = s.find(id)?;
        s.lessons[i].uses += 1;
        s.lessons[i].last_used_at = Some(now.clone());
        Ok(s.lessons[i].clone())
    })?;
    if json {
        println!("{}", serde_json::to_string_pretty(&l)?);
        return Ok(());
    }
    println!("{}", line(&l));
    if !l.consequence.is_empty() {
        println!("    {} {}", "why:".dimmed(), l.consequence);
    }
    if let Some(r) = &l.retired_reason {
        println!("    {} {r}", "retired:".red());
    }
    if let Some(src) = &l.adopted_from {
        println!("    {} {src}", "adopted from:".dimmed());
    }
    for e in &l.evidence {
        let link = e
            .session
            .as_deref()
            .map(|s| format!("  (claude --resume {s})"))
            .unwrap_or_default();
        println!(
            "    {} \"{}\"{}",
            format!("{} {}", e.kind, e.at).dimmed(),
            e.quote,
            link.dimmed()
        );
    }
    Ok(())
}

fn search(query: &str, all: bool, json: bool) -> Result<()> {
    let s = lessons::load()?;
    let hits = lessons::search(&s.lessons, query, all);
    if json {
        let rows: Vec<Value> = hits
            .iter()
            .map(|(score, i)| json!({ "score": score, "lesson": s.lessons[*i] }))
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if hits.is_empty() {
        println!("nothing matches");
    }
    for (_, i) in hits {
        println!("{}", line(&s.lessons[i]));
    }
    Ok(())
}

/// The situation of a session in `dir`: its repo, and its branch + `extra` as the task.
fn situation(dir: Option<&str>, extra: &[&str]) -> Situation {
    let head = dir.and_then(|d| crate::core::git::head_of(Path::new(d)));
    let mut task: Vec<String> = Vec::new();
    if let Some(b) = head.as_ref().and_then(|h| h.branch.clone())
        && !matches!(b.as_str(), "main" | "master" | "develop")
    {
        task.push(b.replace(['/', '-', '_'], " "));
    }
    task.extend(extra.iter().map(|s| s.to_string()));
    Situation {
        repo: head.and_then(|h| h.repo),
        task: task.join("\n"),
    }
}

fn recall(task: Option<&str>, dir: Option<&str>, limit: usize, json: bool) -> Result<()> {
    let dir = dir.map(crate::core::tools::expand_tilde).or_else(cwd);
    let s = lessons::load()?;
    let sit = situation(dir.as_deref(), &task.into_iter().collect::<Vec<_>>());
    let picks = lessons::select(&s.lessons, &sit, limit, &HashSet::new());
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "repo": sit.repo, "task": sit.task, "picks": picks
            }))?
        );
        return Ok(());
    }
    println!(
        "{}",
        format!(
            "repo {} · task words: {}",
            sit.repo.as_deref().unwrap_or("-"),
            lessons::tokens(&sit.task).join(" ")
        )
        .dimmed()
    );
    if picks.is_empty() {
        println!("nothing would be injected");
    }
    for p in &picks {
        let l = &s.lessons[s.find(&p.id)?];
        println!("{:>5.2} {:<5} {} {}", p.score, p.why, l.id.bold(), l.title);
    }
    Ok(())
}

fn confirm(id: &str, quote: Option<String>) -> Result<()> {
    let now = lessons::now_iso();
    let l = lessons::update(|s| {
        let i = s.find(id)?;
        let ev = evidence("confirm", quote, own_session(), &now);
        s.lessons[i].confirm(ev, &now);
        Ok(s.lessons[i].clone())
    })?;
    println!(
        "confirmed {} (seen {}, confidence {:.2})",
        l.id.bold(),
        l.occurrences,
        l.confidence
    );
    Ok(())
}

fn retire(id: &str, reason: &str) -> Result<()> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(Error::Other("--reason must not be empty".into()));
    }
    let now = lessons::now_iso();
    let l = lessons::update(|s| {
        let i = s.find(id)?;
        let l = &mut s.lessons[i];
        l.status = "retired".into();
        l.retired_at = Some(now.clone());
        l.retired_reason = Some(reason.to_string());
        Ok(l.clone())
    })?;
    println!(
        "retired {} — it will not be injected or proposed again",
        l.id.bold()
    );
    Ok(())
}

fn edit(id: &str, c: &ChangeArgs) -> Result<()> {
    let l = lessons::update(|s| {
        let i = s.find(id)?;
        c.changes().apply(&mut s.lessons[i])?;
        Ok(s.lessons[i].clone())
    })?;
    println!("{}", line(&l));
    Ok(())
}

fn proposals(json: bool) -> Result<()> {
    let s = lessons::load()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&s.proposals)?);
        return Ok(());
    }
    if s.proposals.is_empty() {
        println!("no proposals");
    }
    for p in &s.proposals {
        let d = &p.draft;
        let scope = d.repo.as_deref().unwrap_or("global");
        println!(
            "{} {}  {}",
            p.pid.bold(),
            d.title,
            format!(
                "({scope}, {}, {})",
                d.kind.as_deref().unwrap_or("approach"),
                p.created_at
            )
            .dimmed()
        );
        println!("    {}", d.rule);
        if !d.consequence.is_empty() {
            println!("    {} {}", "why:".dimmed(), d.consequence);
        }
        for e in &d.evidence {
            println!("    {} \"{}\"", "quote:".dimmed(), e.quote);
        }
    }
    if !s.proposals.is_empty() {
        println!(
            "\n{}",
            "overmind lesson accept <pid> [--tier/--scope/…] · overmind lesson reject <pid> --reason …"
                .dimmed()
        );
    }
    Ok(())
}

fn accept(pid: &str, c: &ChangeArgs) -> Result<()> {
    let (handle, persona) = (lessons::handle(), lessons::persona());
    let now = lessons::now_iso();
    let l = lessons::update(|s| {
        let i = s.find_proposal(pid)?;
        let p = s.proposals[i].clone();
        let conf = c.confidence.unwrap_or(lessons::CONF_MINED);
        let mut l = s
            .add(p.draft, "mined", conf, &handle, &persona, &now)?
            .clone();
        let last = s.lessons.len() - 1;
        c.changes().apply(&mut s.lessons[last])?;
        l.clone_from(&s.lessons[last]);
        s.proposals.remove(i);
        Ok(l)
    })?;
    println!("accepted as {} {}", l.id.bold(), where_(&l).dimmed());
    Ok(())
}

fn reject(pid: &str, reason: Option<String>) -> Result<()> {
    let now = lessons::now_iso();
    let title = lessons::update(|s| {
        let i = s.find_proposal(pid)?;
        let p = s.proposals.remove(i);
        s.rejected.push(lessons::Rejected {
            title: p.draft.title.clone(),
            rule: p.draft.rule,
            reason: reason.filter(|r| !r.trim().is_empty()),
            at: now.clone(),
        });
        Ok(p.draft.title)
    })?;
    println!("rejected \"{title}\" — it will not be proposed again");
    Ok(())
}

fn mine(
    target: &str,
    dir: Option<&str>,
    model: Option<&str>,
    again: bool,
    json: bool,
) -> Result<()> {
    let dir = dir.map(crate::core::tools::expand_tilde);
    let (transcript, session) = if target.ends_with(".jsonl") || Path::new(target).is_file() {
        (
            PathBuf::from(crate::core::tools::expand_tilde(target)),
            None,
        )
    } else {
        let home = crate::core::discovery::claude_home();
        let p = crate::core::context::locate_transcript(&home, dir.as_deref(), target)
            .ok_or_else(|| Error::Other(format!("no transcript for session {target}")))?;
        (p, Some(target.to_string()))
    };
    let model = model
        .map(String::from)
        .or_else(|| lessons::setting("mineModel"))
        .unwrap_or_else(|| lessons_mine::DEFAULT_MODEL.into());
    let rep = lessons_mine::mine(&lessons_mine::Opts {
        transcript: &transcript,
        session: session.as_deref(),
        cwd: dir.as_deref(),
        model: &model,
        again,
    })?;
    if json {
        println!("{}", serde_json::to_string_pretty(&rep)?);
        return Ok(());
    }
    if let Some(why) = &rep.skipped {
        println!("not mined: {why}");
        return Ok(());
    }
    if rep.proposed.is_empty() && rep.confirmed.is_empty() {
        println!("no new lessons");
    }
    if !rep.proposed.is_empty() {
        println!(
            "proposed {} — review with: overmind lesson proposals",
            rep.proposed.join(", ")
        );
    }
    if !rep.confirmed.is_empty() {
        println!("confirmed {}", rep.confirmed.join(", "));
    }
    for d in &rep.dropped {
        println!("{} {d}", "dropped:".dimmed());
    }
    Ok(())
}

fn import(files: &[String], extra_repos: &[String], json: bool) -> Result<()> {
    let mut texts = Vec::new();
    for f in files {
        let p = crate::core::tools::expand_tilde(f);
        let text = std::fs::read_to_string(&p).map_err(|e| Error::Other(format!("{f}: {e}")))?;
        texts.push((f.clone(), text));
    }
    for r in extra_repos {
        lessons::check_repo(r)?;
    }
    let now = lessons::now_iso();
    let reports = lessons::update(|s| {
        let mut repos = lessons::known_repos(s);
        repos.extend(extra_repos.iter().cloned());
        Ok(texts
            .iter()
            .map(|(name, text)| {
                let source = Path::new(name)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| name.clone());
                (
                    name.clone(),
                    lessons::import(s, text, &source, &repos, &now),
                )
            })
            .collect::<Vec<_>>())
    })?;
    if json {
        let v: Vec<Value> = reports
            .iter()
            .map(|(f, r)| json!({ "file": f, "report": r }))
            .collect();
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    for (f, r) in &reports {
        println!(
            "{f}: adopted {} · already had {} · retired {} · other repos {}{}",
            r.adopted.len(),
            r.already,
            r.retired,
            r.other_repo,
            if r.invalid.is_empty() {
                String::new()
            } else {
                format!(" · invalid {}", r.invalid.len())
            }
        );
        for e in &r.invalid {
            eprintln!("{} {e}", "skipped:".yellow());
        }
    }
    Ok(())
}

fn export(out: Option<&str>) -> Result<()> {
    let s = lessons::load()?;
    let mut mine: Vec<&Lesson> = s.lessons.iter().filter(|l| l.is_mine()).collect();
    mine.sort_by(|a, b| {
        a.persona
            .cmp(&b.persona)
            .then(id_order(&a.id).cmp(&id_order(&b.id)))
    });
    let mut by_persona: std::collections::BTreeMap<&str, Vec<String>> = Default::default();
    let mut held = 0;
    for l in mine {
        match lessons::export_line(l) {
            Some(line) => by_persona.entry(&l.persona).or_default().push(line),
            None => held += 1,
        }
    }
    if held > 0 {
        eprintln!(
            "{} {held} lesson(s) left out: they look like they hold a secret or personal data",
            "note:".yellow()
        );
    }
    match out {
        None => {
            for lines in by_persona.values() {
                for l in lines {
                    println!("{l}");
                }
            }
        }
        Some(dir) => {
            let dir = PathBuf::from(crate::core::tools::expand_tilde(dir));
            std::fs::create_dir_all(&dir)?;
            for (persona, lines) in &by_persona {
                let p = dir.join(format!("{persona}.jsonl"));
                std::fs::write(&p, lines.join("\n") + "\n")?;
                eprintln!("wrote {} ({} lessons)", p.display(), lines.len());
            }
        }
    }
    Ok(())
}

/// Sort key for `<handle>/<persona>#<n>`: the prefix, then n as a number.
fn id_order(id: &str) -> (String, u64) {
    match id.rsplit_once('#') {
        Some((p, n)) => (p.to_string(), n.parse().unwrap_or(u64::MAX)),
        None => (id.to_string(), u64::MAX),
    }
}

// ------------------------------------------------------------------ hook

fn hook_config() -> Value {
    let h = json!([{ "hooks": [{ "type": "command", "command": "overmind lesson hook", "timeout": 10 }] }]);
    json!({ "hooks": { "SessionStart": h, "UserPromptSubmit": h, "SessionEnd": h } })
}

/// Lessons are off for this process: `OVERMIND_LESSONS=off`, a headless `claude -p`, or the
/// miner's own `claude -p`.
pub fn lessons_off() -> bool {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    matches!(env("OVERMIND_LESSONS").as_str(), "off" | "0" | "false")
        || env("CLAUDE_CODE_ENTRYPOINT").starts_with("sdk")
}

/// The hook: never fails the session — any error means no output.
fn hook() {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() || lessons_off() {
        return;
    }
    let Ok(input) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    if let Some(out) = hook_answer(&input) {
        println!("{out}");
    }
}

/// What the hook prints for one event (none: nothing to add).
pub fn hook_answer(input: &Value) -> Option<String> {
    let s = |k: &str| input[k].as_str().map(str::trim).filter(|v| !v.is_empty());
    let event = s("hook_event_name")?;
    let sid = s("session_id")?;
    let cwd = s("cwd");
    match event {
        "SessionStart" => {
            let mut extra = Vec::new();
            let brief = crate::core::brief::briefs_dir()
                .ok()
                .and_then(|d| crate::core::brief::read(&d, sid).ok().flatten())
                .map(|b| b.chars().take(4000).collect::<String>());
            extra.extend(brief.as_deref());
            inject(event, sid, cwd, &extra, lessons::INJECT_LIMIT, false)
        }
        "UserPromptSubmit" => {
            let prompt = s("prompt")?;
            inject(event, sid, cwd, &[prompt], lessons::PROMPT_LIMIT, true)
        }
        "SessionEnd" => {
            if lessons::mining_on()
                && let Some(t) = s("transcript_path")
            {
                spawn_miner(t, cwd);
            }
            None
        }
        _ => None,
    }
}

/// What a session was already given: `<lessons dir>/lessons-injected/<sid>.json`.
fn marker_path(sid: &str) -> Option<PathBuf> {
    if !crate::core::brief::is_session_id(sid) {
        return None;
    }
    let base = lessons::path().parent()?.join("lessons-injected");
    Some(base.join(format!("{sid}.json")))
}

fn inject(
    event: &str,
    sid: &str,
    cwd: Option<&str>,
    extra: &[&str],
    limit: usize,
    on_prompt: bool,
) -> Option<String> {
    let marker = marker_path(sid)?;
    let mut seen: Value = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "ids": [], "prompted": false }));
    if on_prompt && seen["prompted"] == true {
        return None;
    }
    let store = lessons::load().ok()?;
    let skip: HashSet<String> = seen["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let sit = situation(cwd, extra);
    let picks = lessons::select(&store.lessons, &sit, limit, &skip);
    let mut ids: Vec<String> = skip.into_iter().collect();
    ids.extend(picks.iter().map(|p| p.id.clone()));
    ids.sort();
    seen["ids"] = json!(ids);
    if on_prompt {
        seen["prompted"] = json!(true);
    }
    seen["at"] = json!(lessons::now_iso());
    write_marker(&marker, &seen);
    if picks.is_empty() {
        return None;
    }
    let chosen: Vec<&Lesson> = picks
        .iter()
        .filter_map(|p| store.lessons.iter().find(|l| l.id == p.id))
        .collect();
    let out = json!({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": lessons::context_block(&chosen),
        }
    });
    Some(out.to_string())
}

/// Write a marker, and drop the ones older than a week.
fn write_marker(p: &Path, v: &Value) {
    let Some(dir) = p.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let _ = std::fs::write(p, v.to_string());
    let week = std::time::Duration::from_secs(7 * 86_400);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > week);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Start `overmind lesson mine` detached (its own process group, output to
/// `<lessons dir>/lessons-mine.log`): mining takes a minute, the hook must not.
fn spawn_miner(transcript: &str, cwd: Option<&str>) {
    use std::os::unix::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let log = lessons::path()
        .parent()
        .map(|d| d.join("lessons-mine.log"))
        .and_then(|p| {
            std::fs::create_dir_all(p.parent()?).ok()?;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .ok()
        });
    let mut c = std::process::Command::new(exe);
    // The transcript path, not the id: it is known here (its file name is the session id).
    c.args(["--local", "lesson", "mine", transcript])
        .env("OVERMIND_LESSONS", "off")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .process_group(0);
    if let Some(d) = cwd {
        c.args(["-C", d]);
    }
    match log {
        Some(f) => {
            c.stderr(f);
        }
        None => {
            c.stderr(std::process::Stdio::null());
        }
    }
    let _ = c.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_sort_by_number() {
        let mut ids = vec!["a/c#10", "a/c#9", "a/c#100"];
        ids.sort_by_key(|i| id_order(i));
        assert_eq!(ids, vec!["a/c#9", "a/c#10", "a/c#100"]);
    }

    #[test]
    fn hook_config_installs_three_events() {
        let v = hook_config();
        for e in ["SessionStart", "UserPromptSubmit", "SessionEnd"] {
            assert_eq!(
                v["hooks"][e][0]["hooks"][0]["command"],
                "overmind lesson hook"
            );
        }
    }

    #[test]
    fn unknown_events_and_bad_input_say_nothing() {
        assert!(hook_answer(&json!({})).is_none());
        assert!(hook_answer(&json!({"hook_event_name": "Stop", "session_id": "x"})).is_none());
    }
}
