/**
 * `session-mirror` ── 把 `useAgentSessionStore` 的 threadProjections 镜像到
 * 旧 store (`useChatStore.threadStates` / `useAgentConversationStore.messageStates`).
 *
 * **这是 Phase 3 的过渡层**, 让 6 个月内 468 个 import 点 (chat-store /
 * agent-conversation-store 消费者 + 测试) 零修改继续工作. Phase 5 删除旧
 * store 时, 本文件一并删除.
 *
 * 镜像语义:
 * - 旧 `chat-store.threadStates[tid]` 的 `messages` / `pendingAssistantId` /
 *   `pendingReasoningId` / `isLoading` / `activeRunId` / `runs` / `lastRun` /
 *   `oldestSequence` / `hasMoreHistory` / `loadingMore` 都从 session store
 *   `threadProjections[tid]` 派生.
 * - 旧 `agent-conversation-store.messageStates[tid]` 的 messages /
 *   pendingAssistantId / pendingReasoningId / oldestSequence /
 *   hasMoreHistory / loadingInitial / loadingMore 也从 session store 派生.
 *
 * 参考等值 ── 组件订阅 `useChatStore(s => s.threadStates[tid].isLoading)` 在
 * session store 的对应字段变化时, 通过 zustand shallow equality 触发 re-render.
 */

import { shallow } from "zustand/shallow";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { useChatStore } from "@features/agent/store/chat-store";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";
import type { ThreadState } from "@features/agent/store/chat-store";
import type { AgentConversationMessageState } from "@features/agent/store/agent-conversation-store";
import type { ThreadProjection } from "@features/agent/store/session-reducer";

/**
 * 把 ThreadProjection 转换为旧 `ThreadState` 形态 ── 包含 messages (现
 * 在 session store 真源) 与所有 metadata. 这让 `useChatStore.threadStates[tid]`
 * 在流式期间也保持完整 shape, 不破坏依赖 `state.threadStates[tid].isLoading`
 * 等字段的组件.
 */
/**
 * 公开版 ── 让组件层 (subscriptions-controller 等) 也可以把 ThreadProjection
 * 还原为旧 ThreadState shape, 维持 select 闭包返回类型稳定. 后续 Phase 5
 * 删除 chat-store 时, 调用方应改成 projection-native 类型 (不必经此函数).
 */
export function projectionToLegacyThreadState(
  p: ThreadProjection,
): ThreadState {
  return projectionToThreadState(p);
}

function projectionToThreadState(p: ThreadProjection): ThreadState {
  return {
    messages: p.messages,
    isLoading: p.runs.isLoading,
    activeRunId: p.runs.activeRunId,
    runs: p.runs.runs,
    pendingAssistantId: p.pending.assistantId,
    pendingReasoningId: p.pending.reasoningId,
    lastRun: p.runs.lastRun,
    oldestSequence: p.pagination.oldestSequence,
    hasMoreHistory: p.pagination.hasMoreHistory,
    loadingMore: p.pagination.loadingMore,
  };
}

function projectionToMessageState(
  p: ThreadProjection,
): AgentConversationMessageState {
  return {
    messages: p.messages,
    pendingAssistantId: p.pending.assistantId,
    pendingReasoningId: p.pending.reasoningId,
    oldestSequence: p.pagination.oldestSequence,
    hasMoreHistory: p.pagination.hasMoreHistory,
    loadingInitial: p.pagination.loadingInitial,
    loadingMore: p.pagination.loadingMore,
  };
}

let mirrorStarted = false;

/**
 * 启动 session-store → 旧 store 的镜像. 整个 webview 生命周期内只调一次.
 * 由 chat-store.ts 在 factory 阶段触发 (与 dispatcher 同时).
 */
