//! Shared helpers: every test runs `overmind` against a temp config (never the
//! user's real one) with ssh multiplexing off.
#![allow(dead_code, deprecated)]

use std::path::{Path, PathBuf};

pub struct Env {
    pub dir: tempfile::TempDir,
}

impl Env {
    pub fn new() -> Self {
        Env {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.dir.path().join("config.json")
    }

    pub fn write_config(&self, v: &serde_json::Value) -> PathBuf {
        let p = self.config_path();
        std::fs::write(&p, serde_json::to_string_pretty(v).unwrap()).unwrap();
        p
    }

    pub fn read_config(&self) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(self.config_path()).unwrap()).unwrap()
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    /// `overmind` with OVERMIND_CONFIG pointed into the temp dir.
    pub fn cmd(&self) -> assert_cmd::Command {
        let mut c = assert_cmd::Command::cargo_bin("overmind").unwrap();
        c.env("OVERMIND_CONFIG", self.config_path())
            // `overmind list` records the session snapshot: never into the real one.
            .env("OVERMIND_SNAPSHOT", self.path("snapshot.json"))
            // …nor which process runs which Codex / pi thread (this machine's live ones).
            .env("OVERMIND_HARNESS_OWNERS", self.path("harness-owners.json"))
            .env("OVERMIND_MUX", "0")
            .env("OVERMIND_CONNECT_TIMEOUT", "2")
            .env("NO_COLOR", "1")
            .env_remove("OVERMIND_HOST")
            .env_remove("OVERMIND_DRY_RUN")
            .env_remove("OVERMIND_AS_HOST");
        c
    }
}

/// A two-host config: this machine is `laptop`, tmux commands go to
/// `workstation` (reachable as ssh alias `devbox`).
pub fn two_hosts() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "self": "laptop",
        "defaultHost": "workstation",
        "hosts": {
            "laptop": { "ssh": null, "web": null },
            "workstation": { "ssh": "devbox", "web": null }
        },
        "web": { "port": 7878, "bind": "0.0.0.0", "dir": null },
        "tmux": null,
        "spawnDirs": []
    })
}

pub fn fixture(dir: &Path, json: &str) -> PathBuf {
    let p = dir.join("overmind-fixture.json");
    std::fs::write(&p, json).unwrap();
    p
}

pub fn stdout(o: &std::process::Output) -> String {
    String::from_utf8_lossy(&o.stdout).to_string()
}

pub fn stderr(o: &std::process::Output) -> String {
    String::from_utf8_lossy(&o.stderr).to_string()
}
