import type { AgentChunk } from '@/types/agent';
import { listenToAgentChunks } from '@features/agent/store/agent-client';

type ChunkDispatcher = (chunk: AgentChunk) => void;

/**
 * Creates a reference-counted projection bridge for one webview.
 *
 * The bridge owns the native listener lifecycle. Consumers may mount and
 * unmount independently; the listener is released only after the last
 * consumer leaves.
 */
export function createAgentChunkBridge(dispatch: ChunkDispatcher) {
  let references = 0;
  let unlisten: (() => void) | null = null;
  let ready = false;
  const readyHandlers = new Set<() => void>();

  const notifyReady = () => {
    ready = true;
    for (const handler of [...readyHandlers]) handler();
  };

  return function acquire(onReady?: () => void): () => void {
    references += 1;
    if (onReady) readyHandlers.add(onReady);

    if (!unlisten) {
      unlisten = listenToAgentChunks(dispatch, {
        onListenerReady: notifyReady,
      });
    } else if (ready && onReady) {
      queueMicrotask(() => {
        if (readyHandlers.has(onReady)) onReady();
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (onReady) readyHandlers.delete(onReady);
      references = Math.max(0, references - 1);
      if (references > 0) return;

      unlisten?.();
      unlisten = null;
      ready = false;
      readyHandlers.clear();
    };
  };
}