export function startSessionMirror(): () => void {
  if (mirrorStarted) return () => undefined;
  mirrorStarted = true;

  // 镜像 threadProjections 变化 → chat-store.threadStates[tid]
  const unsubChat = useAgentSessionStore.subscribe(
    (s) => s.threadProjections,
    (projections) => {
      useChatStore.setState((state) => {
        const next: typeof state.threadStates = { ...state.threadStates };
        let changed = false;
        // 同步存在的 tid.
        for (const [tid, projection] of Object.entries(projections)) {
          const existing = next[tid];
          const mirror = projectionToThreadState(projection);
          if (
            !existing ||
            existing.messages !== mirror.messages ||
            existing.isLoading !== mirror.isLoading ||
            existing.activeRunId !== mirror.activeRunId ||
            existing.pendingAssistantId !== mirror.pendingAssistantId ||
            existing.pendingReasoningId !== mirror.pendingReasoningId ||
            existing.runs !== mirror.runs ||
            existing.lastRun !== mirror.lastRun ||
            existing.oldestSequence !== mirror.oldestSequence ||
            existing.hasMoreHistory !== mirror.hasMoreHistory ||
            existing.loadingMore !== mirror.loadingMore
          ) {
            next[tid] = mirror;
            changed = true;
          }
        }
        // 清理已不存在的 tid (session-resolved 已迁走 / 显式 removeThreadProjection).
        for (const tid of Object.keys(next)) {
          if (!(tid in projections)) {
            delete next[tid];
            changed = true;
          }
        }
        return changed ? { threadStates: next } : state;
      });
    },
    { equalityFn: shallow },
  );

  // 镜像 threadProjections 变化 → conv-store.messageStates[tid]
  const unsubConv = useAgentSessionStore.subscribe(
    (s) => s.threadProjections,
    (projections) => {
      useAgentConversationStore.setState((state) => {
        const next: typeof state.messageStates = { ...state.messageStates };
        let changed = false;
        for (const [tid, projection] of Object.entries(projections)) {
          const existing = next[tid];
          const mirror = projectionToMessageState(projection);
          if (
            !existing ||
            existing.messages !== mirror.messages ||
            existing.pendingAssistantId !== mirror.pendingAssistantId ||
            existing.pendingReasoningId !== mirror.pendingReasoningId ||
            existing.oldestSequence !== mirror.oldestSequence ||
            existing.hasMoreHistory !== mirror.hasMoreHistory ||
            existing.loadingInitial !== mirror.loadingInitial ||
            existing.loadingMore !== mirror.loadingMore
          ) {
            next[tid] = mirror;
            changed = true;
          }
        }
        for (const tid of Object.keys(next)) {
          if (!(tid in projections)) {
            delete next[tid];
            changed = true;
          }
        }
        return changed ? { messageStates: next } : state;
      });
    },
    { equalityFn: shallow },
  );

  // 镜像 sessionMeta → chat-store 的 metadata 字段 (activeThreadIds /
  // activeAgentTypeKey / threadTypes / threadLists / currentThreadTitles /
  // externalSessionResolutions / lastRunningRunsReconciledAt). 让旧组件
  // 读 useChatStore 这七个字段也能跟随 session store 同步.
  const unsubMeta = useAgentSessionStore.subscribe(
    (s) => s.sessionMeta,
    (meta) => {
      useChatStore.setState((state) => {
        if (
          state.activeThreadIds === meta.activeThreadIds &&
          state.activeAgentTypeKey === meta.activeAgentTypeKey &&
          state.threadTypes === meta.threadTypes &&
          state.threadLists === meta.threadLists &&
          state.currentThreadTitles === meta.currentThreadTitles &&
          state.externalSessionResolutions === meta.externalSessionResolutions &&
          state.lastRunningRunsReconciledAt === meta.lastRunningRunsReconciledAt
        ) {
          return state;
        }
        return {
          activeThreadIds: meta.activeThreadIds,
          activeAgentTypeKey: meta.activeAgentTypeKey,
          threadTypes: meta.threadTypes,
          threadLists: meta.threadLists,
          currentThreadTitles: meta.currentThreadTitles,
          externalSessionResolutions: meta.externalSessionResolutions,
          lastRunningRunsReconciledAt: meta.lastRunningRunsReconciledAt,
        };
      });
    },
    { equalityFn: shallow },
  );

  // 镜像 conversationRegistry.instances 变化 → conv-store.instances. 让
  // memo-list / document-titlebar-shared / agent-conversation-overlay 等
  // 组件读 useAgentConversationStore.instances 仍跟随 session-store 真源.
  const unsubInstances = useAgentSessionStore.subscribe(
    (s) => s.conversationRegistry.instances,
    (instances) => {
      useAgentConversationStore.setState((state) => {
        if (state.instances === instances) return state;
        return { instances };
      });
    },
  );

  // 镜像 conv-store.instances 变化 → session-store.conversationRegistry
  // .instances (反向同步). 让 conv-store.createInstance / upsertInstance /
  // setRuntimeConfig 等仍能写真源 session-store ── Phase 5 删 conv-store
  // 时整个 unsubscribe 一起删.
  const unsubInstancesReverse = useAgentConversationStore.subscribe(
    (s) => s.instances,
    (instances) => {
      useAgentSessionStore.setState((state) => {
        const reg = state.conversationRegistry;
        if (reg.instances === instances) return state;
        return {
          conversationRegistry: { ...reg, instances },
        };
      });
    },
  );

  return () => {
    unsubChat();
    unsubConv();
    unsubMeta();
    unsubInstances();
    unsubInstancesReverse();
    mirrorStarted = false;
  };
}