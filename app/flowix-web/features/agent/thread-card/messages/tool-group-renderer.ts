import { translate, type AppLanguage } from "@/lib/i18n";
import {
  createAgentThreadCardMessageElement,
} from "@features/agent/thread-card/messages/message-item-renderer";
import {
  isFailedToolMessage,
  type AgentRenderItem,
} from "@features/agent/thread-card/messages/tool-grouping";
import type {
  AgentMessage,
  AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-render-context";
import {
  createChevronIcon,
  createToolPreviewLoadingIcon,
} from "@features/agent/thread-card/agent-thread-card-icons";

type ToolGroup = Extract<AgentRenderItem, { kind: "tool-group" }>;

const TOOL_PREVIEW_FADE_DURATION_MS = 300;

function getToolGroupLabel(group: ToolGroup, language: AppLanguage): string {
  const key =
    group.status === "running"
      ? "agent.tools.runningSteps"
      : group.status === "failed"
        ? "agent.tools.failedSteps"
        : "agent.tools.completedSteps";
  return translate(language, key, { count: group.totalCount });
}

function renderTool(
  tool: AgentMessage,
  context: AgentThreadCardMessageRenderContext,
): HTMLElement | null {
  return createAgentThreadCardMessageElement({
    message: tool,
    language: context.language,
    getReasoningCollapsed: context.getReasoningCollapsed,
    setReasoningCollapsed: context.setReasoningCollapsed,
    getDisplayExpanded: context.getDisplayExpanded,
    setDisplayExpanded: context.setDisplayExpanded,
    isStreaming: context.isStreaming(tool),
    showActions: false,
    canFork: false,
    onForkMessage: context.onForkMessage,
  })?.element ?? null;
}

export function createToolGroupElement(options: {
  group: ToolGroup;
  context: AgentThreadCardMessageRenderContext;
}): HTMLElement {
  const { group, context } = options;
  const wrapper = document.createElement("div");
  wrapper.className = "agent-thread-card__tool-group";
  wrapper.dataset.toolGroupId = group.id;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "agent-thread-card__tool-group-header";
  header.id = `${group.id}-header`;

  const tools = document.createElement("div");
  tools.className = "agent-thread-card__tool-group-tools";
  tools.id = group.id;
  tools.setAttribute("role", "region");
  tools.setAttribute("aria-labelledby", header.id);
  header.setAttribute("aria-controls", tools.id);

  type PreviewEntry = {
    element: HTMLElement;
    message: AgentMessage;
    exitTimer: number | null;
  };

  const previews = new Map<string, PreviewEntry>();
  let currentGroup = group;
  let currentContext = context;
  let expanded = context.getToolGroupExpanded?.(group.id) ?? false;

  const createPreview = (message: AgentMessage): HTMLElement | null => {
    const element = renderTool(message, currentContext);
    if (!element) return null;
    const loadingIcon = createToolPreviewLoadingIcon();
    loadingIcon.setAttribute("aria-hidden", "true");
    const toolName = element.querySelector(
      ".agent-thread-card__message-tool-name",
    );
    if (toolName) toolName.before(loadingIcon);
    else element.prepend(loadingIcon);
    element.classList.add("agent-thread-card__tool-group-preview");
    element.setAttribute("aria-hidden", String(expanded));
    return element;
  };

  const syncTools = () => {
    if (!expanded) {
      tools.replaceChildren();
      return;
    }
    const renderedTools = currentGroup.tools
      .map((tool) => renderTool(tool, currentContext))
      .filter((element): element is HTMLElement => element !== null);
    tools.replaceChildren(...renderedTools);
  };

  const finishPreviewExit = (id: string, entry: PreviewEntry) => {
    if (previews.get(id) !== entry) return;
    entry.element.remove();
    previews.delete(id);
  };

  const startPreviewExit = (id: string, entry: PreviewEntry) => {
    if (entry.exitTimer !== null) return;
    entry.element.classList.remove("agent-thread-card__tool-group-preview");
    entry.element.classList.add("agent-thread-card__tool-group-preview--exiting");
    entry.element.setAttribute("aria-hidden", "true");
    entry.exitTimer = window.setTimeout(
      () => finishPreviewExit(id, entry),
      TOOL_PREVIEW_FADE_DURATION_MS,
    );
  };

  const cancelPreviewExit = (entry: PreviewEntry) => {
    if (entry.exitTimer !== null) {
      window.clearTimeout(entry.exitTimer);
      entry.exitTimer = null;
    }
    entry.element.classList.remove(
      "agent-thread-card__tool-group-preview--exiting",
    );
    entry.element.classList.add("agent-thread-card__tool-group-preview");
  };

  const syncPreviews = () => {
    // Failed tools must remain visible while the group is collapsed. Their
    // renderer may have produced a fallback because malformed provider data
    // threw during parsing; hiding that fallback would turn a recoverable
    // rendering error into a silently missing message.
    const previewTools = [
      ...(currentGroup.previewTools ?? []),
      ...currentGroup.tools.filter(isFailedToolMessage),
    ];
    const nextPreviewTools = [...new Map(
      previewTools.map((tool) => [tool.id, tool]),
    ).values()];
    const nextIds = new Set(nextPreviewTools.map((tool) => tool.id));

    for (const [id, entry] of previews) {
      if (!nextIds.has(id)) startPreviewExit(id, entry);
    }

    for (const message of nextPreviewTools) {
      const existing = previews.get(message.id);
      if (existing) {
        cancelPreviewExit(existing);
        if (existing.message !== message) {
          const nextElement = createPreview(message);
          if (nextElement) {
            nextElement.classList.add(
              "agent-thread-card__tool-group-preview--updated",
            );
            existing.element.replaceWith(nextElement);
            existing.element = nextElement;
            existing.message = message;
          }
        }
        wrapper.insertBefore(existing.element, tools);
        continue;
      }

      const element = createPreview(message);
      if (!element) continue;
      const entry: PreviewEntry = { element, message, exitTimer: null };
      previews.set(message.id, entry);
      wrapper.insertBefore(element, tools);
    }
  };

  const label = document.createElement("span");

  const applyExpanded = (nextExpanded: boolean) => {
    expanded = nextExpanded;
    wrapper.classList.toggle(
      "agent-thread-card__tool-group--expanded",
      nextExpanded,
    );
    wrapper.classList.remove(
      "agent-thread-card__tool-group--completed",
      "agent-thread-card__tool-group--running",
      "agent-thread-card__tool-group--failed",
    );
    wrapper.classList.add(`agent-thread-card__tool-group--${currentGroup.status}`);
    label.textContent = getToolGroupLabel(currentGroup, currentContext.language);
    header.setAttribute("aria-expanded", String(nextExpanded));
    header.replaceChildren(
      createChevronIcon(nextExpanded ? "down" : "right"),
      label,
    );
    syncTools();
    for (const entry of previews.values()) {
      entry.element.setAttribute("aria-hidden", String(nextExpanded));
    }
  };

  header.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextExpanded = !wrapper.classList.contains(
      "agent-thread-card__tool-group--expanded",
    );
    currentContext.setToolGroupExpanded?.(group.id, nextExpanded);
    applyExpanded(nextExpanded);
  });
  header.addEventListener("mousedown", (event) => event.stopPropagation());

  wrapper.append(header);
  wrapper.append(tools);
  applyExpanded(context.getToolGroupExpanded?.(group.id) ?? false);
  syncPreviews();

  toolGroupUpdaters.set(wrapper, (nextGroup, nextContext) => {
    currentGroup = nextGroup;
    currentContext = nextContext;
    syncPreviews();
    applyExpanded(expanded);
  });
  return wrapper;
}

type ToolGroupUpdater = (
  group: ToolGroup,
  context: AgentThreadCardMessageRenderContext,
) => void;

const toolGroupUpdaters = new WeakMap<HTMLElement, ToolGroupUpdater>();

export function updateToolGroupElement(
  element: HTMLElement,
  options: {
    group: ToolGroup;
    context: AgentThreadCardMessageRenderContext;
  },
): boolean {
  const update = toolGroupUpdaters.get(element);
  if (!update) return false;
  update(options.group, options.context);
  return true;
}
