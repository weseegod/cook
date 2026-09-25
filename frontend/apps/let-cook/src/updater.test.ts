import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.fn();
const relaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));

async function loadUpdater() {
  vi.resetModules();
  return import("./updater");
}

describe("updater", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset();
    vi.unstubAllEnvs();
  });

  it("shows a local update preview without installing when the updater is unset", async () => {
    const { UPDATER_CONFIGURED, UPDATER_PREVIEW, checkForAppUpdates, installAppUpdate } = await loadUpdater();
    expect(UPDATER_CONFIGURED).toBe(false);
    expect(UPDATER_PREVIEW).toBe(true);
    await expect(checkForAppUpdates()).resolves.toEqual({
      status: "available",
      version: `${__APP_VERSION__}-local`,
    });
    await expect(installAppUpdate()).resolves.toEqual({ status: "disabled" });
    expect(check).not.toHaveBeenCalled();
  });

  it("checks and installs when VITE_COOK_UPDATER=1", async () => {
    vi.stubEnv("VITE_COOK_UPDATER", "1");
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    check.mockResolvedValue({ version: "1.0.37", body: "notes", downloadAndInstall });
    const { UPDATER_CONFIGURED, checkForAppUpdates, installAppUpdate } = await loadUpdater();
    expect(UPDATER_CONFIGURED).toBe(true);
    await expect(checkForAppUpdates()).resolves.toEqual({
      status: "available",
      version: "1.0.37",
      notes: "notes",
    });
    await expect(installAppUpdate()).resolves.toEqual({ status: "installed" });
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
