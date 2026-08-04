export type StreamingBufferSnapshot = Map<string, string>;

export interface StreamingBuffer {
  appendText(threadId: string, text: string): void;
  appendReasoning(threadId: string, text: string): void;
  flushSync(): void;
}

export interface StreamingScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

function defaultStreamingScheduler(): StreamingScheduler {
  return {
    request: (callback) => {
      if (typeof requestAnimationFrame === "function") {
        return requestAnimationFrame(callback);
      }
      return setTimeout(
        () => callback(performance.now()),
        16,
      ) as unknown as number;
    },
    cancel: (id) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
      else clearTimeout(id);
    },
  };
}

export function createStreamingBuffer(
  onFlush: (
    textSnapshot: StreamingBufferSnapshot,
    reasoningSnapshot: StreamingBufferSnapshot,
  ) => void,
  scheduler: StreamingScheduler = defaultStreamingScheduler(),
): StreamingBuffer {
  const textBuffer = new Map<string, string>();
  const reasoningBuffer = new Map<string, string>();
  let pendingRafId: number | null = null;

  function appendBuffer(
    buf: Map<string, string>,
    threadId: string,
    text: string,
  ): void {
    buf.set(threadId, (buf.get(threadId) ?? "") + text);
  }

  function flushSync(): void {
    if (textBuffer.size === 0 && reasoningBuffer.size === 0) {
      if (pendingRafId != null) {
        scheduler.cancel(pendingRafId);
        pendingRafId = null;
      }
      return;
    }

    const textSnapshot = new Map(textBuffer);
    const reasoningSnapshot = new Map(reasoningBuffer);
    textBuffer.clear();
    reasoningBuffer.clear();
    if (pendingRafId != null) {
      scheduler.cancel(pendingRafId);
      pendingRafId = null;
    }
    onFlush(textSnapshot, reasoningSnapshot);
  }

  function scheduleFlush(): void {
    if (pendingRafId != null) return;
    pendingRafId = scheduler.request(() => {
      pendingRafId = null;
      flushSync();
    });
  }

  return {
    appendText(threadId, text) {
      appendBuffer(textBuffer, threadId, text);
      scheduleFlush();
    },
    appendReasoning(threadId, text) {
      appendBuffer(reasoningBuffer, threadId, text);
      scheduleFlush();
    },
    flushSync,
  };
}
