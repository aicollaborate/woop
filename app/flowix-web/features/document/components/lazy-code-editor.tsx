import { forwardRef } from 'react';
import type { ComponentProps } from 'react';
import {
  CodeEditor,
  type CodeEditorHandle,
} from '@features/editor/code-editor';

type CodeEditorProps = ComponentProps<typeof CodeEditor>;

export const LazyCodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function LazyCodeEditor(props, ref) {
  // CodeMirror is intentionally part of the application entry bundle. A
  // second, on-demand chunk here can be stale in an upgraded WebView cache or
  // fail to resolve from a packaged protocol URL. The old null Suspense
  // fallback turned either case into an indistinguishable blank document.
  // Language packages remain lazy and already fall back to plain text.
  return <CodeEditor {...props} ref={ref} />;
});
