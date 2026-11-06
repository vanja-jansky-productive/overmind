//! `overmind lesson …` end to end: a temp store, a temp config, a fake checkout and (for
//! mining) a fake `claude` on PATH. Never the user's home, config or sessions.

mod common;

use std::path::{Path, PathBuf};

use common::{Env, stdout};
use serde_json::{Value, json};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/agent-memory/claude.jsonl"
);
const SID: &str = "0b5e7a1c-2f3d-4e5f-8a9b-0c1d2e3f4a5b";

struct T {
    env: Env,
}

impl T {
    fn new(lessons_cfg: Value) -> T {
        let env = Env::new();
        std::fs::create_dir_all(env.path("home")).unwrap();
        std::fs::create_dir_all(env.path("roots")).unwrap();
        env.write_config(&json!({
            "version": 1,
            "self": "laptop",
            "hosts": { "laptop": { "ssh": null, "web": null } },
            "repos": { "roots": [env.path("roots")] },
            "lessons": lessons_cfg,
        }));
        T { env }
    }

    fn cmd(&self) -> assert_cmd::Command {
        let mut c = self.env.cmd();
        // Outside any checkout, so nothing picks up this repo's own origin.
        c.current_dir(self.env.path("home"))
            .env("OVERMIND_LESSONS_FILE", self.env.path("state/lessons.json"))
            .env("OVERMIND_BRIEFS_DIR", self.env.path("briefs"))
            .env("HOME", self.env.path("home"))
            .env("XDG_STATE_HOME", self.env.path("state"))
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .env_remove("OVERMIND_LESSONS");
        c
    }

