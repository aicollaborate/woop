import { translate, type AppLanguage } from "@/lib/i18n";
import type { ThreadState } from "@features/agent/store/chat-store";
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from "@features/agent/message";
import { parseAgentCommandInput } from "@features/agent/tool-display";
import {
  fillWithAgentThreadCardMarkdownHtml,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/agent/thread-card/agent-thread-card-markdown";
import {
  createAgentThreadCardCommandList,
  createAgentThreadCardMessageFallback,
} from "@features/agent/thread-card/agent-thread-card-command-renderer";
import {
  applyMessageDisplayBudget,
  truncateToolMessageForDisplay,
  type MessageDisplayBudgetRole,
} from "@features/agent/message/display-limits";
import {
  createChevronIcon,
  createToolIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";

type AgentMessage = ThreadState["messages"][number];

export interface AgentThreadCardMessageElementResult {
  element: HTMLElement;
  shouldRemember: boolean;
}

export interface AgentThreadCardMessageDisplayContext {
  language: AppLanguage;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
}

function getDisplayToggleLabel(
  language: AppLanguage,
  expanded: boolean,
): string {
  if (language === "zh-CN") return expanded ? "收起全文" : "展开全文";
  return expanded ? "Collapse" : "Show full message";
}

function directChildDisplayToggle(parent: HTMLElement): HTMLButtonElement | null {
  for (const child of Array.from(parent.children)) {
    if (child.classList.contains("agent-thread-card__message-display-toggle")) {
      return child as HTMLButtonElement;
    }
  }
  return null;
}

/**
 * 块级增量渲染状态 ── 按 content 元素缓存已定型块的 HTML, 避免流式期间每帧
 * marked.parse 整条消息全文。流式输出时只有最后一个块在变化, 前面的块已定型,
 * 把它们的 HTML 缓存下来, 每帧只 parse 未完成的 tail, 把 marked.parse 的输入
 * 从 O(全文) 降到 O(最后一个块)。
 *
 * 状态生命周期跟 content 元素绑定(WeakMap): content 被 replaceChildren 重建或
 * 消息切换时自然失效。前缀校验(text.startsWith(finalizedText))兜底文本回退
 * (编辑 / compact 重建 / 展开切换改裁剪)导致的前缀变化, 回退时重置走全量。
 */
interface BlockIncrementalState {
  finalizedText: string;
  finalizedHtml: string;
}

const blockIncrementalState = new WeakMap<HTMLElement, BlockIncrementalState>();

/**
 * 找出 text 中"最后一个完整块结尾"的位置, 之后的是正在写入的未完成块(tail)。
 * 块边界 = 代码围栏之外的空行; 围栏(``` / ~~~)内的空行不算边界, 保证未闭合
 * 代码块整体留在 tail 直到闭合。数学块($$ / \[)由 marked 扩展在 parse 时处理,
 * 未闭合数学块留在 tail, 闭合后随其后空行 finalize, 视觉可接受。
 *
 * 返回值是 finalized 部分的长度(含结尾空行), text.slice(return) 即 tail。
 */
function findFinalizableBlockBoundary(text: string): number {
  let inCodeFence = false;
  let fenceChar: string | null = null;
  let lastBoundary = 0;
  let pos = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (inCodeFence) {
      if (fenceChar !== null && line.trim().startsWith(fenceChar.repeat(3))) {
        inCodeFence = false;
        fenceChar = null;
      }
    } else {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        inCodeFence = true;
        fenceChar = fenceMatch[1][0];
      }
    }
    pos += line.length + 1;
    if (!inCodeFence && line.trim() === "") {
      lastBoundary = pos;
    }
  }
  return lastBoundary;
}

/**
 * 增量计算消息 HTML。流式中(isCompleted=false)只 marked.parse 最后一个未完成块,
 * 已定型块 HTML 从缓存复用; 完成时(isCompleted=true)把剩余 tail 全部 finalize
 * 进缓存, 之后整条消息走缓存不再 parse。文本前缀变化时(回退/编辑/展开切换)自动
 * 重置缓存走全量, 保证正确性。
 */
