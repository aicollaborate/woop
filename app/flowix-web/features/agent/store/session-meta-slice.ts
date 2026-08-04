import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import type { ThreadListItem } from "@/types";
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";

type SessionMetaContext = SessionMetaSlice & {
  activateThread(threadId: string): void;
};

type SessionSet = (
  updater: (state: SessionMetaContext) => Partial<SessionMetaContext>,
) => void;
type SessionGet = () => SessionMetaContext;

export interface SessionMetaSlice {
  sessionMeta: AgentSessionMeta;
  setSessionMeta(updater: (meta: AgentSessionMeta) => AgentSessionMeta): void;
  setThreadList(list: ThreadListItem[]): void;
  setActiveThreadId(threadId: string | undefined): void;
  setActiveCodexThreadId(threadId: string | undefined): void;
  setActiveClaudeThreadId(threadId: string | undefined): void;
  setActiveAgentTypeKey(typeKey: AgentTypeKey): void;
  setActiveAgentThread(
    typeKey: AgentTypeKey,
    threadId: string | undefined,
  ): void;
  bindThreadType(threadId: string, typeKey: AgentTypeKey): void;
  setAgentPermissionMode(mode: AgentPermissionMode): void;
  setAgentCodexModel(model: AgentCodexModel): void;
  setAgentCodexReasoningEffort(effort: AgentCodexReasoningEffort): void;
}

export function createSessionMetaSlice(
  set: SessionSet,
  get: SessionGet,
): SessionMetaSlice {
  const setActiveThread = (
    typeKey: AgentTypeKey,
    threadId: string | undefined,
    activateAgent: boolean,
  ) => {
    set((state) => ({
      sessionMeta: {
        ...state.sessionMeta,
        ...(activateAgent ? { activeAgentTypeKey: typeKey } : {}),
        activeThreadIds: {
          ...state.sessionMeta.activeThreadIds,
          [typeKey]: threadId,
        },
        ...(threadId
          ? {
              threadTypes: {
                ...state.sessionMeta.threadTypes,
                [threadId]: typeKey,
              },
            }
          : {}),
      },
    }));
  };

  return {
    sessionMeta: DEFAULT_AGENT_SESSION_META,
    setSessionMeta: (updater) =>
      set((state) => ({ sessionMeta: updater(state.sessionMeta) })),
    setThreadList: (list) =>
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          threadLists: { ...state.sessionMeta.threadLists, flowix: list },
        },
      })),
    setActiveThreadId: (threadId) => setActiveThread("flowix", threadId, false),
    setActiveCodexThreadId: (threadId) =>
      setActiveThread("codex", threadId, false),
    setActiveClaudeThreadId: (threadId) =>
      setActiveThread("claude", threadId, false),
    setActiveAgentTypeKey: (typeKey) =>
      set((state) => ({
        sessionMeta: { ...state.sessionMeta, activeAgentTypeKey: typeKey },
      })),
    setActiveAgentThread: (typeKey, threadId) =>
      setActiveThread(typeKey, threadId, true),
    bindThreadType: (threadId, typeKey) => {
      get().activateThread(threadId);
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          threadTypes: {
            ...state.sessionMeta.threadTypes,
            [threadId]: typeKey,
          },
        },
      }));
    },
    setAgentPermissionMode: (mode) =>
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          settings: {
            ...state.sessionMeta.settings,
            agentPermissionMode: mode,
          },
        },
      })),
    setAgentCodexModel: (model) =>
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          settings: { ...state.sessionMeta.settings, agentCodexModel: model },
        },
      })),
    setAgentCodexReasoningEffort: (effort) =>
      set((state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          settings: {
            ...state.sessionMeta.settings,
            agentCodexReasoningEffort: effort,
          },
        },
      })),
  };
}
