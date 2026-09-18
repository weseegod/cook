//! ACP stdio mux + native Layer 1 reverse handlers (C5).
//!
//! Role: spawn/kill the agent sidecar, map JSON-RPC ids, coalesce notifications, and
//! answer `fs/read_text_file` / `fs/write_text_file` with the sessions-root allow-path.
//! Terminal stub arms are intentionally absent while `terminal: false` (H-term / C1).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::bin_resolve::{resolve_and_gate, ResolvedBinary};

type PendingResult = Result<Value, String>;

pub struct AcpHost {
    runtime: Mutex<Option<ChildRuntime>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<PendingResult>>>>,
    next_id: AtomicU64,
    workspace: Arc<Mutex<Option<PathBuf>>>,
    live_session: Mutex<Option<String>>,
}

impl Default for AcpHost {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            workspace: Arc::new(Mutex::new(None)),
            live_session: Mutex::new(None),
        }
    }
}

struct ChildRuntime {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    binary: ResolvedBinary,
    cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub binary_path: PathBuf,
    pub binary_version: String,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    state: &'static str,
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    code: i64,
    message: String,
    #[serde(default)]
    data: Option<Value>,
}

impl AcpHost {
    pub fn start(&self, app: AppHandle, cwd: PathBuf) -> Result<StartInfo, String> {
        self.stop();
        let cwd = cwd
            .canonicalize()
            .map_err(|error| format!("invalid workspace {}: {error}", cwd.display()))?;
        if !cwd.is_dir() {
            return Err(format!("workspace is not a directory: {}", cwd.display()));
        }
        let binary = resolve_and_gate().map_err(|error| error.to_string())?;
        let mut command = Command::new(&binary.path);
        command
            .args(["agent", "stdio"])
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The desktop config APIs use THANH_HOME. Pin the child to the same directory so the
        // agent and Settings can never read two different config.toml files.
        if let Some(home) = std::env::var_os("THANH_HOME") {
            command.env("GROK_HOME", home);
        }
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to spawn {}: {error}", binary.path.display()))?;
        let stdin = child.stdin.take().ok_or("agent stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("agent stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("agent stderr was not piped")?;
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));

        *self.workspace.lock() = Some(cwd.clone());
        *self.runtime.lock() = Some(ChildRuntime {
            child: child.clone(),
            stdin: stdin.clone(),
            binary: binary.clone(),
            cwd: cwd.clone(),
        });

        spawn_stdout_reader(
            app.clone(),
            stdout,
            stdin,
            self.pending.clone(),
            self.workspace.clone(),
        );
        spawn_stderr_reader(app.clone(), stderr);
        let _ = app.emit(
            "acp-status",
            StatusEvent {
                state: "running",
                detail: None,
            },
        );

