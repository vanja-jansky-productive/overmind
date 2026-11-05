//! Host dispatch, exec, all-hosts aggregation — without a real remote. Remote
//! hops are exercised in dry-run (the ssh command is printed, not run) or
//! against a destination that cannot resolve.

mod common;

use common::{Env, fixture, stderr, stdout, two_hosts};

#[test]
fn tmux_commands_go_to_the_default_host() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let out = env.cmd().args(["-n", "tmux", "list"]).output().unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.starts_with("ssh "), "{s}");
    assert!(s.contains("devbox"), "{s}");
    assert!(s.contains("BatchMode=yes"), "not a terminal → no pty: {s}");
    assert!(s.contains("--local --as-host workstation tmux list"), "{s}");
    // The dispatcher's own flags don't travel.
    assert!(!s.contains(" -n "), "{s}");
}

#[test]
fn session_commands_stay_on_this_machine_unless_told() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let fx = fixture(
        env.dir.path(),
        r#"[{"pid":7,"session_id":"s-1","name":"demo","status":"idle","backend":"tmux"}]"#,
    );
    let out = env
        .cmd()
        .env("OVERMIND_FIXTURE", &fx)
        .args(["list", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v[0]["name"], "demo");
    assert_eq!(v[0]["host"], "laptop", "rows carry this machine's name");

    let out = env
        .cmd()
        .args(["-n", "-H", "workstation", "list", "--json"])
        .output()
        .unwrap();
    assert!(stdout(&out).contains("--as-host workstation list --json"));
    // OVERMIND_HOST works like -H…
    let out = env
        .cmd()
        .env("OVERMIND_HOST", "workstation")
        .args(["-n", "list"])
        .output()
        .unwrap();
    assert!(stdout(&out).contains("devbox"), "{}", stdout(&out));
    // …and --local beats both.
    let out = env
        .cmd()
        .env("OVERMIND_HOST", "workstation")
        .env("OVERMIND_FIXTURE", &fx)
        .args(["--local", "list", "--json"])
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v[0]["name"], "demo");
}

#[test]
fn as_host_tags_rows_with_the_callers_name() {
    let env = Env::new();
    let fx = fixture(
        env.dir.path(),
        r#"[{"pid":7,"session_id":"s-1","name":"demo","status":"idle","backend":"tmux"}]"#,
    );
    let out = env
        .cmd()
        .env("OVERMIND_FIXTURE", &fx)
        .args(["--local", "--as-host", "workstation", "list", "--json"])
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v[0]["host"], "workstation");
}

#[test]
fn directories_are_remapped_for_the_remote_home() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let home = dirs::home_dir().unwrap();
    let dir = home.join("Code/project");
    let out = env
        .cmd()
        .args(["-n", "-H", "workstation", "spawn", "--dir"])
        .arg(&dir)
        .arg("go")
        .output()
        .unwrap();
    let s = stdout(&out);
    assert!(s.contains("~/Code/project"), "{s}");
    assert!(!s.contains(&home.display().to_string()), "{s}");

    let out = env
        .cmd()
        .args(["-n", "new", "x", "-C", "relative/dir"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(stderr(&out).contains("absolute"), "{}", stderr(&out));
}

#[test]
fn unknown_and_address_less_hosts() {
    let env = Env::new();
    let mut cfg = two_hosts();
    cfg["hosts"]["noaddr"] = serde_json::json!({ "ssh": null });
    env.write_config(&cfg);
    let out = env.cmd().args(["-H", "noaddr", "list"]).output().unwrap();
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("no ssh destination"),
        "{}",
        stderr(&out)
    );
    // An unconfigured name is used as an ssh destination as-is.
    let out = env
        .cmd()
        .args(["-n", "-H", "some-alias", "tmux", "list"])
        .output()
        .unwrap();
    assert!(stdout(&out).contains(" some-alias "), "{}", stdout(&out));
}

