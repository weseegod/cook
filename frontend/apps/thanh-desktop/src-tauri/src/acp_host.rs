use std::collections::HashMap;
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
    let outcome = match method {
        "fs/read_text_file" => read_text_file(&params, workspace),
        "fs/write_text_file" => write_text_file(&params, workspace),
        "terminal/create" | "x.ai/terminal/create" => Ok(json!({
            "terminalId": format!("desktop-stub-{}", id.as_u64().unwrap_or_default())
        })),
        "terminal/output" => Ok(json!({ "output": "", "truncated": false, "exitStatus": null })),
        "terminal/wait_for_exit" => Ok(json!({ "exitCode": 0, "signal": null })),
        "terminal/release" | "terminal/kill" => Ok(json!({})),
        _ if method.starts_with("x.ai/terminal/") => Ok(json!({})),
        _ => return false,
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

fn safe_workspace_path(
    raw: &str,
    workspace: &Arc<Mutex<Option<PathBuf>>>,
    writing: bool,
) -> Result<PathBuf, String> {
    let root = workspace.lock().clone().ok_or("no active workspace")?;
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
        root.join(requested)
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
    if !checked.starts_with(&root) {
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
    fn rejects_parent_traversal() {
        let root = Arc::new(Mutex::new(Some(std::env::temp_dir())));
        assert!(safe_workspace_path("../secret", &root, false).is_err());
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
