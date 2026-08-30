import type { ComponentProps } from 'react';
import type { WindowTab } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';
import {
  ThirdColumnSurfaceHost,
  resolveTabSurface,
  type ThirdColumnSurface,
} from '@features/surface';
import type { MemoItem } from '@/types/memo-item';

export interface ResolveTabContentSurfaceInput {
  tab: WindowTab;
  contentKey: string;
  memo: MemoItem | null;
  memoContentProps: Omit<ComponentProps<typeof DocumentContainer>, 'memoId' | 'filePath' | 'notebookId' | 'notebookPath'> & {
    filePath: string;
    notebookId: string | null;
    notebookPath: string | null;
  };
}

export function resolveTabContentSurface({
  tab,
  contentKey,
  memo,
  memoContentProps,
}: ResolveTabContentSurfaceInput) {
  if (tab.target.kind === 'web') {
    return resolveTabSurface({
      target: { kind: 'web', url: tab.target.url },
    });
  }

  const isExternal = tab.target.kind === 'external_markdown';
  const memoId = tab.target.kind === 'memo' ? tab.target.memoId : null;
  const documentPath = memoContentProps.filePath;
  const notebookId = tab.target.kind === 'memo'
    ? memoContentProps.notebookId ?? tab.target.notebookId
    : null;
  const notebookPath = tab.target.kind === 'memo'
    ? memoContentProps.notebookPath ?? tab.target.notebookPath
    : null;
  return resolveTabSurface({
    target: {
      kind: 'document',
      target: tab.target.kind === 'memo'
        ? {
            kind: 'memo',
            memoId: tab.target.memoId,
            path: tab.target.filePath,
            notebookId: tab.target.notebookId,
            notebookPath: tab.target.notebookPath,
          }
        : {
            kind: 'external',
            path: tab.target.filePath,
            scopePath: null,
          },
      document: {
        identity: memoId
          ? {
              kind: 'memo' as const,
              memoId,
              path: documentPath,
              notebookId,
              notebookPath,
              transitionId: memoContentProps.transitionId ?? null,
            }
          : {
              kind: 'external' as const,
              path: documentPath,
              scopePath: memoContentProps.externalScopePath ?? null,
              transitionId: memoContentProps.transitionId ?? null,
            },
        memo,
        markdown: {
          kind: 'markdown',
          instanceKey: contentKey,
          props: {
            ...memoContentProps,
            filePath: documentPath,
            memoId,
            notebookId,
            notebookPath,
            isExternalDocument: isExternal,
          },
        },
        artifact: memoId
          ? {
              memoId,
              transitionId: memoContentProps.transitionId ?? undefined,
            }
          : undefined,
      },
    },
  });
}

export function TabContent({ surface }: { surface: ThirdColumnSurface }) {
  return <ThirdColumnSurfaceHost surface={surface} />;
}
