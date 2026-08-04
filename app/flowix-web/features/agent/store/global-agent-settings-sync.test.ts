import { describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/lib/constants";
import { DEFAULT_AGENT_SESSION_META } from "@features/agent/store/session-state";
import { installGlobalAgentSettingsSync } from "@features/agent/store/global-agent-settings-sync";

describe("installGlobalAgentSettingsSync", () => {
  it("applies settings written by another Webview", () => {
    const update = vi.fn();
    installGlobalAgentSettingsSync(update);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: STORAGE_KEYS.AGENT_SESSION,
        newValue: JSON.stringify({
          state: {
            sessionMeta: {
              settings: {
                ...DEFAULT_AGENT_SESSION_META.settings,
                agentPermissionMode: "read-only",
              },
            },
          },
        }),
      }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(
      update.mock.calls[0][0](DEFAULT_AGENT_SESSION_META).settings
        .agentPermissionMode,
    ).toBe("read-only");
  });
});
