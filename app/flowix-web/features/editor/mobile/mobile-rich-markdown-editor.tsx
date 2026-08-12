import { Editor, Extension, renderNestedMarkdownContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { ListItem } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import {
  Bold, Braces, Heading1, Heading2, Italic, KeyboardOff, List, ListOrdered, ListTodo, Paperclip, Quote,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { AttachmentLink } from '@features/editor/extensions/attachment-link';
import { buildUploadContent } from '@features/editor/extensions/attachment-link/upload/build-content';
import { insertUploadContent } from '@features/editor/extensions/attachment-link/upload/build-content';
import { createAttachmentUpload } from '@features/editor/extensions/attachment-link/upload/storage';
import { CodeBlockShiki } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki';
import { DateTimeWidget } from '@features/editor/extensions/datetime-widget';
import Frontmatter from '@features/editor/extensions/frontmatter';
import MarkdownPaste from '@features/editor/extensions/markdown-paste';
import ManagedPasteRules from '@features/editor/extensions/paste-rules';
import { MathBlock } from '@features/editor/extensions/math-block';
import { MarkdownLink, LinkSelectionHighlight } from '@features/editor/extensions/markdown-link';
import { NoteMention } from '@features/editor/extensions/note-mention';
import { NoteReference } from '@features/editor/extensions/note-link';
import { TablePlugin } from '@features/editor/extensions/table/table-plugin';
import { Tag } from '@features/editor/extensions/tag';
import { WebCard } from '@features/editor/extensions/web-card';
import {
  MOBILE_EDITOR_VIEWPORT_CHANGE_EVENT,
  scrollMobileEditorSelectionIntoView,
} from './mobile-editor-viewport';
import { StaticCustomBlock } from './static-custom-block';

interface MobileRichMarkdownEditorProps {
  memoId: string;
  content: string;
  onChange: (markdown: string) => void;
  uploadAttachment?: (params: { file: File; fileName: string }) => Promise<string | null>;
  onEditorReady?: (editor: Editor) => void;
  externalContent?: { value: string; emitUpdate: boolean; token: number };
  /** The native iOS shell draws the keyboard toolbar outside this WebView. */
  showToolbar?: boolean;
  /** Let WKWebView own caret scrolling when its toolbar is native. */
  nativeKeyboardToolbar?: boolean;
  nativeToolbarAction?: { action: MobileEditorToolbarAction; token: number };
}

export type MobileEditorToolbarAction =
  | 'bold' | 'italic' | 'heading1' | 'heading2' | 'bulletList'
  | 'orderedList' | 'taskList' | 'blockquote' | 'codeBlock'
  | 'attachment' | 'dismiss';

interface ToolbarAction {
  id: MobileEditorToolbarAction;
  icon: LucideIcon;
  title: string;
  run: (editor: Editor) => void;
  active?: (editor: Editor) => boolean;
}

const MOBILE_ATTACHMENT_MAX_BATCH_BYTES = 100 * 1024 * 1024;

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { id: 'bold', icon: Bold, title: '粗体', run: (editor) => { editor.chain().focus().toggleBold().run(); }, active: (editor) => editor.isActive('bold') },
  { id: 'italic', icon: Italic, title: '斜体', run: (editor) => { editor.chain().focus().toggleItalic().run(); }, active: (editor) => editor.isActive('italic') },
  { id: 'heading1', icon: Heading1, title: '一级标题', run: (editor) => { editor.chain().focus().toggleHeading({ level: 1 }).run(); }, active: (editor) => editor.isActive('heading', { level: 1 }) },
  { id: 'heading2', icon: Heading2, title: '二级标题', run: (editor) => { editor.chain().focus().toggleHeading({ level: 2 }).run(); }, active: (editor) => editor.isActive('heading', { level: 2 }) },
  { id: 'bulletList', icon: List, title: '无序列表', run: (editor) => { editor.chain().focus().toggleBulletList().run(); }, active: (editor) => editor.isActive('bulletList') },
  { id: 'orderedList', icon: ListOrdered, title: '有序列表', run: (editor) => { editor.chain().focus().toggleOrderedList().run(); }, active: (editor) => editor.isActive('orderedList') },
  { id: 'taskList', icon: ListTodo, title: '任务列表', run: (editor) => { editor.chain().focus().toggleTaskList().run(); }, active: (editor) => editor.isActive('taskList') },
  { id: 'blockquote', icon: Quote, title: '引用', run: (editor) => { editor.chain().focus().toggleBlockquote().run(); }, active: (editor) => editor.isActive('blockquote') },
  { id: 'codeBlock', icon: Braces, title: '代码块', run: (editor) => { editor.chain().focus().toggleCodeBlock().run(); }, active: (editor) => editor.isActive('codeBlock') },
];

type MarkdownContext = { parentType?: string | null; index?: number; meta?: { parentAttrs?: { start?: number } } };
type MarkdownNodeLike = { type?: string; text?: string; content?: unknown };
const EMPTY_MARKDOWN = '&nbsp;';
const EMPTY_RE = /&(?:amp;)?nbsp;/gi;
const LIST_PARENTS = new Set(['listItem', 'taskItem']);
const CELL_PARENTS = new Set(['tableCell', 'tableHeader']);

function isEmpty(value: string): boolean { return value.replace(/\u00a0/g, '').replace(EMPTY_RE, '').trim() === ''; }
function emptyTextNode(node: unknown): boolean {
  const item = node as MarkdownNodeLike;
  return item?.type === 'text' && typeof item.text === 'string' && isEmpty(item.text);
}
function emptyParagraph(node: unknown): boolean {
  const item = node as MarkdownNodeLike;
  return item?.type === 'paragraph' && (!Array.isArray(item.content) || item.content.length === 0 || item.content.every(emptyTextNode));
}
function shouldDrop(ctx: MarkdownContext): boolean {
  return CELL_PARENTS.has(ctx.parentType || '') || (LIST_PARENTS.has(ctx.parentType || '') && ctx.index === 0);
}

const PreservedParagraph = Paragraph.extend({
  renderMarkdown(node, h, ctx: MarkdownContext) {
    const content = Array.isArray(node.content) ? node.content : [];
    return content.length === 0 || (shouldDrop(ctx) && content.every(emptyTextNode))
      ? (shouldDrop(ctx) ? '' : EMPTY_MARKDOWN)
      : h.renderChildren(content);
  },
});

const PreservedListItem = ListItem.extend({
  renderMarkdown(node, h, ctx: MarkdownContext) {
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 1 && emptyParagraph(content[0])) {
      if (ctx?.parentType === 'orderedList') return `${ctx.meta?.parentAttrs?.start || 1 + (ctx.index || 0)}. ${EMPTY_MARKDOWN}`;
      return '-';
    }
    return renderNestedMarkdownContent(node, h, (nested: MarkdownContext) => {
      if (nested.parentType === 'bulletList') return '- ';
      if (nested.parentType === 'orderedList') return `${(nested.meta?.parentAttrs?.start || 1) + (nested.index || 0)}. `;
      return '- ';
    }, ctx);
  },
});

