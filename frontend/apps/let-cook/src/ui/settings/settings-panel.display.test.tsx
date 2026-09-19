import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/client", () => ({
  acpClient: {
    setYolo: vi.fn(async () => undefined),
    xai: { resetPermissions: vi.fn(async () => undefined) },
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));

vi.mock("../../state/catalog", () => ({
  useModelSelection: () => ({ id: null, models: [] }),
}));

vi.mock("../theme/theme", () => ({
  useTheme: () => ({ preference: "system", setPreference: vi.fn() }),
}));

import { readLocal } from "../storage";
import { COMPOSER_SHOW_DIFFSTAT_KEY, COMPOSER_SHOW_TPS_KEY } from "../preferences";
import { SettingsPanel } from "./settings-panel";

beforeEach(() => {
  localStorage.clear();
});

describe("SettingsPanel Display toggles", () => {
  it("defaults both composer metric toggles on and writes prefs immediately", () => {
    render(<SettingsPanel onClose={() => undefined} />);

    const tps = screen.getByRole("checkbox", { name: "Show tokens per second" });
    const diff = screen.getByRole("checkbox", { name: "Show line changes" });
    expect(tps).toBeChecked();
    expect(diff).toBeChecked();

    fireEvent.click(tps);
    fireEvent.click(diff);
    expect(readLocal(COMPOSER_SHOW_TPS_KEY)).toBe("false");
    expect(readLocal(COMPOSER_SHOW_DIFFSTAT_KEY)).toBe("false");
    expect(tps).not.toBeChecked();
    expect(diff).not.toBeChecked();
  });
});
