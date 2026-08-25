export const FLOWIX_DSH_BRIDGE_PROTOCOL_VERSION = 1 as const;

export const FLOWIX_DSH_BRIDGE_CAPABILITIES = [
  "runtime-events",
  "session-control",
  "session-history",
  "session-dispose",
  "run-cancel",
  "profile",
  "credentials-management",
  "model-settings-management",
] as const;

export type FlowixDshBridgeCapability =
  (typeof FLOWIX_DSH_BRIDGE_CAPABILITIES)[number];

export interface FlowixDshBridgeCapabilities {
  protocolVersion: typeof FLOWIX_DSH_BRIDGE_PROTOCOL_VERSION;
  capabilities: readonly FlowixDshBridgeCapability[];
}

export interface FlowixDshBridgeEvent {
  protocolVersion: typeof FLOWIX_DSH_BRIDGE_PROTOCOL_VERSION;
  kind: "session.event" | "agent.status";
  sessionId: string;
  event?: unknown;
  status?: "idle" | "running";
}

export interface FlowixDshBridgeStatus {
  protocolVersion: typeof FLOWIX_DSH_BRIDGE_PROTOCOL_VERSION;
  provider: string;
  model: string;
  cwd: string;
  sessions: Array<{ sessionId: string; status: "idle" | "running" }>;
}

export interface FlowixDshBridgeHistoryPage {
  sessionId: string;
  events: Array<Record<string, unknown>>;
  snapshotSeq: number;
}

export interface FlowixDshCredentialInfo {
  configured: boolean;
  source?: string;
  writable: boolean;
}

export interface FlowixDshModelsSettings {
  revision: number;
  providers: Record<string, Record<string, unknown>>;
  applies: "live" | "restart";
}
