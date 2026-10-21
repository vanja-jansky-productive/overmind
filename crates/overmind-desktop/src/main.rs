//! Overmind as a macOS app: one window on this machine's Overmind web server
//! (`overmind web serve`), which the app starts when nothing is listening.
//! The server's page gets no app commands (only the bundled start page, `start/`,
//! does) — just the window-dragging permission its top bar needs (see `shell`).

mod links;
mod server;
mod shell;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use links::Action;

const START_PAGE: &str = "tauri://localhost/index.html";
/// How long a server the app started gets to answer before the start page gives up.
const START_GRACE: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

struct State {
    target: Result<server::Target, String>,
    /// Computed on first use: asking the login shell can take a moment.
    path: OnceLock<String>,
    /// The `overmind web serve` this app started, and when.
    child: Mutex<Option<(Child, Instant)>>,
    downloads: Mutex<HashMap<String, PathBuf>>,
    /// The full-screen state the page was last told (see `sync_shell`).
    fullscreen: AtomicBool,
}

impl State {
    fn path(&self) -> &str {
        self.path.get_or_init(server::server_path)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    /// `ok` (navigating to the server), `starting`, `down` or `error` (bad config).
    state: &'static str,
    url: Option<String>,
    source: Option<String>,
    error: Option<String>,
    log: Option<String>,
    log_path: Option<String>,
}

impl Status {
    fn new(state: &'static str, t: Option<&server::Target>) -> Self {
        Status {
            state,
            url: t.map(|t| t.url.to_string()),
            source: t.map(|t| t.source.clone()),
            error: None,
            log: None,
            log_path: None,
        }
    }
    fn error(mut self, e: impl Into<String>) -> Self {
        self.error = Some(e.into());
        self
    }
    fn with_log(mut self) -> Self {
        let p = server::log_path();
        self.log = Some(server::tail(&p, 20)).filter(|l| !l.is_empty());
        self.log_path = Some(p.display().to_string());
        self
    }
}

/// Start page → is the server up? Navigates the window there when it is;
/// otherwise starts `overmind web serve` once (for this machine's server).
#[tauri::command]
async fn connect(window: WebviewWindow) -> Status {
    tauri::async_runtime::spawn_blocking(move || connect_blocking(&window))
        .await
        .unwrap_or_else(|e| Status::new("error", None).error(e.to_string()))
}

fn connect_blocking(window: &WebviewWindow) -> Status {
    let st = window.state::<State>();
    let t = match &st.target {
        Ok(t) => t,
        Err(e) => return Status::new("error", None).error(e.clone()),
    };
    let err = match server::probe(&t.url, PROBE_TIMEOUT) {
        Ok(()) => {
            return match window.navigate(t.url.clone()) {
                Ok(()) => Status::new("ok", Some(t)),
                Err(e) => Status::new("error", Some(t)).error(e.to_string()),
            };
        }
        Err(e) => e,
    };
    let down = Status::new("down", Some(t));
    if !t.local {
        return down.error(err);
    }
    let mut child = st.child.lock().unwrap();
    if let Some((c, since)) = child.as_mut() {
        return match c.try_wait() {
            Ok(Some(exit)) => {
                *child = None;
                down.error(format!("overmind web serve exited ({exit})"))
                    .with_log()
            }
            _ if since.elapsed() < START_GRACE => Status::new("starting", Some(t)).with_log(),
            _ => down
                .error(format!("started overmind web serve, but {err}"))
                .with_log(),
        };
    }
    let Some(overmind) = server::overmind_bin(overmind::core::config::get(), st.path()) else {
        return down.error(format!(
            "{err}\n\n`overmind` was not found on the login shell's PATH, ~/.local/bin or ~/.cargo/bin — set `overmindBin` in the config"
        ));
    };
    match server::spawn(
        &overmind,
        &server::serve_args(t),
        st.path(),
        &server::log_path(),
    ) {
        Ok(c) => {
            *child = Some((c, Instant::now()));
            Status::new("starting", Some(t)).with_log()
        }
        Err(e) => down.error(e),
    }
}

#[tauri::command]
fn open_log() {
    open_external(&server::log_path().display().to_string());
}

fn open_external(target: &str) {
    if let Err(e) = Command::new("/usr/bin/open").arg(target).spawn() {
        eprintln!("overmind-desktop: open {target}: {e}");
    }
}

/// Open an iTerm tab running `overmind -H <host> enter <session>` (off the UI thread:
/// the AppleScript waits for the new tab's shell).
fn attach(host: &str, session: &str) {
    let line = overmind::core::backend::attach_command(host, session);
    std::thread::spawn(move || {
        if let Err(e) = overmind::core::backend::iterm_run(&line, false) {
            eprintln!("overmind-desktop: attach ({line}): {e}");
        }
    });
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item =
        |id: &str, label: &str, accel: &str| MenuItem::with_id(app, id, label, true, Some(accel));
    let sep = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Overmind",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Overmind"), None)?,
                    &sep()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&item("new-session", "New Session", "CmdOrCtrl+N")?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &item("reload", "Reload", "CmdOrCtrl+R")?,
                    &item("reconnect", "Reconnect to Server", "CmdOrCtrl+Shift+R")?,
                    &sep()?,
                    &item("back", "Back", "CmdOrCtrl+[")?,
                    &item("forward", "Forward", "CmdOrCtrl+]")?,
                    &sep()?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

