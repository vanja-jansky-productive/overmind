//! `overmind group` — the smart-grouping pass (see `core::grouping`).
//!
//! It only reads sessions and asks `claude -p`; nothing is ever sent to a
//! session. Without `--apply` the result is printed and the state file is left
//! alone; `-n` builds the prompts but calls no model.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::time::Instant;

use colored::Colorize;

use crate::cli::render::home_rel;
use crate::core::config;
use crate::core::grouping::{
    self, Consolidate, Item, MoveTo, Observed, PassOpts, Report, State, ask_model, llm_allowed,
    run_pass, view,
};
use crate::error::{Error, Result};

pub struct GroupOpts {
    pub all_hosts: bool,
    pub json: bool,
    pub apply: bool,
    pub refresh: bool,
    pub consolidate: bool,
    pub cached: bool,
    pub input: Option<String>,
    pub dry_run: bool,
    /// `--rename` / `--move`: edit the stored groups instead of running a pass.
    pub edit: Option<Edit>,
}

/// A change made on the board (web `POST /api/groups/edit`).
pub enum Edit {
    Rename {
        id: String,
        label: String,
    },
    Create {
        label: String,
    },
    Delete {
        id: String,
    },
    /// `session` is `host/sessionId` (or `host/pid`).
    Move {
        session: String,
        to: MoveTo,
    },
}

/// One host's dormant session ids; `None` = couldn't be read (nothing of that host is pruned).
type DormantIds = Option<HashSet<String>>;

/// The dormant session ids of every configured host (and of this machine under its own
/// label), fetched in parallel: this machine reads its snapshot, a remote one answers
/// `overmind restore --json` (only when `remotes`). A fixture never reaches a remote host.
fn gather_dormant(remotes: bool) -> BTreeMap<String, DormantIds> {
    use crate::core::hosts::{self, Target};
    let cfg = config::get();
    let fixture = crate::core::discovery::is_fixture();
    let handles: Vec<_> = cfg
        .ssh_host_names()
        .into_iter()
        .map(|name| {
            let target = hosts::resolve(cfg, Some(&name), false, hosts::Scope::SelfHost);
            std::thread::spawn(move || {
                let ids = match target {
                    Err(_) => None,
                    Ok(Target::Local { .. }) => {
                        crate::core::snapshot::dormant_session_ids_checked()
                    }
                    Ok(Target::Remote(_)) if fixture || !remotes => Some(HashSet::new()),
                    Ok(Target::Remote(r)) => remote_dormant(&r),
                };
                (name, ids)
            })
        })
        .collect();
    let mut out: BTreeMap<String, DormantIds> =
        handles.into_iter().filter_map(|h| h.join().ok()).collect();
    out.entry(crate::cli::commands::host_label())
        .or_insert_with(crate::core::snapshot::dormant_session_ids_checked);
    out
}

/// `overmind restore --json` on `r` → its dormant session ids. An overmind too old to know
/// `restore` has none; any other failure is unknown.
fn remote_dormant(r: &crate::core::hosts::Remote) -> DormantIds {
    use crate::core::hosts;
    let c = hosts::capture_remote(
        r,
        &["restore".into(), "--json".into()],
        hosts::remote_timeout(),
    )
    .ok()?;
    if !c.ok() {
        hosts::debug(&format!("[{}] dormant list: {}", r.name, c.why(r)));
        return c
            .stderr
            .contains("unrecognized subcommand")
            .then(HashSet::new);
    }
    dormant_ids_of(&serde_json::from_str(&c.stdout).ok()?)
}

/// The session ids in a `overmind restore --json` list (`dormant[].sessions[].sessionId`).
fn dormant_ids_of(v: &serde_json::Value) -> DormantIds {
    let list = v.get("dormant")?.as_array()?;
    Some(
        list.iter()
            .filter_map(|d| d.get("sessions").and_then(|s| s.as_array()))
            .flatten()
            .filter_map(|s| s.get("sessionId").and_then(|i| i.as_str()))
            .map(str::to_string)
            .collect(),
    )
}

