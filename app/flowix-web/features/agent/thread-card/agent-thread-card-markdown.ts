import { Marked } from "marked";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import type { AgentThreadCardInputImage } from "@features/agent/thread-card/composer/composer-image-controller";

export const DEFAULT_AGENT_THREAD_CARD_TITLE = "";

export function escapeAgentThreadCardAttr(
  value: string | null | undefined,
): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function unescapeAgentThreadCardAttr(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function parseAgentThreadCardAttrs(
  rawAttrs: string,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="((?:\\"|\\\\|[^"])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(rawAttrs))) {
    attrs[match[1]] = unescapeAgentThreadCardAttr(match[2]);
  }

  return attrs;
}

export function encodeAgentThreadCardInputDraft(
  value: string | null | undefined,
): string {
  return encodeURIComponent(value ?? "");
}

export function decodeAgentThreadCardInputDraft(
  value: string | null | undefined,
): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeAgentThreadCardInputImages(
  images: AgentThreadCardInputImage[] | null | undefined,
): string {
  return encodeURIComponent(JSON.stringify(images ?? []));
}

export function decodeAgentThreadCardInputImages(
  value: string | null | undefined,
): AgentThreadCardInputImage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (image): image is AgentThreadCardInputImage =>
        !!image &&
        typeof image.path === "string" &&
        typeof image.mimeType === "string" &&
        typeof image.name === "string",
    );
  } catch {
    return [];
  }
}

type KatexModule = typeof import("katex");

const AGENT_MATH_SELECTOR = ".agent-thread-card__math[data-latex]";
const BLOCK_MATH_RE =
  /^ {0,3}(?:\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$)/;
const BLOCK_MATH_START_RE = /^ {0,3}(?:\\\[|\$\$)/m;
const INLINE_MATH_RE = /^\\\(([\s\S]*?)\\\)/;
const mathCopyContainers = new WeakSet<HTMLElement>();
let katexPromise: Promise<KatexModule> | null = null;
let katexLoaded: KatexModule | null = null;

function escapeAgentThreadCardHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAgentThreadCardHtmlAttr(value: string): string {
  return escapeAgentThreadCardHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureAgentThreadCardKatex(): Promise<KatexModule> {
  if (katexLoaded) return Promise.resolve(katexLoaded);
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ])
      .then(([module]) => {
        katexLoaded = module;
        return module;
      })
      .catch((error) => {
        katexPromise = null;
        throw error;
      });
  }
  return katexPromise;
}

function renderAgentMathHtml(latex: string, displayMode: boolean): string {
  const normalizedLatex = latex.trim();
  const className = displayMode
    ? "agent-thread-card__math agent-thread-card__math--block"
    : "agent-thread-card__math agent-thread-card__math--inline";
  const attrLatex = escapeAgentThreadCardHtmlAttr(normalizedLatex);
  const escapedLatex = escapeAgentThreadCardHtml(normalizedLatex);
  const content = displayMode
    ? `<span class="agent-thread-card__math-scroller">${escapedLatex}</span>`
    : escapedLatex;

  return `<span class="${className}" data-latex="${attrLatex}" data-display-mode="${displayMode ? "block" : "inline"}" role="button" tabindex="0">${content}</span>`;
}

/**
 * 行为约束：
 * - 数学语法必须由 Marked tokenizer 识别，让 Markdown lexer 统一处理代码、链接和转义边界。
 * - tokenizer 只消费到公式结束符，结束符后的 Markdown 必须继续参与解析。
 * - data-latex 始终保存原始公式；KaTeX 只替换展示内容，复制功能不得依赖渲染后的 DOM。
 */
const cardMarked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
});

cardMarked.use({
  extensions: [
    {
      name: "agentMathBlock",
      level: "block",
      start(src) {
        return BLOCK_MATH_START_RE.exec(src)?.index;
      },
      tokenizer(src) {
        const match = BLOCK_MATH_RE.exec(src);
        if (!match) return;
        return {
          type: "agentMathBlock",
          raw: match[0],
          text: match[1] ?? match[2] ?? "",
        };
      },
      renderer(token) {
        return `${renderAgentMathHtml(token.text, true)}\n`;
      },
    },
    {
      name: "agentMathInline",
      level: "inline",
      start(src) {
        const index = src.indexOf("\\(");
        return index >= 0 ? index : undefined;
      },
      tokenizer(src) {
        const match = INLINE_MATH_RE.exec(src);
        if (!match) return;
        return {
          type: "agentMathInline",
          raw: match[0],
          text: match[1],
        };
      },
      renderer(token) {
        return renderAgentMathHtml(token.text, false);
      },
    },
  ],
});

export function renderAgentThreadCardMarkdownToHtml(content: string): string {
  if (!content || !content.trim()) return "";
  return cardMarked.parse(content) as string;
}

function findAgentMathElement(
  container: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const math = target.closest<HTMLElement>(AGENT_MATH_SELECTOR);
  return math && container.contains(math) ? math : null;
}

async function copyAgentMath(math: HTMLElement): Promise<void> {
  const latex = math.dataset.latex;
  if (!latex || !navigator.clipboard?.writeText) return;

  try {
    await navigator.clipboard.writeText(latex);
    math.classList.add("agent-thread-card__math--copied");
    window.setTimeout(() => {
      math.classList.remove("agent-thread-card__math--copied");
    }, 700);
  } catch {
    // Clipboard access is optional in browser previews and may be denied.
  }
}

