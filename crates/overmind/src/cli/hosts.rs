//! Machine-level verbs: `exec`, `ssh`, `doctor`, `list --all-hosts`, `install`,
//! and the hidden `_probe` that `doctor` runs on each host.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use colored::Colorize;
use serde::{Deserialize, Serialize};

use crate::core::config;
use crate::core::discovery::Session;
use crate::core::harness::{self, Harness};
use crate::core::hosts::{self, Remote, Target, Tty};
use crate::core::tools::{self, remote_path, shq, shq_min};
use crate::error::{Error, Result};

fn ok(msg: &str) {
    println!("  {} {msg}", "✔".green());
}
fn bad(msg: &str) {
    println!("  {} {msg}", "✘".red());
}
fn info(msg: &str) {
    println!("  {msg}");
}

// --- exec / ssh ----------------------------------------------------------------

/// Run a command on a host. Locally through a login shell (so PATH matches an
/// interactive session); remotely over ssh, where the remote login shell does
/// the same. The exit code passes through verbatim.
pub fn exec(target: &Target, dir: Option<&str>, tty: bool, argv: &[String]) -> Result<i32> {
    if argv.is_empty() {
        return Err(Error::exit(
            1,
            "usage: overmind exec [-C <dir>] [-t] -- <cmd...>",
        ));
    }
    let dir = dir.unwrap_or("~");
    match target {
        Target::Local { .. } => {
            let dir = tools::expand_tilde(dir);
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut c = Command::new(&shell);
            c.args([
                "-l",
                "-c",
                "cd \"$1\" && shift && exec \"$@\"",
                "overmind-exec",
                &dir,
            ]);
            c.args(argv);
            if hosts::dry_run() {
                println!("{}", hosts::display_command(&c));
                return Ok(0);
            }
            let st = c
                .status()
                .map_err(|e| Error::Other(format!("cannot run {shell}: {e}")))?;
            Ok(st.code().unwrap_or(1))
        }
        Target::Remote(r) => {
            let dir = tools::tildify(dir);
            let dir = dir.as_str();
            if !(dir.starts_with('/') || dir == "~" || dir.starts_with("~/")) {
                return Err(Error::exit(
                    1,
                    format!("--dir must be absolute or ~/… when targeting {}", r.name),
                ));
            }
            let mut s = format!("cd {} && exec", remote_path(dir));
            for a in argv {
                s.push(' ');
                s.push_str(&shq_min(a));
            }
            // No 255 remapping: the code is the command's own.
            hosts::run_remote_shell(r, &s, if tty { Tty::Auto } else { Tty::Never }, true)
        }
    }
}

/// A plain shell (or one command) on a host, no tmux.
pub fn ssh(target: &Target, argv: &[String]) -> Result<i32> {
    match target {
        Target::Local { .. } => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut c = Command::new(&shell);
            if argv.is_empty() {
                c.arg("-l");
            } else {
                c.args(["-l", "-c", "exec \"$@\"", "overmind-ssh"])
                    .args(argv);
            }
            if hosts::dry_run() {
                println!("{}", hosts::display_command(&c));
                return Ok(0);
            }
            use std::os::unix::process::CommandExt;
            Err(Error::Other(format!("cannot exec {shell}: {}", c.exec())))
        }
        Target::Remote(r) => {
            let s = if argv.is_empty() {
                "exec \"${SHELL:-/bin/sh}\" -l".to_string()
            } else {
                let mut s = String::from("exec");
                for a in argv {
                    s.push(' ');
                    s.push_str(&shq_min(a));
                }
                s
            };
            if !hosts::dry_run() && !tools::interactive() {
                return Err(Error::exit(
                    3,
                    "'overmind ssh' needs a terminal (stdin/stdout is not a tty)",
                ));
            }
            hosts::run_remote_shell(r, &s, Tty::Auto, false)
        }
    }
}

// --- probe / doctor ------------------------------------------------------------

