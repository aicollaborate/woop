'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import {
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tagHighlighter, tags } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import {
  closeSearchPanel,
  openSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';

import { cn } from '@/lib/utils';

import { isMarkdownFilePath } from '@features/editor/code-file';
import { shikiHighlighting, shikiLanguageIdForPath } from '@features/editor/code-editor-shiki';

export interface CodeEditorHandle {
  flushPendingChanges: () => string | null;
}

interface CodeEditorProps {
  filePath: string;
  content: string;
  editable?: boolean;
  onChange: (content: string) => void;
  className?: string;
  autoFocus?: boolean;
  searchPanelOpen?: boolean;
  onSearchPanelOpenChange?: (open: boolean) => void;
  onEditorScroll?: (scrollTop: number) => void;
  onEditingFinished?: () => void;
}

const codeEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--document-foreground, var(--foreground, #1f2937))',
    backgroundColor: 'transparent',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
    lineHeight: '1.65',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '14px 0 28px',
    // Keep the document text color on the actual content layer. Relying on
    // inheritance from `.cm-editor` makes text disappear in WebKit when a
    // theme variable is unavailable during the production-app startup.
    color: 'var(--document-foreground, var(--foreground, #1f2937))',
    caretColor: 'var(--foreground)',
  },
  '.cm-line': {
    padding: '0 20px 0 10px',
    color: 'var(--document-foreground, var(--foreground, #1f2937))',
  },
  '.cm-gutters': {
    border: 'none',
    color: 'var(--muted-foreground)',
    backgroundColor: 'var(--document-bg)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: 'color-mix(in oklch, var(--muted-foreground) 40%, transparent)',
  },
  '.cm-foldGutter .cm-gutterElement > span': {
    opacity: 0,
    transition: 'opacity 120ms ease',
  },
  '.cm-gutters:hover .cm-foldGutter .cm-gutterElement > span': {
    opacity: 0.5,
  },
  '.cm-foldGutter .cm-gutterElement > span[title="Fold line"]': {
    display: 'inline-block',
    position: 'relative',
    top: '-3px',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in oklch, var(--muted) 58%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 24%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--foreground)',
  },
  '.cm-panels': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--card)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--border)',
  },
  '.cm-search': {
    padding: '6px 10px',
  },
  '.cm-textfield': {
    height: '26px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--foreground)',
    backgroundColor: 'var(--background)',
  },
  '.cm-button': {
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--foreground)',
    backgroundImage: 'none',
    backgroundColor: 'var(--muted)',
  },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    color: 'var(--foreground)',
    backgroundColor: 'var(--popover)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--muted)',
  },
});

// Fixed class names keep syntax colors in the compiled application CSS.
// HighlightStyle.define() emits a runtime <style> sheet with generated class
// names, which can be absent during packaged WebView startup.
const codeHighlighter = tagHighlighter([
  { tag: tags.comment, class: 'cm-code-comment' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], class: 'cm-code-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'cm-code-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'cm-code-constant' },
  { tag: [tags.function(tags.variableName), tags.labelName], class: 'cm-code-function' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'cm-code-type' },
  { tag: [tags.regexp, tags.escape], class: 'cm-code-regexp' },
  { tag: tags.invalid, class: 'cm-code-invalid' },
]);

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  filePath,
  content,
  editable = true,
  onChange,
  className,
  autoFocus = false,
  searchPanelOpen: controlledSearchPanelOpen = false,
  onSearchPanelOpenChange,
  onEditorScroll,
  onEditingFinished,
}, ref) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingContentRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSearchPanelOpenChangeRef = useRef(onSearchPanelOpenChange);
  const onEditorScrollRef = useRef(onEditorScroll);
  const onEditingFinishedRef = useRef(onEditingFinished);
  const languageCompartment = useMemo(() => new Compartment(), []);
  const editableCompartment = useMemo(() => new Compartment(), []);

  onChangeRef.current = onChange;
  onSearchPanelOpenChangeRef.current = onSearchPanelOpenChange;
  onEditorScrollRef.current = onEditorScroll;
  onEditingFinishedRef.current = onEditingFinished;

  useImperativeHandle(ref, () => ({
    flushPendingChanges: () => viewRef.current?.state.doc.toString() ?? null,
  }), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let lastSearchPanelOpen = false;
    // Files whose extension maps to a preloaded Shiki language are colored by
    // the shared Shiki highlighter (see code-editor-shiki.ts) instead of the
    // Lezer tagHighlighter path. Anything else falls back to the 8-class
    // tagHighlighter. The Lezer language is still loaded below for structure
    // (folding / indentation / bracket matching).
    const shikiLang = shikiLanguageIdForPath(filePath);
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        codeEditorTheme,
        ...(shikiLang
          ? [shikiHighlighting(shikiLang)]
          : [syntaxHighlighting(codeHighlighter)]),
        EditorView.lineWrapping,
        languageCompartment.of([]),
        editableCompartment.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
        EditorView.contentAttributes.of({
          'aria-label': filePath.split(/[\\/]/).pop() ?? filePath,
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingContentRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
          const nextSearchPanelOpen = searchPanelOpen(update.state);
          if (nextSearchPanelOpen !== lastSearchPanelOpen) {
            lastSearchPanelOpen = nextSearchPanelOpen;
            onSearchPanelOpenChangeRef.current?.(nextSearchPanelOpen);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: mount });
    viewRef.current = view;

    const handleScroll = () => onEditorScrollRef.current?.(view.scrollDOM.scrollTop);
    const handleBlur = () => onEditingFinishedRef.current?.();
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
    view.contentDOM.addEventListener('blur', handleBlur);

    if (autoFocus) requestAnimationFrame(() => view.focus());

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      view.contentDOM.removeEventListener('blur', handleBlur);
      view.destroy();
      viewRef.current = null;
    };
  }, [autoFocus, editableCompartment, filePath, languageCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [editable, editableCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    syncingContentRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    } finally {
      syncingContentRef.current = false;
    }
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const isOpen = searchPanelOpen(view.state);
    if (controlledSearchPanelOpen && !isOpen) openSearchPanel(view);
    if (!controlledSearchPanelOpen && isOpen) closeSearchPanel(view);
  }, [controlledSearchPanelOpen]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Markdown is rendered by Shiki and does not need a Lezer language loaded.
    if (isMarkdownFilePath(filePath)) return;
    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, filePath);
    if (!description) return;
    void description.load().then((support) => {
      if (disposed || viewRef.current !== view) return;
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    }).catch((error: unknown) => {
      if (disposed) return;
      console.error('[CodeEditor] Failed to load language support', {
        filePath,
        language: description.name,
        error,
      });
    });
    return () => {
      disposed = true;
    };
  }, [filePath, languageCompartment]);

  return <div ref={mountRef} className={cn('code-editor h-full w-full min-h-0 min-w-0 overflow-hidden', className)} />;
});
