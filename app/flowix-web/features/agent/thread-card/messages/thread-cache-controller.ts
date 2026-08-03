import type { AgentTypeKey } from "@/types/agent";
import type { ChatMessage } from "@/types";
import { loadAgentThreadCardCache } from "@features/agent/thread-card/agent-thread-card-cache";

export interface ThreadCacheControllerOptions {
  element: HTMLElement;
  isDestroyed: () => boolean;
  getThreadId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getMessageCount: () => number;
  shouldLoad: () => boolean;
  render: () => void;
  renderResolvedSessionMessages: (messages: ChatMessage[]) => void;
  applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;
}

export class ThreadCacheController {
  // 30s 兜底: external session 路径 resolveExternalSessionId 失败 / applyResolvedSession
  // 早 return 时, skeleton 永远不会被清. 用一个绝对时间窗口强制退出 loading, 让
  // skeleton 至少在用户感知层面收敛 (用户能看到空状态, 而不是无尽 loading).
  private static readonly LOADING_TIMEOUT_MS = 30_000;

  private readonly element: HTMLElement;
  private readonly isDestroyed: () => boolean;
  private readonly getThreadId: () => string | null;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getMessageCount: () => number;
  private readonly shouldLoad: () => boolean;
  private readonly render: () => void;
  private readonly renderResolvedSessionMessages: (
    messages: ChatMessage[],
  ) => void;
  private readonly applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;

  private loading = false;
  private loadedFor: string | null = null;
  private loadingFor: string | null = null;
  private loadingStartedAt: number | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleId: number | null = null;
  private settling = false;
  private revealFrame: number | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private viewportReady =
    typeof window === "undefined" || !("IntersectionObserver" in window);

  constructor(options: ThreadCacheControllerOptions) {
    this.element = options.element;
    this.isDestroyed = options.isDestroyed;
    this.getThreadId = options.getThreadId;
    this.getTypeKey = options.getTypeKey;
    this.getMessageCount = options.getMessageCount;
    this.shouldLoad = options.shouldLoad;
    this.render = options.render;
    this.renderResolvedSessionMessages = options.renderResolvedSessionMessages;
    this.applyResolvedSession = options.applyResolvedSession;
  }

  get isLoading(): boolean {
    return this.loading;
  }

  isPresentationHidden(): boolean {
    // 30s 后强制退出 loading, 防止外部 session 路径卡死导致 skeleton 永远显示.
    // 此时投影可能仍空, 但 UI 至少能进入"空状态"分支, 用户可以操作重试 / 关闭.
    if (
      this.loading &&
      this.loadingStartedAt !== null &&
      Date.now() - this.loadingStartedAt > ThreadCacheController.LOADING_TIMEOUT_MS
    ) {
      this.loading = false;
      this.loadingStartedAt = null;
      this.loadingFor = null;
    }
    return (
      !!this.getThreadId() &&
      this.getMessageCount() === 0 &&
      (this.loading || this.settling)
    );
  }

  requestIfNeeded(): void {
    if (this.shouldLoad()) {
      this.scheduleLoad();
      return;
    }
    this.cancelScheduledLoad();
  }

  observeVisibility(): void {
    if (
      this.viewportReady ||
      this.visibilityObserver ||
      typeof window === "undefined" ||
      !("IntersectionObserver" in window)
    ) {
      return;
    }

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        if (this.isDestroyed() || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        this.viewportReady = true;
        this.visibilityObserver?.disconnect();
        this.visibilityObserver = null;
        this.requestIfNeeded();
      },
      { root: null, rootMargin: "600px 0px", threshold: 0 },
    );
    this.visibilityObserver.observe(this.element);
  }

  canLoadForViewport(isFullscreen: boolean): boolean {
    return this.viewportReady || isFullscreen;
  }

  dispose(): void {
    this.cancelScheduledLoad();
    this.cancelRevealFrame();
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
  }

  private scheduleLoad(): void {
    const threadId = this.getThreadId();
    if (!threadId || this.isDestroyed() || !this.shouldLoad()) return;
    if (this.loadedFor === threadId || this.loadingFor === threadId) return;

    this.loadingFor = threadId;
    this.loading = true;
    this.loadingStartedAt = Date.now();
    this.settling = false;
    this.cancelRevealFrame();
    this.render();

    const run = async (): Promise<void> => {
      try {
        if (!this.isDestroyed() && this.getThreadId() === threadId) {
          const typeKey = this.getTypeKey();
          const result = await loadAgentThreadCardCache({ threadId, typeKey });
          if (result.resolvedSessionId) {
            this.renderResolvedSessionMessages(result.messages);
            this.applyResolvedSession(threadId, result.resolvedSessionId, typeKey);
            return;
          }
          this.loadedFor = threadId;
        }
      } finally {
        if (this.loadingFor === threadId) {
          this.loadingFor = null;
          this.loading = false;
          this.loadingStartedAt = null;
        }
        if (!this.isDestroyed() && this.getThreadId() === threadId) {
          const hasLoadedMessages = this.getMessageCount() > 0;
          if (!hasLoadedMessages) {
            this.settling = false;
            this.render();
            return;
          }
          this.settling = true;
          this.render();
          this.cancelRevealFrame();
          this.revealFrame = window.requestAnimationFrame(() => {
            this.revealFrame = null;
            if (this.isDestroyed() || this.getThreadId() !== threadId) return;
            this.settling = false;
            this.render();
          });
        }
      }
    };

    if ("requestIdleCallback" in window) {
      this.idleId = window.requestIdleCallback(
        () => {
          this.idleId = null;
          void run();
        },
        { timeout: 1200 },
      );
    } else {
      this.timeoutId = globalThis.setTimeout(() => {
        this.timeoutId = null;
        void run();
      }, 300);
    }
  }

  private cancelScheduledLoad(): void {
    const hadScheduledLoad = this.timeoutId !== null || this.idleId !== null;
    if (this.timeoutId !== null) {
      globalThis.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.idleId !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(this.idleId);
      this.idleId = null;
    }
    if (hadScheduledLoad && this.loadingFor) {
      this.loadingFor = null;
      this.loading = false;
      this.loadingStartedAt = null;
      this.settling = false;
      this.render();
    }
  }

  private cancelRevealFrame(): void {
    if (this.revealFrame === null) return;
    window.cancelAnimationFrame(this.revealFrame);
    this.revealFrame = null;
  }
}
