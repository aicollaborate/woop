import type { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type {
  FlowixDshBridgeCapabilities,
  FlowixDshBridgeEvent,
  FlowixDshBridgeStatus,
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
    return requireCapabilities(
      await this.harness.client.request("flowix.bridge.capabilities"),
    );
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
    text: string,
  ): Promise<{ messageId: string }> {
    const value = await this.harness.client.request(
      "flowix.bridge.session.prompt",
      { sessionId, text },
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

  async disposeSession(sessionId: string): Promise<boolean> {
    const value = await this.harness.client.request(
      "flowix.bridge.session.dispose",
      { sessionId },
    );
    return isRecord(value) && value.disposed === true;
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
