mod acp_host;
mod bin_resolve;

use std::path::PathBuf;

use acp_host::{AcpHost, RpcError, StartInfo};
use serde_json::Value;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSecurity {
    path: PathBuf,
    exists: bool,
    world_readable: bool,
}

#[tauri::command]
fn acp_start(
    app: tauri::AppHandle,
    host: State<'_, AcpHost>,
    cwd: PathBuf,
) -> Result<StartInfo, String> {
    host.start(app, cwd)
}

#[tauri::command]
fn acp_stop(host: State<'_, AcpHost>) {
    host.stop();
}

#[tauri::command]
async fn acp_request(
    host: State<'_, AcpHost>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    host.request(method, params).await
}

#[tauri::command]
fn acp_notify(host: State<'_, AcpHost>, method: String, params: Value) -> Result<(), String> {
    host.notify(method, params)
}

#[tauri::command]
fn acp_respond(
    host: State<'_, AcpHost>,
    id: Value,
    result: Option<Value>,
    error: Option<RpcError>,
) -> Result<(), String> {
    host.respond(id, result, error)
}

#[tauri::command]
fn acp_info(host: State<'_, AcpHost>) -> Option<StartInfo> {
    host.info()
}

#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title("Choose a workspace for Thanh")
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
}

#[tauri::command]
fn config_security() -> ConfigSecurity {
    let home = std::env::var_os("THANH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(".thanh")))
        .unwrap_or_else(|| PathBuf::from(".thanh"));
    let path = home.join("config.toml");
    let metadata = std::fs::metadata(&path).ok();
    #[cfg(unix)]
    let world_readable = {
        use std::os::unix::fs::PermissionsExt;
        metadata
            .as_ref()
            .is_some_and(|value| value.permissions().mode() & 0o077 != 0)
    };
    #[cfg(not(unix))]
    let world_readable = false;
    ConfigSecurity {
        exists: metadata.is_some(),
        world_readable,
        path,
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AcpHost::default())
        .invoke_handler(tauri::generate_handler![
            acp_start,
            acp_stop,
            acp_request,
            acp_notify,
            acp_respond,
            acp_info,
            pick_folder,
            config_security,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("Thanh Desktop")?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Thanh Desktop");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<AcpHost>().stop();
        }
    });
}