/// What the pass sees: the live sessions plus every answering host's dormant ones
/// (fetched alongside, so a reboot doesn't cost the board its groups).
fn observe(o: &GroupOpts) -> Result<(Observed, BTreeMap<String, String>)> {
    let remotes = o.all_hosts || o.input.is_some();
    let dormant = std::thread::spawn(move || gather_dormant(remotes));
    let (mut obs, hosts) = observe_live(o)?;
    let dormant = dormant.join().unwrap_or_default();
    let answered: Vec<String> = obs.hosts_ok.iter().cloned().collect();
    for h in answered {
        // A host this config doesn't know has nothing dormant (as before).
        let ids = dormant
            .get(&h)
            .cloned()
            .unwrap_or_else(|| Some(HashSet::new()));
        obs.add_dormant(&h, ids.as_ref());
    }
    Ok((obs, hosts))
}

fn observe_live(o: &GroupOpts) -> Result<(Observed, BTreeMap<String, String>)> {
    let mut hosts = BTreeMap::new();
    if let Some(src) = &o.input {
        let text = if src == "-" {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        } else {
            std::fs::read_to_string(crate::core::tools::expand_tilde(src))
                .map_err(|e| Error::Other(format!("cannot read {src}: {e}")))?
        };
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let obs = Observed::from_json(&v).map_err(Error::Other)?;
        for h in &obs.hosts_ok {
            hosts.insert(h.clone(), "ok".to_string());
        }
        if let Some(hs) = v.get("hosts").and_then(|h| h.as_array()) {
            for h in hs {
                if let Some(n) = h.get("name").and_then(|n| n.as_str())
                    && !obs.hosts_ok.contains(n)
                {
                    let why = h.get("error").and_then(|e| e.as_str()).unwrap_or("not ok");
                    hosts.insert(n.to_string(), why.to_string());
                }
            }
        }
        return Ok((obs, hosts));
    }
    let mut obs = Observed::default();
    if o.all_hosts {
        for h in crate::cli::hosts::gather_all_hosts() {
            match h.rows {
                Ok(rows) => {
                    obs.hosts_ok.insert(h.host.clone());
                    obs.items
                        .extend(rows.iter().map(|s| Item::from_session(s, &h.host)));
                    hosts.insert(h.host, "ok".into());
                }
                Err(e) => {
                    hosts.insert(h.host, e);
                }
            }
        }
        if obs.hosts_ok.is_empty() {
            return Err(Error::exit(
                crate::core::hosts::EXIT_UNREACHABLE,
                "no host answered",
            ));
        }
    } else {
        let me = crate::cli::commands::host_label();
        let rows = crate::cli::commands::list_rows();
        obs.hosts_ok.insert(me.clone());
        obs.items
            .extend(rows.iter().map(|s| Item::from_session(s, &me)));
        hosts.insert(me, "ok".into());
    }
    Ok((obs, hosts))
}

pub fn run(o: GroupOpts) -> Result<()> {
    let path = grouping::state_path();
    let mut state = State::load_from(&path);

    if let Some(edit) = &o.edit {
        let now = chrono::Utc::now().timestamp_millis();
        match edit {
            Edit::Rename { id, label } => grouping::rename_group(&mut state, id, label, now),
            Edit::Create { label } => grouping::create_group(&mut state, label, now).map(drop),
            Edit::Delete { id } => grouping::delete_group(&mut state, id, now),
            Edit::Move { session, to } => match session.split_once('/') {
                Some((host, id)) if !host.is_empty() && !id.is_empty() => {
                    grouping::move_session(&mut state, host, id, to, now).map(drop)
                }
                _ => Err(format!("--move wants host/sessionId, got \"{session}\"")),
            },
        }
        .map_err(Error::Other)?;
        if o.dry_run {
            eprintln!("{}", "dry run: nothing saved".dimmed());
        } else {
            state
                .save_to(&path)
                .map_err(|e| Error::Other(format!("cannot write {}: {e}", path.display())))?;
        }
    }

    if o.cached || o.edit.is_some() {
        let (groups, ungrouped) = view(&state, None);
        let report = Report {
            version: grouping::STATE_VERSION,
            applied: true,
            updated_at: state.updated_at,
            last_run: state.last_run.clone(),
            groups,
            ungrouped,
            hosts: BTreeMap::new(),
        };
        return print(&report, o.json, &path, None);
    }

    let (obs, hosts) = observe(&o)?;
    let cfg = &config::get().grouping;
    let fixture = crate::core::discovery::is_fixture();
    let opts = PassOpts {
        allow_llm: llm_allowed(cfg.enabled()),
        refresh: o.refresh,
        consolidate: if o.consolidate {
            Consolidate::Force
        } else {
            Consolidate::Auto
        },
        dry_run: o.dry_run,
        now: chrono::Utc::now().timestamp_millis(),
        consolidate_every_ms: cfg.consolidate_every_ms(),
    };
    let model = cfg.model();
    let started = Instant::now();
    let mut sum = run_pass(&mut state, &obs, &opts, |p| ask_model(p, &model));
    sum.ms = started.elapsed().as_millis() as i64;

    // A fixture is a demo: it never touches the real state file — only one
    // named explicitly (tests).
    let applied =
        o.apply && !o.dry_run && (!fixture || std::env::var_os("OVERMIND_GROUPS_STATE").is_some());
    if applied {
        state.last_run = Some(sum.clone());
        state
            .save_to(&path)
            .map_err(|e| Error::Other(format!("cannot write {}: {e}", path.display())))?;
    }
    let (groups, ungrouped) = view(&state, Some(&obs));
    let report = Report {
        version: grouping::STATE_VERSION,
        applied,
        updated_at: state.updated_at,
        last_run: Some(sum),
        groups,
        ungrouped,
        hosts,
    };
    print(&report, o.json, &path, Some(o.dry_run))
}

