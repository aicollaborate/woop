import type { ComponentProps } from 'react';
import type { WindowTab } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';
import {
  ThirdColumnSurfaceHost,
  resolveThirdColumnSurface,
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
    return resolveThirdColumnSurface({
      webUrl: tab.target.url,
      emptyMessage: '',
    });
  }

  const isExternal = tab.target.kind === 'external_markdown';
  const memoId = tab.target.kind === 'memo' ? tab.target.memoId : null;
  return resolveThirdColumnSurface({
    document: {
      memo,
      markdown: {
        kind: 'markdown',
        instanceKey: contentKey,
        props: {
          ...memoContentProps,
          filePath: memoContentProps.filePath || tab.target.filePath,
          memoId,
          notebookId: tab.target.kind === 'memo'
            ? memoContentProps.notebookId ?? tab.target.notebookId
            : null,
          notebookPath: tab.target.kind === 'memo'
            ? memoContentProps.notebookPath ?? tab.target.notebookPath
            : null,
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
    emptyMessage: '',
  });
}

export function TabContent({ surface }: { surface: ThirdColumnSurface }) {
  return <ThirdColumnSurfaceHost surface={surface} />;
}
