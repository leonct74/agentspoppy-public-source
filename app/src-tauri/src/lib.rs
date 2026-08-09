// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//! AgentsPoppy desktop shell.
//!
//! The Rust core stays deliberately thin: it hosts the webview (the React app)
//! and spawns the **broker** (a self-contained Node binary shipped as a Tauri
//! `externalBin`) on launch, then tears it down on exit. The frontend talks to
//! the broker over `http://127.0.0.1:8799`; the user's AWS credentials are held
//! by the broker on the local machine and never cross into the webview.

use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// The local port the broker listens on (kept in sync with the app's API client
/// default and deliberately distinct from MailPoppy's sidecar port, 8787).
const BROKER_PORT: &str = "8799";

/// The broker prints exactly this, once, on its first stdout line:
/// `AGENTSPOPPY_HOST_TOKEN=<token>`. We capture the token (a channel a spawned
/// poppy backend can't read), hold it here, hand it to the webview via the
/// `broker_host_token` command, and NEVER echo the line. Must match
/// `HOST_TOKEN_STDOUT_PREFIX` in packages/broker/src/auth.ts.
const HOST_TOKEN_PREFIX: &str = "AGENTSPOPPY_HOST_TOKEN=";

/// Holds the running broker child so we can kill it when the app exits.
#[derive(Default)]
struct BrokerState(Mutex<Option<CommandChild>>);

/// The management-plane host token, captured off the broker's stdout. The webview
/// reads it via `broker_host_token` and sends it on every broker call so the broker
/// knows the caller is the trusted UI (not a poppy backend).
#[derive(Default)]
struct HostToken(Mutex<Option<String>>);

/// Hand the captured host token to the webview. Empty string until the broker has
/// emitted it (the frontend retries), so this never blocks startup.
#[tauri::command]
fn broker_host_token(state: tauri::State<'_, HostToken>) -> String {
    state.0.lock().expect("host-token mutex poisoned").clone().unwrap_or_default()
}

/// AWS env vars worth forwarding to the broker. (A GUI app launched from Finder
/// inherits no shell env, so the SDK falls back to the default profile +
/// `~/.aws/config`; forwarding these helps when launched from a terminal.) The
/// broker uses these to resolve the operator's local credential chain for STS
/// AssumeRole vending and CloudFormation inventory/teardown.
const FORWARDED_ENV: [&str; 10] = [
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    // Dev/testing affordances (unset in production): run the broker with the demo
    // providers, seed demo poppies, simulate a brand-new-user (no AWS) bootstrap,
    // isolate state under a scratch home, or point the curated directory at a
    // local catalog for dogfood installs.
    "AGENTSPOPPY_DEMO",
    "AGENTSPOPPY_SEED",
    "AGENTSPOPPY_SIMULATE",
    "AGENTSPOPPY_HOME",
    "AGENTSPOPPY_DIRECTORY_URL",
];

