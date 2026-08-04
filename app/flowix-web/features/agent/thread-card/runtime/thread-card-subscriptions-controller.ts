import type { AgentTypeKey } from "@/types/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import type { ThreadProjection } from "@features/agent/store/session-reducer";
import {
  isLocalExternalThreadId,
  resolveExternalSessionId,
} from "@features/agent/services/external-agent-runtime-service";

export interface AgentThreadCardSubscriptionsControllerOptions {
  getRuntimeThreadId: () => string | null;
  getRenderThreadId: () => string | null;
  getStoredThreadId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getInstanceId: () => string | null;
  getResolvedSessionId: (threadId: string | null) => string | null | undefined;
  renderThreadState: () => void;
  refreshAttrs: () => void;
  refreshExternalAgentEmptySettings: () => void;
  isExternalSettingsOpen: () => boolean;
  renderCodexSettingsPopover: () => void;
  applyResolvedExternalSessionId: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;
  syncRuntimeBadge: () => void;
}

type Unsubscribe = () => void;

export class AgentThreadCardSubscriptionsController {
  private readonly options: AgentThreadCardSubscriptionsControllerOptions;
  private unsubscribes: Unsubscribe[] = [];

  constructor(options: AgentThreadCardSubscriptionsControllerOptions) {
    this.options = options;
  }

  subscribe(): void {
    this.dispose();
    this.unsubscribes = [
      this.subscribeThreadState(),
      this.subscribeTitle(),
      this.subscribeSettings(),
      ...this.subscribeConversation(),
      this.subscribeRuntime(),
    ];
  }

