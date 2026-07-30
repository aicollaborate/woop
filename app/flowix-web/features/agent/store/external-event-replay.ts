import type { AgentChunk, AgentTypeKey } from "@/types/agent";
import type { AgentExternalEvent } from "@platform/tauri/client";
import { agentClient } from "@features/agent/store/agent-client";
import type { ChatStore } from "@features/agent/store/chat-store";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import { useAgentConversationStore } from "@features/agent/store/agent-conversation-store";

const REPLAY_PAGE_SIZE = 1000;
const MAX_COMPLETE_EXTERNAL_EVENTS = 10_000;
const AGENT_CHUNK_KINDS = new Set<AgentChunk["kind"]>([
  "user_message",
  "stream_start",
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "error",
  "usage",
  "stream_end",
  "session_resolved",
]);
function resetReplayState(state: ThreadState | undefined): ThreadState {
  return {
    messages: [],
    isLoading: false,
    activeRunId: null,
    runs: {},
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingMore: state?.loadingMore ?? false,
  };
}

function parseReplayChunk(normalizedJson: string): AgentChunk | null {
  try {
    const value = JSON.parse(normalizedJson) as AgentChunk;
    if (!value || typeof value !== "object") return null;
    if (!AGENT_CHUNK_KINDS.has(value.kind)) return null;
    return value;
  } catch (err) {
    console.warn("[AgentExternalReplay] skipped malformed event payload:", err);
    return null;
  }
}

function isTruncatedHistoryEvent(event: AgentExternalEvent): boolean {
  try {
    const value = JSON.parse(event.normalizedJson) as { kind?: string };
    return value.kind === "history_truncated";
  } catch {
    return false;
  }
}

function replayEventKind(event: AgentExternalEvent): string | null {
  try {
    const value = JSON.parse(event.normalizedJson) as { kind?: unknown };
    return typeof value.kind === "string" ? value.kind : null;
  } catch {
    return null;
  }
}

function resetThreadsForReplay(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  threadIds: Iterable<string>,
  typeKey: AgentTypeKey,
): void {
  const ids = Array.from(new Set(Array.from(threadIds).filter(Boolean)));
  if (ids.length === 0) return;
  useAgentConversationStore.getState().resetMessageStates(ids);
  set((state) => {
    const threadStates = { ...state.threadStates };
    const threadTypes = { ...state.threadTypes };
    for (const id of ids) {
      threadStates[id] = resetReplayState(threadStates[id]);
      threadTypes[id] = threadTypes[id] ?? typeKey;
    }
    return { threadStates, threadTypes };
  });
}

export async function replayExternalEventsForThread(
  set: (updater: (state: ChatStore) => Partial<ChatStore>) => void,
  get: () => ChatStore,
  typeKey: AgentTypeKey,
  threadId: string,
): Promise<boolean> {
  let afterId: number | null = null;
  const persistedEvents: AgentExternalEvent[] = [];
  const resetThreadIds = new Set<string>();
  resetThreadsForReplay(set, [threadId], typeKey);
  resetThreadIds.add(threadId);

  for (;;) {
    let events: AgentExternalEvent[];
    try {
      events = await agentClient.externalEvents(
        threadId,
        afterId,
        REPLAY_PAGE_SIZE,
      );
    } catch (err) {
      console.warn(
        "[AgentExternalReplay] database replay failed; using external history:",
        err,
      );
      return false;
    }
    if (events.length === 0) break;
    persistedEvents.push(...events);

    afterId = events[events.length - 1]?.id ?? afterId;
    if (events.length < REPLAY_PAGE_SIZE) break;
  }

  if (persistedEvents.length === 0) return false;
  if (
    persistedEvents.length >= MAX_COMPLETE_EXTERNAL_EVENTS ||
    persistedEvents.some(isTruncatedHistoryEvent) ||
    // user_message became the first normalized event in the complete-history
    // protocol. Older databases started at stream_start and therefore lack
    // user turns; treat those as incomplete and use transcript/main history.
    replayEventKind(persistedEvents[0]) !== "user_message"
  ) {
    return false;
  }

  const newThreadIds = persistedEvents
    .map((event) => event.threadId)
    .filter((id) => !resetThreadIds.has(id));
  if (newThreadIds.length > 0) {
    resetThreadsForReplay(set, newThreadIds, typeKey);
    for (const id of newThreadIds) resetThreadIds.add(id);
  }

  for (const event of persistedEvents) {
    const chunk = parseReplayChunk(event.normalizedJson);
    if (!chunk) continue;
    get().dispatchAgentChunk(chunk);
  }
  get().flushAgentEventBuffer();
  return true;
}
