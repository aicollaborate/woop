import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import type { AppLanguage, I18nKey } from "@/lib/i18n";
import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { supportsAgentEmptySettings } from "@features/agent/runtime/agent-runtime-spec";
import {
  appendRenderedAgentMessagesToTail,
  createRenderedAgentMessageList,
  getRenderedAgentMessages,
  patchLastRenderedAgentMessage,
  type AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-list-renderer";
import { recordMessageRenderPlan } from "@features/agent/thread-card/messages/message-render-plan";
import {
  MessageViewportController,
  type MessageRenderScrollOptions,
} from "@features/agent/thread-card/messages/message-viewport-controller";

type AgentMessage = ThreadState["messages"][number];

export interface ThreadMessageRenderControllerOptions {
  body: HTMLElement;
  loadingIndicator: HTMLDivElement;
  messageViewport: MessageViewportController;
  getLanguage: () => AppLanguage;
  getTypeKey: () => AgentTypeKey;
  t: (key: I18nKey) => string;
  createThreadCacheSkeleton: () => HTMLDivElement;
  createExternalAgentEmptySettings: () => HTMLElement;
}

export interface ThreadMessageRenderInput {
  messages: ThreadState["messages"];
  isLoading: boolean;
  shouldRenderMessages: boolean;
  isThreadCachePresentationHidden: boolean;
  isThreadCacheLoading: boolean;
}

export class ThreadMessageRenderController {
  private readonly body: HTMLElement;
  private readonly loadingIndicator: HTMLDivElement;
  private readonly messageViewport: MessageViewportController;
  private readonly getLanguage: () => AppLanguage;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly t: (key: I18nKey) => string;
  private readonly createThreadCacheSkeleton: () => HTMLDivElement;
  private readonly createExternalAgentEmptySettings: () => HTMLElement;
  private renderedMessagesList: HTMLDivElement | null = null;
  private renderedEmptyState: HTMLElement | null = null;
  private renderedMessageRefs: ThreadState["messages"] = [];
  private reasoningCollapsedOverrides = new Map<string, boolean>();
  private displayExpandedOverrides = new Map<string, boolean>();
  private renderRafId: number | null = null;
  private pendingRenderInput: ThreadMessageRenderInput | null = null;
  private wasLoading = false;

  constructor(options: ThreadMessageRenderControllerOptions) {
    this.body = options.body;
    this.loadingIndicator = options.loadingIndicator;
    this.messageViewport = options.messageViewport;
    this.getLanguage = options.getLanguage;
    this.getTypeKey = options.getTypeKey;
    this.t = options.t;
    this.createThreadCacheSkeleton = options.createThreadCacheSkeleton;
    this.createExternalAgentEmptySettings =
      options.createExternalAgentEmptySettings;
  }

  render(input: ThreadMessageRenderInput): void {
    // 非流式态(空态/隐藏/完成)立即渲染, 不节流 ── 保证最终状态及时生效
    if (!input.isLoading || !input.shouldRenderMessages) {
      this.cancelPendingRender();
      this.renderNow(input);
      return;
    }
    // 流式中: rAF 合并(trailing edge)。claude text_delta 带 messageId 走
    // flushSync 绕过 streaming-buffer, 每个 Tauri 事件(已按字节 batch 的
    // token 组)都更新 canonical projection; 高 token 率下一帧多事件 -> 多次 patch-last DOM
    // 重建。rAF 合并把同帧内所有 render 调用收拢为帧末一次(渲染最新 input),
    // 降到每帧最多 1 次。
    // 延迟代价: 内容渲染推迟到下一帧(~16ms, 流式下不可察)。非流式态已走上面
    // 立即路径, 不受影响。不用时间阈值 ── jsdom 的 performance.now 不随 rAF
    // 前进, 时间阈值会让测试永远等不到渲染。
    this.pendingRenderInput = input;
    if (this.renderRafId != null) return;
    this.renderRafId = requestAnimationFrame(this.flushPendingRender);
  }

  private readonly flushPendingRender = (): void => {
    this.renderRafId = null;
    const next = this.pendingRenderInput;
    this.pendingRenderInput = null;
    if (next) this.renderNow(next);
  };

  private cancelPendingRender(): void {
    if (this.renderRafId != null) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }
    this.pendingRenderInput = null;
  }

  dispose(): void {
    this.cancelPendingRender();
  }

  private renderNow(input: ThreadMessageRenderInput): void {
    const scrollState = this.messageViewport.captureRenderScrollState();
    // run 结束下降沿: 流式末条仍是增量缓存的块切分态, 需在引用稳定(canReuse)
    // 时强制 patch-last 走 forceFinalize 全量 re-parse, 修正 loose list / 多段
    // blockquote。assistant 无 isCompleted, 这是它唯一的终态修正入口。
    const loadingJustEnded = this.wasLoading && !input.isLoading;
    this.wasLoading = input.isLoading;
    this.renderLoadingIndicator(input.isLoading);

    if (!input.shouldRenderMessages) {
      recordMessageRenderPlan("hidden", input.messages.length);
      this.body.replaceChildren();
      /*
       * body.replaceChildren() 会把 loadingIndicator 一起擦掉。下次切回可见
       * (shouldRenderMessages=true) 时, 第一次 render 走 insertBefore(list,
       * loadingIndicator) 要求 indicator 仍挂在 body 末尾, 否则 insertBefore
       * 会抛 NotFoundError。 在 hidden 期间把 indicator 重新挂回 (断开重连
       * 不可避免 — 这是一次状态切换, 视觉上用户刚展开卡片, 动画重新计时也合理)。
       */
      if (this.loadingIndicator.parentNode !== this.body) {
        this.body.appendChild(this.loadingIndicator);
      }
      this.renderedEmptyState = null;
      this.resetRenderedMessageCache();
      this.messageViewport.resetForHiddenMessages();
      return;
    }

    if (input.messages.length > 0) {
      this.removeRenderedEmptyState();
    }

    this.pruneReasoningCollapsedOverrides(input.messages);
    this.pruneDisplayExpandedOverrides(input.messages);

    if (this.canReuseRenderedMessages(input.messages)) {
      if (
        loadingJustEnded &&
        this.tryPatchLastRenderedMessage(
          input.messages,
          { isLoading: input.isLoading, ...scrollState },
          true,
        )
      ) {
        recordMessageRenderPlan("patch-last", input.messages.length);
        return;
      }
      recordMessageRenderPlan("noop", input.messages.length);
      return;
    }

    if (
      this.tryPatchLastRenderedMessage(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("patch-last", input.messages.length);
      return;
    }

    if (
      this.tryAppendMessagesToTail(input.messages, {
        isLoading: input.isLoading,
        ...scrollState,
      })
    ) {
      recordMessageRenderPlan("append-tail", input.messages.length);
      return;
    }

    if (input.messages.length === 0) {
      /*
       * 不调用 body.replaceChildren() — loadingIndicator 由 factory 持久挂
       * 在 body 末尾, replaceChildren 会把它也擦掉, 下次 render 还要重新挂,
       * WebKit 重连节点会重启 @keyframes 计时。 这里只移除旧 list (若有),
       * 走 renderEmptyState 用 insertBefore 放 empty 元素到 indicator 之前。
       */
      const prevList = this.renderedMessagesList;
      if (prevList && prevList.parentNode === this.body) {
        this.body.removeChild(prevList);
      }
      this.renderEmptyState(input);
      return;
    }

    recordMessageRenderPlan("replace-all", input.messages.length);
    const { list, rememberedMessages } = createRenderedAgentMessageList(
      input.messages,
      this.createMessageRenderContext(input.messages, input.isLoading),
    );

    /*
     * loadingIndicator 由 factory 一次性 append 到 body 末尾, 此后保持连接。
     * 这里仅 removeChild 旧 list 并 insertBefore 新 list —— 不把 indicator
     * 作为 replaceChildren / append 的参数, 避免 WebKit 重连节点导致
     * @keyframes 计时回到 t=0 (关键帧 0%/100% 是底色, 高频 streaming 下亮峰
     * 永远到不了)。
     */
    const prevList = this.renderedMessagesList;
    if (prevList && prevList.parentNode === this.body) {
      this.body.removeChild(prevList);
    }
    this.body.insertBefore(list, this.loadingIndicator);
    this.rememberRenderedMessages(list, rememberedMessages);
    this.applyBodyScrollAfterRender({
      isLoading: input.isLoading,
      ...scrollState,
    });
  }

  private renderEmptyState(input: ThreadMessageRenderInput): void {
    recordMessageRenderPlan("replace-empty", input.messages.length);
    this.removeRenderedEmptyState();
    this.resetRenderedMessageCache();

    if (input.isThreadCachePresentationHidden) {
      const skeleton = this.createThreadCacheSkeleton();
      this.renderedEmptyState = skeleton;
      this.body.insertBefore(skeleton, this.loadingIndicator);
      this.messageViewport.resetForEmptyMessages();
      return;
    }

    const typeKey = this.getTypeKey();
    const empty =
      supportsAgentEmptySettings(typeKey) && !input.isThreadCacheLoading
        ? this.createExternalAgentEmptySettings()
        : document.createElement("div");
    if (!empty.classList.contains("agent-thread-card__empty")) {
      empty.className = "agent-thread-card__empty";
      empty.textContent = input.isThreadCacheLoading
        ? this.t("editor.threadCard.loadingThreadCache")
        : this.t("editor.threadCard.empty");
    }
    this.renderedEmptyState = empty;
    this.body.insertBefore(empty, this.loadingIndicator);
    this.messageViewport.resetForEmptyMessages();
  }

  private renderLoadingIndicator(isLoading: boolean): void {
    const loadingText = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-text",
    );
    const loadingCells = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-cells",
    );
    if (loadingText) {
      loadingText.textContent = getAgentType(this.getTypeKey()).capabilities
        .supportsTextStreaming
        ? this.t("editor.threadCard.thinking")
        : this.t("editor.threadCard.running");
      loadingText.hidden = !isLoading;
    }
    if (loadingCells) loadingCells.hidden = !isLoading;
  }

  private removeRenderedEmptyState(): void {
    const emptyState = this.renderedEmptyState;
    this.renderedEmptyState = null;
    if (emptyState?.parentNode === this.body) {
      this.body.removeChild(emptyState);
    }
  }

  private resetRenderedMessageCache(): void {
    this.renderedMessagesList = null;
    this.renderedMessageRefs = [];
  }

  private rememberRenderedMessages(
    list: HTMLDivElement,
    messages: ThreadState["messages"],
  ): void {
    this.renderedMessagesList = list;
    this.renderedMessageRefs = messages;
  }

  private pruneReasoningCollapsedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.reasoningCollapsedOverrides.size === 0) return;

    const visibleReasoningIds = new Set(
      messages
        .filter((message) => message.role === "reasoning")
        .map((message) => message.id),
    );

    for (const id of this.reasoningCollapsedOverrides.keys()) {
      if (!visibleReasoningIds.has(id)) {
        this.reasoningCollapsedOverrides.delete(id);
      }
    }
  }

  private pruneDisplayExpandedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.displayExpandedOverrides.size === 0) return;

    const visibleIds = new Set(messages.map((message) => message.id));

    for (const id of this.displayExpandedOverrides.keys()) {
      if (!visibleIds.has(id)) {
        this.displayExpandedOverrides.delete(id);
      }
    }
  }

  private getReasoningCollapsed(message: AgentMessage): boolean {
    return (
      this.reasoningCollapsedOverrides.get(message.id) ?? !!message.isCompleted
    );
  }

  private getDisplayExpanded(message: AgentMessage): boolean {
    return this.displayExpandedOverrides.get(message.id) ?? false;
  }

  private createMessageRenderContext(
    messages: ThreadState["messages"],
    isLoading: boolean,
  ): AgentThreadCardMessageRenderContext {
    // 流式态下只有末条消息在增长; 末条且未完成(isCompleted)的才走块级增量,
    // 其余(历史 / 已完成 / run 结束)走全量 re-parse 修正块切分。引用比较
    // message === lastMessage 依赖 store 侧保持非末条消息引用稳定。
    const lastMessage = messages[messages.length - 1];
    return {
      language: this.getLanguage(),
      getReasoningCollapsed: (message) => this.getReasoningCollapsed(message),
      setReasoningCollapsed: (messageId, collapsed) => {
        this.reasoningCollapsedOverrides.set(messageId, collapsed);
      },
      getDisplayExpanded: (message) => this.getDisplayExpanded(message),
      setDisplayExpanded: (messageId, expanded) => {
        if (expanded) this.displayExpandedOverrides.set(messageId, true);
        else this.displayExpandedOverrides.delete(messageId);
      },
      isStreaming: (message) =>
        isLoading && message === lastMessage && !message.isCompleted,
    };
  }

  private canReuseRenderedMessages(messages: ThreadState["messages"]): boolean {
    const list = this.renderedMessagesList;
    if (!list || !this.body.contains(list)) return false;
    const renderedMessages = getRenderedAgentMessages(messages);
    if (
      renderedMessages.length !== this.renderedMessageRefs.length ||
      list.children.length !== renderedMessages.length
    ) {
      return false;
    }
    for (let i = 0; i < renderedMessages.length; i += 1) {
      if (renderedMessages[i] !== this.renderedMessageRefs[i]) return false;
    }
    return true;
  }

  private tryPatchLastRenderedMessage(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
    force = false,
  ): boolean {
    const nextRefs = patchLastRenderedAgentMessage(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(messages, options.isLoading),
      afterRender: () => this.applyBodyScrollAfterRender(options),
      force,
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private tryAppendMessagesToTail(
    messages: ThreadState["messages"],
    options: MessageRenderScrollOptions,
  ): boolean {
    const nextRefs = appendRenderedAgentMessagesToTail(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(messages, options.isLoading),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  private applyBodyScrollAfterRender(options: MessageRenderScrollOptions): void {
    this.messageViewport.applyAfterRender(options);
  }
}