const PreservedTaskItem = TaskItem.extend({
  renderMarkdown(node, h) {
    const checked = node.attrs?.checked ? 'x' : ' ';
    const content = Array.isArray(node.content) ? node.content : [];
    if (!emptyParagraph(content[0])) return renderNestedMarkdownContent(node, h, `- [${checked}] `);
    return `- [${checked}] ${EMPTY_MARKDOWN}`;
  },
});

const MarkdownEscape = Extension.create({
  name: 'mobileMarkdownEscape',
  markdownTokenName: 'escape',
  parseMarkdown(token, h) { return h.createTextNode(token.raw || token.text || ''); },
});

function normalizeTables(markdown: string): string {
  return markdown.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return line;
    const cells = trimmed.slice(1, -1).split('|');
    if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) return line;
    return `|${cells.map((cell) => isEmpty(cell) ? '' : cell).join('|')}|`;
  }).join('\n');
}

function normalizeTaskPlaceholders(editor: Editor) {
  let transaction = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem' || node.firstChild?.type.name !== 'paragraph') return false;
    const paragraph = node.firstChild;
    if (!isEmpty(paragraph.textContent)) return false;
    const from = pos + 2;
    const to = pos + paragraph.nodeSize;
    if (from < to) transaction = transaction.delete(from, to);
    return false;
  });
  if (transaction.docChanged) editor.view.dispatch(transaction);
}

