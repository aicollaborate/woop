import {
  cloud,
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  type CloudState,
  type CloudNotebook,
  type CloudSyncStatus,
} from './client/cloud';
import {
  memos,
  notebooks,
  tags,
  type NotebookRecord,
  type OpenMemoSession,
} from './client/memos';
import { invoke } from '@tauri-apps/api/core';
import { mobile } from './client/mobile';
import type { MemoItem } from '@/types/memo-item';

export interface MobileLibrarySnapshot {
  notebooks: NotebookRecord[];
  selectedNotebookId: string | null;
  tags: Array<{ id: string; name: string }>;
  memos: MemoItem[];
}

/**
 * Compile-time capability surface for the mobile Tauri shell.
 *
 * Keep this list aligned with `flowix-mobile/src/lib.rs`. Mobile features must
 * import this facade instead of the desktop-wide `@platform/tauri/client`
 * barrel, so an unavailable desktop command cannot be called accidentally.
 */
export const mobileClient = {
  initialize: mobile.initialize,
  bootstrapCloud: mobile.bootstrapCloud,
  hapticLight: () => invoke<void>('mobile_haptic_light'),
  syncNotebookActionButtons: (buttons: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>) => invoke<void>('mobile_sync_notebook_action_buttons', { buttons }),
  setNotebookActionButtonsOffset: (offset: number) =>
    invoke<void>('mobile_set_notebook_action_buttons_offset', { offset }),
  showNotebookActions: (id: string, name: string) =>
    invoke<void>('mobile_show_notebook_actions', { id, name }),
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  cloud: {
    getState: cloud.getState,
    login: cloud.login,
    logout: cloud.logout,
    listNotebooks: () => invoke<CloudNotebook[]>('mobile_list_cloud_notebooks'),
    resetBinding: mobile.resetCloudBinding,
    refreshMembership: cloud.refreshMembership,
  },
  notebooks: {
    getAll: notebooks.getAll,
    getLibrarySnapshot: (params: { preferredNotebookId?: string; selectedTagId?: string }) =>
      invoke<MobileLibrarySnapshot>('mobile_get_library_snapshot', params),
    create: (name: string) => invoke<NotebookRecord>('mobile_create_notebook', { name }),
    rename: (id: string, name: string) =>
      invoke<NotebookRecord>('mobile_rename_notebook', { id, name }),
    delete: (id: string) => invoke<boolean>('mobile_delete_notebook', { id }),
  },
  tags: {
    getAll: tags.getAll,
  },
  memos: {
    getMemos: memos.getMemos,
    search: (params: { notebookId: string; tagId?: string; query: string }) =>
      invoke<{ memos: MemoItem[] }>('mobile_search_memos', params),
    openMemoSession: memos.openMemoSession,
    writeDocument: memos.writeDocument,
    deleteMemo: memos.deleteMemo,
    favoriteMemo: memos.favoriteMemo,
    unfavoriteMemo: memos.unfavoriteMemo,
    addDocument: memos.addDocument,
  },
  attachments: {
    beginUpload: (params: { fileName: string; mimeType: string; sizeBytes: number; memoId: string }) =>
      invoke<{ uploadId: string }>('mobile_begin_attachment_upload', params),
    writeChunk: (params: { uploadId: string; content: string }) =>
      invoke<void>('mobile_write_attachment_chunk', params),
    finishUpload: (uploadId: string) =>
      invoke<string>('mobile_finish_attachment_upload', { uploadId }),
    cancelUpload: (uploadId: string) =>
      invoke<void>('mobile_cancel_attachment_upload', { uploadId }),
  },
} as const;

export type { CloudNotebook, CloudState, CloudSyncStatus, NotebookRecord, OpenMemoSession };
