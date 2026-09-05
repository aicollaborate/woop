import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";

export interface ComposerSlashTokenOptions {
  onRemove?: () => void;
}

const SLASH_TOKEN_RE = /^\[\/([a-z0-9_-]+)\]\(flowix:\/\/slash\/([a-z0-9_-]+)\)/i;

export const ComposerSlashToken = Node.create<ComposerSlashTokenOptions>({
  name: "composerSlashToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() { return { onRemove: undefined }; },
  addAttributes() { return { command: { default: "" } }; },

  parseHTML() {
    return [{ tag: "span[data-composer-slash]", getAttrs: (dom) => ({
      command: (dom as HTMLElement).getAttribute("data-composer-slash") ?? "",
    }) }];
  },

  renderHTML({ node }) {
    const command = String(node.attrs?.command ?? "");
    return ["span", {
      "data-composer-slash": command,
      class: "agent-thread-card__slash-token",
    }, `/${command}`];
  },

  markdownTokenizer: {
    name: "composerSlashToken",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf("flowix://slash/");
      return index >= 0 ? index : -1;
    },
    tokenize(src: string) {
      const match = SLASH_TOKEN_RE.exec(src);
      return match ? {
        type: "composerSlashToken",
        raw: match[0],
        href: `flowix://slash/${match[2]}`,
        text: `/${match[1]}`,
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const command = href.replace(/^flowix:\/\/slash\//i, "") ||
      String(token.text ?? "").replace(/^\//, "");
    return { type: "composerSlashToken", attrs: { command } };
  },

  renderMarkdown(node: JSONContent) {
    const command = String(node.attrs?.command ?? "");
    return `[/${command}](flowix://slash/${command})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      const button = document.createElement("button");
      const command = String(node.attrs.command ?? "");
      button.type = "button";
      button.className = "agent-thread-card__slash-token";
      button.textContent = `/${command}`;
      button.title = "点击移除命令";
      button.setAttribute("aria-label", `移除 /${command} 命令`);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        view.focus();
      });
      return { dom: button };
    };
  },
});

export function getComposerSlashToken(editor: Editor): string | null {
  let command: string | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composerSlashToken" && command === null) {
      command = String(node.attrs.command ?? "");
      return false;
    }
    return command === null;
  });
  return command || null;
}

export function insertComposerSlashToken(editor: Editor, command: string): void {
  const { selection } = editor.state;
  editor.chain().focus().deleteRange({ from: 1, to: selection.to })
    .insertContent({ type: "composerSlashToken", attrs: { command } }).run();
}

export function removeComposerSlashToken(editor: Editor): void {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === "composerSlashToken") {
      found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return found === null;
  });
  if (!found) return;
  const range = found as { from: number; to: number };
  editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
}