#[test]
fn an_unreachable_host_is_a_clear_error() {
    let env = Env::new();
    let mut cfg = two_hosts();
    cfg["hosts"]["workstation"]["ssh"] = serde_json::json!("overmind-test-host.invalid");
    env.write_config(&cfg);
    let out = env
        .cmd()
        .args(["tmux", "list"])
        .timeout(std::time::Duration::from_secs(20))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("cannot reach 'workstation'"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn list_all_hosts_keeps_going_past_a_dead_host() {
    let env = Env::new();
    let mut cfg = two_hosts();
    cfg["hosts"]["workstation"]["ssh"] = serde_json::json!("overmind-test-host.invalid");
    env.write_config(&cfg);
    let fx = fixture(
        env.dir.path(),
        r#"[{"pid":7,"session_id":"s-1","name":"demo","status":"idle","backend":"tmux"}]"#,
    );
    let out = env
        .cmd()
        .env("OVERMIND_FIXTURE", &fx)
        .args(["list", "--all-hosts", "--json"])
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["host"], "laptop");
    assert!(stderr(&out).contains("workstation"), "{}", stderr(&out));

    let out = env
        .cmd()
        .env("OVERMIND_FIXTURE", &fx)
        .args(["list", "--all-hosts"])
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .unwrap();
    assert!(
        stdout(&out).contains("OVERMIND @ laptop"),
        "{}",
        stdout(&out)
    );
}

#[test]
fn exec_passes_the_exit_code_through() {
    let env = Env::new();
    let out = env
        .cmd()
        .args(["exec", "--", "sh", "-c", "exit 7"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));
    let tmp = env.dir.path().canonicalize().unwrap();
    let out = env
        .cmd()
        .args(["exec", "-C"])
        .arg(&tmp)
        .args(["--", "pwd"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        std::path::Path::new(stdout(&out).trim())
            .canonicalize()
            .unwrap(),
        tmp
    );
}

#[test]
fn remote_exec_is_a_plain_ssh_hop() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let out = env
        .cmd()
        .args([
            "-n",
            "-H",
            "workstation",
            "exec",
            "-C",
            "~/x",
            "--",
            "echo",
            "a b",
        ])
        .output()
        .unwrap();
    let s = stdout(&out);
    assert!(s.contains("devbox"), "{s}");
    assert!(s.contains("cd \"$HOME\"/x && exec echo "), "{s}");
    assert!(
        !s.contains("--local"),
        "exec needs no overmind on the remote: {s}"
    );
}

#[test]
fn install_needs_a_remote_host() {
    let env = Env::new();
    env.write_config(&two_hosts());
    let out = env.cmd().arg("install").output().unwrap();
    assert!(!out.status.success());
    let out = env
        .cmd()
        .args(["install", "--host", "laptop"])
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "installing onto yourself is a mistake"
    );
    let out = env
        .cmd()
        .args(["-n", "install", "--host", "workstation", "--no-web"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.contains("uname -sm"), "{s}");
    assert!(s.contains("scp "), "{s}");
    assert!(s.contains("devbox:.local/bin/overmind.new"), "{s}");
}

#[test]
fn doctor_runs_with_no_config() {
    let env = Env::new();
    let out = env
        .cmd()
        .arg("doctor")
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .unwrap();
    let s = stdout(&out);
    assert!(s.contains("overmind doctor"), "{s}");
    assert!(s.contains("this machine"), "{s}");
    assert!(s.contains("overmind init"), "{s}");
}

#[test]
fn probe_is_json() {
    let env = Env::new();
    let out = env.cmd().arg("_probe").output().unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["overmindVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["configExists"], false);
}

// The probe counts live sessions per harness (Claude's registry rows no longer include Codex
// and pi rows) and reports Codex: its version, whether it has a home here and a login.
#[test]
fn probe_counts_sessions_per_harness_and_reports_codex() {
    let env = Env::new();
    let fixture = fixture(
        env.dir.path(),
        r#"[{"pid":1,"status":"idle","harness":"claude"},
            {"pid":2,"status":"busy","harness":"codex"},
            {"pid":3,"status":"idle","harness":"codex"},
            {"pid":4,"status":"idle","harness":"pi"}]"#,
    );
    let stub = env.path("bin/codex");
    std::fs::create_dir_all(stub.parent().unwrap()).unwrap();
    std::fs::write(&stub, "#!/bin/sh\necho codex-cli 9.9.9\n").unwrap();
    std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let codex_home = env.path("codex");
    std::fs::create_dir_all(&codex_home).unwrap();
    env.write_config(&serde_json::json!({
        "version": 1,
        "harnesses": { "codex": { "command": format!("{} -a on-request", stub.display()) } }
    }));
    let probe = || {
        let out = env
            .cmd()
            .arg("_probe")
            .env("OVERMIND_FIXTURE", &fixture)
            .env("CODEX_HOME", &codex_home)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", stderr(&out));
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let v = probe();
    assert_eq!(v["claudeSessions"], 1, "{v}");
    assert_eq!(v["codexSessions"], 2, "{v}");
    assert_eq!(v["piSessions"], 1, "{v}");
    assert_eq!(v["codex"], "codex-cli 9.9.9", "{v}");
    assert_eq!(v["codexHome"], true, "{v}");
    assert_eq!(v["codexLogin"], false, "{v}");
    std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
    assert_eq!(probe()["codexLogin"], true);
}

#[test]
fn skill_is_embedded_and_generic() {
    let env = Env::new();
    let out = env.cmd().args(["skill", "show"]).output().unwrap();
    let s = stdout(&out);
    assert!(s.contains("name: overmind"), "{s}");
    assert!(s.contains("overmind list"), "{s}");
    assert!(!s.contains("tb-fleet"), "{s}");
}

#[test]
fn web_serve_runs_node_with_the_config() {
    if overmind::core::tools::find_binary("node").is_none() {
        return;
    }
    let env = Env::new();
    let web = env.path("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("server.mjs"), "").unwrap();
    let out = env
        .cmd()
        .args(["-n", "web", "serve", "--port", "7799", "--dir"])
        .arg(&web)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.contains("OVERMIND_CONFIG="), "{s}");
    assert!(s.contains("OVERMIND_WEB_PORT=7799"), "{s}");
    assert!(s.contains("server.mjs"), "{s}");

    let out = env
        .cmd()
        .args(["web", "serve", "--dir"])
        .arg(env.path("nowhere"))
        .output()
        .unwrap();
    assert!(!out.status.success());
}

#[cfg(target_os = "macos")]
#[test]
fn web_service_prints_a_launchd_plist() {
    let env = Env::new();
    let out = env
        .cmd()
        .args(["web", "install-service", "--print"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let s = stdout(&out);
    assert!(s.contains("<key>ProgramArguments</key>"), "{s}");
    assert!(s.contains(&env.config_path().display().to_string()), "{s}");
}

/// A fake web dir: server.mjs, ui/ sources, and optionally a built ui/dist.
fn fake_web(env: &Env, built: bool) -> std::path::PathBuf {
    let web = env.path("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("server.mjs"), "").unwrap();
    std::fs::create_dir_all(web.join("ui/src")).unwrap();
    std::fs::write(web.join("ui/package.json"), "{}").unwrap();
    if built {
        std::fs::create_dir_all(web.join("ui/dist/assets")).unwrap();
        std::fs::write(web.join("ui/dist/index.html"), "").unwrap();
    }
    web
}

fn config_with_web(web: &std::path::Path) -> serde_json::Value {
    let mut cfg = two_hosts();
    cfg["web"]["dir"] = serde_json::Value::String(web.display().to_string());
    cfg
}

#[test]
fn install_copies_only_the_built_ui() {
    let env = Env::new();
    let web = fake_web(&env, true);
    env.write_config(&config_with_web(&web));
    let out = env
        .cmd()
        .args(["-n", "install", "--host", "workstation"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    assert!(s.contains(".local/share/overmind/web/ui/dist"), "{s}");
    assert!(s.contains("mkdir -p"), "{s}");
    if overmind::core::tools::find_binary("rsync").is_some() {
        assert!(s.contains("--exclude=/ui"), "ui sources stay behind: {s}");
    }
    assert!(!stderr(&out).contains("not built"), "{}", stderr(&out));
}

#[test]
fn install_without_a_built_ui_warns_and_drops_a_stale_one() {
    let env = Env::new();
    let web = fake_web(&env, false);
    env.write_config(&config_with_web(&web));
    let out = env
        .cmd()
        .args(["-n", "install", "--host", "workstation"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let s = stdout(&out);
    let e = stderr(&out);
    assert!(e.contains("not built"), "{e}");
    assert!(e.contains("npm --prefix web/ui ci"), "{e}");
    assert!(s.contains("rm -rf"), "a stale remote ui/ is removed: {s}");
    assert!(!s.contains("ui/dist"), "{s}");
}

#[test]
fn web_build_runs_npm_ci_then_build() {
    if overmind::core::tools::find_binary("npm").is_none() {
        return;
    }
    let env = Env::new();
    let web = fake_web(&env, false);
    let run = |extra: &[&str]| {
        let out = env
            .cmd()
            .args(["-n", "web", "build", "--dir"])
            .arg(&web)
            .args(extra)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", stderr(&out));
        stdout(&out)
    };
    let s = run(&[]);
    let lines: Vec<&str> = s.lines().collect();
    assert_eq!(lines.len(), 2, "{s}");
    assert!(
        lines[0].ends_with("/ui ci"),
        "no node_modules → npm ci first: {s}"
    );
    assert!(lines[1].ends_with("/ui run build"), "{s}");

    std::fs::create_dir_all(web.join("ui/node_modules")).unwrap();
    let s = run(&[]);
    assert_eq!(s.lines().count(), 1, "deps present → build only: {s}");
    assert_eq!(run(&["--install"]).lines().count(), 2);

    // An installed web dir has no ui sources.
    std::fs::remove_file(web.join("ui/package.json")).unwrap();
    let out = env
        .cmd()
        .args(["web", "build", "--dir"])
        .arg(&web)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(stderr(&out).contains("no UI sources"), "{}", stderr(&out));
}
