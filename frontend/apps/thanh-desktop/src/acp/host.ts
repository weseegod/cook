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

export async function startProcess(cwd: string): Promise<StartInfo> {
  if (!isTauri()) {
    if (import.meta.env.VITE_MOCK_ACP === "1") {
      return { binaryPath: "mock://thanh", binaryVersion: "1.0.32", cwd };
    }
    throw new Error("Thanh Desktop must run inside Tauri (use pnpm tauri dev)");
  }
  return invoke<StartInfo>("acp_start", { cwd });
}

export async function stopProcess(): Promise<void> {
  if (isTauri()) await invoke("acp_stop");
}

export async function request<T>(method: string, params: unknown = {}): Promise<T> {
  if (!isTauri()) return mockRequest<T>(method, params);
  return invoke<T>("acp_request", { method, params });
}

export async function notify(method: string, params: unknown = {}): Promise<void> {
  if (isTauri()) await invoke("acp_notify", { method, params });
}

export async function respond(
  id: number | string,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): Promise<void> {
  if (isTauri()) await invoke("acp_respond", { id, result, error });
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return "/tmp/thanh-demo";
  return invoke<string | null>("pick_folder");
}

export async function getConfigSecurity(): Promise<ConfigSecurity> {
  if (!isTauri()) return { path: "~/.thanh/config.toml", exists: false, worldReadable: false };
  return invoke<ConfigSecurity>("config_security");
}

export async function onMessage(handler: (message: RpcMessage) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
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

async function mockRequest<T>(method: string, params: unknown): Promise<T> {
  if (import.meta.env.VITE_MOCK_ACP !== "1") throw new Error("Tauri IPC is unavailable");
  const sessionId = "mock-session";
  const results: Record<string, unknown> = {
    initialize: { protocolVersion: 1, agentCapabilities: {} },
    "session/new": { sessionId, modes: null },
    "session/load": { modes: null },
    "session/prompt": { stopReason: "end_turn" },
    "x.ai/session/list": { sessions: [] },
    "x.ai/models/list": { models: [{ id: "demo", name: "Demo model" }] },
    "x.ai/commands/list": { commands: [] },
  };
  void params;
  return (results[method] ?? {}) as T;
}
