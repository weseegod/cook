import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StartInfo {
  binaryPath: string;
  binaryVersion: string;
  cwd: string;
}

export interface AcpStatus {
  state: "running" | "exited";
  detail?: string;
}

export interface ConfigSecurity {
  path: string;
  exists: boolean;
  worldReadable: boolean;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;
const isMock = () => !isTauri() && import.meta.env.VITE_MOCK_ACP === "1";

/** The browser stand-in, loaded lazily so the mock never ships in the Tauri path. */
async function mock() {
  return import("./mock-transport");
}

export async function startProcess(cwd: string): Promise<StartInfo> {
  if (!isTauri()) {
    if (isMock()) {
      return { binaryPath: "mock://thanh", binaryVersion: "1.0.32", cwd };
    }
    throw new Error("Thanh Desktop must run inside Tauri (use pnpm tauri dev)");
  }
  return invoke<StartInfo>("acp_start", { cwd });
}

export async function stopProcess(): Promise<void> {
  if (isTauri()) await invoke("acp_stop");
}

/**
 * Unwrap the agent's `ExtMethodResult` envelope (`{ result, error }`) when present.
 *
 * Most `x.ai/*` methods answer with that envelope; a bare payload passes through untouched, and
 * an `error` field becomes a rejected promise so callers never render a silent failure.
 */
export function unwrapExtResult<T>(value: unknown): T {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const enveloped = keys.every((key) => key === "result" || key === "error");
    if (enveloped && (keys.includes("result") || keys.includes("error"))) {
      if (record.error !== undefined && record.error !== null) {
        throw new Error(typeof record.error === "string" ? record.error : JSON.stringify(record.error));
      }
      return record.result as T;
    }
  }
  return value as T;
}

/**
 * Extension methods travel as `_x.ai/...`; the agent strips the underscore and routes the call to
 * its extension handler. Sent without it, a bare `x.ai/...` request comes back `-32601 Method not
 * found`, which silently empties the model picker, sessions list, and every settings surface.
 */
export function wireMethod(method: string): string {
  return method.startsWith("x.ai/") ? `_${method}` : method;
}

export async function request<T>(method: string, params: unknown = {}): Promise<T> {
  // Both transports deliver the same shape: the JSON-RPC `result` field, which for most
  // `x.ai/*` methods is the agent's `{ result, error }` envelope.
  const value = isTauri()
    ? await invoke<T>("acp_request", { method: wireMethod(method), params })
    : await (await mock()).mockRequest<T>(wireMethod(method), params);
  return unwrapExtResult<T>(value);
}

export async function notify(method: string, params: unknown = {}): Promise<void> {
  if (isTauri()) await invoke("acp_notify", { method: wireMethod(method), params });
  else if (isMock()) {
    const { mockRequest } = await mock();
    await mockRequest(wireMethod(method), params);
  }
}

export async function respond(
  id: number | string,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): Promise<void> {
  if (isTauri()) await invoke("acp_respond", { id, result, error });
  else if (isMock()) {
    const { mockRespond } = await mock();
    mockRespond(id, error ? { error } : result);
  }
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return "/tmp/thanh-demo";
  return invoke<string | null>("pick_folder");
}

export interface FilePayload {
  data: string;
  mediaType: string;
  size: number;
}

/**
 * Native attachment picker. Returns `null` outside Tauri so the composer can fall back to a
 * browser file input, which is the only way to get bytes there.
 */
export async function pickFiles(): Promise<string[] | null> {
  if (!isTauri()) {
    if (isMock()) return (await mock()).mockPickFiles();
    return null;
  }
  return invoke<string[]>("pick_files");
}

/** Read one attached file (base64) for an ACP `image` part. */
export async function readFilePayload(path: string): Promise<FilePayload> {
  if (isTauri()) return invoke<FilePayload>("read_file_base64", { path });
  return (await mock()).mockReadFilePayload(path);
}

/**
 * OS drag-and-drop of files onto the window. Tauri intercepts native drops, so the webview never
 * sees them as HTML5 events; this is how a dropped file keeps its path.
 */
export async function onFileDrop(handler: (paths: string[], phase: "over" | "drop" | "leave") => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "drop") handler(payload.paths, "drop");
    else if (payload.type === "leave") handler([], "leave");
    else handler([], "over");
  });
}

export async function getConfigSecurity(): Promise<ConfigSecurity> {
  if (!isTauri()) return { path: "~/.thanh/config.toml", exists: false, worldReadable: false };
  return invoke<ConfigSecurity>("config_security");
}

export async function onMessage(handler: (message: RpcMessage) => void): Promise<UnlistenFn> {
  if (!isTauri()) {
    if (!isMock()) return () => undefined;
    const { subscribe } = await mock();
    return subscribe((message) => handler(message as RpcMessage));
  }
  const disposeSingle = await listen<RpcMessage>("acp-message", ({ payload }) => handler(payload));
  const disposeBatch = await listen<RpcMessage[]>("acp-messages", ({ payload }) => payload.forEach(handler));
  return () => { disposeSingle(); disposeBatch(); };
}

export async function onStatus(handler: (status: AcpStatus) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AcpStatus>("acp-status", ({ payload }) => handler(payload));
}

export async function onLog(handler: (line: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<string>("acp-log", ({ payload }) => handler(payload));
}
