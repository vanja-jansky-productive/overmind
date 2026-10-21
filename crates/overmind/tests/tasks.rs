//! `overmind tasks` / `overmind task` against a fake `curl` (OVERMIND_CURL): columns, the cache, moving a
//! task, the token staying off the command line.

mod common;

use std::os::unix::fs::PermissionsExt;

use common::Env;
use serde_json::{Value, json};

const TOKEN: &str = "secret-token";

fn task(id: &str, title: &str, project: &str, status: &str, due: Option<&str>) -> Value {
    json!({ "id": id, "type": "tasks",
        "attributes": { "title": title, "task_number": id, "due_date": due,
            "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-02T10:00:00Z",
            "last_activity_at": "2026-10-02T10:00:00Z", "todo_count": 2, "open_todo_count": 1,
            "tag_list": [], "description": "<p>Do it</p>" },
        "relationships": {
            "project": { "data": { "type": "projects", "id": project } },
            "workflow_status": { "data": { "type": "workflow_statuses", "id": status } } } })
}

fn status(id: &str, name: &str, category: u64, position: i64) -> Value {
    json!({ "id": id, "type": "workflow_statuses",
        "attributes": { "name": name, "category_id": category, "position": position },
        "relationships": { "workflow": { "data": { "type": "workflows", "id": "9" } } } })
}

fn included() -> Value {
    json!([
        { "id": "7", "type": "projects", "attributes": { "name": "App", "archived_at": null } },
        { "id": "8", "type": "projects", "attributes": { "name": "Old", "archived_at": "2024-01-01T00:00:00Z" } },
        status("20", "Open", 1, 1),
        status("21", "Working", 2, 2),
        status("22", "Peer Review", 2, 3),
    ])
}

fn person(id: &str, org: &str) -> Value {
    json!({ "id": id, "type": "people", "attributes": { "first_name": "Ada", "last_name": "L" },
        "relationships": { "organization": { "data": { "type": "organizations", "id": org } } } })
}

/// A `curl` that answers from files by URL, logs its arguments (`calls`) and its stdin
/// (`stdin`), and fails while `fail` exists.
fn fake_curl(env: &Env) -> std::path::PathBuf {
    let w = |name: &str, v: Value| std::fs::write(env.path(name), v.to_string()).unwrap();
    w(
        "me.json",
        json!({ "data": [], "included": [
            person("100", "1"), person("200", "2"),
            { "id": "1", "type": "organizations", "attributes": { "name": "Acme" } },
            { "id": "2", "type": "organizations", "attributes": { "name": "Other Co" } },
        ] }),
    );
    w(
        "tasks.json",
        json!({ "data": [
            task("1001", "Fix login", "7", "21", Some("2099-01-01")),
            task("1002", "Write docs", "7", "20", None),
            task("1003", "Overdue", "7", "20", Some("2000-01-01")),
            task("1004", "Archived", "8", "20", None),
        ], "included": included(), "meta": { "total_pages": 1 } }),
    );
    w(
        "task.json",
        json!({ "data": task("1001", "Fix login", "7", "21", Some("2099-01-01")), "included": included() }),
    );
    w(
        "task-moved.json",
        json!({ "data": task("1001", "Fix login", "7", "22", Some("2099-01-01")), "included": included() }),
    );
    w(
        "statuses.json",
        json!({ "data": [ status("22", "Peer Review", 2, 3), status("20", "Open", 1, 1), status("21", "Working", 2, 2) ] }),
    );
    let dir = env.dir.path().display();
    let script = format!(
        r#"#!/bin/sh
cat > {dir}/stdin
{{ printf '%s ' "$@" | tr '\n' ' '; echo; }} >> {dir}/calls
[ -e {dir}/fail ] && {{ echo "curl: (6) Could not resolve host" >&2; exit 6; }}
method=GET; prev=""; url=""
for a in "$@"; do [ "$prev" = "-X" ] && method=$a; prev=$a; url=$a; done
case "$method $url" in
  PATCH*) touch {dir}/patched; printf '{{}}\n200'; exit 0 ;;
  *organization_memberships*) cat {dir}/me.json ;;
  *workflow_statuses*) cat {dir}/statuses.json ;;
  */tasks/1001*) if [ -e {dir}/patched ]; then cat {dir}/task-moved.json; else cat {dir}/task.json; fi ;;
  */tasks\?*) cat {dir}/tasks.json ;;
  *) printf '{{"errors":[{{"detail":"no route"}}]}}\n404'; exit 0 ;;
esac
printf '\n200'
"#
    );
    let p = env.path("curl");
    std::fs::write(&p, script).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn cmd(env: &Env, curl: &std::path::Path, tasks: Value) -> assert_cmd::Command {
    env.write_config(&json!({ "version": 1, "tasks": tasks }));
    let mut c = env.cmd();
    c.env("OVERMIND_CURL", curl)
        .env("OVERMIND_PRODUCTIVE_API", "https://api.example.test/v2")
        .env("OVERMIND_TASKS_CACHE", env.path("tasks.cache.json"))
        .env("OVERMIND_PRODUCTIVE_TOKEN", TOKEN)
        .env_remove("PRODUCTIVE_API_TOKEN");
    c
}

fn org1() -> Value {
    json!({ "organization": "1" })
}

fn calls(env: &Env) -> Vec<String> {
    std::fs::read_to_string(env.path("calls"))
        .map(|s| s.lines().map(String::from).collect())
        .unwrap_or_default()
}