    fn ok(&self, args: &[&str]) -> String {
        let o = self.cmd().args(args).output().unwrap();
        assert!(o.status.success(), "{args:?}: {}", common::stderr(&o));
        stdout(&o)
    }

    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_str(&self.ok(args)).unwrap()
    }

    /// A checkout of `slug` on `branch` (just the files `git::head_of` reads).
    fn repo(&self, name: &str, slug: &str, branch: &str) -> PathBuf {
        let d = self.env.path(name);
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::write(d.join(".git/HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
        std::fs::write(
            d.join(".git/config"),
            format!("[remote \"origin\"]\n\turl = git@github.com:{slug}.git\n"),
        )
        .unwrap();
        d
    }

    fn hook(&self, payload: Value, extra_env: &[(&str, &str)]) -> String {
        let mut c = self.cmd();
        for (k, v) in extra_env {
            c.env(k, v);
        }
        let o = c
            .args(["lesson", "hook"])
            .write_stdin(payload.to_string())
            .output()
            .unwrap();
        assert!(o.status.success());
        stdout(&o)
    }
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn learn_list_show_confirm_retire() {
    let t = T::new(json!({ "handle": "tester" }));
    let app = t.repo("app", "example/app", "main");
    let o = t
        .cmd()
        .current_dir(&app)
        .env("CLAUDE_CODE_SESSION_ID", SID)
        .args([
            "lesson",
            "learn",
            "--rule",
            "When cargo test hangs, look for a leftover tmux server first.",
            "--consequence",
            "Two hours went to a stale server.",
            "--quote",
            "it was the tmux server again",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", common::stderr(&o));
    let l: Value = serde_json::from_str(&stdout(&o)).unwrap();
    assert_eq!(l["id"], "tester/claude#1");
    assert_eq!(l["scope"], "repo");
    assert_eq!(l["repo"], "example/app");
    assert_eq!(l["confidence"], 0.7);
    assert_eq!(l["title"], "When cargo test hangs, look for a leftover…");
    assert_eq!(l["evidence"][0]["session"], SID);

    t.ok(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--title",
        "Lead with the answer",
        "--rule",
        "Put the result first.",
        "--consequence",
        "Preambles bury it.",
        "--tier",
        "2",
    ]);
    let list = t.json(&["lesson", "list", "--json"]);
    assert_eq!(list.as_array().unwrap().len(), 2);
    // Only lessons that hold in another repo.
    assert_eq!(
        t.json(&["lesson", "list", "--repo", "example/other", "--json"])
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let shown = t.json(&["lesson", "show", "1", "--json"]);
    assert_eq!(shown["uses"], 1);
    assert!(t.ok(&["lesson", "show", "#1"]).contains("claude --resume"));

    t.ok(&["lesson", "confirm", "tester/claude#1", "--quote", "again"]);
    let c = t.json(&["lesson", "show", "1", "--json"]);
    assert_eq!(
        (c["occurrences"].as_u64(), c["confidence"].as_f64()),
        (Some(2), Some(0.75))
    );

    t.ok(&["lesson", "edit", "1", "--tier", "0", "--kind", "friction"]);
    assert_eq!(t.json(&["lesson", "show", "1", "--json"])["tier"], 0);

    // Search reaches tier 2; recall never does.
    assert!(
        t.ok(&["lesson", "search", "result first"])
            .contains("Lead with the answer")
    );
    let r = t.json(&[
        "lesson",
        "recall",
        "-C",
        s(&app),
        "--task",
        "put the result first",
        "--json",
    ]);
    let ids: Vec<&str> = r["picks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["tester/claude#1"]);

    t.ok(&["lesson", "retire", "1", "--reason", "tmux is gone"]);
    assert_eq!(
        t.json(&["lesson", "list", "--json"])
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        t.json(&["lesson", "list", "--all", "--json"])
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let r = t.json(&["lesson", "recall", "-C", s(&app), "--json"]);
    assert!(r["picks"].as_array().unwrap().is_empty());

    let bad = t.cmd().args(["lesson", "show", "99"]).output().unwrap();
    assert!(!bad.status.success());
}

#[test]
fn import_once_and_export_only_mine() {
    let t = T::new(json!({ "handle": "tester" }));
    // A repo under repos.roots counts as one you work in.
    t.repo("roots/app", "example/app", "main");
    let rep = t.json(&["lesson", "import", FIXTURE, "--json"]);
    let adopted: Vec<&str> = rep[0]["report"]["adopted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        adopted,
        vec!["someone/claude#3", "someone/claude#7", "someone/claude#15"]
    );
    assert_eq!(rep[0]["report"]["other_repo"], 1);
    assert_eq!(rep[0]["report"]["retired"], 1);

    let list = t.json(&["lesson", "list", "--json"]);
    for l in list.as_array().unwrap() {
        assert_eq!(l["origin"], "imported");
        assert!(l["confidence"].as_f64().unwrap() <= 0.3);
        assert!(
            l["tier"].as_u64().unwrap() >= 1,
            "never tier 0: {}",
            l["id"]
        );
        assert_eq!(l["adopted_from"], "claude.jsonl");
    }

    // Never twice, not even after retiring one, and --repo widens the repos.
    t.ok(&[
        "lesson",
        "retire",
        "someone/claude#3",
        "--reason",
        "not for me",
    ]);
    let again = t.json(&[
        "lesson",
        "import",
        FIXTURE,
        "--repo",
        "example/other",
        "--json",
    ]);
    assert_eq!(again[0]["report"]["adopted"], json!(["someone/claude#9"]));
    assert_eq!(again[0]["report"]["already"], 3);

    // Export: only my own lessons, schema 1, no overmind fields.
    assert_eq!(t.ok(&["lesson", "export"]), "");
    t.ok(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--rule",
        "Quote every path.",
        "--consequence",
        "Spaces broke it.",
    ]);
    let out = t.ok(&["lesson", "export"]);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 1);
    let v: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(v["schema"], 1);
    assert_eq!(
        v["id"], "tester/claude#16",
        "past every number already used"
    );
    assert!(v.get("origin").is_none());
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys[0], "schema");

    // --out writes <persona>.jsonl, and what it writes imports back elsewhere.
    t.ok(&["lesson", "export", "--out", s(&t.env.path("out"))]);
    let file = t.env.path("out/claude.jsonl");
    let other = T::new(json!({}));
    let rep = other.json(&["lesson", "import", s(&file), "--json"]);
    assert_eq!(rep[0]["report"]["adopted"], json!(["tester/claude#16"]));
}

#[test]
fn every_line_of_the_fixture_parses() {
    let t = T::new(json!({}));
    let rep = t.json(&[
        "lesson",
        "import",
        FIXTURE,
        "--repo",
        "example/app",
        "--repo",
        "example/other",
        "--json",
    ]);
    assert!(rep[0]["report"]["invalid"].as_array().unwrap().is_empty());
}

#[test]
fn the_hook_injects_at_start_and_once_on_the_first_prompt() {
    let t = T::new(json!({ "handle": "tester", "mine": false }));
    let app = t.repo("app", "example/app", "feat/billing-export");
    t.ok(&[
        "lesson",
        "learn",
        "--repo",
        "example/app",
        "--tier",
        "0",
        "--rule",
        "Run the migration check before seeding.",
        "--consequence",
        "Stale schema.",
    ]);
    t.ok(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--title",
        "Flaky e2e selectors",
        "--rule",
        "When an e2e selector times out, check the aria label first.",
        "--consequence",
        "Retries hid it.",
    ]);
    t.ok(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--title",
        "Billing exports",
        "--rule",
        "When a billing export is wrong, compare currencies first.",
        "--consequence",
        "Rounding hid it.",
    ]);

    let start = t.hook(json!({"hook_event_name": "SessionStart", "session_id": SID, "cwd": s(&app), "source": "startup"}), &[]);
    let v: Value = serde_json::from_str(start.trim()).unwrap();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
    let ctx = v["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    // Tier 0 of this repo, and the branch (billing export) matches the third.
    assert!(
        ctx.contains("[tester/claude#1]") && ctx.contains("[tester/claude#3]"),
        "{ctx}"
    );
    assert!(!ctx.contains("[tester/claude#2]"));
    assert!(ctx.contains("overmind lesson retire"));

    let prompt = json!({"hook_event_name": "UserPromptSubmit", "session_id": SID, "cwd": s(&app),
        "prompt": "the e2e selector times out on the export page"});
    let first = t.hook(prompt.clone(), &[]);
    let ctx = serde_json::from_str::<Value>(first.trim()).unwrap()["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        ctx.contains("[tester/claude#2]") && !ctx.contains("[tester/claude#1]"),
        "{ctx}"
    );
    assert_eq!(t.hook(prompt.clone(), &[]), "", "only the first prompt");

    // Headless sessions and OVERMIND_LESSONS=off get nothing.
    let other = json!({"hook_event_name": "SessionStart", "session_id": "1b5e7a1c-2f3d-4e5f-8a9b-0c1d2e3f4a5b", "cwd": s(&app)});
    assert_eq!(
        t.hook(other.clone(), &[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")]),
        ""
    );
    assert_eq!(t.hook(other.clone(), &[("OVERMIND_LESSONS", "off")]), "");
    // Garbage in: nothing out, exit 0.
    let o = t
        .cmd()
        .args(["lesson", "hook"])
        .write_stdin("nope")
        .output()
        .unwrap();
    assert!(o.status.success() && o.stdout.is_empty());
    // SessionEnd with mining off: nothing, nothing spawned.
    assert_eq!(t.hook(json!({"hook_event_name": "SessionEnd", "session_id": SID, "transcript_path": "/nonexistent.jsonl"}), &[]), "");
}

fn transcript(path: &Path, prompts: &[&str]) {
    let mut out = String::new();
    for p in prompts {
        out += &json!({"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": p}}).to_string();
        out += "\n";
        out += &json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}}).to_string();
        out += "\n";
    }
    std::fs::write(path, out).unwrap();
}

/// A `claude` that ignores its prompt and answers `answer`.
fn fake_claude(t: &T, answer: &Value) -> String {
    let bin = t.env.path("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(t.env.path("answer.json"), answer.to_string()).unwrap();
    let script = bin.join("claude");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\ncat >/dev/null\ncat '{}'\n",
            s(&t.env.path("answer.json"))
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    format!("{}:/usr/bin:/bin", s(&bin))
}

#[test]
fn mining_proposes_checks_quotes_and_remembers_rejections() {
    let t = T::new(json!({ "handle": "tester" }));
    let app = t.repo("app", "example/app", "main");
    let tr = t.env.path(format!("{SID}.jsonl").as_str());
    transcript(
        &tr,
        &[
            "fix the export",
            "No — never push to main, open a branch first.",
            "ok now run the tests",
        ],
    );
    let answer = json!([
        {"title": "Branch before pushing", "rule": "When a fix is ready, push it to a branch, never to main.",
         "consequence": "A push to main skipped review.", "kind": "friction", "scope": "repo",
         "quote": "never push to main, open a branch first"},
        {"title": "Invented", "rule": "When anything, do something.", "consequence": "x", "quote": "words nobody said"}
    ]);
    let path = fake_claude(&t, &answer);
    let mine = |args: &[&str]| -> Value {
        let o = t.cmd().env("PATH", &path).args(args).output().unwrap();
        assert!(o.status.success(), "{}", common::stderr(&o));
        serde_json::from_str(&stdout(&o)).unwrap()
    };

    let rep = mine(&["lesson", "mine", s(&tr), "-C", s(&app), "--json"]);
    assert_eq!(rep["session"], SID);
    assert_eq!(rep["proposed"], json!(["p1"]));
    assert_eq!(rep["dropped"].as_array().unwrap().len(), 1);
    let props = t.json(&["lesson", "proposals", "--json"]);
    assert_eq!(props[0]["draft"]["repo"], "example/app");
    assert_eq!(props[0]["draft"]["evidence"][0]["session"], SID);

    // Mined from where it stopped: nothing new.
    let rep = mine(&["lesson", "mine", s(&tr), "--json"]);
    assert!(rep["skipped"].as_str().unwrap().contains("0 new prompt"));
    // Again from the start: the same proposal is already queued.
    let rep = mine(&["lesson", "mine", s(&tr), "-C", s(&app), "--again", "--json"]);
    assert!(rep["proposed"].as_array().unwrap().is_empty());

    t.ok(&["lesson", "accept", "p1", "--tier", "0"]);
    let l = &t.json(&["lesson", "list", "--json"])[0];
    assert_eq!(
        (
            l["origin"].as_str(),
            l["tier"].as_u64(),
            l["confidence"].as_f64()
        ),
        (Some("mined"), Some(0), Some(0.5))
    );
    assert_eq!(l["id"], "tester/claude#2");

    // Mined again: it confirms the lesson instead of proposing it.
    let rep = mine(&["lesson", "mine", s(&tr), "-C", s(&app), "--again", "--json"]);
    assert_eq!(rep["confirmed"], json!(["tester/claude#2"]));

    // A rejected proposal never comes back.
    t.ok(&["lesson", "retire", "2", "--reason", "we push to main here"]);
    std::fs::write(
        t.env.path("answer.json"),
        json!([{"title": "Run tests after fixes", "rule": "When a fix lands, run the tests.",
        "consequence": "Breakage.", "quote": "ok now run the tests"}])
        .to_string(),
    )
    .unwrap();
    let rep = mine(&["lesson", "mine", s(&tr), "--again", "--json"]);
    assert_eq!(rep["proposed"], json!(["p3"]));
    t.ok(&["lesson", "reject", "p3", "--reason", "obvious"]);
    let rep = mine(&["lesson", "mine", s(&tr), "--again", "--json"]);
    assert!(rep["proposed"].as_array().unwrap().is_empty());
    assert!(rep["dropped"][0].as_str().unwrap().contains("Rejected"));
    // And the retired one is not proposed again either.
    std::fs::write(t.env.path("answer.json"), answer.to_string()).unwrap();
    let rep = mine(&["lesson", "mine", s(&tr), "--again", "--json"]);
    assert!(
        rep["dropped"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d.as_str().unwrap().contains("Retired"))
    );

    // Too short a session is not mined.
    let short = t.env.path("short.jsonl");
    transcript(&short, &["hi"]);
    let rep = mine(&["lesson", "mine", s(&short), "--json"]);
    assert!(rep["skipped"].is_string());
}

#[test]
fn compact_brings_the_lessons_back() {
    let t = T::new(json!({ "handle": "tester", "mine": false }));
    let app = t.repo("app", "example/app", "main");
    t.ok(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--tier",
        "0",
        "--rule",
        "Run the migration check before seeding.",
        "--consequence",
        "Stale schema.",
    ]);
    let ev = |source: &str| json!({"hook_event_name": "SessionStart", "session_id": SID, "cwd": s(&app), "source": source});
    assert!(t.hook(ev("startup"), &[]).contains("tester/claude#1"));
    assert_eq!(t.hook(ev("resume"), &[]), "", "already in the context");
    assert!(t.hook(ev("compact"), &[]).contains("tester/claude#1"));
}

#[test]
fn lesson_commands_stay_on_this_host_unless_named() {
    let t = T::new(json!({}));
    let o = t
        .cmd()
        .env("OVERMIND_HOST", "workstation")
        .args(["-n", "lesson", "list"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", common::stderr(&o));
    assert!(!stdout(&o).contains("ssh"), "{}", stdout(&o));
}

#[test]
fn import_refuses_own_ids_and_unknown_scopes() {
    let t = T::new(json!({ "handle": "someone" }));
    t.ok(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--rule",
        "Mine.",
        "--consequence",
        "x",
    ]);
    let odd = t.env.path("odd.jsonl");
    let line = std::fs::read_to_string(FIXTURE)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .to_string();
    let own = line.replace("someone/claude#3", "someone/claude#1");
    let scoped = line
        .replace("someone/claude#3", "other/claude#2")
        .replace(r#""scope":"global""#, r#""scope":"project""#);
    std::fs::write(&odd, format!("{own}\n{scoped}\n")).unwrap();
    let rep = t.json(&["lesson", "import", s(&odd), "--json"]);
    assert!(rep[0]["report"]["adopted"].as_array().unwrap().is_empty());
    assert_eq!(rep[0]["report"]["invalid"].as_array().unwrap().len(), 2);
    // A later lesson of ours never takes an imported number.
    t.ok(&["lesson", "import", FIXTURE, "--repo", "example/app"]);
    let l = t.json(&[
        "lesson",
        "learn",
        "--scope",
        "global",
        "--rule",
        "Next.",
        "--consequence",
        "x",
        "--json",
    ]);
    assert_eq!(l["id"], "someone/claude#16");
}

#[test]
fn trivial_quotes_are_not_evidence() {
    let t = T::new(json!({}));
    let tr = t.env.path(format!("{SID}.jsonl").as_str());
    transcript(&tr, &["ok", "fine", "go on"]);
    let path = fake_claude(
        &t,
        &json!([{"title": "T", "rule": "When x, y.", "consequence": "z", "quote": "ok"}]),
    );
    let o = t
        .cmd()
        .env("PATH", &path)
        .args(["lesson", "mine", s(&tr), "--json"])
        .output()
        .unwrap();
    let rep: Value = serde_json::from_str(&stdout(&o)).unwrap();
    assert!(rep["proposed"].as_array().unwrap().is_empty());
}
