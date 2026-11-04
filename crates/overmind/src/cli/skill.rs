//! `overmind skill install|show` — the Claude Code skill embedded in the binary.

use std::path::PathBuf;

use crate::error::{Error, Result};

/// The skill text, embedded at build time.
pub const CONTENT: &str = include_str!("../../SKILL.md");
const TOOL: &str = "overmind";

#[derive(clap::Subcommand, Debug, Clone)]
pub enum SkillAction {
    /// Install SKILL.md to ~/.claude/skills/overmind/
    Install {
        /// Overwrite an existing, different SKILL.md
        #[arg(long)]
        force: bool,
    },
    /// Print SKILL.md to stdout
    Show,
}

pub fn run(action: &SkillAction) -> Result<()> {
    match action {
        SkillAction::Show => {
            print!("{CONTENT}");
            Ok(())
        }
        SkillAction::Install { force } => install(*force).map(|_| ()),
    }
}

fn install(force: bool) -> Result<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| Error::Other("cannot determine home directory".into()))?
        .join(".claude")
        .join("skills")
        .join(TOOL);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("SKILL.md");
    if path.exists() && !force {
        let existing = std::fs::read_to_string(&path)?;
        if existing == CONTENT {
            println!("Already up to date: {}", path.display());
            return Ok(path);
        }
        return Err(Error::Other(format!(
            "{} already exists (use --force to overwrite)",
            path.display()
        )));
    }
    std::fs::write(&path, CONTENT)?;
    println!("Installed: {}", path.display());
    Ok(path)
}
