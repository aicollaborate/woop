import { useDocumentStore } from "@features/document";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-types";

export function getCurrentThreadCardSource(): AgentConversationSource {
  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === "memo") {
    const session = documentState.activeMemoSession;
    return {
      kind: "thread-card",
      documentPath: session?.path ?? documentState.currentDocumentPath ?? null,
      memoId: session?.memoId ?? null,
      notebookId: session?.notebookId ?? null,
    };
  }
  if (documentState.currentDocumentSource === "external") {
    return {
      kind: "thread-card",
      documentPath: documentState.currentDocumentPath ?? null,
      memoId: null,
      notebookId: null,
    };
  }
  return { kind: "thread-card" };
}
