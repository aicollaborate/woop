import type { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type {
  FlowixDshBridgeCapabilities,
  FlowixDshBridgeEvent,
  FlowixDshBridgeHistoryPage,
  FlowixDshBridgeStatus,
  FlowixDshBackgroundJob,
  FlowixDshCredentialInfo,
  FlowixDshModelsSettings,
} from "./protocol.ts";

/**
 * Flowix-side client for the DSH-runtime bridge. It intentionally exposes raw
 * DSH bridge events; conversion to AgentChunk belongs to the desktop/UI
 * adapter, so the runtime protocol never becomes coupled to Flowix rendering.
 */
export class FlowixDshBridgeClient {
  constructor(private readonly harness: DeepSeekHarness) {}

  /**
   * Bootstrap the SDK transport before using bridge-owned session control.
   * The published SDK type intentionally exposes only request/subscribe on
   * `client`; the concrete client also owns the documented initialize/start
   * handshake used by DeepSeekHarness.run(). Keep that compatibility detail
   * here so SessionPool remains expressed in bridge terms.
   */
  async initialize(spec: { cwd: string; provider: string; model: string; maxTokens?: number }): Promise<void> {
    // Keep the same transport alive while settings-file publishes its initial
    // document. The public DeepSeekHarness.start() closes and replaces the
    // runtime after an initialize error, which would restart the very process
    // whose llm-pi-ai route is still becoming ready.
    const client = this.harness.client as unknown as {
      start(): void;
      initialize(params: { cwd: string; provider: string; model: string; maxTokens?: number }): Promise<unknown>;
    };
    client.start();
    await client.initialize({
      cwd: spec.cwd,
      provider: spec.provider,
      model: spec.model,
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    });
  }

  async capabilities(): Promise<FlowixDshBridgeCapabilities> {
    // The SDK JSON-RPC server can accept requests before Cordis has finished
    // activating the bridge's injected settings/credentials/llm services.
    // Retry only the explicit not-yet-registered response; every other error
    // remains immediate and actionable.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return requireCapabilities(
          await this.harness.client.request("flowix.bridge.capabilities"),
        );
      } catch (error) {
        if (attempt >= 99 || !/unknown DeepSeek Harness SDK runtime method: flowix\.bridge\.capabilities/i.test(errorMessage(error))) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  async status(): Promise<FlowixDshBridgeStatus> {
    return requireStatus(
      await this.harness.client.request("flowix.bridge.status"),
    );
  }

  async ensureSession(sessionId: string): Promise<{ sessionId: string }> {
    const value = await this.harness.client.request(
      "flowix.bridge.session.ensure",
      { sessionId },
    );
    if (!isRecord(value) || typeof value.sessionId !== "string") {
      throw new Error(
        "flowix bridge returned an invalid session.ensure result",
      );
    }
    return { sessionId: value.sessionId };
  }

  async prompt(
    sessionId: string,
    prompt: { modelText: string; displayText: string; clientMessageId: string },
  ): Promise<{ messageId: string }> {
    const value = await this.harness.client.request(
      "flowix.bridge.session.prompt",
      { sessionId, ...prompt },
    );
    if (!isRecord(value) || typeof value.messageId !== "string") {
      throw new Error(
        "flowix bridge returned an invalid session.prompt result",
      );
    }
    return { messageId: value.messageId };
  }

  async cancel(sessionId: string): Promise<boolean> {
    const value = await this.harness.client.request(
      "flowix.bridge.run.cancel",
      { sessionId },
    );
    return isRecord(value) && value.cancelled === true;
  }

  async backgroundJobs(sessionId: string): Promise<FlowixDshBackgroundJob[]> {
    const value = await this.harness.client.request(
      "flowix.bridge.jobs.list",
      { sessionId },
    );
    if (!isRecord(value) || !Array.isArray(value.jobs)) {
      throw new Error("flowix bridge returned invalid jobs.list result");
    }
    return value.jobs as FlowixDshBackgroundJob[];
  }

  async history(
    sessionId: string,
  ): Promise<FlowixDshBridgeHistoryPage> {
    const value = await this.harness.client.request(
      "flowix.bridge.session.history",
      { sessionId },
    );
    if (
      !isRecord(value) || value.sessionId !== sessionId ||
      !Array.isArray(value.events) || !value.events.every(isRecord) ||
      !Number.isSafeInteger(value.snapshotSeq)
    ) {
      throw new Error("flowix bridge returned an invalid session.history result");
    }
    return value as unknown as FlowixDshBridgeHistoryPage;
  }

  async disposeSession(sessionId: string): Promise<boolean> {
    const value = await this.harness.client.request(
      "flowix.bridge.session.dispose",
      { sessionId },
    );
    return isRecord(value) && value.disposed === true;
  }

  async credentialDescribe(reference: string): Promise<FlowixDshCredentialInfo> {
    return requireCredentialInfo(await this.harness.client.request(
      "flowix.bridge.credentials.describe", { reference },
    ));
  }

  async credentialSet(reference: string, value: string): Promise<FlowixDshCredentialInfo> {
    return requireCredentialInfo(await this.harness.client.request(
      "flowix.bridge.credentials.set", { reference, value },
    ));
  }

  async credentialUnset(reference: string): Promise<FlowixDshCredentialInfo> {
    return requireCredentialInfo(await this.harness.client.request(
      "flowix.bridge.credentials.unset", { reference },
    ));
  }

  async modelsDescribe(): Promise<FlowixDshModelsSettings> {
    return requireModelsSettings(await this.harness.client.request("flowix.bridge.models.describe"));
  }

  async modelsDiscover(request: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const value = await this.harness.client.request("flowix.bridge.models.discover", { request });
    if (!isRecord(value) || !Array.isArray(value.models) || !value.models.every(isRecord)) {
      throw new Error("flowix bridge returned invalid discovered models");
    }
    return value.models;
  }

  async modelUpsert(route: string, profile: Record<string, unknown>, expectedRevision?: number): Promise<FlowixDshModelsSettings> {
    return requireModelsSettings(await this.harness.client.request(
      "flowix.bridge.models.upsert", { route, profile, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
    ));
  }

  async modelRemove(route: string, expectedRevision?: number): Promise<FlowixDshModelsSettings> {
    return requireModelsSettings(await this.harness.client.request(
      "flowix.bridge.models.remove", { route, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
    ));
  }

  subscribeEvents(): {
    next(): Promise<FlowixDshBridgeEvent>;
    close(): void;
  } {
    const subscription = this.harness.client.subscribe(
      (notification) => notification.method === "flowix.bridge.event",
    );
    return {
      async next() {
        return requireEvent(await subscription.next());
      },
      close() {
        subscription.close();
      },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCapabilities(value: unknown): FlowixDshBridgeCapabilities {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !Array.isArray(value.capabilities)
  ) {
    throw new Error("flowix bridge returned invalid capabilities");
  }
  return value as unknown as FlowixDshBridgeCapabilities;
}

function requireStatus(value: unknown): FlowixDshBridgeStatus {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.cwd !== "string" ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("flowix bridge returned invalid status");
  }
  return value as unknown as FlowixDshBridgeStatus;
}

function requireEvent(notification: {
  params: Record<string, unknown>;
}): FlowixDshBridgeEvent {
  const value = notification.params;
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    typeof value.kind !== "string" ||
    typeof value.sessionId !== "string"
  ) {
    throw new Error("flowix bridge returned invalid event");
  }
  return value as unknown as FlowixDshBridgeEvent;
}

function requireCredentialInfo(value: unknown): FlowixDshCredentialInfo {
  if (!isRecord(value) || typeof value.configured !== "boolean" || typeof value.writable !== "boolean") {
    throw new Error("flowix bridge returned invalid credential info");
  }
  return value as FlowixDshCredentialInfo;
}

function requireModelsSettings(value: unknown): FlowixDshModelsSettings {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || !isRecord(value.providers) || !["live", "restart"].includes(value.applies)) {
    throw new Error("flowix bridge returned invalid model settings");
  }
  return value as FlowixDshModelsSettings;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
