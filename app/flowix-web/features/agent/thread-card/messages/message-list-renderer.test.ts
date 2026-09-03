import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import {
  createRenderedAgentMessageList,
  isCurrentTurnMessage,
  isLastMessageInTurnAndAssistant,
  type AgentThreadCardMessageRenderContext,
} from "@features/agent/thread-card/messages/message-list-renderer";

function message(
  id: string,
  role: ChatMessage["role"],
  codexTurnId?: string,
): ChatMessage {
  return {
    id,
    role,
    content: id,
    timestamp: "2026-08-29T00:00:00.000Z",
    isCompleted: true,
    codexTurnId,
  };
}

function context(): AgentThreadCardMessageRenderContext {
  return {
    language: "zh-CN",
    isLoading: false,
    getReasoningCollapsed: () => false,
    setReasoningCollapsed: () => undefined,
    getDisplayExpanded: () => false,
    setDisplayExpanded: () => undefined,
    isStreaming: () => false,
  };
}

describe("Codex turn-end message actions", () => {
  it("shows copy and time only on the final assistant for agents without turn ids", () => {
    const messages = [
      message("assistant-1", "assistant"),
      message("tool-1", "tool"),
      message("assistant-2", "assistant"),
    ];

    expect(isLastMessageInTurnAndAssistant(messages, 0)).toBe(false);
    expect(isLastMessageInTurnAndAssistant(messages, 2)).toBe(true);

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(1);
    expect(list.children[0].querySelector(".agent-thread-card__message-actions")).toBeNull();
    const actions = list.children[2].querySelector(".agent-thread-card__message-actions");
    expect(actions).not.toBeNull();
    expect(actions?.querySelectorAll(".agent-thread-card__message-action")).toHaveLength(1);
    expect(actions?.querySelector(".agent-thread-card__message-time")?.textContent).toContain("星期");
  });

  it("does not show actions when a tool is the final message of the turn", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("tool-1", "tool"),
    ];

    expect(isLastMessageInTurnAndAssistant(messages, 1)).toBe(false);

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(0);
  });

  it("keeps actions only on the final assistant when non-assistant rows lack a turn id", () => {
    const messages = [
      message("assistant-1", "assistant", "turn-1"),
      message("reasoning-1", "reasoning"),
      message("assistant-2", "assistant", "turn-1"),
    ];

    expect(isLastMessageInTurnAndAssistant(messages, 0)).toBe(false);
    expect(isLastMessageInTurnAndAssistant(messages, 2)).toBe(true);

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(1);
    expect(list.children[0].querySelector(".agent-thread-card__message-actions")).toBeNull();
    expect(list.children[2].querySelector(".agent-thread-card__message-actions")).not.toBeNull();
  });

  it("shows actions at the end of each distinct Codex turn", () => {
    const messages = [
      message("assistant-1", "assistant", "turn-1"),
      message("assistant-2", "assistant", "turn-2"),
    ];

    const { list } = createRenderedAgentMessageList(messages, context());
    expect(list.querySelectorAll(".agent-thread-card__message-actions")).toHaveLength(2);
  });

  it("does not show actions while the turn is still streaming", () => {
    const messages = [message("assistant-1", "assistant", "turn-1")];
    const streamingContext = { ...context(), isLoading: true };

    const { list } = createRenderedAgentMessageList(messages, streamingContext);
    expect(list.querySelector(".agent-thread-card__message-actions")).toBeNull();
  });

  it("keeps historical actions while hiding only the current no-id agent turn", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
      { ...message("assistant-2", "assistant"), isCompleted: false },
    ];
    const streamingContext = { ...context(), isLoading: true };

    expect(isCurrentTurnMessage(messages[1], messages)).toBe(false);
    expect(isCurrentTurnMessage(messages[3], messages)).toBe(true);
    expect(isLastMessageInTurnAndAssistant(messages, 1)).toBe(true);
    expect(isLastMessageInTurnAndAssistant(messages, 3)).toBe(false);

    const { list } = createRenderedAgentMessageList(messages, streamingContext);
    expect(
      list.querySelectorAll(".agent-thread-card__message-actions"),
    ).toHaveLength(1);
    expect(
      list.children[1].querySelector(".agent-thread-card__message-actions"),
    ).not.toBeNull();
    expect(
      list.children[3].querySelector(".agent-thread-card__message-actions"),
    ).toBeNull();
  });

  it("uses Codex turn ids while including id-less reasoning and tool rows in the current turn", () => {
    const messages = [
      message("user-1", "user", "turn-1"),
      message("assistant-1", "assistant", "turn-1"),
      message("user-2", "user", "turn-2"),
      message("reasoning-2", "reasoning"),
      message("tool-2", "tool"),
      message("assistant-2a", "assistant", "turn-2"),
      {
        ...message("assistant-2b", "assistant", "turn-2"),
        isCompleted: false,
      },
    ];
    const streamingContext = { ...context(), isLoading: true };

    expect(isCurrentTurnMessage(messages[1], messages)).toBe(false);
    expect(isCurrentTurnMessage(messages[3], messages)).toBe(true);
    expect(isCurrentTurnMessage(messages[5], messages)).toBe(true);
    expect(isCurrentTurnMessage(messages[6], messages)).toBe(true);
    expect(isLastMessageInTurnAndAssistant(messages, 5)).toBe(false);

    const { list } = createRenderedAgentMessageList(messages, streamingContext);
    expect(
      list.children[1].querySelector(".agent-thread-card__message-actions"),
    ).not.toBeNull();
    expect(
      list.children[5].querySelector(".agent-thread-card__message-actions"),
    ).toBeNull();
    expect(
      list.children[6].querySelector(".agent-thread-card__message-actions"),
    ).toBeNull();
  });

  it("shows a check for one second after copying succeeds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      context(),
    );
    const copyButton = list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    );
    expect(copyButton).not.toBeNull();

    copyButton?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("assistant-1");
    expect(copyButton?.dataset.state).toBe("copied");
    vi.advanceTimersByTime(999);
    expect(copyButton?.dataset.state).toBe("copied");
    vi.advanceTimersByTime(1);
    expect(copyButton?.dataset.state).toBe("");
    vi.useRealTimers();
  });

  it("requires inline fork confirmation and does not fork on cancel", () => {
    const onFork = vi.fn();
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      { ...context(), onForkMessage: onFork },
    );
    const buttons = list.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    );
    const forkButton = buttons[1];
    forkButton.click();
    const confirmation = list.querySelector<HTMLElement>(
      ".agent-thread-card__message-fork-confirm",
    );
    expect(confirmation).not.toBeNull();
    expect(confirmation?.previousElementSibling).toBe(forkButton);
    forkButton.click();
    expect(list.querySelectorAll(".agent-thread-card__message-fork-confirm")).toHaveLength(0);
    expect(onFork).not.toHaveBeenCalled();

    forkButton.click();
    list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-fork-cancel-button",
    )?.click();
    expect(onFork).not.toHaveBeenCalled();

    forkButton.click();
    list.querySelector<HTMLButtonElement>(
      ".agent-thread-card__message-fork-confirm-button",
    )?.click();
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ id: "assistant-1" }));
  });

  it("closes the fork confirmation when the message action area is left", () => {
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      context(),
    );
    const item = list.firstElementChild as HTMLElement;
    const forkButton = list.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    )[1];

    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).toBeNull();

    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    item.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).toBeNull();
    expect(forkButton.style.visibility).toBe("");
  });

  it("closes the fork confirmation when clicking outside the actions", () => {
    const { list } = createRenderedAgentMessageList(
      [message("assistant-1", "assistant", "turn-1")],
      context(),
    );
    const forkButton = list.querySelectorAll<HTMLButtonElement>(
      ".agent-thread-card__message-action",
    )[1];

    forkButton.click();
    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).not.toBeNull();
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(list.querySelector(".agent-thread-card__message-fork-confirm")).toBeNull();
  });
});

