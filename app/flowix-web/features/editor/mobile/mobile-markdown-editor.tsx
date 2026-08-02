import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import {
  Bold,
  Braces,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { StaticCustomBlock } from './static-custom-block';

interface MobileMarkdownEditorProps {
  content: string;
  onChange: (markdown: string) => void;
}

interface ToolbarAction {
  icon: LucideIcon;
  title: string;
  run: (editor: Editor) => void;
  active?: (editor: Editor) => boolean;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { icon: Bold, title: '粗体', run: (editor) => { editor.chain().focus().toggleBold().run(); }, active: (editor) => editor.isActive('bold') },
  { icon: Italic, title: '斜体', run: (editor) => { editor.chain().focus().toggleItalic().run(); }, active: (editor) => editor.isActive('italic') },
  { icon: Heading1, title: '一级标题', run: (editor) => { editor.chain().focus().toggleHeading({ level: 1 }).run(); }, active: (editor) => editor.isActive('heading', { level: 1 }) },
  { icon: Heading2, title: '二级标题', run: (editor) => { editor.chain().focus().toggleHeading({ level: 2 }).run(); }, active: (editor) => editor.isActive('heading', { level: 2 }) },
  { icon: List, title: '无序列表', run: (editor) => { editor.chain().focus().toggleBulletList().run(); }, active: (editor) => editor.isActive('bulletList') },
  { icon: ListOrdered, title: '有序列表', run: (editor) => { editor.chain().focus().toggleOrderedList().run(); }, active: (editor) => editor.isActive('orderedList') },
  { icon: ListTodo, title: '任务列表', run: (editor) => { editor.chain().focus().toggleTaskList().run(); }, active: (editor) => editor.isActive('taskList') },
  { icon: Quote, title: '引用', run: (editor) => { editor.chain().focus().toggleBlockquote().run(); }, active: (editor) => editor.isActive('blockquote') },
  { icon: Braces, title: '代码块', run: (editor) => { editor.chain().focus().toggleCodeBlock().run(); }, active: (editor) => editor.isActive('codeBlock') },
];

export function createMobileMarkdownExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    StaticCustomBlock,
    Markdown.configure({
      markedOptions: { gfm: true, breaks: true },
    }),
  ];
}

export function MobileMarkdownEditor({ content, onChange }: MobileMarkdownEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, setToolbarVersion] = useState(0);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!mountRef.current) return;
    const instance = new Editor({
      element: mountRef.current,
      extensions: createMobileMarkdownExtensions(),
      content,
      contentType: 'markdown',
      autofocus: false,
      onUpdate: ({ editor: current }) => {
        onChangeRef.current(current.getMarkdown());
        setToolbarVersion((version) => version + 1);
      },
      onSelectionUpdate: () => setToolbarVersion((version) => version + 1),
    });
    editorRef.current = instance;
    setEditor(instance);
    return () => {
      instance.destroy();
      editorRef.current = null;
      setEditor(null);
    };
  }, []);

  return (
    <div className="mobile-markdown-editor">
      <div ref={mountRef} className="mobile-markdown-editor__content" />
      <div className="mobile-editor-toolbar" role="toolbar" aria-label="Markdown 格式">
        {TOOLBAR_ACTIONS.map((action, index) => {
          const Icon = action.icon;
          return (
            <button
              key={action.title}
              type="button"
              title={action.title}
              aria-label={action.title}
              className={`${editor && action.active?.(editor) ? 'is-active' : ''}${index === 2 || index === 4 || index === 7 ? ' starts-group' : ''}`.trim() || undefined}
              disabled={!editor}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => editor && action.run(editor)}
            >
              <Icon size={18} strokeWidth={1.8} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