fn json_of(out: &[u8]) -> Value {
    serde_json::from_slice(out).unwrap()
}

#[test]
fn tasks_json_sorts_into_columns_and_caches() {
    let env = Env::new();
    let curl = fake_curl(&env);
    let out = cmd(&env, &curl, org1())
        .args(["tasks", "--json"])
        .assert()
        .success();
    let v = json_of(&out.get_output().stdout);
    assert_eq!(v["user"]["id"], "100");
    assert_eq!(v["organization"]["slug"], "1-acme");
    let cols: Vec<(&str, &str)> = v["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["id"].as_str().unwrap(), t["column"].as_str().unwrap()))
        .collect();
    assert_eq!(
        cols,
        vec![("1003", "due"), ("1001", "inProgress"), ("1002", "toDo")]
    );
    assert_eq!(
        v["tasks"][1]["url"],
        "https://app.productive.io/1-acme/tasks/1001"
    );
    assert_eq!(v["columns"][0]["id"], "due");
    assert_eq!(v["columns"][0]["count"], 1);
    // Statuses by workflow, in order.
    let names: Vec<&str> = v["statuses"]["9"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Open", "Working", "Peer Review"]);

    // The token goes in on stdin, never on the command line; requests name the organization.
    let c = calls(&env);
    assert_eq!(c.len(), 3, "{c:?}");
    assert!(c.iter().all(|l| !l.contains(TOKEN)));
    let stdin = std::fs::read_to_string(env.path("stdin")).unwrap();
    assert!(stdin.contains(&format!("X-Auth-Token: {TOKEN}")));
    assert!(stdin.contains("X-Organization-Id: 1"));
    assert!(c[1].contains("filter[assignee_id]=100"), "{}", c[1]);

    // Fresh cache: no fetch.
    cmd(&env, &curl, org1())
        .args(["tasks", "--json"])
        .assert()
        .success();
    assert_eq!(calls(&env).len(), 3);

    // --column filters, by any spelling.
    let out = cmd(&env, &curl, org1())
        .args(["tasks", "--json", "--column", "in-progress"])
        .assert()
        .success();
    let v = json_of(&out.get_output().stdout);
    assert_eq!(v["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(v["columns"].as_array().unwrap().len(), 1);
}

#[test]
fn task_status_moves_it_and_updates_the_cache() {
    let env = Env::new();
    let curl = fake_curl(&env);
    cmd(&env, &curl, org1())
        .args(["tasks", "--json"])
        .assert()
        .success();
    // Ambiguous or unknown names are refused, with the candidates.
    cmd(&env, &curl, org1())
        .args(["task", "status", "1001", "nope"])
        .assert()
        .code(2)
        .stderr(predicates::str::contains("Peer Review (22)"));
    let out = cmd(&env, &curl, org1())
        .args([
            "task",
            "status",
            "https://app.productive.io/1-acme/tasks/1001",
            "peer",
            "--json",
        ])
        .assert()
        .success();
    let v = json_of(&out.get_output().stdout);
    assert_eq!(v["task"]["status"]["name"], "Peer Review");
    assert!(env.path("patched").exists());
    let patch = calls(&env)
        .into_iter()
        .find(|l| l.contains("PATCH"))
        .unwrap();
    assert!(patch.contains(r#""id":"22""#), "{patch}");

    let out = cmd(&env, &curl, org1())
        .args(["tasks", "--json", "--cached"])
        .assert()
        .success();
    let v = json_of(&out.get_output().stdout);
    let t = v["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "1001")
        .unwrap();
    assert_eq!(t["status"]["name"], "Peer Review");
}

#[test]
fn task_show_has_the_context_line() {
    let env = Env::new();
    let curl = fake_curl(&env);
    let out = cmd(&env, &curl, org1())
        .args(["task", "show", "1001", "--json"])
        .assert()
        .success();
    let v = json_of(&out.get_output().stdout);
    assert_eq!(
        v["contextLine"],
        "Productive task #1001 https://app.productive.io/1-acme/tasks/1001 — “Fix login” (App, Working)."
    );
    assert_eq!(v["description"], "Do it");
}

#[test]
fn several_organizations_need_one_configured() {
    let env = Env::new();
    let curl = fake_curl(&env);
    cmd(&env, &curl, json!({}))
        .args(["tasks"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("1 (Acme), 2 (Other Co)"));
}

#[test]
fn no_token_is_an_error() {
    let env = Env::new();
    let curl = fake_curl(&env);
    cmd(&env, &curl, org1())
        .env_remove("OVERMIND_PRODUCTIVE_TOKEN")
        .args(["tasks"])
        .assert()
        .failure()
        .stderr(predicates::str::contains("tasks.token"));
}

#[test]
fn a_failed_refresh_serves_the_cache_with_the_error() {
    let env = Env::new();
    let curl = fake_curl(&env);
    cmd(&env, &curl, org1())
        .args(["tasks", "--json"])
        .assert()
        .success();
    std::fs::write(env.path("fail"), "").unwrap();
    let out = cmd(&env, &curl, org1())
        .args(["tasks", "--json", "--refresh"])
        .assert()
        .success();
    let v = json_of(&out.get_output().stdout);
    assert_eq!(v["stale"], true);
    assert!(v["error"].as_str().unwrap().contains("resolve host"), "{v}");
    assert_eq!(v["tasks"].as_array().unwrap().len(), 3);
}
