import { Node, mergeAttributes, type MarkdownToken } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';

const CUSTOM_BLOCK_RE = /^::([a-z][a-z0-9-]*)(\{[^\n]*\})?[ \t]*(?:\r?\n|$)/i;
const ATTR_RE = /([A-Za-z][\w]*)="((?:\\"|\\\\|[^"])*)"/g;

export interface StaticCustomBlockToken {
  type: 'staticCustomBlock';
  raw: string;
  kind: string;
  attrsSource: string;
}

export function tokenizeStaticCustomBlock(source: string): StaticCustomBlockToken | undefined {
  const match = CUSTOM_BLOCK_RE.exec(source);
  if (!match) return undefined;
  return {
    type: 'staticCustomBlock',
    raw: match[0],
    kind: match[1],
    attrsSource: match[2]?.slice(1, -1) ?? '',
  };
}

export function parseStaticCustomBlockAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(source))) {
    attrs[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return attrs;
}

export function protectedStaticBlockSequence(doc: ProseMirrorNode): string[] {
  const sequence: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'staticCustomBlock') {
      sequence.push(String(node.attrs.rawMarkdown ?? ''));
    }
  });
  return sequence;
}

function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderStaticCard(dom: HTMLElement, kind: string, attrsSource: string) {
  const attrs = parseStaticCustomBlockAttrs(attrsSource);
  dom.replaceChildren();
  dom.dataset.staticCustomBlock = kind;

  const eyebrow = document.createElement('span');
  eyebrow.className = 'mobile-static-block__eyebrow';
  eyebrow.textContent = kind === 'agent-thread-card' ? 'Agent Thread' : 'Flowix Block';

  const title = document.createElement('strong');
  title.className = 'mobile-static-block__title';
  title.textContent = attrs.title || attrs.agentRoleName || kind;

  const meta = document.createElement('span');
  meta.className = 'mobile-static-block__meta';
  meta.textContent = kind === 'agent-thread-card'
    ? [attrs.agentType, attrs.agentRoleName].filter(Boolean).join(' · ') || '只读内容'
    : '此内容仅可在桌面端编辑';

  dom.append(eyebrow, title, meta);
}

export const StaticCustomBlock = Node.create({
  name: 'staticCustomBlock',
  group: 'block',
  atom: true,
  isolating: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      kind: { default: 'custom-block' },
      attrsSource: { default: '' },
      rawMarkdown: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'section[data-static-custom-block]' }];
  },

  renderHTML({ node }) {
    return [
      'section',
      mergeAttributes({
        'data-static-custom-block': node.attrs.kind,
        class: 'mobile-static-block',
        contenteditable: 'false',
      }),
      ['strong', {}, node.attrs.kind],
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('section');
      dom.className = 'mobile-static-block';
      dom.contentEditable = 'false';
      renderStaticCard(dom, String(node.attrs.kind), String(node.attrs.attrsSource));
      return {
        dom,
        update(nextNode) {
          if (nextNode.type.name !== 'staticCustomBlock') return false;
          renderStaticCard(
            dom,
            String(nextNode.attrs.kind),
            String(nextNode.attrs.attrsSource),
          );
          return true;
        },
        stopEvent: () => true,
        ignoreMutation: () => true,
      };
    };
  },

  markdownTokenizer: {
    name: 'staticCustomBlock',
    level: 'block' as const,
    start(source: string) {
      return source.search(/^::[a-z][a-z0-9-]*(?:\{|\s|$)/im);
    },
    tokenize(source: string) {
      return tokenizeStaticCustomBlock(source);
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const staticToken = token as MarkdownToken & Partial<StaticCustomBlockToken>;
    return {
      type: 'staticCustomBlock',
      attrs: {
        kind: staticToken.kind || 'custom-block',
        attrsSource: staticToken.attrsSource || '',
        rawMarkdown: staticToken.raw || '',
      },
    };
  },

  renderMarkdown(node) {
    return String(node.attrs?.rawMarkdown ?? '');
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged) return true;
          if (transaction.getMeta('flowixAllowStaticBlockMutation')) return true;
          return sameSequence(
            protectedStaticBlockSequence(state.doc),
            protectedStaticBlockSequence(transaction.doc),
          );
        },
      }),
    ];
  },
});
