//! `overmind codex hooks install|uninstall|status` — the opt-in Codex hook that tells
//! Overmind when a Codex session waits on an approval (see [`crate::core::codex_hooks`]).

use std::path::PathBuf;

use crate::core::codex_hooks::{self, Installed, Status};
use crate::core::harness::codex_home;
use crate::error::{Error, Result};

#[derive(clap::Subcommand, Debug, Clone)]
pub enum CodexCmd {
    /// The approval hook in $CODEX_HOME/hooks.json (PermissionRequest, Stop, UserPromptSubmit)
    Hooks {
        #[command(subcommand)]
        action: HooksAction,
    },
}

#[derive(clap::Subcommand, Debug, Clone)]
pub enum HooksAction {
    /// Add Overmind's hook (Codex asks you to trust it at its next start)
    Install,
    /// Remove Overmind's hook, leaving every other hook alone
    Uninstall,
    /// Installed? Trusted and enabled per event? (and the Codex daemon it runs under)
    Status {
        #[arg(long)]
        json: bool,
    },
}

pub fn run(cmd: &CodexCmd) -> Result<()> {
    let CodexCmd::Hooks { action } = cmd;
    let home = codex_home();
    match action {
        HooksAction::Install => install(&home),
        HooksAction::Uninstall => uninstall(&home),
        HooksAction::Status { json } => {
            let st = codex_hooks::status(&home, &exe()?, &codex_hooks::sidecar_dir())?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&st)?);
            } else {
                print_status(&st);
            }
            Ok(())
        }
    }
}

/// The binary as invoked, not canonicalised: a symlink like `~/.local/bin/overmind`
/// stays the same path across rebuilds, so Codex's trust in the hook survives them.
fn exe() -> Result<PathBuf> {
    let argv0 = std::env::args_os().next().map(PathBuf::from);
    match argv0 {
        Some(p) if p.is_absolute() => Ok(p),
        Some(p) if p.components().count() > 1 => Ok(std::env::current_dir()?
            .join(p)
            .components()
            .filter(|c| !matches!(c, std::path::Component::CurDir))
            .collect()),
        _ => std::env::current_exe().map_err(Error::from),
    }
}

/// Verified on Codex 0.166: the app-server daemon applies a new hooks.json to sessions
/// started after it, without a restart (docs/codex-findings.md).
const RUNNING_NOTE: &str = "Codex sessions already running keep the hooks they started with; new ones (daemon or embedded) get it.";

fn install(home: &std::path::Path) -> Result<()> {
    let exe = exe()?;
    let path = codex_hooks::hooks_path(home);
    let what = codex_hooks::install(home, &exe, &codex_hooks::sidecar_dir())?;
    match &what {
        Installed::AlreadyInstalled => println!("Already installed: {}", path.display()),
        Installed::Fresh => println!("Installed: {}", path.display()),
        Installed::Rewritten { old } => {
            println!(
                "Updated: {} (the hook ran {old}; re-trust needed)",
                path.display()
            )
        }
    }
    println!("Hook binary: {}", exe.display());
    if what != Installed::AlreadyInstalled {
        println!("Codex reviews new hooks at its next start — accept the review.");
        println!("{RUNNING_NOTE}");
    }
    Ok(())
}

fn uninstall(home: &std::path::Path) -> Result<()> {
    let path = codex_hooks::hooks_path(home);
    let (changed, shifted) = codex_hooks::uninstall(home, &codex_hooks::sidecar_dir())?;
    if changed {
        println!("Removed Overmind's hook from {}", path.display());
    } else {
        println!("Not installed: {}", path.display());
    }
    if shifted {
        println!(
            "A hook of yours followed Overmind's under the same event: its position changed, so Codex asks you to trust it once more."
        );
    }
    println!(
        "Codex sessions already running keep the hook until they restart (their sidecars may reappear meanwhile)."
    );
    Ok(())
}

fn print_status(st: &Status) {
    if !st.installed {
        println!(
            "Not installed ({}) — run `overmind codex hooks install`",
            st.path
        );
        return;
    }
    println!("Installed: {}", st.path);
    let bin = st.binary.as_deref().unwrap_or("?");
    if st.binary_matches {
        println!("Hook binary: {bin}");
    } else {
        println!(
            "Hook binary: {bin} — not this overmind; `overmind codex hooks install` points it here"
        );
    }
    for (event, v) in &st.events {
        let line = match v["trust"].as_str() {
            Some("stale") => {
                "changed since you trusted it — Codex asks for a review at its next start; accept it"
            }
            Some("trusted" | "unverified") if v["enabled"] == false => "disabled in `/hooks`",
            Some("trusted") => "trusted, enabled",
            Some("unverified") => {
                "trusted, enabled (unverified: no install record to date the trust by — if Codex asks for a review, accept it)"
            }
            _ => "not trusted yet — start `codex` and accept the review",
        };
        println!("  {event}: {line}");
    }
}