  private subscribeTitle(): Unsubscribe {
    const options = this.options;
    return useAgentSessionStore.subscribe(
      (state) => {
        const threadId = options.getRenderThreadId();
        const typeKey = options.getTypeKey();
        // Read canonical metadata directly.
        const meta = state.sessionMeta;
        return {
          listTitle: threadId
            ? meta.threadLists[typeKey]?.find(
                (item) => item.threadId === threadId,
              )?.title
            : undefined,
          activeTitle:
            threadId && meta.activeThreadIds[typeKey] === threadId
              ? meta.currentThreadTitles[typeKey]
              : undefined,
        };
      },
      () => options.refreshAttrs(),
      {
        equalityFn: (a, b) =>
          a.listTitle === b.listTitle && a.activeTitle === b.activeTitle,
      },
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
  }

  private subscribeThreadState(): Unsubscribe {
    const options = this.options;
    // Phase 5.3: 订阅 session-store.threadProjections (projection ref-stable).
    // currentThreadState() reads the same ref-stable projection cache.
    // handleThreadStateChange 内 session resolution 路径仅 codex/claude
    // 触发, flowix 不走 -> 无循环.
    return useAgentSessionStore.subscribe(
      (state) => {
        const threadId = options.getRuntimeThreadId();
        const renderThreadId = options.getRenderThreadId();
        const storedThreadId = options.getStoredThreadId();
        const resolvedSessionId =
          options.getResolvedSessionId(threadId) ??
          options.getResolvedSessionId(storedThreadId);
        const typeKey = options.getTypeKey();
        const localThreadId =
          threadId && isLocalExternalThreadId(threadId, typeKey)
            ? threadId
            : storedThreadId && isLocalExternalThreadId(storedThreadId, typeKey)
              ? storedThreadId
              : null;
        const projection = renderThreadId
          ? state.threadProjections[renderThreadId]
          : undefined;
        return {
          threadId,
          renderThreadId,
          projection,
          resolvedSessionId,
          localThreadId,
        };
      },
      (next) => this.handleThreadStateChange(next),
      {
        equalityFn: (a, b) =>
          a.threadId === b.threadId &&
          a.renderThreadId === b.renderThreadId &&
          a.projection === b.projection &&
          a.resolvedSessionId === b.resolvedSessionId &&
          a.localThreadId === b.localThreadId,
      },
    );
  }

  private handleThreadStateChange(next: {
    threadId: string | null;
    projection: ThreadProjection | undefined;
    resolvedSessionId: string | null | undefined;
    localThreadId: string | null;
  }): void {
    const options = this.options;
    const typeKey = options.getTypeKey();
    if (
      (typeKey === "codex" || typeKey === "claude") &&
      next.localThreadId &&
      next.resolvedSessionId
    ) {
      options.applyResolvedExternalSessionId(
        next.localThreadId,
        next.resolvedSessionId,
        typeKey,
      );
    } else if (
      (typeKey === "codex" || typeKey === "claude") &&
      next.threadId &&
      isLocalExternalThreadId(next.threadId, typeKey) &&
      next.projection &&
      !next.projection.runs.isLoading &&
      !next.projection.runs.activeRunId
    ) {
      const localThreadId = next.threadId;
      void resolveExternalSessionId(localThreadId, typeKey).then(
        (sessionId) => {
          if (sessionId && sessionId !== localThreadId) {
            options.applyResolvedExternalSessionId(
              localThreadId,
              sessionId,
              typeKey,
            );
          }
        },
      );
    }
  }

  private subscribeSettings(): Unsubscribe {
    const options = this.options;
    // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.settings.
    return useAgentSessionStore.subscribe(
      (state) => ({
        agentPermissionMode: state.sessionMeta.settings.agentPermissionMode,
        agentCodexModel: state.sessionMeta.settings.agentCodexModel,
        agentCodexReasoningEffort:
          state.sessionMeta.settings.agentCodexReasoningEffort,
      }),
      () => {
        options.refreshExternalAgentEmptySettings();
        if (options.isExternalSettingsOpen()) {
          options.renderCodexSettingsPopover();
        }
      },
      {
        equalityFn: (a, b) =>
          a.agentPermissionMode === b.agentPermissionMode &&
          a.agentCodexModel === b.agentCodexModel &&
          a.agentCodexReasoningEffort === b.agentCodexReasoningEffort,
      },
    );
  }

  private subscribeConversation(): Unsubscribe[] {
    const options = this.options;
    // Phase 7 (2026-08-03): 改直读 session-store 真源. 之前用 conv-store
    // 是因为 selector 返回新对象 (`{ instance, messageState }`) 触发了
    // session-store dispatch 的 shallow 不到的场景. 这里拆成两个独立
    // subscription, 每个 selector 只返回单一引用 (string/number/
    // record), equalityFn 直接 === 比较, 干净过滤.
    const unsubInstance = useAgentSessionStore.subscribe(
      (state) => {
        const instanceId = options.getInstanceId();
        return instanceId
          ? state.conversationRegistry.instances[instanceId]
          : undefined;
      },
      (next, previous) => {
        if (next !== previous) {
          options.refreshAttrs();
          options.refreshExternalAgentEmptySettings();
          if (options.isExternalSettingsOpen()) {
            options.renderCodexSettingsPopover();
          }
        }
      },
      { equalityFn: (a, b) => a === b },
    );
    // messageState 同样拆出来 ── 但只有 threadId 有效时才有意义.
    // threadProjections 由 session-store 真源持有, equalityFn 用 === 比较
    // 引用, 没变化时不触发 callback. dispatch 每次新建 projection 引用,
    // 但这是 session-store 自身行为, callback 会被正确触发.
    const unsubProjection = useAgentSessionStore.subscribe(
      (state) => {
        const threadId = options.getRenderThreadId();
        return threadId ? state.threadProjections[threadId] : undefined;
      },
      () => options.renderThreadState(),
      { equalityFn: (a, b) => a === b },
    );
    return [unsubInstance, unsubProjection];
  }

  private subscribeRuntime(): Unsubscribe {
    return useAgentRuntimeStore.subscribe(() => {
      this.options.syncRuntimeBadge();
    });
  }
}
