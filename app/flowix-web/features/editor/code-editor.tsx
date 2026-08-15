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
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import {
  closeSearchPanel,
  openSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';

import { cn } from '@/lib/utils';

export interface CodeEditorHandle {
  flushPendingChanges: () => string | null;
}

interface CodeEditorProps {
  filePath: string;
  content: string;
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
    color: 'var(--foreground)',
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
    caretColor: 'var(--foreground)',
  },
  '.cm-line': {
    padding: '0 20px 0 10px',
  },
  '.cm-gutters': {
    paddingLeft: '8px',
    border: 'none',
    color: 'var(--muted-foreground)',
    backgroundColor: 'var(--document-bg)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: 'color-mix(in oklch, var(--muted-foreground) 40%, transparent)',
  },
  '.cm-foldGutter .cm-gutterElement > span': {
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

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--primary)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--document-link)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--brand)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--memo-color-orange)' },
  { tag: tags.invalid, color: 'var(--destructive)' },
]);

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  filePath,
  content,
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
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        codeEditorTheme,
        syntaxHighlighting(codeHighlightStyle),
        EditorView.lineWrapping,
        languageCompartment.of([]),
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
  }, [autoFocus, filePath, languageCompartment]);

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
    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, filePath);
    if (!description) return;
    void description.load().then((support) => {
      if (disposed || viewRef.current !== view) return;
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    });
    return () => {
      disposed = true;
    };
  }, [filePath, languageCompartment]);

  return <div ref={mountRef} className={cn('h-full w-full min-w-0', className)} />;
});
