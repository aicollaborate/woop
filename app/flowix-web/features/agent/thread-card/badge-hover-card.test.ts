import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgeHoverCard, type BadgeHoverCardRuntimeInfo } from "./badge-hover-card";

vi.mock("@shared/ui/hover-card", () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement("button", {
        "data-open": "true",
        onClick: () => onOpenChange?.(true),
      }),
      createElement("button", {
        "data-open": "false",
        onClick: () => onOpenChange?.(false),
      }),
      children,
    ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  HoverCardContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    language: "en-US",
    t: (key: string) =>
      key === "editor.threadCard.cwd"
        ? "Space"
        : key === "editor.threadCard.contextUsage"
          ? "Context"
          : key === "editor.threadCard.inputOutputTokens"
            ? "In/Out"
            : key,
  }),
}));

describe("BadgeHoverCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders cwd only when the conversation has captured one", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: "thread-1",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 3,
            total_tokens: 123,
            context_used_tokens: 600,
            model_context_window: 2000,
          },
          cwd: "D:\\projects\\flowix",
        }),
      );
    });

    expect(host.textContent).toContain("Space");
    expect(host.textContent).toContain("flowix");
    expect(host.textContent).not.toContain("D:\\projects\\flowix");
    expect(host.querySelector<HTMLElement>(".agent-thread-card__cwd-value")?.title).toBe(
      "D:\\projects\\flowix",
    );
    expect(host.textContent).toContain("100");
    expect(host.textContent).toContain("In/Out100 / 3 tok");
    expect(host.textContent).toContain("17%");
    expect(host.textContent).toContain("3");
    expect(host.textContent).toContain("Context");
    expect(host.textContent).toContain("30%");
    expect(host.querySelector(".agent-thread-card__cache-hit-ring")).toBeNull();
    expect(host.querySelector(".agent-thread-card__context-ring")).not.toBeNull();

    await act(async () => {
      root.render(createElement(BadgeHoverCard, { threadId: "thread-1" }));
    });

    expect(host.textContent).not.toContain("CWD");
    expect(host.textContent).not.toContain("D:\\projects\\flowix");
    expect(host.querySelector(".agent-thread-card__model-value")?.textContent).toBe(
      "-",
    );

    await act(async () => root.unmount());
  });

  it("refreshes runtime info once for every open transition", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const requestRuntimeInfo = vi.fn().mockResolvedValue({
      model: "deepseek-chat",
      sessionId: "provider-session-1",
      usage: {
        input_tokens: 200,
        cached_input_tokens: 100,
        output_tokens: 8,
        context_used_tokens: 900,
        model_context_window: 2000,
      },
    });

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: "thread-1",
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    const open = host.querySelector<HTMLButtonElement>('[data-open="true"]');
    const close = host.querySelector<HTMLButtonElement>('[data-open="false"]');
    expect(open).not.toBeNull();
    expect(close).not.toBeNull();

    await act(async () => {
      open?.click();
    });
    expect(requestRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("provider-session-1");
    expect(host.textContent).toContain("deepseek-chat");
    expect(host.textContent).toContain("45%");

    await act(async () => {
      close?.click();
      open?.click();
    });
    expect(requestRuntimeInfo).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("treats an empty usage object as not loaded", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const requestRuntimeInfo = vi.fn().mockResolvedValue({
      usage: { input_tokens: 12 },
    });

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: "thread-1",
          usage: {},
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    expect(requestRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("12 / - tok");

    await act(async () => root.unmount());
  });

  it("refreshes when only aggregate tokens are present", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const requestRuntimeInfo = vi.fn().mockResolvedValue({
      usage: { input_tokens: 42, output_tokens: 7 },
    });

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: "thread-1",
          usage: { total_tokens: 49 },
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    expect(requestRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("42 / 7 tok");

    await act(async () => root.unmount());
  });

  it("shows inline skeletons while runtime info is pending", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let resolveRequest!: (value: BadgeHoverCardRuntimeInfo | null) => void;
    const requestRuntimeInfo = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<BadgeHoverCardRuntimeInfo | null>((resolve) => {
            resolveRequest = resolve;
          }),
      );

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: "thread-1",
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    // 在途: 空值行显示骨架块而不是 "-" 占位。
    expect(
      host.querySelectorAll(".agent-thread-card__hover-skeleton").length,
    ).toBeGreaterThan(0);
    expect(host.textContent).not.toContain("- / - tok");

    await act(async () => {
      resolveRequest({
        model: "deepseek-chat",
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    });

    // 完成: 骨架撤掉, 数据落到行内。
    expect(
      host.querySelectorAll(".agent-thread-card__hover-skeleton"),
    ).toHaveLength(0);
    expect(host.textContent).toContain("deepseek-chat");
    expect(host.textContent).toContain("5 / 1 tok");

    await act(async () => root.unmount());
  });

  it("never exposes the flowix instance threadId in the popover first row", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const instanceThreadId = "codex-local-agent-inst-6a02d087-3ce6-415a-a668-610f3345bb1e";
    const providerSessionId = "0193f1c4-7c12-7e3a-9b22-c6b2c4b9af83";
    let resolveRequest!: (value: BadgeHoverCardRuntimeInfo | null) => void;
    const requestRuntimeInfo = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<BadgeHoverCardRuntimeInfo | null>((resolve) => {
            resolveRequest = resolve;
          }),
      );

    await act(async () => {
      root.render(
        createElement(BadgeHoverCard, {
          threadId: instanceThreadId,
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    // 首帧: 本地 instance handle 不应出现, 而是显示骨架。
    expect(host.textContent).not.toContain(instanceThreadId);
    expect(host.textContent).not.toContain("codex-local-agent-inst");
    expect(
      host.querySelectorAll(".agent-thread-card__hover-skeleton").length,
    ).toBeGreaterThan(0);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    // request 仍在途: 仍未出现 instance handle, 也未出现 sessionId。
    expect(host.textContent).not.toContain(instanceThreadId);

    await act(async () => {
      resolveRequest({
        sessionId: providerSessionId,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    });

    // 解析后: 第一行展示 provider session id, 仍然不展示 instance handle。
    expect(host.textContent).toContain(providerSessionId);
    expect(host.textContent).not.toContain(instanceThreadId);
    expect(host.textContent).not.toContain("codex-local-agent-inst");
    expect(
      host.querySelectorAll(".agent-thread-card__hover-skeleton"),
    ).toHaveLength(0);

    await act(async () => root.unmount());
  });
});
