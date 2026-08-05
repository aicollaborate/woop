import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { deriveThreadTitleFromPrompt } from "@features/agent/store/thread-titles";
import type { AgentTypeKey } from "@/types/agent";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { focusWithoutScroll } from "@features/agent/thread-card/agent-thread-card-dom";

export interface AgentThreadCardTitleEditControllerOptions {
  titleEl: HTMLElement;
  getAttrTitle: () => string | null;
  getAttrTypeKey: () => string | null;
  getInstanceTitle: () => string | undefined;
  getThreadId: () => string | null;
  getInstanceId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  updateAttrs: (attrs: Record<string, unknown>) => void;
  /**
   * 首条 user 消息原文 (已 strip 系统块), 用于孤儿卡片标题恢复。
   * 无可用消息时返回 undefined。
   */
  getFirstUserMessageText: () => string | undefined;
  /** 该 agent 类型的默认标题 (例如 "Claude Code 会话"), 永不空。 */
  getDefaultTitle: () => string;
}

export class AgentThreadCardTitleEditController {
  private readonly titleEl: HTMLElement;
  private readonly getAttrTitle: () => string | null;
  private readonly getAttrTypeKey: () => string | null;
  private readonly getInstanceTitle: () => string | undefined;
  private readonly getThreadId: () => string | null;
  private readonly getInstanceId: () => string | null;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly updateAttrs: (attrs: Record<string, unknown>) => void;
  private readonly getFirstUserMessageText: () => string | undefined;
  private readonly getDefaultTitle: () => string;
  private titleInput: HTMLInputElement | null = null;
  private titleBeforeEdit: string | null = null;

  constructor(options: AgentThreadCardTitleEditControllerOptions) {
    this.titleEl = options.titleEl;
    this.getAttrTitle = options.getAttrTitle;
    this.getAttrTypeKey = options.getAttrTypeKey;
    this.getInstanceTitle = options.getInstanceTitle;
    this.getThreadId = options.getThreadId;
    this.getInstanceId = options.getInstanceId;
    this.getTypeKey = options.getTypeKey;
    this.updateAttrs = options.updateAttrs;
    this.getFirstUserMessageText = options.getFirstUserMessageText;
    this.getDefaultTitle = options.getDefaultTitle;
  }

  get activeInput(): HTMLInputElement | null {
    return this.titleInput;
  }

  /**
   * 显式标题 ── 来自持久化真源 (threadLists / 活跃 thread / instance.title /
   * node attr), 不含从首条 user 消息现取或默认标题的恢复回退。
   *
   * card 视图据此判断"标题是否仍需随消息加载而恢复", 避免对已有真实标题的
   * 卡片在每条消息 tick 上重复 syncTitleText。
   */
  private explicitTitle(): string {
    const attrTitle = (this.getAttrTitle() ?? "").trim();
    const attrTypeKey = normalizeAgentTypeKey(this.getAttrTypeKey());
    const threadId = this.getThreadId();
    if (threadId) {
      const meta = useAgentSessionStore.getState().sessionMeta;
      const listTitle = meta.threadLists[attrTypeKey]?.find(
        (item) => item.threadId === threadId,
      )?.title;
      if (listTitle) return listTitle;
      if (meta.activeThreadIds[attrTypeKey] === threadId) {
        const activeTitle = meta.currentThreadTitles[attrTypeKey];
        if (activeTitle) return activeTitle;
      }
    }

    return this.getInstanceTitle() || attrTitle;
  }

  hasExplicitTitle(): boolean {
    return this.explicitTitle().trim().length > 0;
  }

  getTitle(): string {
    const explicit = this.explicitTitle();
    if (explicit) return explicit;

    // 孤儿卡片恢复: 持久化真源查不到标题 (thread.db 无行 / 持久化失败 /
    // 卡片 threadId 漂移成外部 session id) 时, 从已加载的首条 user 消息现取。
    // 首条 user 消息是所有 agent 类型共有的标题信号, 跨 runtime 统一。
    const firstUser = this.getFirstUserMessageText();
    if (firstUser) {
      const derived = deriveThreadTitleFromPrompt(firstUser);
      if (derived) return derived;
    }

    // 兜底: 永不返回空串, 至少展示按类型的默认标题。
    return this.getDefaultTitle();
  }

  syncTitleText(): void {
    if (this.titleInput) return;
    this.titleEl.textContent = this.getTitle();
  }

  startEdit(): void {
    if (this.titleInput) return;

    const currentTitle = this.getTitle();
    this.titleBeforeEdit = currentTitle;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "agent-thread-card__title-input";
    input.value = currentTitle;
    input.setAttribute("aria-label", "重命名对话");
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void this.commitEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEdit();
      }
    });
    input.addEventListener("blur", () => {
      void this.commitEdit();
    });

    this.titleInput = input;
    this.titleEl.replaceChildren(input);
    focusWithoutScroll(input);
    input.select();
  }

  cancelEdit(): void {
    const previousTitle = this.titleBeforeEdit ?? this.getTitle();
    this.titleInput = null;
    this.titleBeforeEdit = null;
    this.titleEl.textContent = previousTitle;
  }

  private async commitEdit(): Promise<void> {
    const input = this.titleInput;
    if (!input) return;

    const previousTitle = this.titleBeforeEdit ?? this.getTitle();
    const nextTitle = input.value.replace(/\s+/g, " ").trim();
    this.titleInput = null;
    this.titleBeforeEdit = null;

    if (!nextTitle || nextTitle === previousTitle) {
      this.titleEl.textContent = previousTitle;
      return;
    }

    const threadId = this.getThreadId();
    const instanceId = this.getInstanceId();
    if (!threadId && !instanceId) {
      this.titleEl.textContent = previousTitle;
      return;
    }

    this.titleEl.textContent = nextTitle;
    // Phase 5.3 修正 (2026-08-03): 同步先调 renameInstance 更新 conv-store
    // + session-store 的 instance.title, 再触发 updateAttrs. 否则后续
    // syncTitleText 读 instance.title 仍是 previousTitle, 把刚设的
    // nextTitle 又覆盖回去, DOM 卡在旧 title.
    if (instanceId) {
      useAgentSessionStore.getState().renameInstance(instanceId, nextTitle);
    }
    this.updateAttrs({ title: nextTitle });

    try {
      await useAgentSessionStore.getState().renameAgentConversation({
        instanceId,
        threadId,
        title: nextTitle,
        typeKey: this.getTypeKey(),
      });
    } catch {
      this.titleEl.textContent = previousTitle;
      if (instanceId) {
        useAgentSessionStore.getState().renameInstance(instanceId, previousTitle);
      }
      this.updateAttrs({ title: previousTitle });
    }
  }
}
