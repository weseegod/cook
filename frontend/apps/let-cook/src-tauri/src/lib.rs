mod acp_host;
mod bin_resolve;
mod http;
mod logging;
mod provider_config;
mod workspace;

use std::path::PathBuf;
use std::process::Command;

use acp_host::{AcpHost, RpcError, StartInfo};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::Value;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use provider_config::{ModelUpsert, ProviderList, ProviderModels, ProviderUpsert};

// Commands are invoked on the main thread (macOS delivers webview IPC on it via
// `startURLSchemeTask`), so any command that blocks on the event loop, a subprocess, or a
// pipe deadlocks the window. Everything below that can wait is an `async` command.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSecurity {
    path: PathBuf,
    exists: bool,
    world_readable: bool,
}

#[tauri::command]
async fn acp_start(
    app: tauri::AppHandle,
    host: State<'_, AcpHost>,
    cwd: PathBuf,
) -> Result<StartInfo, String> {
    host.start(app, cwd)
}

#[tauri::command]
async fn acp_stop(app: tauri::AppHandle) {
    app.state::<AcpHost>().stop();
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
async fn acp_notify(host: State<'_, AcpHost>, method: String, params: Value) -> Result<(), String> {
    host.notify(method, params)
}

#[tauri::command]
async fn acp_respond(
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

/// Show the native workspace picker and resolve with the choice.
///
/// The dialog callback can only run while the event loop spins, so the command awaits a channel
/// instead of blocking on `blocking_pick_folder` — blocking here would stall the run loop the
/// dialog itself needs, freezing the window with no picker ever shown.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<PathBuf> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a workspace for Cook")
        .pick_folder(move |path| {
            let _ = sender.send(path.and_then(|path| path.into_path().ok()));
        });
    receiver.await.unwrap_or(None)
}

/// Native attachment picker: a webview file input never exposes a path, and a non-image
/// attachment reaches the agent as a path it can `read_file`.
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Vec<String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Attach files to Cook")
        .pick_files(move |paths| {
            let files = paths
                .unwrap_or_default()
                .into_iter()
                .filter_map(|path| path.into_path().ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            let _ = sender.send(files);
        });
    receiver.await.unwrap_or_default()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePayload {
    data: String,
    media_type: String,
    size: u64,
}

/// Read one attached file for an ACP `image` part, bounded so a huge file cannot wedge the UI.
#[tauri::command]
async fn read_file_base64(path: String) -> Result<FilePayload, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_payload(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_list(
    host: State<'_, AcpHost>,
    relative_path: String,
) -> Result<Vec<workspace::WorkspaceEntry>, String> {
    let root = host.workspace_root()?;
    tauri::async_runtime::spawn_blocking(move || workspace::list(root, relative_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_read_file(
    host: State<'_, AcpHost>,
    relative_path: String,
) -> Result<workspace::FilePreview, String> {
    let root = host.workspace_root()?;
    tauri::async_runtime::spawn_blocking(move || workspace::read_file(root, relative_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_review(host: State<'_, AcpHost>) -> Result<workspace::ReviewSnapshot, String> {
    let root = host.workspace_root()?;
    tauri::async_runtime::spawn_blocking(move || workspace::review(root))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_git_status(host: State<'_, AcpHost>) -> Result<workspace::GitStatusSummary, String> {
    let root = host.workspace_root()?;
    tauri::async_runtime::spawn_blocking(move || workspace::git_status(root))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_open(host: State<'_, AcpHost>, relative_path: String) -> Result<(), String> {
    let root = host.workspace_root()?;
    tauri::async_runtime::spawn_blocking(move || workspace::open(root, relative_path))
        .await
        .map_err(|error| error.to_string())?
}

/// Open an explicit path with the operating system default handler.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&path);
        if !source.exists() {
            return Err(format!("{path} does not exist"));
        }

        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = std::process::Command::new("open");
            command.arg(&source);
            command
        };
        #[cfg(target_os = "linux")]
        let mut command = {
            let mut command = std::process::Command::new("xdg-open");
            command.arg(&source);
            command
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "start", "", &path]);
            command
        };

        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not open {path}: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn read_file_payload(path: &str) -> Result<FilePayload, String> {
    const MAX_BYTES: u64 = 25 * 1024 * 1024;
    let source = PathBuf::from(path);
    let metadata = std::fs::metadata(&source).map_err(|e| format!("{path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if metadata.len() > MAX_BYTES {
        return Err(format!("{path} is larger than 25 MB"));
    }
    let bytes = std::fs::read(&source).map_err(|e| format!("{path}: {e}"))?;
    Ok(FilePayload {
        data: BASE64.encode(&bytes),
        media_type: media_type_for(&source).to_owned(),
        size: bytes.len() as u64,
    })
}

/// Media type from the extension; the agent only needs a hint, never a sniffed type.
fn media_type_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "toml" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn config_security() -> ConfigSecurity {
    let path = bin_resolve::cook_home().join("config.toml");
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

/// Escape a string for embedding inside an AppleScript double-quoted literal.
fn escape_applescript(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
        .replace('\r', " ")
}

/// Native OS notification when a turn finishes while the window is unfocused.
#[tauri::command]
async fn os_notify(title: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let script = format!(
                "display notification \"{}\" with title \"{}\"",
                escape_applescript(&body),
                escape_applescript(&title),
            );
            let status = Command::new("osascript")
                .args(["-e", &script])
                .status()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(format!("osascript exited with {status}"));
            }
        }
        #[cfg(target_os = "linux")]
        {
            let status = Command::new("notify-send")
                .args([&title, &body])
                .status()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(format!("notify-send exited with {status}"));
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (title, body);
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn desktop_provider_list() -> Result<ProviderList, String> {
    tauri::async_runtime::spawn_blocking(provider_config::list)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn desktop_provider_upsert(request: ProviderUpsert) -> Result<Value, String> {
    let id = request.id().to_owned();
    let models = request.model_ids();
    tauri::async_runtime::spawn_blocking(move || provider_config::upsert_provider(request))
        .await
        .map_err(|error| error.to_string())??;
    Ok(serde_json::json!({ "ok": true, "id": id, "models": models }))
}

#[tauri::command]
async fn desktop_provider_delete(id: String, replacement: Option<String>) -> Result<Value, String> {
    let response_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        provider_config::delete_provider(&id, replacement.as_deref())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(serde_json::json!({ "ok": true, "id": response_id }))
}

/// Read-only `/models` probe: what the provider offers, without writing `config.toml`.
#[tauri::command]
async fn desktop_provider_models(id: String) -> Result<ProviderModels, String> {
    let target = tauri::async_runtime::spawn_blocking(move || provider_config::probe_target(&id))
        .await
        .map_err(|error| error.to_string())??;
    provider_config::probe_models(target).await
}

#[tauri::command]
async fn desktop_model_upsert(request: ModelUpsert) -> Result<Value, String> {
    let model_id = request.id().to_owned();
    tauri::async_runtime::spawn_blocking(move || provider_config::upsert_model(request))
        .await
        .map_err(|error| error.to_string())??;
    Ok(serde_json::json!({ "ok": true, "modelId": model_id }))
}

#[tauri::command]
async fn desktop_model_delete(model_id: String) -> Result<Value, String> {
    let response_id = model_id.clone();
    tauri::async_runtime::spawn_blocking(move || provider_config::delete_model(&model_id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(serde_json::json!({ "ok": true, "modelId": response_id }))
}

#[tauri::command]
async fn desktop_model_set_default(model_id: String) -> Result<Value, String> {
    let response_id = model_id.clone();
    tauri::async_runtime::spawn_blocking(move || provider_config::set_default_model(&model_id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(serde_json::json!({ "ok": true, "defaultModel": response_id }))
}

pub fn run() {
    logging::init();
    logging::info(
        "desktop.version",
        format!("version={}", env!("CARGO_PKG_VERSION")),
    );
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // App-shell updater only (see plugins.updater). Never writes ~/.cook/bin/cook.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .manage(AcpHost::default())
        .invoke_handler(tauri::generate_handler![
            acp_start,
            acp_stop,
            acp_request,
            acp_notify,
            acp_respond,
            acp_info,
            pick_folder,
            pick_files,
            read_file_base64,
            workspace_list,
            workspace_read_file,
            workspace_review,
            workspace_git_status,
            workspace_open,
            open_path,
            config_security,
            os_notify,
            desktop_provider_list,
            desktop_provider_upsert,
            desktop_provider_delete,
            desktop_provider_models,
            desktop_model_upsert,
            desktop_model_delete,
            desktop_model_set_default,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("Let Cook")?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Let Cook");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<AcpHost>().stop();
        }
    });
}
