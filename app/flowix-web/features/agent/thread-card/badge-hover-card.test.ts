import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadgeHoverCard } from "./badge-hover-card";

vi.mock("@shared/ui/hover-card", () => ({
  HoverCard: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  HoverCardTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  HoverCardContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    language: "en-US",
    t: (key: string) =>
      key === "editor.threadCard.cwd" ? "CWD" : key,
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
          cwd: "D:\\projects\\flowix",
        }),
      );
    });

    expect(host.textContent).toContain("CWD");
    expect(host.textContent).toContain("D:\\projects\\flowix");

    await act(async () => {
      root.render(createElement(BadgeHoverCard, { sessionId: "session-1" }));
    });

    expect(host.textContent).not.toContain("CWD");
    expect(host.textContent).not.toContain("D:\\projects\\flowix");

    await act(async () => root.unmount());
  });
});