        Ok(StartInfo {
            binary_path: binary.path,
            binary_version: binary.version,
            cwd,
        })
    }

    pub fn stop(&self) {
        // Take the runtime out before the shutdown handshake: the kill/wait loop below can take
        // hundreds of milliseconds, and holding the mutex would stall any `acp_info` caller.
        let runtime = self.runtime.lock().take();
        if let Some(runtime) = runtime {
            if let Some(session_id) = self.live_session.lock().take() {
                let _ = write_message(
                    &runtime.stdin,
                    &json!({
                        "jsonrpc": "2.0",
                        "method": "session/cancel",
                        "params": { "sessionId": session_id },
                    }),
                );
            }
            let mut child = runtime.child.lock();
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            #[cfg(unix)]
            for _ in 0..10 {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            #[cfg(unix)]
            if child.try_wait().ok().flatten().is_none() {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
            }
            let _ = child.wait();
        }
        self.fail_pending("ACP process stopped");
    }

    fn fail_pending(&self, message: &str) {
        for (_, sender) in self.pending.lock().drain() {
            let _ = sender.send(Err(message.to_owned()));
        }
    }

    fn send_value(&self, value: &Value) -> Result<(), String> {
        let runtime = self.runtime.lock();
        let runtime = runtime.as_ref().ok_or("ACP process is not running")?;
        write_message(&runtime.stdin, value)
    }

    pub async fn request(&self, method: String, params: Value) -> Result<Value, String> {
        let prompt_session = (method == "session/prompt")
            .then(|| {
                params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten();
        if let Some(session_id) = &prompt_session {
            *self.live_session.lock() = Some(session_id.clone());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().insert(id, sender);
        if let Err(error) = self.send_value(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })) {
            self.pending.lock().remove(&id);
            if prompt_session.is_some() {
                self.live_session.lock().take();
            }
            return Err(error);
        }
        let result = receiver
            .await
            .map_err(|_| "ACP response channel closed".to_owned())?;
        if prompt_session.is_some() {
            self.live_session.lock().take();
        }
        result
    }

    pub fn notify(&self, method: String, params: Value) -> Result<(), String> {
        let cancelling = method == "session/cancel";
        let result = self.send_value(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
        if cancelling {
            self.live_session.lock().take();
        }
        result
    }

    pub fn respond(
        &self,
        id: Value,
        result: Option<Value>,
        error: Option<RpcError>,
    ) -> Result<(), String> {
        let value = match error {
            Some(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": error.code, "message": error.message, "data": error.data },
            }),
            None => json!({ "jsonrpc": "2.0", "id": id, "result": result.unwrap_or(Value::Null) }),
        };
        self.send_value(&value)
    }

    pub fn info(&self) -> Option<StartInfo> {
        self.runtime.lock().as_ref().map(|runtime| StartInfo {
            binary_path: runtime.binary.path.clone(),
            binary_version: runtime.binary.version.clone(),
            cwd: runtime.cwd.clone(),
        })
    }

    pub fn workspace_root(&self) -> Result<PathBuf, String> {
        self.workspace
            .lock()
            .clone()
            .ok_or_else(|| "no active workspace".to_owned())
    }
}

fn write_message(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock();
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn spawn_stdout_reader(
    app: AppHandle,
    stdout: impl Read + Send + 'static,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<PendingResult>>>>,
    workspace: Arc<Mutex<Option<PathBuf>>>,
) {
    let (sender, receiver) = mpsc::sync_channel::<Value>(256);
    let reader_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) if !line.trim().is_empty() => line,
                Ok(_) => continue,
                Err(error) => {
                    let _ = reader_app.emit("acp-log", format!("stdout read failed: {error}"));
                    break;
                }
            };
            let message: Value = match serde_json::from_str(&line) {
                Ok(message) => message,
                Err(error) => {
                    let _ = reader_app.emit(
                        "acp-log",
                        format!("ignored invalid JSON from agent: {error}"),
                    );
                    continue;
                }
            };
            if sender.send(message).is_err() {
                break;
            }
        }
    });

    thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut batch = vec![first];
            while batch.len() < 64 {
                match receiver.recv_timeout(Duration::from_millis(8)) {
                    Ok(message) => batch.push(message),
                    Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                        break
                    }
                }
            }
            let mut forwarded = Vec::with_capacity(batch.len());
            for message in batch {
                if route_pending_response(&message, &pending) {
                    continue;
                }
                if handle_host_request(&message, &stdin, &workspace) {
                    continue;
                }
                forwarded.push(message);
            }
            match forwarded.len() {
                0 => {}
                1 => {
                    let _ = app.emit("acp-message", forwarded.pop().expect("one message"));
                }
                _ => {
                    let _ = app.emit("acp-messages", forwarded);
                }
            }
        }
        for (_, sender) in pending.lock().drain() {
            let _ = sender.send(Err("ACP process exited".to_owned()));
        }
        let _ = app.emit(
            "acp-status",
            StatusEvent {
                state: "exited",
                detail: Some("The Thanh agent process exited".to_owned()),
            },
        );
    });
}

fn route_pending_response(
    message: &Value,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<PendingResult>>>>,
) -> bool {
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return false;
    };
    if message.get("result").is_none() && message.get("error").is_none() {
        return false;
    }
    let Some(sender) = pending.lock().remove(&id) else {
        return false;
    };
    let response = match message.get("error") {
        Some(error) => Err(error.to_string()),
        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = sender.send(response);
    true
}

fn spawn_stderr_reader(app: AppHandle, stderr: impl Read + Send + 'static) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("acp-log", line);
        }
    });
}

