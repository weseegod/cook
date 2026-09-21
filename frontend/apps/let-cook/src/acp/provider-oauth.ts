/**
 * OAuth connect for ChatGPT, Claude, and Grok on Settings → Models.
 *
 * Grok reuses the agent's existing `authenticate` + `x.ai/auth/*` device/loopback flow.
 * ChatGPT and Claude run in the desktop host (no CORS) and fall back to the mock ACP
 * transport in Playwright.
 */
import { desktopCommand, request } from "./host";

export type OauthMode = "device" | "paste" | "loopback";

export interface OauthStart {
  id: string;
  mode: OauthMode;
  authorizeUrl: string;
  userCode?: string | null;
  needsCode: boolean;
}

export interface OauthStatus {
  status: "pending" | "connected" | "error" | "cancelled";
  error?: string;
}

let grokAuth: { requestSeq: number; done: Promise<void> } | null = null;

export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  await desktopCommand("open_url", { url }, async () => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

export async function startProviderOauth(id: string): Promise<OauthStart> {
  if (id === "xai") return startGrokOauth();
  return desktopCommand<OauthStart>("provider_oauth_start", { id }, () =>
    request<OauthStart>("x.ai/providers/oauth/start", { id }),
  );
}

export async function pollProviderOauth(id: string): Promise<OauthStatus> {
  if (id === "xai") return pollGrokOauth();
  return desktopCommand<OauthStatus>("provider_oauth_poll", { id }, () =>
    request<OauthStatus>("x.ai/providers/oauth/poll", { id }),
  );
}

export async function submitProviderOauthCode(id: string, code: string): Promise<OauthStatus> {
  if (id === "xai") {
    await request("x.ai/auth/submit_code", { code });
    return { status: "pending" };
  }
  return desktopCommand<OauthStatus>("provider_oauth_submit_code", { id, code }, () =>
    request<OauthStatus>("x.ai/providers/oauth/submit_code", { id, code }),
  );
}

export async function cancelProviderOauth(id: string): Promise<void> {
  if (id === "xai") {
    const requestSeq = grokAuth?.requestSeq;
    grokAuth = null;
    await request("x.ai/auth/cancel", requestSeq ? { request_seq: requestSeq } : {}).catch(() => undefined);
    return;
  }
  await desktopCommand("provider_oauth_cancel", { id }, () =>
    request("x.ai/providers/oauth/cancel", { id }),
  ).catch(() => undefined);
}

export async function logoutProviderOauth(id: string): Promise<void> {
  if (id === "xai") {
    await request("x.ai/auth/logout", {});
    return;
  }
  await desktopCommand("provider_oauth_logout", { id }, () =>
    request("x.ai/providers/oauth/logout", { id }),
  );
}

async function startGrokOauth(): Promise<OauthStart> {
  const requestSeq = Date.now();
  const done = request("authenticate", {
    methodId: "grok.com",
    _meta: { force_interactive: true, request_seq: requestSeq },
  }).then(() => undefined);
  grokAuth = { requestSeq, done };
  const info = await request<{ auth_url?: string | null; authUrl?: string | null; mode?: string | null }>(
    "x.ai/auth/get_url",
    {},
  );
  const authorizeUrl = info.auth_url ?? info.authUrl ?? "";
  const mode: OauthMode = info.mode === "device" ? "device" : info.mode === "command" ? "loopback" : "loopback";
  const userCode = userCodeFromUrl(authorizeUrl);
  return {
    id: "xai",
    mode,
    authorizeUrl,
    userCode,
    needsCode: mode === "loopback" && !userCode,
  };
}

async function pollGrokOauth(): Promise<OauthStatus> {
  const pending = grokAuth;
  if (!pending) {
    const info = await request<{ methodId?: string | null }>("x.ai/auth/info", {});
    return { status: info.methodId ? "connected" : "pending" };
  }
  const winner = await Promise.race([
    pending.done.then(() => "done" as const).catch((error: unknown) => error),
    new Promise<"wait">((resolve) => window.setTimeout(() => resolve("wait"), 800)),
  ]);
  if (winner === "wait") return { status: "pending" };
  grokAuth = null;
  if (winner !== "done") {
    return { status: "error", error: winner instanceof Error ? winner.message : String(winner) };
  }
  return { status: "connected" };
}

function userCodeFromUrl(url: string): string | null {
  try {
    const value = new URL(url).searchParams.get("user_code");
    return value && /^[A-Za-z0-9-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
