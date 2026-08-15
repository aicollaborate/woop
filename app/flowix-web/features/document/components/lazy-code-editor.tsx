import { forwardRef, lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import type { CodeEditorHandle } from '@features/editor/code-editor';

type CodeEditorProps = ComponentProps<
  typeof import('@features/editor/code-editor').CodeEditor
>;

const LazyCodeMirrorEditor = lazy(() =>
  import('@features/editor/code-editor').then((module) => ({
    default: module.CodeEditor,
  }))
);

export const LazyCodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function LazyCodeEditor(props, ref) {
  return (
    <Suspense fallback={null}>
      <LazyCodeMirrorEditor {...props} ref={ref} />
    </Suspense>
  );
});