/// What `overmind _probe` reports about the machine it runs on.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Probe {
    pub overmind_version: String,
    pub overmind_path: Option<String>,
    pub hostname: String,
    pub user: String,
    /// `uname -sm`, e.g. `Darwin arm64`.
    pub platform: String,
    pub tmux: Option<String>,
    pub claude: Option<String>,
    /// `codex --version` of the launcher `harness list` uses; `null` when there is none.
    pub codex: Option<String>,
    /// Codex's home (`$CODEX_HOME`, default `~/.codex`) exists: it has run here.
    pub codex_home: bool,
    /// Codex has a login there ([`crate::core::harness::codex_login`]).
    pub codex_login: bool,
    /// …only as far as its config keeps credentials in the OS keyring, which overmind can't
    /// read ([`crate::core::harness::CodexLogin::Keyring`]).
    pub codex_keyring: bool,
    /// `pi --version`; `null` when pi isn't installed.
    pub pi: Option<String>,
    pub node: Option<String>,
    pub tmux_sessions: usize,
    /// Live sessions per harness.
    pub claude_sessions: usize,
    pub codex_sessions: usize,
    pub pi_sessions: usize,
    pub config_path: String,
    pub config_exists: bool,
    pub config_self: Option<String>,
    pub config_problems: Vec<String>,
    pub web_dir: Option<String>,
    /// GitHub-triggered bots: their last poll, and whether the tick service runs them.
    pub bots: Vec<BotHealth>,
}

/// One line of `doctor` about a bot that needs the tick service or polls GitHub.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BotHealth {
    pub name: String,
    pub ok: bool,
    pub line: String,
}

/// `<bin> --version` of a harness launcher: stdin closed, the fallback dirs on `PATH` (an
/// npm-installed launcher is a `#!/usr/bin/env node` script, and node may be in nvm/Volta too),
/// and killed after a few seconds (a wrapper that ignores `--version` and starts its TUI).
/// A launcher that runs but prints nothing still counts as there: `"?"`.
fn launcher_version(bin: &Path) -> String {
    harness::run_with_timeout(
        Command::new(bin)
            .arg("--version")
            .env("PATH", tools::search_path()),
        Duration::from_secs(5),
    )
    .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
    .filter(|l| !l.is_empty())
    .unwrap_or_else(|| "?".into())
}

fn first_line(cmd: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(cmd).args(args).output().ok()?;
    if !o.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&o.stdout);
    s.lines().next().map(|l| l.trim().to_string())
}

pub fn uname() -> String {
    first_line("uname", &["-sm"]).unwrap_or_default()
}

pub fn gather_probe() -> Probe {
    let loaded = config::load();
    let mut problems = loaded.config.problems();
    if let Some(p) = &loaded.problem {
        problems.insert(0, p.clone());
    }
    if !loaded.exists {
        problems.clear();
    }
    let claude = tools::claude().and_then(|c| first_line(&c, &["--version"]));
    let node = tools::find_binary("node")
        .and_then(|n| first_line(&n.display().to_string(), &["--version"]));
    let version_of = |h: Harness| harness::binary(&h.command()).map(|b| launcher_version(&b));
    let codex_home = harness::codex_home();
    let codex_login = harness::codex_login(&codex_home);
    let rows = crate::core::discovery::discover();
    let sessions = |h: Harness| rows.iter().filter(|s| s.harness == h).count();
    Probe {
        overmind_version: crate::VERSION.into(),
        overmind_path: std::env::current_exe()
            .ok()
            .map(|p| tools::tildify(&p.display().to_string())),
        hostname: first_line("hostname", &["-s"]).unwrap_or_default(),
        user: std::env::var("USER").unwrap_or_default(),
        platform: uname(),
        tmux: crate::core::tmux::version(),
        claude,
        codex: version_of(Harness::Codex),
        codex_home: codex_home.is_dir(),
        codex_login: codex_login.logged_in(),
        codex_keyring: codex_login == harness::CodexLogin::Keyring,
        pi: version_of(Harness::Pi),
        node,
        tmux_sessions: crate::core::tmux::list_sessions()
            .map(|v| v.len())
            .unwrap_or(0),
        claude_sessions: sessions(Harness::Claude),
        codex_sessions: sessions(Harness::Codex),
        pi_sessions: sessions(Harness::Pi),
        config_path: tools::tildify(&loaded.path.display().to_string()),
        config_exists: loaded.exists,
        config_self: loaded.config.self_name.clone(),
        config_problems: problems,
        web_dir: config::web_dir(&loaded.config).map(|p| tools::tildify(&p.display().to_string())),
        bots: crate::cli::jobs::health(),
    }
}

pub fn probe() -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&gather_probe())?);
    Ok(())
}

/// How a doctor line is marked: ✔, ✘, or plain.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Mark {
    Ok,
    Bad,
    Info,
}

