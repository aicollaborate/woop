import { create } from "zustand";
import type { AgentConfig } from "@platform/tauri/client/agent";
import { deepseekHarness } from "@platform/tauri/client";

export interface DshModelConfigSnapshot {
  model: AgentConfig;
}

interface DshModelConfigState {
  configs: DshModelConfigSnapshot[] | null;
  setConfigs: (configs: DshModelConfigSnapshot[] | null) => void;
}

export const useDshModelConfigStore = create<DshModelConfigState>((set) => ({
  configs: null,
  setConfigs: (configs) => set({ configs }),
}));

let pendingLoad: Promise<DshModelConfigSnapshot[]> | null = null;

/** Shared by all DSH cards in this window and across controller remounts. */
export function loadDshModelConfigs(): Promise<DshModelConfigSnapshot[]> {
  const cached = useDshModelConfigStore.getState().configs;
  if (cached) return Promise.resolve(cached);
  if (pendingLoad) return pendingLoad;

  pendingLoad = deepseekHarness.list()
    .then((configs) => {
      useDshModelConfigStore.getState().setConfigs(configs);
      return configs;
    })
    .finally(() => {
      pendingLoad = null;
    });
  return pendingLoad;
}

export function invalidateDshModelConfigs(): void {
  useDshModelConfigStore.getState().setConfigs(null);
}
