export {
  useChatStore,
  acquireAgentChunkBridge,
  type ThreadState,
} from '@features/agent/store/chat-store';
export { useAgentAccessStore } from '@features/agent/store/agent-access-store';
export { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
export {
  useAgentConversationStore,
  selectAgentConversationRunStatus,
  selectIsAgentConversationRunning,
  selectRunningAgentConversationInstances,
  selectRunningAgentConversationThreadIds,
  type AgentConversationInstance,
  type AgentConversationSource,
} from '@features/agent/store/agent-conversation-store';
// Phase 4 (2026-08-02): 新真源 store. 组件应优先 import useAgentSessionStore,
// 旧 useChatStore / useAgentConversationStore 保留作为兼容 shim (Phase 5 删除).
export {
  useAgentSessionStore,
  selectThreadProjection,
  selectSessionMeta,
  selectConversationRegistry,
  type AgentSessionStore,
  type AgentSessionMeta,
  type AgentConversationRegistry,
} from '@features/agent/store/agent-session-store';
export {
  reduceProjection,
  emptyProjection,
  type ThreadProjection,
} from '@features/agent/store/session-reducer';