fn report_probe(p: &Probe, compare: Option<&str>) -> usize {
    let (lines, failures) = probe_lines(p, compare);
    for (mark, line) in lines {
        match mark {
            Mark::Ok => ok(&line),
            Mark::Bad => bad(&line),
            Mark::Info => info(&line),
        }
    }
    failures
}

/// `codex-cli 0.166.0` → `codex 0.166.0`.
fn codex_version(v: &str) -> String {
    let v = v.trim();
    let bare = v
        .strip_prefix("codex-cli ")
        .or_else(|| v.strip_prefix("codex "))
        .unwrap_or(v);
    format!("codex {bare}")
}

#[derive(Default)]
struct Lines(Vec<(Mark, String)>);

impl Lines {
    fn ok(&mut self, s: &str) {
        self.0.push((Mark::Ok, s.into()));
    }
    fn bad(&mut self, s: &str) {
        self.0.push((Mark::Bad, s.into()));
    }
    fn info(&mut self, s: &str) {
        self.0.push((Mark::Info, s.into()));
    }
}

/// The doctor's lines about one machine, and how many of them are failures.
fn probe_lines(p: &Probe, compare: Option<&str>) -> (Vec<(Mark, String)>, usize) {
    let mut l = Lines::default();
    let mut failures = 0;
    let overmind = format!(
        "overmind {} ({})",
        p.overmind_version,
        p.overmind_path.as_deref().unwrap_or("?")
    );
    match compare {
        Some(v) if v != p.overmind_version => {
            l.bad(&format!(
                "{overmind} — differs from this machine's {v}; run: overmind install --host <name>"
            ));
            failures += 1;
        }
        _ => l.ok(&overmind),
    }
    l.info(&format!(
        "host: {} ({}, {})",
        p.hostname, p.user, p.platform
    ));
    match &p.tmux {
        Some(t) => l.ok(&format!("{t} — {} session(s)", p.tmux_sessions)),
        None => {
            l.bad("tmux: missing");
            failures += 1;
        }
    }
    // Doctor fails only when nothing can run here: a Codex that isn't logged in is a note on a
    // host that has Claude or pi, and a failure on a Codex-only one.
    let codex_usable = p.codex.is_some() && p.codex_home && p.codex_login;
    let usable = p.claude.is_some() || codex_usable || p.pi.is_some();
    match &p.claude {
        Some(c) => l.ok(&format!(
            "claude {c} — {} live session(s)",
            p.claude_sessions
        )),
        // A Codex- or pi-only host is a supported setup.
        None if usable => l.info(&format!(
            "{} claude: missing (fine: this host runs another harness)",
            "·".dimmed()
        )),
        None => {
            l.bad("claude: missing, and no other harness can run here (install Claude Code, or Codex and `codex login`, or pi)");
            failures += 1;
        }
    }
    let codex_problem = |v: &str| {
        let why = if p.codex_home {
            "not logged in"
        } else {
            "never run here (no $CODEX_HOME, default ~/.codex)"
        };
        format!("{}: {why} — run `codex login`", codex_version(v))
    };
    match &p.codex {
        Some(v) if codex_usable => {
            let keyring = if p.codex_keyring {
                " (credentials in keyring, unverified)"
            } else {
                ""
            };
            l.ok(&format!(
                "{} — {} live session(s){keyring}",
                codex_version(v),
                p.codex_sessions
            ));
        }
        Some(v) if usable => l.info(&format!("{} {}", "·".dimmed(), codex_problem(v))),
        Some(v) => {
            l.bad(&codex_problem(v));
            failures += 1;
        }
        None => l.info(&format!(
            "{} codex: missing (optional — brew install codex, or npm i -g @openai/codex; or set harnesses.codex.command)",
            "·".dimmed()
        )),
    }
    if let Some(v) = &p.pi {
        l.ok(&format!("pi {v} — {} live session(s)", p.pi_sessions));
    }
    match &p.node {
        Some(n) => l.ok(&format!("node {n}")),
        None => l.info(&format!(
            "{} node: missing (only needed for `overmind web serve`)",
            "·".dimmed()
        )),
    }
    match &p.web_dir {
        Some(d) => l.ok(&format!("web app: {d}")),
        None => l.info(&format!(
            "{} web app: not found (only needed for `overmind web serve`)",
            "·".dimmed()
        )),
    }
    for b in &p.bots {
        if b.ok {
            l.ok(&b.line);
        } else {
            l.bad(&b.line);
            failures += 1;
        }
    }
    if p.config_exists {
        let who = p.config_self.as_deref().unwrap_or("(self unset)");
        if p.config_problems.is_empty() {
            l.ok(&format!("config {} — self: {who}", p.config_path));
        } else {
            l.bad(&format!("config {} — self: {who}", p.config_path));
            for pr in &p.config_problems {
                l.info(&format!("    {pr}"));
            }
            failures += 1;
        }
    } else {
        l.info(&format!(
            "{} config: none at {} (run: overmind init)",
            "·".dimmed(),
            p.config_path
        ));
    }
    (l.0, failures)
}

