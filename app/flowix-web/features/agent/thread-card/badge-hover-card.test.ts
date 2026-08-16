import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgeHoverCard } from "./badge-hover-card";

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
  HoverCardTrigger: ({
    children,
    onPointerEnter,
  }: {
    children: ReactNode;
    onPointerEnter?: () => void;
  }) => createElement("div", { onPointerEnter }, children),
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
          sessionId: "session-1",
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
    expect(host.textContent).toContain("100 tok");
    expect(host.textContent).toContain("In/Out100 tok / 3 tok");
    expect(host.textContent).toContain("17%");
    expect(host.textContent).toContain("3");
    expect(host.textContent).toContain("Context");
    expect(host.textContent).toContain("30%");
    expect(host.querySelector(".agent-thread-card__cache-hit-ring")).toBeNull();
    expect(host.querySelector(".agent-thread-card__context-ring")).not.toBeNull();

    await act(async () => {
      root.render(createElement(BadgeHoverCard, { sessionId: "session-1" }));
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
          sessionId: "session-1",
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
          sessionId: "session-1",
          usage: {},
          onRequestRuntimeInfo: requestRuntimeInfo,
        }),
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-open="true"]')?.click();
    });

    expect(requestRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("12 tok / -");

    await act(async () => root.unmount());
  });
});