fn start_page() -> Url {
    Url::parse(START_PAGE).expect("static URL")
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    match id {
        // Browsers keep ⌘N for themselves, so the page binds it only through this menu.
        "new-session" => drop(w.eval(shell::command("new"))),
        "back" => drop(w.eval("history.back()")),
        "forward" => drop(w.eval("history.forward()")),
        "reconnect" => drop(w.navigate(start_page())),
        // Reloading a server that is gone would leave a blank error page.
        "reload" => {
            std::thread::spawn(move || {
                let on_server = w.url().is_ok_and(|u| u.scheme().starts_with("http"));
                let up = w
                    .state::<State>()
                    .target
                    .as_ref()
                    .is_ok_and(|t| server::probe(&t.url, PROBE_TIMEOUT).is_ok());
                if on_server && !up {
                    let _ = w.navigate(start_page());
                } else {
                    let _ = w.eval("location.reload()");
                }
            });
        }
        _ => {}
    }
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let server = app
        .state::<State>()
        .target
        .as_ref()
        .map(|t| t.url.clone())
        .unwrap_or_else(|_| start_page());
    let dl = app.clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Overmind")
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 480.0)
        .visible(false)
        .initialization_script(shell::script(false))
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished {
                sync_shell(&w, true);
            }
        })
        // Let the page get file drops (composer attachments) instead of Tauri.
        .disable_drag_drop_handler()
        .on_navigation(move |url| match links::navigation(url, &server) {
            Action::Allow => true,
            Action::Open => {
                open_external(url.as_str());
                false
            }
            Action::Attach { host, session } => {
                attach(&host, &session);
                false
            }
            Action::Deny => false,
        })
        .on_new_window(|url, _| {
            if links::new_window(&url) == Action::Open {
                open_external(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(if title.trim().is_empty() {
                "Overmind"
            } else {
                &title
            });
        })
        .on_download(move |_, ev| {
            let st = dl.state::<State>();
            match ev {
                DownloadEvent::Requested { url, destination } => {
                    st.downloads
                        .lock()
                        .unwrap()
                        .insert(url.to_string(), destination.clone());
                }
                // macOS reports no path on finish: reveal the one chosen at request time.
                DownloadEvent::Finished { url, success, .. } => {
                    let dest = st.downloads.lock().unwrap().remove(url.as_str());
                    if let (true, Some(d)) = (success, dest) {
                        let _ = Command::new("/usr/bin/open").arg("-R").arg(d).spawn();
                    }
                }
                _ => {}
            }
            true
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            shell::TRAFFIC_LIGHTS.0,
            shell::TRAFFIC_LIGHTS.1,
        ));
    let w = builder.build()?;
    let _ = w.restore_state(StateFlags::all() & !StateFlags::VISIBLE);
    w.show()?;
    Ok(w)
}

/// Tell the page whether the window is in full screen (the traffic lights hide
/// there, so its top-bar inset collapses) — when it changed, or always (`force`,
/// after a page load, which starts from the initialization script's default).
fn sync_shell(w: &WebviewWindow, force: bool) {
    let Ok(fs) = w.is_fullscreen() else { return };
    let last = w.state::<State>().fullscreen.swap(fs, Ordering::Relaxed);
    if force || last != fs {
        let _ = w.eval(shell::script(fs));
    }
}

/// Window dragging for the page's top bar (`data-tauri-drag-region`): Tauri's
/// drag script calls these two window commands. Granted to the start page and
/// the server's origin, in this window only — nothing else is exposed to the page.
fn allow_window_drag(app: &AppHandle) -> tauri::Result<()> {
    let mut cap = CapabilityBuilder::new("window-drag")
        .window("main")
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize");
    let st = app.state::<State>();
    if let Some(p) = st
        .target
        .as_ref()
        .ok()
        .and_then(|t| shell::drag_pattern(&t.url))
    {
        cap = cap.remote(p);
    }
    app.add_capability(cap)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    let loaded = overmind::core::config::load();
    let env_url = std::env::var("OVERMIND_DESKTOP_URL").ok();
    let target = match &loaded.problem {
        Some(p) => Err(p.clone()),
        None => server::resolve(env_url.as_deref(), loaded),
    };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .manage(State {
            target,
            path: OnceLock::new(),
            child: Mutex::new(None),
            downloads: Mutex::new(HashMap::new()),
            fullscreen: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![connect, open_log])
        .menu(menu)
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .setup(|app| {
            allow_window_drag(app.handle())?;
            build_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|w, ev| {
            // ⌘W / the close button hide the window; ⌘Q quits.
            match ev {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = w.hide();
                }
                // Entering / leaving full screen resizes the window.
                WindowEvent::Resized(_) => {
                    if let Some(wv) = w.app_handle().get_webview_window(w.label()) {
                        sync_shell(&wv, false);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Overmind");
    app.run(|app, ev| match ev {
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => {
            if let Some((mut c, _)) = app.state::<State>().child.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        _ => {}
    });
}
