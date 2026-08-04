import { STORAGE_KEYS } from "@/lib/constants";
import type { AgentSessionMeta } from "@features/agent/store/session-state";

export function installGlobalAgentSettingsSync(
  updateMeta: (
    updater: (meta: AgentSessionMeta) => AgentSessionMeta,
  ) => void,
): void {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEYS.AGENT_SESSION || !event.newValue) return;
    try {
      const settings = (
        JSON.parse(event.newValue) as {
          state?: { sessionMeta?: Pick<AgentSessionMeta, "settings"> };
        }
      ).state?.sessionMeta?.settings;
      if (!settings) return;
      updateMeta((meta) => ({
        ...meta,
        settings: { ...meta.settings, ...settings },
      }));
    } catch {
      // Ignore malformed external writes. Rehydration falls back safely.
    }
  });
}