export function attachAgentThreadCardMathCopyHandlers(container: HTMLElement): void {
  if (mathCopyContainers.has(container)) return;
  mathCopyContainers.add(container);

  container.addEventListener("click", (event) => {
    const math = findAgentMathElement(container, event.target);
    if (!math) return;
    event.stopPropagation();
    void copyAgentMath(math);
  });

  container.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const math = findAgentMathElement(container, event.target);
    if (!math) return;
    event.preventDefault();
    event.stopPropagation();
    void copyAgentMath(math);
  });
}

async function renderAgentThreadCardMathNodes(
  mathNodes: HTMLElement[],
): Promise<void> {
  if (!mathNodes.length) return;

  let katex: KatexModule;
  try {
    katex = await ensureAgentThreadCardKatex();
  } catch {
    return;
  }

  mathNodes.forEach((math) => {
    const latex = math.dataset.latex;
    if (!latex || math.dataset.katexRendered === "true") return;
    const renderTarget =
      math.querySelector<HTMLElement>(".agent-thread-card__math-scroller") ??
      math;

    try {
      katex.render(latex, renderTarget, {
        displayMode: math.dataset.displayMode === "block",
        throwOnError: false,
        strict: false,
      });
      math.dataset.katexRendered = "true";
    } catch {
      renderTarget.textContent = latex;
    }
  });
}

/**
 * 对 `root`(DocumentFragment 或已挂载容器)内的 math 节点设无障碍标签并触发
 * KaTeX 渲染。KaTeX 跳过 `data-katex-rendered === "true"` 的节点 ── 增量 DOM
 * 注入下 finalized 区的 math 节点持久存在, 每条公式只在定型 append 那帧
 * 渲染一次, 不再每帧重渲染。
 *
 * 事件委托(click / keydown 复制 LaTeX)挂在稳定的 content 容器上, 由
 * [`attachAgentThreadCardMathCopyHandlers`] 一次性绑定; 新注入 fragment 内
 * 的 math 点击靠冒泡到容器, 无需重复绑定。
 */
export function prepareAgentThreadCardMath(
  root: ParentNode,
  mathCopyLabel: string,
): void {
  const mathNodes = Array.from(
    root.querySelectorAll<HTMLElement>(AGENT_MATH_SELECTOR),
  );
  mathNodes.forEach((math) => {
    math.setAttribute("aria-label", mathCopyLabel);
    math.title = mathCopyLabel;
  });
  void renderAgentThreadCardMathNodes(mathNodes);
}

export function fillWithAgentThreadCardMarkdownHtml(
  container: HTMLElement,
  html: string,
  mathCopyLabel = "Copy LaTeX",
): void {
  container.replaceChildren();
  if (!html) return;

  const template = document.createElement("template");
  template.innerHTML = html;
  container.append(template.content.cloneNode(true));
  attachAgentThreadCardMathCopyHandlers(container);
  prepareAgentThreadCardMath(container, mathCopyLabel);
}

export function parseAgentThreadCardMarkdown(token: unknown) {
  const rawAttrs =
    typeof token === "object" &&
    token !== null &&
    "attrs" in token &&
    typeof token.attrs === "string"
      ? token.attrs
      : "";
  const attrs = parseAgentThreadCardAttrs(
    rawAttrs,
  );
  return {
    type: "agentThreadCard",
    attrs: {
      threadId: attrs.threadId || null,
      instanceId: attrs.instanceId || null,
      title: attrs.title || DEFAULT_AGENT_THREAD_CARD_TITLE,
      typeKey: normalizeAgentTypeKey(attrs.agentType as string | undefined),
      agentRoleMemoId: attrs.agentRoleMemoId || null,
      agentRoleName: attrs.agentRoleName || null,
      collapsed: attrs.collapsed === "true",
      fullscreen: attrs.fullscreen === "true",
      inputDraft: attrs.inputDraft
        ? decodeAgentThreadCardInputDraft(attrs.inputDraft)
        : null,
      inputImages: decodeAgentThreadCardInputImages(attrs.inputImages),
    },
  };
}

export function renderAgentThreadCardMarkdown(node: {
  attrs?: Record<string, unknown>;
}): string {
  const threadId = escapeAgentThreadCardAttr(node.attrs?.threadId as string);
  const instanceId = escapeAgentThreadCardAttr(node.attrs?.instanceId as string);
  const title = escapeAgentThreadCardAttr(node.attrs?.title as string);
  const typeKey = normalizeAgentTypeKey(
    node.attrs?.typeKey as string | undefined,
  );
  const agentRoleMemoId = escapeAgentThreadCardAttr(
    node.attrs?.agentRoleMemoId as string,
  );
  const agentRoleName = escapeAgentThreadCardAttr(
    node.attrs?.agentRoleName as string,
  );
  const collapsed = !!node.attrs?.collapsed;
  const fullscreen = !!node.attrs?.fullscreen;
  const inputDraft = escapeAgentThreadCardAttr(
    encodeAgentThreadCardInputDraft(node.attrs?.inputDraft as string),
  );
  const inputImages = escapeAgentThreadCardAttr(
    encodeAgentThreadCardInputImages(node.attrs?.inputImages as AgentThreadCardInputImage[]),
  );
  return `::agent-thread-card{instanceId="${instanceId}" threadId="${threadId}" title="${title}" agentType="${typeKey}" agentRoleMemoId="${agentRoleMemoId}" agentRoleName="${agentRoleName}" collapsed="${collapsed}" fullscreen="${fullscreen}" inputDraft="${inputDraft}" inputImages="${inputImages}"}\n`;
}
