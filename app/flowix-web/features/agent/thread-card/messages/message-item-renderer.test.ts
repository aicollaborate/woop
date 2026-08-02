import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import type { MessageDisplayBudgetRole } from "@features/agent/message/display-limits";
import {
  renderAgentThreadCardBudgetedMarkdown,
  type AgentThreadCardMessageDisplayContext,
} from "@features/agent/thread-card/messages/message-item-renderer";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

function makeDisplayContext(): AgentThreadCardMessageDisplayContext {
  // 用例不测展开/折叠, expanded 恒 false 即可。
  return {
    language: "zh-CN",
    getDisplayExpanded: () => false,
    setDisplayExpanded: () => undefined,
  };
}

type TextRole = "assistant" | "reasoning" | "user";

interface RenderSetup {
  content: HTMLDivElement;
  toggleParent: HTMLDivElement;
  message: ChatMessage;
}

function setup(role: TextRole, content: string, isCompleted = false): RenderSetup {
  const contentEl = document.createElement("div");
  const toggleParent = document.createElement("div");
  toggleParent.append(contentEl);
  const message: ChatMessage = {
    id: "m1",
    role,
    content,
    timestamp: new Date().toISOString(),
    isCompleted,
  };
  return { content: contentEl, toggleParent, message };
}

function render(
  s: RenderSetup,
  role: MessageDisplayBudgetRole,
  visibleContent: string,
  options: { isCompleted?: boolean; isStreaming?: boolean } = {},
): void {
  renderAgentThreadCardBudgetedMarkdown({
    message: {
      ...s.message,
      content: visibleContent,
      isCompleted: options.isCompleted,
    },
    role,
    visibleContent,
    content: s.content,
    toggleParent: s.toggleParent,
    context: makeDisplayContext(),
    isStreaming: options.isStreaming,
  });
}

describe("renderAgentThreadCardBudgetedMarkdown incremental DOM injection", () => {
  it("persists finalized block DOM nodes across streaming patches", () => {
    const s = setup("assistant", "para 1\n\n");
    render(s, "assistant", "para 1\n\n", { isStreaming: true });
    const firstP = s.content.querySelector("p");
    expect(firstP?.textContent).toBe("para 1");

    // 追加 para 2, 前缀稳定: 已 finalize 的 <p>para 1</p> 节点引用不变
    render(s, "assistant", "para 1\n\npara 2", { isStreaming: true });
    expect(s.content.querySelector("p")).toBe(firstP);
    expect(s.content.textContent).toContain("para 2");
  });

  it("resets and rebuilds when the finalized prefix changes", () => {
    const s = setup("assistant", "para 1\n\n");
    render(s, "assistant", "para 1\n\n", { isStreaming: true });
    expect(s.content.textContent).toContain("para 1");

    // 前缀变化 (编辑/回退): "para 2\n\n" 不以 "para 1\n\n" 开头 -> 清空重建
    render(s, "assistant", "para 2\n\n", { isStreaming: true });
    expect(s.content.textContent).toContain("para 2");
    expect(s.content.textContent).not.toContain("para 1");
  });

  it("keeps finalized KaTeX nodes mounted across streaming patches", async () => {
    const s = setup("assistant", "\\[x^2\\]\n\n");
    render(s, "assistant", "\\[x^2\\]\n\n", { isStreaming: true });
    await vi.waitFor(() => {
      const math = s.content.querySelector<HTMLElement>(
        ".agent-thread-card__math",
      );
      expect(math?.dataset.katexRendered).toBe("true");
    });
    const mathNode = s.content.querySelector<HTMLElement>(
      ".agent-thread-card__math",
    );

    // 追加文本: finalized math 节点持久 (引用不变, 仍已渲染, 不重跑 katex.render)
    render(s, "assistant", "\\[x^2\\]\n\nmore text", { isStreaming: true });
    expect(s.content.querySelector(".agent-thread-card__math")).toBe(mathNode);
    expect(mathNode?.dataset.katexRendered).toBe("true");
    expect(s.content.textContent).toContain("more text");
  });

  it("canonicalizes a loose list into a single list on completion", () => {
    const s = setup("reasoning", "- item 1\n\n", false);
    // 流式中: "- item 1\n\n" finalize 为单项 tight list
    render(s, "reasoning", "- item 1\n\n", { isStreaming: true });
    expect(s.content.querySelectorAll("ul")).toHaveLength(1);

    // 追加 "- item 2" (仍流式): 块切分把两项拆成两个 tight list
    render(s, "reasoning", "- item 1\n\n- item 2", { isStreaming: true });
    expect(s.content.querySelectorAll("ul")).toHaveLength(2);

    // 完成 (isCompleted=true -> forceFinalize): 全量 re-parse 修正为一个 loose list
    render(s, "reasoning", "- item 1\n\n- item 2", { isCompleted: true });
    const uls = s.content.querySelectorAll("ul");
    expect(uls).toHaveLength(1);
    expect(uls[0].querySelectorAll("li")).toHaveLength(2);
    // loose list 条目被 <p> 包裹 (tight list 不会)
    expect(uls[0].querySelector("li p")).not.toBeNull();
  });

  it("canonicalizes an assistant message on run completion (isStreaming=false)", () => {
    const s = setup("assistant", "- item 1\n\n", false);
    // 流式中: 拆成两个 tight list
    render(s, "assistant", "- item 1\n\n- item 2", { isStreaming: true });
    expect(s.content.querySelectorAll("ul")).toHaveLength(2);

    // run 结束 -> controller 传 isStreaming=false -> 全量 re-parse 修正
    // (assistant 无 isCompleted, 靠 isStreaming 下降沿触发)
    render(s, "assistant", "- item 1\n\n- item 2", { isStreaming: false });
    const uls = s.content.querySelectorAll("ul");
    expect(uls).toHaveLength(1);
    expect(uls[0].querySelectorAll("li")).toHaveLength(2);
    expect(uls[0].querySelector("li p")).not.toBeNull();
  });

  it("does not re-parse on repeated completion with unchanged text", () => {
    const s = setup("reasoning", "final answer\n\n", false);
    render(s, "reasoning", "final answer\n\n", { isCompleted: true });
    const pAfterFirst = s.content.querySelector("p");
    expect(pAfterFirst?.textContent).toBe("final answer");

    // 同一 text 再次完成: 不应重建 (节点引用不变)
    render(s, "reasoning", "final answer\n\n", { isCompleted: true });
    expect(s.content.querySelector("p")).toBe(pAfterFirst);
  });
});