function renderIncrementalMarkdownHtml(
  content: HTMLElement,
  text: string,
  isCompleted: boolean,
): string {
  let state = blockIncrementalState.get(content);
  if (!state) {
    state = { finalizedText: "", finalizedHtml: "" };
    blockIncrementalState.set(content, state);
  }

  // 文本回退/前缀变化(编辑、compact 重建、展开切换改裁剪): 重置走全量
  if (
    text.length < state.finalizedText.length ||
    !text.startsWith(state.finalizedText)
  ) {
    state.finalizedText = "";
    state.finalizedHtml = "";
  }

  if (isCompleted) {
    // 完成: 把剩余文本全部 finalize 进缓存, 之后整条消息走缓存不再 parse
    if (state.finalizedText.length < text.length) {
      const remaining = text.slice(state.finalizedText.length);
      state.finalizedHtml += renderAgentThreadCardMarkdownToHtml(remaining);
      state.finalizedText = text;
    }
    return state.finalizedHtml;
  }

  // 流式中: 把新定型的块(最后一个块边界之前)finalize 进缓存
  const remaining = text.slice(state.finalizedText.length);
  const boundary = findFinalizableBlockBoundary(remaining);
  if (boundary > 0) {
    const newlyFinalized = remaining.slice(0, boundary);
    state.finalizedHtml += renderAgentThreadCardMarkdownToHtml(newlyFinalized);
    state.finalizedText += newlyFinalized;
  }

  // tail = 未完成块, 每帧重新 parse(小, 只有最后一个块)
  const tail = text.slice(state.finalizedText.length);
  return state.finalizedHtml + (tail ? renderAgentThreadCardMarkdownToHtml(tail) : "");
}

export function renderAgentThreadCardBudgetedMarkdown(options: {
  message: AgentMessage;
  role: MessageDisplayBudgetRole;
  visibleContent: string;
  content: HTMLElement;
  toggleParent: HTMLElement;
  context: AgentThreadCardMessageDisplayContext;
}): void {
  const { message, role, visibleContent, content, toggleParent, context } =
    options;
  const expanded = context.getDisplayExpanded(message);
  const display = applyMessageDisplayBudget(role, visibleContent, expanded);

  fillWithAgentThreadCardMarkdownHtml(
    content,
    renderIncrementalMarkdownHtml(
      content,
      display.text,
      !!message.isCompleted,
    ),
    translate(context.language, "editor.threadCard.copyLatex"),
  );

  let toggle = directChildDisplayToggle(toggleParent);
  if (!display.isOverBudget) {
    toggle?.remove();
    return;
  }

  if (!toggle) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-thread-card__message-display-toggle";
    toggleParent.append(toggle);
  }
  toggle.textContent = getDisplayToggleLabel(context.language, expanded);
  toggle.onclick = (event) => {
    event.stopPropagation();
    context.setDisplayExpanded(message.id, !expanded);
    renderAgentThreadCardBudgetedMarkdown(options);
  };
  toggle.onmousedown = (event) => {
    event.stopPropagation();
  };
}