/// Reachability, versions on both ends, and config sanity.
pub fn doctor(only: Option<&str>) -> Result<()> {
    let loaded = config::load();
    let cfg = &loaded.config;
    println!("overmind doctor — v{}", crate::VERSION);
    info(&format!(
        "self: {}   default host: {}",
        cfg.self_name(),
        cfg.default_host()
    ));
    if hosts::mux_enabled() {
        info(&format!("mux:  {}", tools::tildify(&hosts::mux_path())));
    } else {
        info("mux:  disabled (OVERMIND_MUX=0, or no ~/.ssh)");
    }

    let mut failures = 0;
    println!(
        "\n{} {}",
        "●".cyan(),
        format!("{} (this machine)", cfg.self_name()).bold()
    );
    let me = gather_probe();
    failures += report_probe(&me, None);

    let targets: Vec<Target> = match only {
        Some(h) => vec![hosts::resolve(cfg, Some(h), false, hosts::Scope::SelfHost)?],
        None => hosts::all_targets(cfg)
            .into_iter()
            .filter_map(|t| match t {
                Ok(t) => Some(t),
                Err(e) => {
                    bad(&e.to_string());
                    failures += 1;
                    None
                }
            })
            .collect(),
    };
    for t in targets {
        let Target::Remote(r) = t else { continue };
        println!(
            "\n{} {}",
            "●".cyan(),
            format!("{} (ssh {})", r.name, r.dest).bold()
        );
        failures += doctor_remote(&r, &me.overmind_version);
    }
    if failures > 0 {
        return Err(Error::exit(1, format!("{failures} problem(s) found")));
    }
    Ok(())
}

fn doctor_remote(r: &Remote, local_version: &str) -> usize {
    let t0 = Instant::now();
    let reach = hosts::capture_shell(r, "true", Duration::from_secs(hosts::connect_timeout() + 5));
    match reach {
        Ok(c) if c.ok() => ok(&format!("reached in {}ms", t0.elapsed().as_millis())),
        Ok(c) => {
            bad(&c.why(r));
            let err = c.stderr.trim();
            if !err.is_empty() {
                info(&format!(
                    "    {}",
                    err.lines().last().unwrap_or(err).dimmed()
                ));
            }
            info(&format!("    check:  ssh -v {} true", r.dest));
            return 1;
        }
        Err(e) => {
            bad(&e.to_string());
            return 1;
        }
    }
    match hosts::capture_remote(r, &["_probe".to_string()], hosts::remote_timeout()) {
        Ok(c) if c.ok() => match serde_json::from_str::<Probe>(&c.stdout) {
            Ok(p) => report_probe(&p, Some(local_version)),
            Err(e) => {
                bad(&format!(
                    "overmind there answered, but not with a probe ({e}) — version too old?"
                ));
                1
            }
        },
        Ok(c) => {
            bad(&c.why(r));
            1
        }
        Err(e) => {
            bad(&e.to_string());
            1
        }
    }
}

// --- list --all-hosts ------------------------------------------------------------

/// One host's answer to `list --json`.
pub struct HostRows {
    pub host: String,
    pub rows: std::result::Result<Vec<Session>, String>,
}

/// `list --json` on every configured host, in parallel, rows tagged with the
/// host name *this* config knows it by.
pub fn gather_all_hosts() -> Vec<HostRows> {
    gather_hosts(None)
}

