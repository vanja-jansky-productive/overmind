//! GitHub-triggered bots end to end: `overmind bots check` against a branch fixture
//! (`OVERMIND_GH_WATCH_FIXTURE`, no network), spawning into an *isolated* tmux server (a wrapper
//! running `tmux -L overmind-test-<rand>`) with a fake `claude`. HOME, the config and the state
//! live in a temp dir; the user's own tmux server and sessions are never visible.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{Env, stderr, stdout};
use serde_json::{Value, json};

const FAKE_CLAUDE: &str = r#"#!/bin/sh
echo "$*" >> "$HOME/launches.log"
while :; do sleep 1; done
"#;

struct Rig {
    env: Env,
    sockets: tempfile::TempDir,
}

fn write_exe(p: &Path, body: &str) {
    std::fs::write(p, body).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

impl Rig {
    /// `None` when tmux isn't installed — the test then passes vacuously.
    fn new() -> Option<Self> {
        let tmux = overmind::core::tools::find_binary("tmux")?;
        let env = Env::new();
        let sockets = tempfile::Builder::new()
            .prefix("fb")
            .tempdir_in("/tmp")
            .ok()?;
        for d in ["home", "bin", "work", "state"] {
            std::fs::create_dir_all(env.path(d)).unwrap();
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        write_exe(
            &env.path("bin/tmux"),
            &format!(
                "#!/bin/sh\nexec '{}' -L 'overmind-test-{nanos:x}' \"$@\"\n",
                tmux.display()
            ),
        );
        write_exe(&env.path("bin/claude"), FAKE_CLAUDE);
        let rig = Rig { env, sockets };
        rig.env.write_config(&json!({
            "version": 1,
            "self": "laptop",
            "hosts": { "laptop": { "ssh": null } },
            "bots": {
                "release": {
                    "on": { "github": { "repo": "o/r", "branch": "release/*" } },
                    "dir": rig.s("work"),
                    "prompt": "Ship {branch} at {sha} from {repo}",
                    "command": rig.s("bin/claude"),
                    "keep": "never"
                }
            }
        }));
        Some(rig)
    }

    fn p(&self, rel: &str) -> PathBuf {
        self.env.path(rel)
    }

    fn s(&self, rel: &str) -> String {
        self.p(rel).display().to_string()
    }

    fn branches(&self, v: Value) {
        std::fs::write(self.p("branches.json"), v.to_string()).unwrap();
    }

    fn overmind(&self, args: &[&str]) -> std::process::Output {
        self.env
            .cmd()
            .env("OVERMIND_TMUX", self.p("bin/tmux"))
            .env("TMUX_TMPDIR", self.sockets.path())
            .env("HOME", self.p("home"))
            .env("XDG_STATE_HOME", self.p("state"))
            .env("OVERMIND_SNAPSHOT", self.p("state/snapshot.json"))
            .env("OVERMIND_GH_WATCH_FIXTURE", self.p("branches.json"))
            .env("SHELL", "/bin/sh")
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .env_remove("OVERMIND_FIXTURE")
            .env_remove("OVERMIND_JOBS_DIR")
            .env_remove("OVERMIND_GH_IDENTITY")
            .timeout(Duration::from_secs(30))
            .args(args)
            .output()
            .unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let o = self.overmind(args);
        assert!(o.status.success(), "{args:?}: {}{}", stdout(&o), stderr(&o));
        stdout(&o)
    }

    fn state(&self) -> Value {
        let p = self.p("state/overmind/jobs/release.json");
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    fn sessions(&self) -> Vec<String> {
        let out = std::process::Command::new(self.p("bin/tmux"))
            .args(["list-sessions", "-F", "#{session_name}"])
            .env("TMUX_TMPDIR", self.sockets.path())
            .env_remove("TMUX")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(String::from)
            .collect()
    }

    fn launches(&self) -> String {
        std::fs::read_to_string(self.p("home/launches.log")).unwrap_or_default()
    }

    fn wait_for(&self, what: &str, ok: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !ok() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::process::Command::new(self.p("bin/tmux"))
            .arg("kill-server")
            .env("TMUX_TMPDIR", self.sockets.path())
            .output();
        let _ = std::process::Command::new("pkill")
            .args(["-f", &self.s("bin/claude")])
            .output();
    }
}

#[test]
fn a_new_branch_starts_one_session_and_only_one() {
    let Some(rig) = Rig::new() else { return };

    // First poll: what is already there is remembered, not run.
    rig.branches(
        json!({ "o/r": [{ "name": "release/41", "sha": "a1" }, { "name": "main", "sha": "m" }] }),
    );
    rig.ok(&["bots", "check", "release"]);
    let st = rig.state();
    assert_eq!(st["github"]["armed"], true);
    assert_eq!(
        st["github"]["branches"]["release/41"]["outcome"],
        "existing"
    );
    assert!(st["github"]["branches"].get("main").is_none());
    assert!(rig.sessions().is_empty());

    // Dry run: says what it would start, starts nothing, changes nothing.
    rig.branches(json!({ "o/r": [{ "name": "release/41", "sha": "a1" }, { "name": "release/42", "sha": "b2" }] }));
    let out = rig.ok(&["bots", "check", "release", "--dry-run", "--json"]);
    let v: Value = serde_json::from_str(&out).unwrap();
    let actions: Vec<(&str, &str)> = v["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| (b["branch"].as_str().unwrap(), b["action"].as_str().unwrap()))
        .collect();
    assert_eq!(actions, [("release/41", "known"), ("release/42", "start")]);
    assert!(rig.sessions().is_empty());
    assert!(
        rig.state()["github"]["branches"]
            .get("release/42")
            .is_none()
    );

    // A real poll starts it, with the template filled in.
    rig.ok(&["bots", "check", "release"]);
    assert_eq!(rig.sessions(), ["release-release-42"]);
    let st = rig.state();
    let t = &st["github"]["branches"]["release/42"];
    assert_eq!(t["outcome"], "spawned");
    assert_eq!(t["tmuxSession"], "release-release-42");
    let run = st["runs"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(run["trigger"], "github");
    assert_eq!(run["subject"]["branch"], "release/42");
    assert_eq!(run["subject"]["sha"], "b2");
    assert_eq!(t["run"], run["id"]);
    rig.wait_for("the session to launch", || {
        rig.launches().contains("Ship release/42")
    });
    assert!(
        rig.launches().contains("Ship release/42 at b2 from o/r"),
        "{}",
        rig.launches()
    );

    // Every later poll (a new process each time, as after a restart): nothing new, even on a
    // new head.
    rig.branches(json!({ "o/r": [{ "name": "release/41", "sha": "a1" }, { "name": "release/42", "sha": "c3" }] }));
    rig.ok(&["bots", "check", "release"]);
    rig.ok(&["bots", "tick", "-q"]);
    assert_eq!(rig.sessions(), ["release-release-42"]);
    assert_eq!(rig.state()["github"]["branches"]["release/42"]["sha"], "c3");
    assert_eq!(rig.state()["runs"].as_array().unwrap().len(), 1);

    // Forgotten while its session is open: adopted, not started again.
    rig.ok(&["bots", "forget", "release", "release/42"]);
    rig.ok(&["bots", "check", "release"]);
    assert_eq!(rig.sessions(), ["release-release-42"]);
    assert_eq!(
        rig.state()["github"]["branches"]["release/42"]["outcome"],
        "adopted"
    );

    // Deleted: dropped from the state, its run marked, its session left open.
    rig.branches(json!({ "o/r": [{ "name": "release/41", "sha": "a1" }] }));
    rig.ok(&["bots", "check", "release"]);
    let st = rig.state();
    assert!(st["github"]["branches"].get("release/42").is_none());
    assert!(st["runs"][0]["subject"]["goneAt"].is_i64(), "{st}");
    assert_eq!(rig.sessions(), ["release-release-42"]);
    let show = rig.ok(&["bots", "show", "release"]);
    assert!(show.contains("branch gone"), "{show}");
}

#[test]
fn poll_errors_are_recorded_and_reported() {
    let Some(rig) = Rig::new() else { return };
    rig.branches(json!({ "o/r": { "error": "auth", "message": "Bad credentials" } }));
    let o = rig.overmind(&["bots", "check", "release"]);
    assert!(!o.status.success());
    let st = rig.state();
    assert_eq!(st["github"]["error"]["kind"], "auth");
    assert!(st["github"]["nextPoll"].is_i64());
    assert_eq!(st["github"]["armed"], false);
    // The tick backs off: no new poll before nextPoll.
    let before = st["github"]["lastPoll"].clone();
    rig.ok(&["bots", "tick", "-q"]);
    assert_eq!(rig.state()["github"]["lastPoll"], before);
    let list = rig.ok(&["bots"]);
    assert!(list.contains("poll failed: Bad credentials"), "{list}");

    // Recovery clears it.
    rig.branches(json!({ "o/r": [] }));
    rig.ok(&["bots", "check", "release"]);
    assert!(rig.state()["github"]["error"].is_null());
}

#[test]
fn manual_runs_of_github_bots_are_refused() {
    let Some(rig) = Rig::new() else { return };
    let o = rig.overmind(&["bots", "run", "release"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("once per branch"), "{}", stderr(&o));
}