export function createMobileRichExtensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, dropcursor: false, gapcursor: false, link: false, codeBlock: false, paragraph: false, listItem: false }),
    PreservedParagraph, PreservedListItem, MarkdownEscape,
    AttachmentLink, MarkdownLink, LinkSelectionHighlight, CodeBlockShiki, MathBlock, WebCard,
    TextStyle, Color, Highlight.configure({ multicolor: true }), TablePlugin,
    TaskList, PreservedTaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    Placeholder.configure({ placeholder: '记录想法...', showOnlyCurrent: true }),
    Tag, ManagedPasteRules, MarkdownPaste, DateTimeWidget, Frontmatter,
    NoteReference, NoteMention, StaticCustomBlock,
  ];
}

export function MobileRichMarkdownEditor({
  content, onChange, uploadAttachment, onEditorReady, externalContent,
  showToolbar: renderToolbar = true, nativeKeyboardToolbar = false, nativeToolbarAction,
}: MobileRichMarkdownEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [, setToolbarVersion] = useState(0);
  const handledNativeToolbarToken = useRef(0);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!mountRef.current) return;
    const instance = new Editor({
      element: mountRef.current,
      extensions: createMobileRichExtensions(),
      content: normalizeTables(content),
      contentType: 'markdown',
      autofocus: false,
      editorProps: nativeKeyboardToolbar
        // The native toolbar is outside the DOM and WKWebView already knows
        // the keyboard's exact frame. Let it perform the sole caret-scroll;
        // the Web toolbar path below remains necessary for Tauri mobile.
        ? {}
        : {
            // ProseMirror normally only keeps the caret inside the visual viewport.
            // The formatting toolbar overlays the bottom of that viewport, so leave
            // one toolbar-height of breathing room when Enter moves the caret down.
            scrollThreshold: { top: 16, right: 0, bottom: 78, left: 0 },
            scrollMargin: { top: 16, right: 0, bottom: 78, left: 0 },
            handleScrollToSelection: scrollMobileEditorSelectionIntoView,
          },
      onUpdate: ({ editor: current }) => { onChangeRef.current(normalizeTables(current.getMarkdown())); setToolbarVersion((v) => v + 1); },
      onSelectionUpdate: () => setToolbarVersion((v) => v + 1),
    });
    normalizeTaskPlaceholders(instance);
    editorRef.current = instance;
    setEditor(instance);
    onEditorReady?.(instance);
    const editorDom = instance.view.dom;
    const handleFocusIn = () => setEditorFocused(true);
    const handleFocusOut = () => {
      window.setTimeout(() => {
        if (!editorDom.contains(document.activeElement)) setEditorFocused(false);
      }, 0);
    };
    editorDom.addEventListener('focusin', handleFocusIn);
    editorDom.addEventListener('focusout', handleFocusOut);
    let viewportFrame = 0;
    const handleViewportChange = () => {
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
      viewportFrame = window.requestAnimationFrame(() => {
        viewportFrame = 0;
        if (instance.isFocused) scrollMobileEditorSelectionIntoView(instance.view);
      });
    };
    if (!nativeKeyboardToolbar) {
      window.addEventListener(MOBILE_EDITOR_VIEWPORT_CHANGE_EVENT, handleViewportChange);
    }
    return () => {
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
      if (!nativeKeyboardToolbar) {
        window.removeEventListener(MOBILE_EDITOR_VIEWPORT_CHANGE_EVENT, handleViewportChange);
      }
      editorDom.removeEventListener('focusin', handleFocusIn);
      editorDom.removeEventListener('focusout', handleFocusOut);
      instance.destroy();
      editorRef.current = null;
      setEditor(null);
    };
  }, []);

  useEffect(() => {
    if (!editor || !externalContent) return;
    editor.commands.setContent(externalContent.value, {
      contentType: 'markdown',
      emitUpdate: externalContent.emitUpdate,
    });
  }, [editor, externalContent]);

  // iOS/WKWebView may briefly report a zero keyboard height while it scrolls
  // the visual viewport to follow a caret created by Enter. Focus remains the
  // stable signal that the user is editing, so it alone controls visibility.
  const toolbarVisible = editorFocused;

  const dismissKeyboard = () => {
    if (!editor) return;
    editor.commands.blur();
    setEditorFocused(false);
  };

  const addAttachment = () => {
    if (!editor) return;
    if (!uploadAttachment) {
      console.warn('[MobileAttachment] 当前客户端尚未提供附件上传能力');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,*/*';
    input.onchange = () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (files.length === 0) return;
      const batchBytes = files.reduce((total, file) => total + file.size, 0);
      if (batchBytes > MOBILE_ATTACHMENT_MAX_BATCH_BYTES) {
        console.error('[MobileAttachment] Attachment batch exceeds the 100 MB limit');
        return;
      }
      void (async () => {
        const result = await createAttachmentUpload(files, undefined, uploadAttachment);
        const assets = result.assets.filter((asset) => asset.storageKey);
        result.assets.forEach((asset) => {
          if (asset.revokeObjectURL) URL.revokeObjectURL(asset.url);
        });
        if (assets.length === 0) return;
        editor.commands.focus();
        insertUploadContent(editor.view, buildUploadContent(assets));
      })().catch((error) => console.error('[MobileAttachment] Failed to add attachment:', error));
    };
    document.body.appendChild(input);
    input.click();
  };

  useEffect(() => {
    if (!editor || !nativeToolbarAction || nativeToolbarAction.token === handledNativeToolbarToken.current) return;
    handledNativeToolbarToken.current = nativeToolbarAction.token;
    if (nativeToolbarAction.action === 'dismiss') {
      dismissKeyboard();
      return;
    }
    if (nativeToolbarAction.action === 'attachment') {
      addAttachment();
      return;
    }
    TOOLBAR_ACTIONS.find((action) => action.id === nativeToolbarAction.action)?.run(editor);
  }, [editor, nativeToolbarAction]);

  const toolbar = (
    <div className={`mobile-editor-toolbar${toolbarVisible ? ' is-visible' : ''}`} role="toolbar" aria-label="Markdown 格式" aria-hidden={!toolbarVisible}>
      <div className="mobile-editor-toolbar__scroll">
        {TOOLBAR_ACTIONS.map((action, index) => {
          const Icon = action.icon;
          return <button key={action.title} type="button" title={action.title} aria-label={action.title}
            className={`${editor && action.active?.(editor) ? 'is-active' : ''}${index === 2 || index === 4 || index === 7 ? ' starts-group' : ''}`.trim() || undefined}
            disabled={!editor} onPointerDown={(event) => event.preventDefault()} onClick={() => editor && action.run(editor)}>
            <Icon size={18} strokeWidth={1.8} />
          </button>;
        })}
        {uploadAttachment && <button type="button" title="添加附件" aria-label="添加附件" disabled={!editor}
          onPointerDown={(event) => event.preventDefault()} onClick={addAttachment}>
          <Paperclip size={18} strokeWidth={1.8} />
        </button>}
      </div>
      <div className="mobile-editor-toolbar__fixed">
        <button type="button" className="mobile-editor-toolbar__dismiss" title="收起键盘" aria-label="收起键盘"
          disabled={!editor} onPointerDown={(event) => event.preventDefault()} onClick={dismissKeyboard}>
          <KeyboardOff size={19} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="mobile-markdown-editor markdown-editor">
      <div ref={mountRef} className="mobile-markdown-editor__content editor-content" />
      {renderToolbar && createPortal(toolbar, document.body)}
    </div>
  );
}
