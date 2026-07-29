import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fillWithAgentThreadCardMarkdownHtml,
  renderAgentThreadCardMarkdownToHtml,
} from "@features/agent/thread-card/agent-thread-card-markdown";

function countMathNodes(html: string): number {
  return html.match(/data-latex=/g)?.length ?? 0;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("agent thread card Markdown math", () => {
  it("recognizes Codex inline LaTeX delimiters", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "Assume \\(q,k\\in\\mathbb R^d\\).",
    );

    expect(html).toContain("agent-thread-card__math--inline");
    expect(html).toContain('data-latex="q,k\\in\\mathbb R^d"');
  });

  it("wraps display math in a horizontal scroller", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "\\[S_tq_t\\in\\mathbb R^d\\] after",
    );

    expect(html).toContain("agent-thread-card__math--block");
    expect(html).toContain("agent-thread-card__math-scroller");
    expect(html).toContain('data-latex="S_tq_t\\in\\mathbb R^d"');
    expect(html).toContain("after");
  });

  it("recognizes double-dollar display math", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "$$\n\\sum_{k=1}^{n} k\n$$\nafter",
    );

    expect(countMathNodes(html)).toBe(1);
    expect(html).toContain("agent-thread-card__math--block");
    expect(html).toContain('data-latex="\\sum_{k=1}^{n} k"');
    expect(html).toContain("after");
  });

  it("waits for the closing delimiter before rendering streaming math", () => {
    expect(
      countMathNodes(renderAgentThreadCardMarkdownToHtml("before \\[x^2")),
    ).toBe(0);
    expect(
      countMathNodes(renderAgentThreadCardMarkdownToHtml("before\n\\[x^2\\]")),
    ).toBe(1);
  });

  it("leaves fenced and multiline inline code untouched", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "```md\n~~~\n\\(x\\)\n```\n\n`alpha\n\\(y\\)\nomega`",
    );

    expect(countMathNodes(html)).toBe(0);
  });

  it("does not replace ordinary text or parse link destinations", () => {
    const html = renderAgentThreadCardMarkdownToHtml(
      "FLOWIX_MATH_INLINE_0 [docs](https://example.com/\\(x\\)) and \\(y\\)",
    );

    expect(countMathNodes(html)).toBe(1);
    expect(html).toContain("FLOWIX_MATH_INLINE_0");
    expect(html).toContain("<a href=");
    expect(html).toContain('data-latex="y"');
  });

  it("renders KaTeX and copies the original LaTeX", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement("div");
    document.body.append(container);

    fillWithAgentThreadCardMarkdownHtml(
      container,
      renderAgentThreadCardMarkdownToHtml("\\[x^2\\]"),
      "复制 LaTeX",
    );

    await vi.waitFor(() => {
      expect(container.querySelector(".katex")).not.toBeNull();
    });

    const math = container.querySelector<HTMLElement>(
      ".agent-thread-card__math",
    );
    expect(
      math?.querySelector(".agent-thread-card__math-scroller .katex-display"),
    ).not.toBeNull();
    expect(
      math?.querySelector('.vlist > span[style*="top"]'),
    ).not.toBeNull();
    expect(math?.hasAttribute("data-math-probe")).toBe(false);
    expect(math?.hasAttribute("data-math-debug")).toBe(false);
    expect(math?.getAttribute("aria-label")).toBe("复制 LaTeX");
    expect(math?.title).toBe("复制 LaTeX");

    math?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("x^2");
    });
    expect(math?.classList.contains("agent-thread-card__math--copied")).toBe(
      true,
    );

    writeText.mockClear();
    math?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("x^2");
    });

    writeText.mockClear();
    math?.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("x^2");
    });
  });
});
