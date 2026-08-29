import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import type { AppLanguage } from "@/lib/i18n";
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import {
  createAgentThreadCardMessageElement,
  attachMessageActions,
  renderAgentThreadCardBudgetedMarkdown,
} from "@features/agent/thread-card/messages/message-item-renderer";

export function getRenderedAgentMessages(
  messages: ThreadState["messages"],
): ThreadState["messages"] {
  return messages.filter(shouldRenderAgentMessage);
}

type AgentMessage = ThreadState["messages"][number];

export interface RenderedAgentMessageCache {
  list: HTMLDivElement | null;
  refs: ThreadState["messages"];
}

export interface AgentThreadCardMessageRenderContext {
  language: AppLanguage;
  /** True while the current Codex turn is still producing items. */
  isLoading: boolean;
  getReasoningCollapsed: (message: AgentMessage) => boolean;
  setReasoningCollapsed: (messageId: string, collapsed: boolean) => void;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
  /**
   * 消息是否仍在流式增长 ── 由 controller 按 `isLoading && 末条 && !isCompleted`
   * 判定。流式中的末条走块级增量, 其余(历史 / 已完成 / 完成态触发)走全量 re-parse
   * 修正块切分。见 [renderAgentThreadCardBudgetedMarkdown]。
   */
  isStreaming: (message: AgentMessage) => boolean;
  onForkMessage?: (message: AgentMessage) => void | Promise<void>;
}

export function isLastAssistantInTurn(
  messages: ThreadState["messages"],
  index: number,
): boolean {
  const message = messages[index];
  if (message.role !== "assistant") return false;
  // DSH and other external agents do not expose Codex turn ids. Their
  // projected assistant rows are still ordered, so the last assistant row is
  // the correct completed-message action target.
  if (!message.codexTurnId) {
    for (let i = index + 1; i < messages.length; i += 1) {
      if (messages[i].role === "assistant") return false;
    }
    return message.isCompleted !== false;
  }
  for (let i = index + 1; i < messages.length; i += 1) {
    // A turn can contain reasoning/tool rows which do not carry the Codex
    // turn id in the projected client state. They must not terminate the
    // search: only a later assistant with the same turn id proves that this
    // assistant is not the turn's final assistant output.
    if (
      messages[i].role === "assistant" &&
      messages[i].codexTurnId === message.codexTurnId
    ) {
      return false;
    }
  }
  return message.isCompleted !== false;
}

function syncMessageActions(
  messages: ThreadState["messages"],
  list: HTMLDivElement,
  context: AgentThreadCardMessageRenderContext,
): void {
  const renderedMessages = getRenderedAgentMessages(messages);
  for (let index = 0; index < renderedMessages.length; index += 1) {
    const message = renderedMessages[index];
    const item = list.children[index] as HTMLDivElement | undefined;
    if (!item || message.role !== "assistant") continue;

    // During a live turn the current last assistant is only a provisional
    // tail: a tool call or another assistant item may still arrive. Actions
    // are therefore enabled only after the turn has stopped streaming.
    const shouldShow =
      !context.isLoading &&
      isLastAssistantInTurn(messages, messages.indexOf(message));
    const actions = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-actions",
    );
    if (shouldShow && !actions) {
      attachMessageActions(
        item,
        message,
        createAgentMessageViewModel(message, context.language),
        context.language,
        true,
        context.onForkMessage,
      );
    } else if (!shouldShow && actions) {
      actions.remove();
    }
  }
}

export interface AgentThreadCardMessagePatchOptions {
  body: HTMLElement;
  cache: RenderedAgentMessageCache;
  context: AgentThreadCardMessageRenderContext;
  afterRender: () => void;
  /**
   * 绕过末条引用相等短路 ── run 结束下降沿(isLoading true->false)时末条引用未变,
   * 但仍需 forceFinalize 全量 re-parse 修正流式期间块切分。仅 controller 在
   * loadingJustEnded + canReuse 时传 true。
   */
  force?: boolean;
}

