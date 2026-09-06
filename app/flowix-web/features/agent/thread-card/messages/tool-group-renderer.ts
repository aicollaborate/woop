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
import { TOOL_PREVIEW_EXIT_DURATION_MS } from "@features/agent/thread-card/messages/transient-display";

type ToolGroup = Extract<AgentRenderItem, { kind: "tool-group" }>;

function parseEventTimestamp(
  event: Record<string, unknown> | undefined,
): number | null {
  if (!event) return null;
  for (const key of ["time", "timestamp", "createdAt"]) {
    const value = event[key];
    const timestamp =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function getToolGroupDurationMs(group: ToolGroup, now = Date.now()): number | null {
  const timings = group.tools.map((tool) => {
    const displayTimestamp = Date.parse(tool.timestamp);
    const callTimestamp = parseEventTimestamp(tool.toolCall);
    const resultTimestamp = parseEventTimestamp(tool.toolResult);
    const hasTrustedTimestamp = tool.sourceTimestamp !== undefined;
    const start = callTimestamp ?? displayTimestamp;
    let end: number | null = resultTimestamp;

    if (end === null && group.status !== "running" && hasTrustedTimestamp && Number.isFinite(displayTimestamp)) {
      end = displayTimestamp;
    }
    return { start, end };
  });

  if (timings.length === 0 || timings.some(({ start, end }) =>
    !Number.isFinite(start) || (group.status !== "running" && end === null),
  )) return null;

  const start = Math.min(...timings.map(({ start }) => start));
  const end = group.status === "running"
    ? now
    : Math.max(...timings.map(({ end }) => end as number));
  return Math.max(0, end - start);
}

function formatToolGroupDuration(durationMs: number): string | null {
  // The product format has no millisecond representation. Do not turn a
  // real sub-second duration into the misleading label "0s".
  if (durationMs < 1000) return null;
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

function getToolGroupLabel(group: ToolGroup, language: AppLanguage): string {
  const completedCount = group.tools.filter(
    (tool) => !tool.isLoading && !isFailedToolMessage(tool),
  ).length;
  const key =
    group.status === "failed"
      ? "agent.tools.failedSteps"
      : "agent.tools.completedSteps";
  return translate(language, key, {
    count: group.status === "failed" ? group.totalCount : completedCount,
  });
}

function renderTool(
  tool: AgentMessage,
  context: AgentThreadCardMessageRenderContext,
): HTMLElement | null {
  const element = createAgentThreadCardMessageElement({
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

  // A running tool is progress feedback, not an expandable detail row. Keep
  // this rule at the group renderer boundary so it applies consistently to
  // both the outer preview and the expanded full list.
  if (element && tool.isLoading) {
    element.querySelector<HTMLElement>(
      ".agent-thread-card__message-tool-toggle",
    )?.remove();
  }
  return element;
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
  let durationTimer: number | null = null;

  const createPreview = (message: AgentMessage): HTMLElement | null => {
    const element = renderTool(message, currentContext);
    if (!element) return null;
    element.classList.add("agent-thread-card__tool-group-preview");
    if (message.isLoading) {
      const loadingIcon = createToolPreviewLoadingIcon();
      loadingIcon.setAttribute("aria-hidden", "true");
      const toolName = element.querySelector(
        ".agent-thread-card__message-tool-name",
      );
      if (toolName) toolName.before(loadingIcon);
      else element.prepend(loadingIcon);
      element.classList.add("agent-thread-card__tool-group-preview--running");
    }
    element.setAttribute("aria-hidden", String(expanded));
    return element;
  };

  const syncTools = () => {
    if (!expanded) {
      tools.replaceChildren();
      return;
    }
    const renderedTools = currentGroup.tools
      // The active tool is already shown once in the outer progress preview.
      // Completed tools remain in the expanded details list.
      .filter((tool) => !tool.isLoading)
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
    // Mark the row as leaving immediately. CSS keeps it unchanged for the
    // first 500ms, then fades it out over the remaining 300ms; the timer only
    // removes the already-faded node at the end of that timeline.
    entry.element.classList.remove("agent-thread-card__tool-group-preview");
    entry.element.classList.remove(
      "agent-thread-card__tool-group-preview--running",
    );
    entry.element.classList.add("agent-thread-card__tool-group-preview--exiting");
    entry.element.setAttribute("aria-hidden", "true");
    entry.exitTimer = window.setTimeout(
      () => finishPreviewExit(id, entry),
      TOOL_PREVIEW_EXIT_DURATION_MS,
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

  const syncLabel = () => {
    const baseLabel = getToolGroupLabel(currentGroup, currentContext.language);
    const duration = getToolGroupDurationMs(currentGroup);
    const formattedDuration = duration === null
      ? null
      : formatToolGroupDuration(duration);
    label.textContent = formattedDuration === null
      ? baseLabel
      : `${baseLabel} · ${formattedDuration}`;
  };

  const syncDurationTimer = () => {
    if (durationTimer !== null) {
      window.clearInterval(durationTimer);
      durationTimer = null;
    }
    if (currentGroup.status !== "running") return;
    if (getToolGroupDurationMs(currentGroup) === null) return;
    durationTimer = window.setInterval(() => {
      if (!wrapper.isConnected) {
        if (durationTimer !== null) window.clearInterval(durationTimer);
        durationTimer = null;
        return;
      }
      syncLabel();
    }, 1000);
  };

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
    syncLabel();
    header.setAttribute("aria-expanded", String(nextExpanded));
    const toggle = document.createElement("span");
    toggle.className = "agent-thread-card__tool-group-toggle";
    toggle.append(createChevronIcon(nextExpanded ? "down" : "right"));
    header.replaceChildren(
      toggle,
      label,
    );
    syncTools();
    syncDurationTimer();
    for (const entry of previews.values()) {
      entry.element.setAttribute(
        "aria-hidden",
        String(nextExpanded && !entry.message.isLoading),
      );
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
