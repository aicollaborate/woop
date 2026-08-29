import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import {
  createRenderedAgentMessageList,
  isLastAssistantInTurn,
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
  it("keeps actions only on the final assistant when non-assistant rows lack a turn id", () => {
    const messages = [
      message("assistant-1", "assistant", "turn-1"),
      message("reasoning-1", "reasoning"),
      message("assistant-2", "assistant", "turn-1"),
    ];

    expect(isLastAssistantInTurn(messages, 0)).toBe(false);
    expect(isLastAssistantInTurn(messages, 2)).toBe(true);

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
    expect(list.querySelectorAll(".agent-thread-card__message-fork-confirm")).toHaveLength(1);
    expect(onFork).not.toHaveBeenCalled();

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
});