/// If a previous run's broker was orphaned (the app crashed or was force-quit, so
/// `kill_broker` never ran), it still holds the port — every new sidecar then dies
/// on EADDRINUSE while the webview talks to the orphan, whose host token it can
/// never learn (endless 401s that survive rebuilds). Reclaim the port before
/// spawning: identify the listener and kill it ONLY if it is (a) an
/// agentspoppy-broker binary AND (b) a true orphan — reparented to launchd (ppid 1)
/// because its spawning app is gone. An unrelated process squatting the port is
/// never touched, and neither is the healthy broker of another live AgentsPoppy
/// instance (its ppid is that instance's app, so this launch backs off exactly like
/// the pre-reclaim behavior: our sidecar reports the conflict and the running
/// instance keeps working).
fn reclaim_broker_port() {
    let port: u16 = BROKER_PORT.parse().expect("BROKER_PORT is numeric");
    let port_free = || std::net::TcpListener::bind(("127.0.0.1", port)).is_ok();
    if port_free() {
        return;
    }

    let listeners = std::process::Command::new("lsof")
        .args(["-nP", &format!("-tiTCP:{port}"), "-sTCP:LISTEN"])
        .output();
    let Ok(out) = listeners else {
        eprintln!("port {port} is busy and lsof is unavailable — cannot reclaim it");
        return;
    };
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        let ps_field = |field: &str| {
            std::process::Command::new("ps")
                .args(["-o", field, "-p", pid])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        };
        let name = ps_field("comm=");
        if name.rsplit('/').next() != Some("agentspoppy-broker") {
            eprintln!("port {port} is held by '{name}' (pid {pid}) — not ours, leaving it alone");
            continue;
        }
        let ppid = ps_field("ppid=");
        if ppid != "1" {
            eprintln!(
                "port {port} is held by a broker whose app (pid {ppid}) is still alive — \
                 another AgentsPoppy instance owns it, leaving it alone"
            );
            continue;
        }
        eprintln!("reclaiming port {port} from orphaned broker pid {pid} ({name})");
        for signal in ["-TERM", "-KILL"] {
            let _ = std::process::Command::new("kill").args([signal, pid]).status();
            for _ in 0..20 {
                if port_free() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    if !port_free() {
        eprintln!("port {port} is still busy after reclaim — the sidecar will report the conflict");
    }
}

fn spawn_broker(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    reclaim_broker_port();
    let mut cmd = app
        .shell()
        .sidecar("agentspoppy-broker")?
        .env("AGENTSPOPPY_PORT", BROKER_PORT)
        // The broker watches this PID and exits when it disappears, so a crash or
        // force-quit (paths where kill_broker never runs) can't leave an orphan.
        .env("AGENTSPOPPY_PARENT_PID", std::process::id().to_string());
    for key in FORWARDED_ENV {
        if let Ok(val) = std::env::var(key) {
            cmd = cmd.env(key, val);
        }
    }

    let (mut rx, child) = cmd.spawn()?;
    app.state::<BrokerState>()
        .0
        .lock()
        .expect("broker mutex poisoned")
        .replace(child);

    // Drain the broker's output into the app's stdout/stderr for debugging — but
    // intercept the one host-token line, store it, and never echo it (so it can't
    // leak into logs).
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines() {
                        if let Some(token) = line.trim().strip_prefix(HOST_TOKEN_PREFIX) {
                            if let Some(state) = handle.try_state::<HostToken>() {
                                *state.0.lock().expect("host-token mutex poisoned") =
                                    Some(token.to_string());
                            }
                        } else {
                            println!("[broker] {line}");
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => eprint!("[broker] {}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(err) => eprintln!("[broker] error: {err}"),
                CommandEvent::Terminated(payload) => eprintln!("[broker] terminated: {payload:?}"),
                _ => {}
            }
        }
    });

    Ok(())
}

fn kill_broker(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BrokerState>() {
        if let Some(child) = state.0.lock().expect("broker mutex poisoned").take() {
            // Graceful first: the broker reaps its poppy-backend children from its
            // exit handler, which only runs if it dies CATCHABLY. `CommandChild::kill`
            // is SIGKILL on unix — using it directly orphaned every running sidecar
            // on each normal quit (they piled up per session: 63 observed live on
            // 2026-07-24, which is what made poppies hang in "loading"). So: SIGTERM,
            // give it a beat to take its children with it, then hard-kill as backstop.
            #[cfg(unix)]
            {
                let pid = child.pid().to_string();
                let termed = std::process::Command::new("kill")
                    .args(["-TERM", &pid])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if termed {
                    // Bounded wait: poll for exit up to ~1s (kill -0 fails once gone).
                    for _ in 0..10 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        let alive = std::process::Command::new("kill")
                            .args(["-0", &pid])
                            .status()
                            .map(|s| s.success())
                            .unwrap_or(false);
                        if !alive {
                            return; // clean exit — children reaped by the broker itself
                        }
                    }
                }
                let _ = child.kill(); // backstop: hung or TERM failed
            }
            // Windows has no SIGTERM; TerminateProcess it is. Orphaned sidecars there
            // are covered by the broker's startup sweep (reap-orphans) on next launch.
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Opens AWS console URLs in the system browser — window.open() does
        // nothing in the WKWebView.
        .plugin(tauri_plugin_opener::init())
        // Native OS banners so a supervised-approval request is seen even when
        // the AgentsPoppy window is hidden.
        .plugin(tauri_plugin_notification::init())
        // Self-update: check a signed latest.json feed, and (user-confirmed only)
        // download + install; tauri-plugin-process provides the relaunch.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BrokerState::default())
        .manage(HostToken::default())
        .invoke_handler(tauri::generate_handler![broker_host_token])
        .setup(|app| {
            spawn_broker(app.handle())?;

            // The main window starts hidden (`"visible": false`) so users never
            // see the blank webview flash on launch — the frontend calls
            // `getCurrentWindow().show()` once React has painted. Safety net:
            // reveal it anyway after a short delay if the frontend never does.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentsPoppy")
        .run(|app_handle, event| {
            // Both events: ExitRequested can be skipped on some quit paths, and
            // Exit is the last chance before the process ends.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_broker(app_handle);
            }
        });
}
