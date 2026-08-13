import type { AgentTypeKey } from "@/types/agent";
import {
  applyResolvedExternalSession,
  createExternalAgentRuntimeHandle,
  getExternalAgentRuntimeThreadId,
  getResolvedExternalSessionId,
} from "@features/agent/services/external-agent-runtime-service";

export interface ApplyResolvedSessionOptions {
  threadId: string;
  sessionId: string;
  typeKey: AgentTypeKey;
  isDestroyed: boolean;
}

export class ThreadSessionController {
  readonly runtimeHandleId = createExternalAgentRuntimeHandle();

  private appliedResolvedSessionKeys = new Set<string>();

  getRuntimeThreadId(threadId: string | null): string | null {
    return getExternalAgentRuntimeThreadId(this.runtimeHandleId, threadId);
  }

  getRenderThreadId(threadId: string | null): string | null {
    return this.getRuntimeThreadId(threadId);
  }

  getResolvedSessionId(threadId: string | null): string | null {
    return getResolvedExternalSessionId(threadId) ?? null;
  }

  applyResolvedSession(options: ApplyResolvedSessionOptions): void {
    const {
      threadId,
      sessionId,
      typeKey,
      isDestroyed,
    } = options;
    const resolutionKey = `${threadId}->${sessionId}`;
    if (
      !sessionId ||
      sessionId === threadId ||
      this.appliedResolvedSessionKeys.has(resolutionKey) ||
      isDestroyed
    ) {
      return;
    }

    this.appliedResolvedSessionKeys.add(resolutionKey);
    applyResolvedExternalSession(
      this.runtimeHandleId,
      threadId,
      sessionId,
      typeKey,
    );
  }
}