describe("continuous tool group rendering", () => {
  function tool(
    id: string,
    overrides: Partial<ChatMessage> = {},
  ): ChatMessage {
    return {
      id,
      role: "tool",
      content: "done",
      timestamp: "2026-09-03T00:00:00.000Z",
      toolName: "read",
      toolInput: { path: `${id}.md`, extra: "preserved" },
      isLoading: false,
      ...overrides,
    };
  }

  it("renders adjacent tools as one top-level group with independently expandable inputs", () => {
    const { list } = createRenderedAgentMessageList(
      [tool("tool-1"), tool("tool-2"), tool("tool-3")],
      context(),
    );

    expect(list.children).toHaveLength(1);
    const group = list.firstElementChild as HTMLElement;
    expect(group.classList.contains("agent-thread-card__tool-group")).toBe(true);
    expect(group.querySelector(".agent-thread-card__tool-group-header")?.textContent)
      .toContain("已完成 3 个步骤");
    expect(group.querySelectorAll(".agent-thread-card__tool-group-tools > .agent-thread-card__message"))
      .toHaveLength(3);

    group.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-header",
    )?.click();
    expect(group.classList.contains("agent-thread-card__tool-group--expanded")).toBe(true);

    const inputToggle = group.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-tools .agent-thread-card__message-tool-toggle",
    );
    inputToggle?.click();
    expect(group.textContent).toContain('"path": "tool-1.md"');
    expect(group.textContent).toContain('"extra": "preserved"');
  });

  it("uses the same group container for a singleton tool", () => {
    const { list } = createRenderedAgentMessageList([tool("tool-1")], context());

    expect(list.children).toHaveLength(1);
    expect(list.querySelector(".agent-thread-card__tool-group-header")?.textContent)
      .toContain("已完成 1 个步骤");
    expect(list.querySelectorAll(".agent-thread-card__tool-group-tools > .agent-thread-card__message"))
      .toHaveLength(1);
  });

  it("keeps the newest tool batch outside the group while streaming", () => {
    const running = tool("tool-2", { isLoading: true, content: "" });
    const { list } = createRenderedAgentMessageList(
      [tool("tool-1"), running],
      {
        ...context(),
        toolGroupPreview: new Map([["tool-group:tool-1", [running]]]),
      },
    );
    const group = list.firstElementChild as HTMLElement;

    expect(group.querySelector(".agent-thread-card__tool-group-header")?.textContent)
      .toContain("正在进行 2 个步骤");
    expect(group.querySelector(".agent-thread-card__tool-group-preview"))
      .not.toBeNull();
    expect(group.querySelectorAll(".agent-thread-card__tool-group-tools > .agent-thread-card__message"))
      .toHaveLength(2);

    group.querySelector<HTMLButtonElement>(
      ".agent-thread-card__tool-group-header",
    )?.click();
    expect(group.querySelector(".agent-thread-card__tool-group-preview"))
      .not.toBeNull();
    expect(group.querySelector(".agent-thread-card__tool-group-tools")?.children)
      .toHaveLength(2);
  });
});
