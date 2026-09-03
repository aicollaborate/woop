'use client';

import { useEffect } from 'react';
import { useAgentEvents } from '@features/agent/hooks/use-agent-events';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { invalidateNotebookCache, prewarmNotebookCache } from '@features/editor/extensions/note-link';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention';
import { listenToAgentAccessChanges } from '@platform/tauri/client';
import { acquireMemoEventBridge } from '@/lib/memo-dispatcher';

/**
 * Agent infrastructure shared by every content-capable Webview.
 *
 * Tauri content Webviews own their live Agent projection and backend hydration.
 * The fourth column lives in the main Webview and therefore reuses this
 * infrastructure; preferences intentionally does not mount this component.
 */
export function AgentWindowEffects() {
  useAgentEvents();
  useEffect(() => acquireMemoEventBridge(), []);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  useEffect(() => {
    void refreshAgentRuntime({ force: true });
  }, [refreshAgentRuntime]);

  // hydrateFromBackend 经 session-store delegate 到 conv-store 实现 (写
  // conv-store.instances, 由 setWithInstanceMirror 反向同步到
  // session-store.conversationRegistry). 消费层只依赖 session-store.
  const hydrateAgentConversations = useAgentSessionStore(
    (state) => state.hydrateFromBackend,
  );
  useEffect(() => {
    void hydrateAgentConversations();
  }, [hydrateAgentConversations]);

  const loadAgentAccess = useAgentAccessStore((state) => state.loadInitial);
  useEffect(() => {
    void loadAgentAccess();
    return listenToAgentAccessChanges(() => {
      void loadAgentAccess();
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      void prewarmNotebookCache();
    });
  }, [loadAgentAccess]);

  useEffect(() => {
    void prewarmNotebookCache();
  }, []);

  return null;
}
