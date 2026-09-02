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
  /** True while the current turn is still producing items. */
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

/**
 * Returns whether a message belongs to the turn currently being submitted.
 *
 * Codex rows are grouped by their provider turn id when one is available.
 * Other agents do not expose that id, so their latest user row is the turn
 * boundary and all following rows belong to that turn until another user row
 * is appended.
 */
export function isCurrentTurnMessage(
  message: AgentMessage,
  messages: ThreadState["messages"],
): boolean {
  const index = messages.indexOf(message);
  if (index < 0) return false;

  let latestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  // A live stream can briefly contain provider rows before its user row is
  // projected. In that state there is no historical boundary to preserve;
  // use the newest known Codex turn id when possible and otherwise treat the
  // available rows as the current turn.
  if (latestUserIndex < 0) {
    if (!message.codexTurnId) return true;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].codexTurnId) {
        return messages[i].codexTurnId === message.codexTurnId;
      }
    }
    return true;
  }

  if (index < latestUserIndex) return false;

  const latestUser = messages[latestUserIndex];
  let currentTurnId = latestUser.codexTurnId;
  if (!currentTurnId) {
    // The optimistic user row may not have adopted the provider id yet. A
    // later Codex row in the same user-delimited segment can still establish
    // the current turn id.
    for (let i = messages.length - 1; i >= latestUserIndex; i -= 1) {
      if (messages[i].codexTurnId) {
        currentTurnId = messages[i].codexTurnId;
        break;
      }
    }
  }

  // Missing ids on reasoning/tool rows are expected in the projected Codex
  // state. The user boundary still keeps those rows in the current turn.
  if (currentTurnId && message.codexTurnId) {
    return currentTurnId === message.codexTurnId;
  }
  return true;
}

export function isLastMessageInTurnAndAssistant(
  messages: ThreadState["messages"],
  index: number,
): boolean {
  const message = messages[index];
  if (message.role !== "assistant") return false;

  // A later user row always starts another turn, regardless of whether its
  // provider metadata has arrived yet.
  for (let i = index + 1; i < messages.length; i += 1) {
    const laterMessage = messages[i];
    if (laterMessage.role === "user") break;

    // Codex turn ids are authoritative when both rows provide one. Rows
    // without an id are tolerated inside the user-delimited turn because
    // reasoning/tool rows may omit the id. Any such later row still means
    // that this assistant is not the final message of the turn.
    if (
      message.codexTurnId &&
      laterMessage.codexTurnId &&
      laterMessage.codexTurnId !== message.codexTurnId
    ) {
      break;
    }
    return false;
  }
  return message.isCompleted !== false;
}

export function shouldShowMessageActions(
  message: AgentMessage,
  messages: ThreadState["messages"],
  isLoading: boolean,
): boolean {
  const index = messages.indexOf(message);
  return (
    isLastMessageInTurnAndAssistant(messages, index) &&
    !(isLoading && isCurrentTurnMessage(message, messages))
  );
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

    // During a live turn only the current turn is provisional. Completed
    // historical turns keep their actions available.
    const shouldShow = shouldShowMessageActions(
      message,
      messages,
      context.isLoading,
    );
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
      showActions: shouldShowMessageActions(
        message,
        messages,
        context.isLoading,
      ),
      canFork: isLastMessageInTurnAndAssistant(
        messages,
        messages.indexOf(message),
      ),
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
      showActions: shouldShowMessageActions(message, messages, context.isLoading),
      canFork: isLastMessageInTurnAndAssistant(messages, index),
      onForkMessage: context.onForkMessage,
    });
    if (!rendered) continue;
    if (rendered.shouldRemember) rememberedMessages.push(message);
    list.append(rendered.element);
  }

  syncMessageActions(messages, list, context);

  return { list, rememberedMessages };
}