export function patchLastRenderedAgentMessage(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): ThreadState["messages"] | null {
  const { body, cache, context, afterRender } = options;
  const list = cache.list;
  if (!list || !body.contains(list)) return null;

  const renderedMessages = getRenderedAgentMessages(messages);
  if (
    renderedMessages.length === 0 ||
    renderedMessages.length !== cache.refs.length ||
    list.children.length !== renderedMessages.length
  ) {
    return null;
  }

  for (let i = 0; i < renderedMessages.length - 1; i += 1) {
    if (renderedMessages[i] !== cache.refs[i]) return null;
  }

  const previousLast = cache.refs[renderedMessages.length - 1];
  const nextLast = renderedMessages[renderedMessages.length - 1];
  if (
    !options.force &&
    (previousLast === nextLast ||
      previousLast.id !== nextLast.id ||
      previousLast.role !== nextLast.role)
  ) {
    return null;
  }

  const item = list.lastElementChild as HTMLDivElement | null;
  if (!item) return null;

  const messageView = createAgentMessageViewModel(nextLast, context.language);
  if (nextLast.role === "assistant" || nextLast.role === "user") {
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!content) return null;
    renderAgentThreadCardBudgetedMarkdown({
      message: nextLast,
      role: nextLast.role,
      visibleContent: messageView.visibleContent,
      content,
      toggleParent: item,
      context,
      isStreaming: context.isStreaming(nextLast),
    });
  } else if (nextLast.role === "reasoning") {
    const label = item.querySelector<HTMLSpanElement>(
      ".agent-thread-card__message-reasoning-header span",
    );
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!label || !content) return null;
    label.textContent = messageView.reasoningLabel;
    const collapsed = context.getReasoningCollapsed(nextLast);
    item.classList.toggle(
      "agent-thread-card__message--reasoning-collapsed",
      collapsed,
    );
    const body = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-reasoning-body",
    );
    if (!body) return null;
    if (!collapsed) {
      renderAgentThreadCardBudgetedMarkdown({
        message: nextLast,
        role: "reasoning",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: body,
        context,
        isStreaming: context.isStreaming(nextLast),
      });
    }
  } else if (nextLast.role === "end") {
    const content = item.querySelector<HTMLElement>(
      ".agent-thread-card__message-content",
    );
    if (!content) return null;
    content.textContent = messageView.visibleContent;
  } else {
    return null;
  }

  syncMessageActions(messages, list, context);
  afterRender();
  return [...cache.refs.slice(0, -1), nextLast];
}

export function appendRenderedAgentMessagesToTail(
  messages: ThreadState["messages"],
  options: AgentThreadCardMessagePatchOptions,
): ThreadState["messages"] | null {
  const { body, cache, context, afterRender } = options;
  const oldRefs = cache.refs;
  const list = cache.list;
  if (oldRefs.length === 0) return null;
  if (!list || !body.contains(list)) return null;

  const newRendered = getRenderedAgentMessages(messages);
  if (newRendered.length <= oldRefs.length) return null;
  if (list.children.length !== oldRefs.length) return null;

  for (let i = 0; i < oldRefs.length; i += 1) {
    if (newRendered[i] !== oldRefs[i]) return null;
  }

  const appended = newRendered.slice(oldRefs.length);
  let appendedCount = 0;
  for (const message of appended) {
    const rendered = createAgentThreadCardMessageElement({
      message,
      language: context.language,
      getReasoningCollapsed: context.getReasoningCollapsed,
      setReasoningCollapsed: context.setReasoningCollapsed,
      getDisplayExpanded: context.getDisplayExpanded,
      setDisplayExpanded: context.setDisplayExpanded,
      isStreaming: context.isStreaming(message),
      showActions: !context.isLoading && isLastAssistantInTurn(
        messages,
        messages.indexOf(message),
      ),
      canFork: isLastAssistantInTurn(messages, messages.indexOf(message)),
      onForkMessage: context.onForkMessage,
    });
    if (!rendered) continue;
    list.append(rendered.element);
    appendedCount += 1;
  }

  if (appendedCount === 0) return null;
  syncMessageActions(messages, list, context);
  afterRender();
  return newRendered;
}

export function createRenderedAgentMessageList(
  messages: ThreadState["messages"],
  context: AgentThreadCardMessageRenderContext,
): {
  list: HTMLDivElement;
  rememberedMessages: ThreadState["messages"];
} {
  const list = document.createElement("div");
  list.className = "agent-thread-card__messages";
  const rememberedMessages: ThreadState["messages"] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const rendered = createAgentThreadCardMessageElement({
      message,
      language: context.language,
      getReasoningCollapsed: context.getReasoningCollapsed,
      setReasoningCollapsed: context.setReasoningCollapsed,
      getDisplayExpanded: context.getDisplayExpanded,
      setDisplayExpanded: context.setDisplayExpanded,
      isStreaming: context.isStreaming(message),
      showActions: !context.isLoading && isLastAssistantInTurn(messages, index),
      canFork: isLastAssistantInTurn(messages, index),
      onForkMessage: context.onForkMessage,
    });
    if (!rendered) continue;
    if (rendered.shouldRemember) rememberedMessages.push(message);
    list.append(rendered.element);
  }

  syncMessageActions(messages, list, context);

  return { list, rememberedMessages };
}