fn print(r: &Report, json: bool, path: &std::path::Path, dry: Option<bool>) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(r)?);
        return Ok(());
    }
    for (h, why) in &r.hosts {
        if why != "ok" {
            eprintln!("{} {h}: {why}", "overmind:".red());
        }
    }
    if r.groups.is_empty() && r.ungrouped.is_empty() {
        println!("{}", "no groups".dimmed());
    }
    for g in &r.groups {
        let src = if g.source == "fallback" {
            " (by repository)".dimmed().to_string()
        } else {
            String::new()
        };
        println!(
            "{} {}{src}",
            g.label.bold(),
            format!("({})", g.members.len()).dimmed()
        );
        if let Some(d) = &g.description {
            println!("  {}", d.dimmed());
        }
        for m in &g.members {
            println!(
                "    {}  {}",
                format!("{:<12}", m.host).dimmed(),
                m.name.as_deref().unwrap_or(&m.id)
            );
        }
    }
    if !r.ungrouped.is_empty() {
        println!(
            "{} {}",
            "Ungrouped".bold(),
            format!("({})", r.ungrouped.len()).dimmed()
        );
        for m in &r.ungrouped {
            println!(
                "    {}  {}",
                format!("{:<12}", m.host).dimmed(),
                m.name.as_deref().unwrap_or(&m.id)
            );
        }
    }
    if let Some(s) = &r.last_run {
        let mut line = format!(
            "{}: {} classified, {} kept, {} model call(s), {}ms",
            s.mode, s.classified, s.kept, s.model_calls, s.ms
        );
        if s.merged + s.renamed > 0 {
            line.push_str(&format!(", {} merged, {} renamed", s.merged, s.renamed));
        }
        println!("\n{}", line.dimmed());
        if let Some(n) = &s.note {
            println!("{}", n.dimmed());
        }
    }
    let where_ = home_rel(&path.to_string_lossy());
    match dry {
        None => println!("{}", format!("state: {where_}").dimmed()),
        Some(_) if r.applied => println!("{}", format!("saved to {where_}").dimmed()),
        Some(_) => println!(
            "{}",
            format!("not saved — --apply writes {where_}").dimmed()
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dormant_ids_come_from_a_restore_list() {
        let v = json!({ "host": "workstation", "bootId": "1", "dormant": [
            { "kind": "tmux", "target": "api", "name": "api", "sessions": [
                { "sessionId": "s-1" }, { "sessionId": "s-2" } ] },
            { "kind": "claude", "target": "s-3", "name": "x", "sessions": [ { "sessionId": "s-3" } ] },
            { "kind": "tmux", "target": "shell", "name": "shell", "sessions": [] }
        ]});
        let ids = dormant_ids_of(&v).unwrap();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains("s-1") && ids.contains("s-3"));
        assert_eq!(
            dormant_ids_of(&json!({ "dormant": [] })),
            Some(HashSet::new())
        );
        assert_eq!(
            dormant_ids_of(&json!({ "error": "x" })),
            None,
            "unknown, not empty"
        );
    }
}
