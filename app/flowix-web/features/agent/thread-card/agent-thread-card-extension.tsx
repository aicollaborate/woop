import { Node, mergeAttributes, type MarkdownToken } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AgentTypeKey } from "@/types/agent";
import {
  DEFAULT_AGENT_TYPE_KEY,
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  DEFAULT_AGENT_THREAD_CARD_TITLE as DEFAULT_TITLE,
  parseAgentThreadCardMarkdown,
  renderAgentThreadCardMarkdown,
  encodeAgentThreadCardInputImages,
  decodeAgentThreadCardInputImages,
} from "@features/agent/thread-card/agent-thread-card-markdown";
import { focusAgentThreadCardInput } from "@features/agent/thread-card/agent-thread-card-dom";
import { AgentThreadCardView } from "@features/agent/thread-card/agent-thread-card-view";
import {
  restoreRemovedAgentThreadCardInstance,
  terminateAgentThreadCardRuntime,
} from "@features/agent/thread-card/agent-thread-card-cleanup";
import { getCurrentThreadCardSource } from "@features/agent/thread-card/runtime/thread-card-source";

export const SKIP_AGENT_THREAD_CARD_CLEANUP_META =
  "flowixSkipAgentThreadCardCleanup";

function collectAgentThreadCards(
  doc: ProseMirrorNode,
): Record<string, unknown>[] {
  const cards: Record<string, unknown>[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "agentThreadCard") return;
    cards.push(node.attrs as Record<string, unknown>);
  });
  return cards;
}

function isSameAgentThreadCard(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const beforeInstanceId =
    typeof before.instanceId === "string" ? before.instanceId : "";
  const afterInstanceId =
    typeof after.instanceId === "string" ? after.instanceId : "";
  if (beforeInstanceId && beforeInstanceId === afterInstanceId) return true;
  const beforeThreadId =
    typeof before.threadId === "string" ? before.threadId : "";
  const afterThreadId =
    typeof after.threadId === "string" ? after.threadId : "";
  return !!beforeThreadId && beforeThreadId === afterThreadId;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    agentThreadCard: {
      insertAgentThreadCard: (options?: {
        typeKey?: AgentTypeKey;
        replaceRange?: { from: number; to: number };
        initialPrompt?: string;
        autoSubmit?: boolean;
      }) => ReturnType;
    };
  }
}

