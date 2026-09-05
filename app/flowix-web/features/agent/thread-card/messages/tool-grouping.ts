import type { ChatMessage } from "@/types";

export type AgentToolGroupStatus = "completed" | "running" | "failed";

export type AgentRenderItem =
  | {
      kind: "message";
      message: ChatMessage;
    }
  | {
      kind: "tool-group";
      id: string;
      tools: ChatMessage[];
      totalCount: number;
      status: AgentToolGroupStatus;
      previewTools?: ChatMessage[];
    };

export function isFailedToolMessage(message: ChatMessage): boolean {
  if (message.role !== "tool") return false;
  if (message.isLoading) return false;
  if (!message.content && !message.toolData) return true;
  return /^\s*\[error\]/i.test(message.content || message.toolData || "");
}

function getToolGroupStatus(tools: ChatMessage[]): AgentToolGroupStatus {
  if (tools.some((tool) => tool.isLoading)) return "running";
  if (tools.some(isFailedToolMessage)) return "failed";
  return "completed";
}

function createToolGroup(
  tools: ChatMessage[],
  previewToolsByGroup?: ReadonlyMap<string, ChatMessage[]>,
): AgentRenderItem {
  const id = `tool-group:${tools[0].id}`;
  return {
    kind: "tool-group",
    // The first tool id is stable across live updates and history hydration.
    id,
    tools,
    totalCount: tools.length,
    status: getToolGroupStatus(tools),
    previewTools: previewToolsByGroup?.get(id),
  };
}

/**
 * Converts the raw message sequence into render units. A non-tool row always
 * flushes the current run, including rows that the message renderer later
 * decides not to display. This preserves the protocol's definition of
 * "consecutive" and prevents hidden assistant rows from joining two groups.
 */
export function groupAgentMessages(
  messages: ChatMessage[],
  previewToolsByGroup?: ReadonlyMap<string, ChatMessage[]>,
): AgentRenderItem[] {
  const items: AgentRenderItem[] = [];
  let toolRun: ChatMessage[] = [];

  const flushTools = () => {
    if (toolRun.length > 0) {
      items.push(createToolGroup(toolRun, previewToolsByGroup));
    }
    toolRun = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      toolRun.push(message);
      continue;
    }
    flushTools();
    items.push({ kind: "message", message });
  }
  flushTools();
  return items;
}

export function areAgentRenderItemsEqual(
  left: AgentRenderItem,
  right: AgentRenderItem,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "message" && right.kind === "message") {
    return left.message === right.message;
  }
  if (left.kind !== "tool-group" || right.kind !== "tool-group") return false;
  if (
    left.id !== right.id ||
    left.status !== right.status ||
    left.totalCount !== right.totalCount ||
    left.tools.length !== right.tools.length
  ) {
    return false;
  }
  if ((left.previewTools?.length ?? 0) !== (right.previewTools?.length ?? 0)) {
    return false;
  }
  return (
    left.tools.every((tool, index) => tool === right.tools[index]) &&
    (left.previewTools ?? []).every(
      (tool, index) => tool === (right.previewTools ?? [])[index],
    )
  );
}
