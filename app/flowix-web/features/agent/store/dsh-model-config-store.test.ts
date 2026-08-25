import { beforeEach, describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@platform/tauri/client", () => ({
  deepseekHarness: { list },
}));

import {
  invalidateDshModelConfigs,
  loadDshModelConfigs,
} from "./dsh-model-config-store";

const configs = [{
  model: {
    provider: "deepseek",
    model: "deepseek-chat",
    apiUrl: "",
    apiKeys: {},
  },
}];

describe("dsh model config store", () => {
  beforeEach(() => {
    invalidateDshModelConfigs();
    list.mockReset();
  });

  it("merges concurrent loads and reuses the cached snapshot", async () => {
    list.mockResolvedValue(configs);
    const first = loadDshModelConfigs();
    const second = loadDshModelConfigs();
    expect(first).toBe(second);
    expect(await first).toEqual(configs);
    expect(await loadDshModelConfigs()).toEqual(configs);
    expect(list).toHaveBeenCalledOnce();
  });

  it("loads again after invalidation", async () => {
    list.mockResolvedValue(configs);
    await loadDshModelConfigs();
    invalidateDshModelConfigs();
    await loadDshModelConfigs();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