/// Layer 1 host intercept: ACP `fs/*` only until a real PTY exists (H-term).
/// Do not stub `terminal/*` while `clientCapabilities.terminal` is false — leave those
/// for the renderer Layer 2 typed-decline path (`docs/desktop-app.md` §5.4).
///
/// Sessions-root allow-path: `fs/*` may touch the workspace cwd **and** the agent's
/// session store (`$THANH_HOME/sessions` / `$GROK_HOME/sessions` / `~/.thanh/sessions`)
/// so plan mode can write `<session>/plan.md` outside any workspace.
fn handle_host_request(
    message: &Value,
    stdin: &Arc<Mutex<ChildStdin>>,
    workspace: &Arc<Mutex<Option<PathBuf>>>,
) -> bool {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return false;
    };
    let Some(id) = message.get("id").cloned() else {
        return false;
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let Some(outcome) = host_native_outcome(method, &params, workspace) else {
        return false;
    };
    let response = match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32001, "message": message }
        }),
    };
    let _ = write_message(stdin, &response);
    true
}

/// Returns `Some` only for methods this host implements natively (fs). Terminal
/// methods return `None` so they are not answered with a fake `exitCode: 0`.
fn host_native_outcome(
    method: &str,
    params: &Value,
    workspace: &Arc<Mutex<Option<PathBuf>>>,
) -> Option<Result<Value, String>> {
    match method {
        "fs/read_text_file" => Some(read_text_file(params, workspace)),
        "fs/write_text_file" => Some(write_text_file(params, workspace)),
        _ => None,
    }
}

/// The agent's session store (`<app home>/sessions`). Plan mode writes its plan file to
/// `<session>/plan.md` through this client filesystem, so that tree has to stay reachable even
/// though it sits outside any workspace. `$GROK_HOME` is honoured because the child agent uses it
/// when `$THANH_HOME` is unset and nothing has pinned the child's home.
fn agent_state_root() -> PathBuf {
    agent_state_root_from(
        std::env::var_os("THANH_HOME").as_deref(),
        std::env::var_os("GROK_HOME").as_deref(),
        crate::provider_config::config_home(),
    )
}

fn agent_state_root_from(
    thanh_home: Option<&OsStr>,
    grok_home: Option<&OsStr>,
    app_home: PathBuf,
) -> PathBuf {
    let home = thanh_home
        .filter(|value| !value.is_empty())
        .or(grok_home.filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .unwrap_or(app_home);
    let sessions = home.join("sessions");
    // The compared path is canonicalized, and on macOS both `$HOME` and `$TMPDIR` may be symlinks.
    sessions.canonicalize().unwrap_or(sessions)
}

fn safe_workspace_path(
    raw: &str,
    workspace: &Arc<Mutex<Option<PathBuf>>>,
    writing: bool,
) -> Result<PathBuf, String> {
    let root = workspace.lock().clone().ok_or("no active workspace")?;
    let allowed = vec![root.clone(), agent_state_root()];
    safe_path(raw, &root, &allowed, writing)
}

/// Resolve `raw` against `base` and require the result to land inside one of `allowed`.
fn safe_path(
    raw: &str,
    base: &Path,
    allowed: &[PathBuf],
    writing: bool,
) -> Result<PathBuf, String> {
    let requested = Path::new(raw);
    if requested
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("parent-directory traversal is not allowed".to_owned());
    }
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        base.join(requested)
    };
    let checked = if writing && !joined.exists() {
        let parent = joined.parent().ok_or("write path has no parent")?;
        let parent = parent
            .canonicalize()
            .map_err(|error| format!("invalid write parent: {error}"))?;
        parent.join(joined.file_name().ok_or("write path has no filename")?)
    } else {
        joined
            .canonicalize()
            .map_err(|error| format!("invalid path: {error}"))?
    };
    if !allowed.iter().any(|root| checked.starts_with(root)) {
        return Err(format!(
            "path is outside the workspace: {}",
            checked.display()
        ));
    }
    Ok(checked)
}