/// [`gather_all_hosts`] limited to shared (`Some(true)`) or own (`Some(false)`) hosts.
fn gather_hosts(only_shared: Option<bool>) -> Vec<HostRows> {
    let cfg = config::get();
    let names: Vec<String> = cfg
        .ssh_host_names()
        .into_iter()
        .filter(|n| only_shared.is_none_or(|want| cfg.is_shared(n) == want))
        .collect();
    let handles: Vec<_> = names
        .into_iter()
        .map(|name| {
            let target = hosts::resolve(cfg, Some(&name), false, hosts::Scope::SelfHost);
            std::thread::spawn(move || {
                let rows = match target {
                    Err(e) => Err(e.to_string()),
                    Ok(Target::Local { .. }) => Ok(crate::cli::commands::list_rows()),
                    Ok(Target::Remote(r)) => {
                        match hosts::capture_remote(
                            &r,
                            &["list".into(), "--json".into()],
                            hosts::remote_timeout(),
                        ) {
                            Err(e) => Err(e.to_string()),
                            Ok(c) if !c.ok() => Err(c.why(&r)),
                            Ok(c) => serde_json::from_str::<Vec<Session>>(&c.stdout)
                                .map_err(|e| format!("bad JSON from {}: {e}", r.name)),
                        }
                    }
                };
                let rows = rows.map(|mut v| {
                    for s in v.iter_mut() {
                        s.host = Some(name.clone());
                    }
                    v
                });
                HostRows { host: name, rows }
            })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

/// `list --all-hosts` (`only_shared`: `--shared` → `Some(true)`, `--mine` → `Some(false)`).
/// JSON rows carry `shared` (their host's `hosts.<name>.shared`).
pub fn list_all_hosts(json: bool, only_shared: Option<bool>) -> Result<()> {
    let cfg = config::get();
    let all = gather_hosts(only_shared);
    let mut any_ok = false;
    let mut rows = Vec::new();
    for h in &all {
        match &h.rows {
            Ok(v) => {
                any_ok = true;
                if !json {
                    println!(
                        "{}\n",
                        crate::cli::render::plain_table_titled(v, Some(&h.host))
                    );
                }
                rows.extend(v.iter().cloned());
            }
            Err(e) => {
                eprintln!("{} {}: {e}", "overmind:".red(), h.host);
            }
        }
    }
    if json {
        let rows: Vec<serde_json::Value> = rows
            .iter()
            .map(|s| {
                let mut v = serde_json::to_value(s).unwrap_or_default();
                if let Some(o) = v.as_object_mut() {
                    let shared = s.host.as_deref().is_some_and(|h| cfg.is_shared(h));
                    o.insert("shared".into(), shared.into());
                }
                v
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows)?);
    }
    if all.is_empty() {
        return Ok(());
    }
    if !any_ok {
        return Err(Error::exit(hosts::EXIT_UNREACHABLE, "no host answered"));
    }
    Ok(())
}

// --- install -------------------------------------------------------------------

/// Where `overmind install` puts the binary on a host.
pub const INSTALLED_BIN: &str = "~/.local/bin/overmind";

fn run_step(what: &str, mut c: Command) -> Result<()> {
    if hosts::dry_run() {
        println!("{}", hosts::display_command(&c));
        return Ok(());
    }
    hosts::debug(&hosts::display_command(&c));
    let st = c.status().map_err(|e| {
        Error::Other(format!(
            "{what}: cannot run {}: {e}",
            c.get_program().to_string_lossy()
        ))
    })?;
    if !st.success() {
        return Err(Error::Other(format!("{what} failed ({st})")));
    }
    Ok(())
}

fn remote_step(r: &Remote, what: &str, script: &str) -> Result<String> {
    if hosts::dry_run() {
        println!(
            "{}",
            hosts::display_command(&hosts::ssh_command(&r.dest, script, Tty::Never))
        );
        return Ok(String::new());
    }
    let c = hosts::capture_shell(r, script, hosts::remote_timeout())?;
    if !c.ok() {
        let err = c.stderr.trim();
        return Err(Error::Other(format!(
            "{what} on {}: {}{}",
            r.name,
            c.why(r),
            if err.is_empty() || c.code == Some(255) {
                String::new()
            } else {
                format!("\n    {err}")
            }
        )));
    }
    Ok(c.stdout)
}

/// Copy a directory's contents to `dest:remote_dir`, skipping tests, VCS and
/// dependencies anywhere, plus the top-level entries in `skip_top` (which are also
/// left alone on the remote). rsync when available (so removed files go too), tar
/// over ssh otherwise.
fn sync_dir(r: &Remote, local: &Path, remote_dir: &str, skip_top: &[&str]) -> Result<()> {
    const EXCLUDES: [&str; 4] = ["node_modules", "tests", ".git", ".DS_Store"];
    if tools::find_binary("rsync").is_some() {
        let mut c = Command::new("rsync");
        c.args(["-az", "--delete"]);
        for e in EXCLUDES {
            c.arg(format!("--exclude={e}"));
        }
        // A leading `/` anchors the pattern at the transfer root.
        for e in skip_top {
            c.arg(format!("--exclude=/{e}"));
        }
        let ssh_e = std::iter::once("ssh".to_string())
            .chain(hosts::ssh_opts().iter().map(|o| shq_min(o)))
            .collect::<Vec<_>>()
            .join(" ");
        c.args(["-e", &ssh_e]);
        c.arg(format!("{}/", local.display()));
        // rsync paths are relative to the remote home.
        let rel = remote_dir.strip_prefix("~/").unwrap_or(remote_dir);
        c.arg(format!("{}:{rel}/", r.dest));
        return run_step("rsync", c);
    }
    let mut excl = String::new();
    for e in EXCLUDES {
        excl.push_str(&format!(" --exclude={}", shq(e)));
    }
    // tar's --exclude is unanchored in bsdtar, so top-level skips are done by naming
    // the entries to pack instead of `.`.
    let entries = if skip_top.is_empty() {
        ".".to_string()
    } else {
        top_entries(local, skip_top)?
            .iter()
            .map(|e| shq(e))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let script = format!(
        "tar -C {} -cf -{excl} {entries} | ssh {} {} {}",
        shq(&local.display().to_string()),
        hosts::ssh_opts()
            .iter()
            .map(|o| shq_min(o))
            .collect::<Vec<_>>()
            .join(" "),
        shq(&r.dest),
        shq(&format!(
            "rm -rf {d} && mkdir -p {d} && tar -C {d} -xf -",
            d = remote_path(remote_dir)
        ))
    );
    let mut c = Command::new("sh");
    c.args(["-c", &script]);
    run_step("copy web app", c)
}

/// `dir`'s top-level entry names minus `skip`, sorted (for the tar fallback).
fn top_entries(dir: &Path, skip: &[&str]) -> Result<Vec<String>> {
    let mut out: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !skip.contains(&n.as_str()))
        .collect();
    out.sort();
    Ok(out)
}

/// The built React UI inside a web dir (`npm --prefix web/ui run build`), if built.
pub fn built_ui(web: &Path) -> Option<PathBuf> {
    let dist = web.join("ui").join("dist");
    dist.join("index.html").is_file().then_some(dist)
}

pub const UI_BUILD_HINT: &str =
    "npm --prefix web/ui ci && npm --prefix web/ui run build   (or: overmind web build)";

/// Copy the web app: the server, then only the *built* React UI
/// (`ui/dist`) — never its sources or node_modules.
fn install_web(r: &Remote, dir: &Path) -> Result<()> {
    let remote_ui = format!("{}/ui", config::INSTALLED_WEB_DIR);
    let remote_dist = format!("{remote_ui}/dist");
    let dist = built_ui(dir);
    // rsync needs the destination's parent; a stale remote ui/ would keep serving an old build.
    let prep = match &dist {
        Some(_) => format!("mkdir -p {}", remote_path(&remote_ui)),
        None => format!("rm -rf {}", remote_path(&remote_ui)),
    };
    remote_step(
        r,
        "prepare web dir",
        &format!(
            "mkdir -p {} && {prep}",
            remote_path(config::INSTALLED_WEB_DIR)
        ),
    )?;
    sync_dir(r, dir, config::INSTALLED_WEB_DIR, &["ui"])?;
    match &dist {
        Some(d) => sync_dir(r, d, &remote_dist, &[])?,
        None => eprintln!(
            "overmind: the web UI is not built ({}/ui/dist missing) — {} gets no UI until it is; build it with:\n  {UI_BUILD_HINT}",
            tools::tildify(&dir.display().to_string()),
            r.name
        ),
    }
    if !hosts::dry_run() {
        println!(
            "  {} {} (from {}{})",
            "✔".green(),
            config::INSTALLED_WEB_DIR,
            tools::tildify(&dir.display().to_string()),
            if dist.is_some() {
                ", with ui/dist"
            } else {
                ", no UI (not built)"
            }
        );
    }
    Ok(())
}

pub struct InstallOpts {
    pub web: bool,
    pub force: bool,
}

/// Copy this binary (and the web app) to a remote host's `~/.local`.
pub fn install(target: &Target, o: InstallOpts) -> Result<()> {
    let Target::Remote(r) = target else {
        return Err(Error::exit(
            1,
            "install copies this binary to another host — pass --host <name> (a configured remote host)",
        ));
    };
    let exe = std::env::current_exe()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);

    // Same OS and CPU, or the copy is useless.
    let local = uname();
    let remote = remote_step(r, "uname", "uname -sm")?;
    let remote = remote.trim();
    if !hosts::dry_run() && remote != local {
        if o.force {
            eprintln!(
                "overmind: {} is {remote}, this machine is {local} — installing anyway (--force)",
                r.name
            );
        } else {
            return Err(Error::exit(
                1,
                format!(
                    "{} is {remote} but this binary is built for {local} — build overmind for that platform there (cargo install --path crates/overmind), or --force",
                    r.name
                ),
            ));
        }
    }
    println!(
        "→ installing overmind {} on {} ({})",
        crate::VERSION,
        r.name,
        if remote.is_empty() { &local } else { remote }
    );

    remote_step(
        r,
        "mkdir",
        "mkdir -p \"$HOME/.local/bin\" \"$HOME/.local/share/overmind\"",
    )?;
    let mut scp = Command::new("scp");
    scp.args(hosts::ssh_opts()).arg("-q").arg(&exe);
    scp.arg(format!("{}:.local/bin/overmind.new", r.dest));
    run_step("scp", scp)?;
    let version = remote_step(
        r,
        "activate",
        "chmod 755 \"$HOME/.local/bin/overmind.new\" && mv -f \"$HOME/.local/bin/overmind.new\" \"$HOME/.local/bin/overmind\" && \"$HOME/.local/bin/overmind\" --version",
    )?;
    if !hosts::dry_run() {
        println!("  {} {INSTALLED_BIN} — {}", "✔".green(), version.trim());
    }

    if o.web {
        match config::web_dir(config::get()) {
            Some(dir) => install_web(r, &dir)?,
            None => eprintln!(
                "overmind: web app not found here (set web.dir, or run from a checkout) — skipped"
            ),
        }
    }

    if hosts::dry_run() {
        return Ok(());
    }
    // Is it usable over there? The probe says whether it has a config yet.
    match hosts::capture_remote(r, &["_probe".to_string()], hosts::remote_timeout()) {
        Ok(c) if c.ok() => {
            if let Ok(p) = serde_json::from_str::<Probe>(&c.stdout) {
                if !p.config_exists {
                    println!(
                        "  {} no config on {} yet — run: overmind -H {} init",
                        "·".dimmed(),
                        r.name,
                        r.name
                    );
                }
                if p.tmux.is_none() {
                    println!("  {} tmux is missing on {}", "✘".red(), r.name);
                }
            }
        }
        Ok(c) => eprintln!(
            "overmind: installed, but the remote probe failed: {}",
            c.why(r)
        ),
        Err(e) => eprintln!("overmind: installed, but the remote probe failed: {e}"),
    }
    println!("  next: overmind doctor --host {}", r.name);
    Ok(())
}

/// For `web install-service`: the absolute path of this binary.
pub fn current_exe() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmux_host() -> Probe {
        Probe {
            overmind_version: "1.0.0".into(),
            tmux: Some("tmux 3.5".into()),
            ..Probe::default()
        }
    }

    fn has(lines: &[(Mark, String)], mark: Mark, text: &str) -> bool {
        lines.iter().any(|(m, l)| *m == mark && l.contains(text))
    }

    #[test]
    fn a_codex_only_host_is_fine_claude_missing_is_info() {
        let p = Probe {
            codex: Some("codex-cli 0.166.0".into()),
            codex_home: true,
            codex_login: true,
            codex_sessions: 2,
            ..tmux_host()
        };
        let (lines, failures) = probe_lines(&p, None);
        assert_eq!(failures, 0, "{lines:?}");
        assert!(
            has(&lines, Mark::Ok, "codex 0.166.0 — 2 live session(s)"),
            "{lines:?}"
        );
        assert!(has(&lines, Mark::Info, "claude: missing"), "{lines:?}");
        assert!(!lines.iter().any(|(m, _)| *m == Mark::Bad), "{lines:?}");

        // pi alone also makes Claude optional
        let p = Probe {
            pi: Some("0.9.0".into()),
            pi_sessions: 1,
            ..tmux_host()
        };
        let (lines, _) = probe_lines(&p, None);
        assert!(
            has(&lines, Mark::Ok, "pi 0.9.0 — 1 live session(s)"),
            "{lines:?}"
        );
        assert!(has(&lines, Mark::Info, "claude: missing"), "{lines:?}");
    }

    #[test]
    fn no_harness_at_all_fails_doctor() {
        let (lines, failures) = probe_lines(&tmux_host(), None);
        assert_eq!(failures, 1, "{lines:?}");
        assert!(
            has(
                &lines,
                Mark::Bad,
                "claude: missing, and no other harness can run here"
            ),
            "{lines:?}"
        );
        assert!(has(&lines, Mark::Info, "codex: missing"), "{lines:?}");
        assert!(
            has(&lines, Mark::Info, "npm i -g @openai/codex"),
            "{lines:?}"
        );
        assert!(!lines.iter().any(|(_, l)| l.starts_with("pi")), "{lines:?}");
    }

    #[test]
    fn a_codex_that_cannot_run_is_info_beside_claude_and_a_failure_alone() {
        let claude = Probe {
            claude: Some("2.1.0 (Claude Code)".into()),
            claude_sessions: 3,
            codex: Some("codex-cli 0.166.0".into()),
            ..tmux_host()
        };
        // never run here, then not logged in: a note, Claude still runs
        let (lines, failures) = probe_lines(&claude, None);
        assert_eq!(failures, 0, "{lines:?}");
        assert!(
            has(
                &lines,
                Mark::Ok,
                "claude 2.1.0 (Claude Code) — 3 live session(s)"
            ),
            "{lines:?}"
        );
        assert!(
            has(&lines, Mark::Info, "codex 0.166.0: never run here"),
            "{lines:?}"
        );
        let p = Probe {
            codex_home: true,
            ..claude
        };
        let (lines, failures) = probe_lines(&p, None);
        assert_eq!(failures, 0, "{lines:?}");
        assert!(
            has(
                &lines,
                Mark::Info,
                "codex 0.166.0: not logged in — run `codex login`"
            ),
            "{lines:?}"
        );
        assert!(!lines.iter().any(|(m, _)| *m == Mark::Bad), "{lines:?}");

        // Codex-only, not logged in / never run: nothing can run, so both lines fail
        for home in [true, false] {
            let p = Probe {
                codex: Some("codex-cli 0.166.0".into()),
                codex_home: home,
                ..tmux_host()
            };
            let (lines, failures) = probe_lines(&p, None);
            assert_eq!(failures, 2, "{lines:?}");
            assert!(has(&lines, Mark::Bad, "claude: missing"), "{lines:?}");
            assert!(
                has(&lines, Mark::Bad, "codex 0.166.0: ") && has(&lines, Mark::Bad, "codex login"),
                "{lines:?}"
            );
        }
    }

    #[test]
    fn a_keyring_login_counts_but_says_it_is_unverified() {
        let p = Probe {
            codex: Some("codex-cli 0.166.0".into()),
            codex_home: true,
            codex_login: true,
            codex_keyring: true,
            ..tmux_host()
        };
        let (lines, failures) = probe_lines(&p, None);
        assert_eq!(failures, 0, "{lines:?}");
        assert!(
            has(
                &lines,
                Mark::Ok,
                "codex 0.166.0 — 0 live session(s) (credentials in keyring, unverified)"
            ),
            "{lines:?}"
        );
    }

    #[test]
    fn an_old_probe_without_the_harness_keys_still_parses() {
        let p: Probe = serde_json::from_str(
            r#"{"overmindVersion":"0.9.0","claude":"2.0.0","claudeSessions":4,"tmux":"tmux 3.4"}"#,
        )
        .unwrap();
        assert_eq!(p.claude_sessions, 4);
        assert_eq!((p.codex, p.codex_sessions, p.codex_login), (None, 0, false));
        let back: serde_json::Value = serde_json::to_value(Probe::default()).unwrap();
        for k in [
            "codex",
            "codexHome",
            "codexLogin",
            "codexKeyring",
            "codexSessions",
            "pi",
            "piSessions",
        ] {
            assert!(back.get(k).is_some(), "{k} missing from {back}");
        }
    }
}
