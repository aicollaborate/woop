import { useEffect } from 'react';

import { acquireAgentChunkBridge } from '@features/agent/store/chat-store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { isProjectionRunActive } from '@features/agent/store/session-reducer';

export async function reconcileAgentRunsAndRefreshEndedHistory(): Promise<void> {
  // Phase 4 (2026-08-02): 真源切到 useAgentSessionStore, chat-store 保留
  // 作为 facade 镜像, 这里直接读 projection 避免 mirror round-trip.
  const before = useAgentSessionStore.getState();
  const locallyRunning = Object.entries(before.threadProjections)
    .filter(([, projection]) => isProjectionRunActive(projection))
    .map(([threadId]) => ({
      threadId,
      agentType:
        before.sessionMeta.threadTypes[threadId] ??
        before.sessionMeta.activeAgentTypeKey,
    }));

  await useAgentSessionStore.getState().reconcileRunningRuns();
  if (locallyRunning.length === 0) return;

  const after = useAgentSessionStore.getState();
  const endedWhileDisconnected = locallyRunning.filter(({ threadId }) => {
    const projection = after.threadProjections[threadId];
    return !projection || !isProjectionRunActive(projection);
  });
  await Promise.allSettled(
    endedWhileDisconnected.map(({ threadId, agentType }) => (
      useAgentSessionStore.getState().loadMessages(agentType, threadId)
    )),
  );
}

/**
 * Installs the agent stream bridge for windows that need live chat updates.
 *
 * This is mounted by AgentWindowEffects in main and tab-host windows, but not
 * preferences. The bridge itself is idempotent within each Webview realm.
 */
export function useAgentEvents(): void {
  useEffect(() => {
    let disposed = false;
    let lastReconcileAt = 0;

    const reconcileRunningRuns = async (force = false) => {
      if (disposed) return;
      const now = Date.now();
      if (!force && now - lastReconcileAt < 1000) return;
      lastReconcileAt = now;
      await reconcileAgentRunsAndRefreshEndedHistory();
    };

    const releaseAgentChunkBridge = acquireAgentChunkBridge(() => {
      // Listener readiness is a recovery boundary. Force a snapshot even if
      // the normal focus/visibility throttle ran recently, because stream_end
      // may have been missed while Tauri registration was unavailable.
      void reconcileRunningRuns(true).catch((err) => {
        console.warn('[useAgentEvents] post-listen reconciliation failed:', err);
      });
    });

    (async () => {
      try {
        await reconcileRunningRuns();
      } catch (err) {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      }
    })();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    const handleFocus = () => {
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      releaseAgentChunkBridge();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