export function createAgentThreadCardMessageElement(options: {
  message: AgentMessage;
  language: AppLanguage;
  getReasoningCollapsed: (message: AgentMessage) => boolean;
  setReasoningCollapsed: (messageId: string, collapsed: boolean) => void;
  getDisplayExpanded: (message: AgentMessage) => boolean;
  setDisplayExpanded: (messageId: string, expanded: boolean) => void;
}): AgentThreadCardMessageElementResult | null {
  const {
    message,
    language,
    getReasoningCollapsed,
    setReasoningCollapsed,
    getDisplayExpanded,
    setDisplayExpanded,
  } = options;
  const displayContext: AgentThreadCardMessageDisplayContext = {
    language,
    getDisplayExpanded,
    setDisplayExpanded,
  };

  if (!shouldRenderAgentMessage(message)) {
    return null;
  }

  let messageView: ReturnType<typeof createAgentMessageViewModel>;
  let item: HTMLDivElement;
  try {
    messageView = createAgentMessageViewModel(message, language);
    item = document.createElement("div");
    item.className = `agent-thread-card__message agent-thread-card__message--${message.role}`;
  } catch (err) {
    console.error("Failed to prepare AgentThreadCard message:", err, message);
    return {
      element: createAgentThreadCardMessageFallback(message, language),
      shouldRemember: true,
    };
  }

  try {
    if (message.role === "tool") {
      const icon = createToolIcon(message.toolName, message.toolAgentType);
      const name = document.createElement("span");
      name.className = "agent-thread-card__message-tool-name";
      name.textContent = messageView.toolLabel;
      const command = parseAgentCommandInput(message.toolInput);
      if (command && message.toolDisplay?.kind === "command") {
        item.classList.add("agent-thread-card__message--tool-command");
        const head = document.createElement("div");
        head.className = "agent-thread-card__message-tool-head";
        head.append(icon, name);
        const body = document.createElement("div");
        body.className = "agent-thread-card__message-tool-body";
        body.append(createAgentThreadCardCommandList(command));
        item.append(head, body);
      } else {
        item.append(icon, name);
        const summaryText = truncateToolMessageForDisplay(
          messageView.toolSummary,
        );
        if (
          message.toolAgentType === "codex" &&
          message.toolName === "mcp_tool_call"
        ) {
          const separatorIndex = summaryText.indexOf(" · ");
          const concreteName = document.createElement("span");
          concreteName.className =
            "agent-thread-card__message-tool-concrete-name";
          concreteName.textContent = separatorIndex >= 0
            ? summaryText.slice(0, separatorIndex)
            : summaryText;
          item.append(concreteName);

          if (separatorIndex >= 0) {
            const summary = document.createElement("span");
            summary.className = "agent-thread-card__message-tool-summary";
            summary.textContent = summaryText.slice(separatorIndex + 3);
            item.append(summary);
          }
        } else {
          const summary = document.createElement("span");
          summary.className = "agent-thread-card__message-tool-summary";
          summary.textContent = summaryText;
          item.append(summary);
        }
      }
    } else if (message.role === "end") {
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      content.textContent = messageView.visibleContent;
      item.append(content);
    } else if (message.role === "user") {
      const content = document.createElement("div");
      content.className =
        "agent-thread-card__message-content agent-thread-card__message-content--user-preview";
      item.append(content);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "user",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: item,
        context: displayContext,
      });
    } else if (message.role === "reasoning") {
      const header = document.createElement("button");
      header.type = "button";
      header.className = "agent-thread-card__message-reasoning-header";
      header.append(createChevronIcon("right"));
      const label = document.createElement("span");
      label.textContent = messageView.reasoningLabel;
      header.append(label);

      const body = document.createElement("div");
      body.className = "agent-thread-card__message-reasoning-body";
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      body.append(content);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "reasoning",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: body,
        context: displayContext,
      });

      const apply = (collapsed: boolean): void => {
        item.classList.toggle(
          "agent-thread-card__message--reasoning-collapsed",
          collapsed,
        );
      };
      apply(getReasoningCollapsed(message));
      header.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = !item.classList.contains(
          "agent-thread-card__message--reasoning-collapsed",
        );
        setReasoningCollapsed(message.id, next);
        apply(next);
      });
      header.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });

      item.append(header, body);
    } else {
      const content = document.createElement("div");
      content.className = "agent-thread-card__message-content";
      item.append(content);
      renderAgentThreadCardBudgetedMarkdown({
        message,
        role: "assistant",
        visibleContent: messageView.visibleContent,
        content,
        toggleParent: item,
        context: displayContext,
      });
    }

    return { element: item, shouldRemember: true };
  } catch (err) {
    console.error("Failed to render AgentThreadCard message:", err, message);
    return {
      element: createAgentThreadCardMessageFallback(message, language),
      shouldRemember: true,
    };
  }
}