fn read_text_file(
    params: &Value,
    workspace: &Arc<Mutex<Option<PathBuf>>>,
) -> Result<Value, String> {
    let raw = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing path")?;
    let path = safe_workspace_path(raw, workspace, false)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    Ok(json!({ "content": content }))
}

fn write_text_file(
    params: &Value,
    workspace: &Arc<Mutex<Option<PathBuf>>>,
) -> Result<Value, String> {
    let raw = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing path")?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or("missing content")?;
    let path = safe_workspace_path(raw, workspace, true)?;
    std::fs::write(&path, content).map_err(|error| format!("write {}: {error}", path.display()))?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_does_not_stub_terminal_wait_for_exit() {
        let workspace = Arc::new(Mutex::new(None));
        assert!(
            host_native_outcome("terminal/wait_for_exit", &json!({}), &workspace).is_none(),
            "terminal stubs must not return exitCode: 0 while terminal cap is false"
        );
        assert!(host_native_outcome("terminal/create", &json!({}), &workspace).is_none());
        assert!(host_native_outcome("x.ai/terminal/create", &json!({}), &workspace).is_none());
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = Arc::new(Mutex::new(Some(std::env::temp_dir())));
        assert!(safe_workspace_path("../secret", &root, false).is_err());
    }

    #[test]
    fn session_store_outranks_thanh_home_then_grok_home() {
        let thanh = OsStr::new("/fake/thanh-home");
        let grok = OsStr::new("/fake/grok-home");
        let app_home = || PathBuf::from("/fake/app-home");
        let sessions = |base: &str| PathBuf::from(format!("{base}/sessions"));

        assert_eq!(
            agent_state_root_from(Some(thanh), Some(grok), app_home()),
            sessions("/fake/thanh-home")
        );
        assert_eq!(
            agent_state_root_from(None, Some(grok), app_home()),
            sessions("/fake/grok-home")
        );
        assert_eq!(
            agent_state_root_from(Some(OsStr::new("")), None, app_home()),
            sessions("/fake/app-home")
        );
    }

    /// Plan mode writes `<session>/plan.md` through the client filesystem; the session store is
    /// outside the workspace, so it must be an allow-path.
    #[test]
    fn allows_plan_file_in_session_store_outside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let workspace = base.join("ws");
        let session = base
            .join("store")
            .join("%2FUsers%2Fthanhbm%2FProjects")
            .join("01a0afaa");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&session).unwrap();
        let allowed = vec![workspace.clone(), base.join("store")];

        let plan = session.join("plan.md");
        assert_eq!(
            safe_path(plan.to_str().unwrap(), &workspace, &allowed, true).unwrap(),
            plan
        );
    }

    #[test]
    fn still_rejects_paths_outside_every_allowed_root() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let workspace = base.join("ws");
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let allowed = vec![workspace.clone(), base.join("store")];

        let error = safe_path(
            outside.join("notes.md").to_str().unwrap(),
            &workspace,
            &allowed,
            true,
        )
        .unwrap_err();
        assert!(
            error.starts_with("path is outside the workspace:"),
            "{error}"
        );
        // Relative paths still resolve against the workspace.
        assert_eq!(
            safe_path("notes.md", &workspace, &allowed, true).unwrap(),
            workspace.join("notes.md")
        );
    }

    #[test]
    fn routes_response_to_matching_request_id() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, mut receiver) = oneshot::channel();
        pending.lock().insert(42, sender);
        assert!(route_pending_response(
            &json!({"jsonrpc": "2.0", "id": 42, "result": {"ok": true}}),
            &pending,
        ));
        assert_eq!(receiver.try_recv().unwrap().unwrap(), json!({"ok": true}));
        assert!(pending.lock().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn fake_ndjson_child_can_crash_and_restart() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!("thanh-acp-fake-{}", std::process::id()));
        std::fs::write(
            &path,
            "#!/bin/sh\nIFS= read -r line\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}'\nexit 23\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();

        for _ in 0..2 {
            let mut child = Command::new(&path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            writeln!(
                child.stdin.as_mut().unwrap(),
                "{}",
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
            )
            .unwrap();
            let mut line = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["id"], 1);
            assert_eq!(child.wait().unwrap().code(), Some(23));
        }
        std::fs::remove_file(path).unwrap();
    }
}