export const AgentThreadCard = Node.create({
  name: "agentThreadCard",
  group: "block",
  content: "",
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      threadId: { default: null },
      instanceId: { default: null },
      title: { default: DEFAULT_TITLE },
      typeKey: { default: DEFAULT_AGENT_TYPE_KEY },
      agentRoleMemoId: { default: null },
      agentRoleName: { default: null },
      collapsed: { default: false },
      fullscreen: { default: false },
      initialPrompt: { default: null },
      autoSubmit: { default: false },
      inputDraft: { default: null },
      inputImages: { default: [] },
    };
  },

  parseHTML() {
    return [
      {
        tag: "section[data-agent-thread-card]",
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          return {
            threadId: element.getAttribute("data-thread-id") || null,
            instanceId: element.getAttribute("data-instance-id") || null,
            title: element.getAttribute("data-title") || DEFAULT_TITLE,
            typeKey: normalizeAgentTypeKey(
              element.getAttribute("data-agent-type"),
            ),
            agentRoleMemoId:
              element.getAttribute("data-agent-role-memo-id") || null,
            agentRoleName: element.getAttribute("data-agent-role-name") || null,
            collapsed: element.getAttribute("data-collapsed") === "true",
            fullscreen: element.getAttribute("data-fullscreen") === "true",
            inputDraft: element.getAttribute("data-input-draft") || null,
            inputImages: decodeAgentThreadCardInputImages(
              element.getAttribute("data-input-images"),
            ),
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const threadId = node.attrs.threadId || "";
    const instanceId = node.attrs.instanceId || "";
    const title = node.attrs.title || DEFAULT_TITLE;
    const typeKey = normalizeAgentTypeKey(node.attrs.typeKey as string | null);
    const type = getAgentType(typeKey);
    const agentRoleMemoId = node.attrs.agentRoleMemoId || "";
    const agentRoleName = node.attrs.agentRoleName || "";
    const collapsed = !!node.attrs.collapsed;
    const fullscreen = !!node.attrs.fullscreen;
    const inputDraft = node.attrs.inputDraft || "";
    const inputImages = encodeAgentThreadCardInputImages(node.attrs.inputImages);

    return [
      "section",
      mergeAttributes({
        "data-agent-thread-card": "true",
        "data-thread-id": threadId,
        "data-instance-id": instanceId,
        "data-agent-type": typeKey,
        "data-agent-role-memo-id": agentRoleMemoId,
        "data-agent-role-name": agentRoleName,
        "data-collapsed": collapsed ? "true" : "false",
        "data-fullscreen": fullscreen ? "true" : "false",
        "data-input-draft": inputDraft,
        "data-input-images": inputImages,
        class: collapsed
          ? "agent-thread-card agent-thread-card--collapsed"
          : "agent-thread-card",
        contenteditable: "false",
      }),
      [
        "div",
        { class: "agent-thread-card__container" },
        [
          "div",
          { class: "agent-thread-card__title" },
          title ? `${type.name} · ${title}` : type.name,
        ],
        [
          "div",
          { class: "agent-thread-card__empty" },
          "Use current note to start an AI conversation",
        ],
        [
          "div",
          { class: "agent-thread-card__composer" },
          [
            "textarea",
            { placeholder: "Ask AI to handle this task", rows: "1" },
            inputDraft,
          ],
          [
            "button",
            {
              class: "agent-thread-card__send",
              type: "button",
              "aria-label": "Send",
            },
          ],
        ],
      ],
    ];
  },

  addCommands() {
    return {
      insertAgentThreadCard:
        (options) =>
        ({ state, dispatch, tr }) => {
          const nodeType = state.schema.nodes[this.name];
          if (!nodeType) return false;
          const typeKey = normalizeAgentTypeKey(
            options?.typeKey ??
              useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
          );
          if (!dispatch) return true;
          const instance = useAgentSessionStore.getState().createInstance({
            agentType: typeKey,
            title: DEFAULT_TITLE,
            threadId: null,
            source: getCurrentThreadCardSource(),
            role: undefined,
            // 插入时只记录 runtime 默认和 notebookId；cwd / paths 在首次
            // send 前解析并冻结，避开插入阶段 store 尚未 hydrate 的 race。
            runtimeConfig: buildInitialInstanceRuntimeConfig(typeKey),
          });
          const node = nodeType.create({
            threadId: null,
            instanceId: instance.instanceId,
            title: DEFAULT_TITLE,
            typeKey,
            agentRoleMemoId: null,
            agentRoleName: null,
            collapsed: false,
            fullscreen: false,
            initialPrompt: options?.initialPrompt ?? null,
            autoSubmit: !!options?.autoSubmit,
            inputDraft: null,
            inputImages: [],
          });
          const from = options?.replaceRange?.from ?? state.selection.from;
          const to = options?.replaceRange?.to ?? from;
          tr.replaceWith(from, to, node);
          const after = from + node.nodeSize;
          const paragraphType = state.schema.nodes.paragraph;

          if (paragraphType) {
            tr.insert(after, paragraphType.create());
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
          }
          dispatch(tr);
          focusAgentThreadCardInput(this.editor.view, from);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }
          if (
            transactions.some((transaction) =>
              transaction.getMeta(SKIP_AGENT_THREAD_CARD_CLEANUP_META),
            )
          ) {
            return null;
          }
          const before = collectAgentThreadCards(oldState.doc);
          const after = collectAgentThreadCards(newState.doc);
          for (const attrs of before) {
            if (!after.some((candidate) => isSameAgentThreadCard(attrs, candidate))) {
              terminateAgentThreadCardRuntime(attrs);
            }
          }
          for (const attrs of after) {
            if (!before.some((candidate) => isSameAgentThreadCard(candidate, attrs))) {
              restoreRemovedAgentThreadCardInstance(attrs);
            }
          }
          return null;
        },
      }),
    ];
  },

  addNodeView() {
    return (props) =>
      new AgentThreadCardView(
        props.node,
        props.view,
        typeof props.getPos === "function" ? props.getPos : undefined,
      );
  },

  markdownTokenizer: {
    name: "agentThreadCard",
    level: "block" as const,
    start(src: string) {
      return src.indexOf("::agent-thread-card");
    },
    tokenize(src: string) {
      const match = /^::agent-thread-card\{([^}]*)\}[ \t]*(?:\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: "agentThreadCard", raw: match[0], attrs: match[1] };
    },
  },

  parseMarkdown(token: MarkdownToken) {
    return parseAgentThreadCardMarkdown(token);
  },

  renderMarkdown(node) {
    return renderAgentThreadCardMarkdown(node);
  },
});
