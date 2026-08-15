// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createCodexSettingsItem } from "./external-agent-settings";

describe("createCodexSettingsItem", () => {
  it("renders a mode name with its secondary description", () => {
    const onSelect = vi.fn();
    const item = createCodexSettingsItem(
      "标准模式",
      true,
      onSelect,
      "功能完整的编码 Agent。",
    );

    expect(item.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("标准模式");
    expect(item.querySelector(".agent-thread-card__codex-settings-item-description")?.textContent)
      .toBe("功能完整的编码 Agent。");
    expect(item.getAttribute("aria-checked")).toBe("true");

    item.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
