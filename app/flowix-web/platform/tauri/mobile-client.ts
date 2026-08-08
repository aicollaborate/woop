import {
  cloud,
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  type CloudState,
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
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  cloud: {
    getState: cloud.getState,
    login: cloud.login,
    logout: cloud.logout,
    resetBinding: mobile.resetCloudBinding,
    refreshMembership: cloud.refreshMembership,
  },
  notebooks: {
    getAll: notebooks.getAll,
    create: (name: string) => invoke<NotebookRecord>('mobile_create_notebook', { name }),
    rename: (id: string, name: string) =>
      invoke<NotebookRecord>('mobile_rename_notebook', { id, name }),
  },
  tags: {
    getAll: tags.getAll,
  },
  memos: {
    getMemos: memos.getMemos,
    openMemoSession: memos.openMemoSession,
    writeDocument: memos.writeDocument,
    deleteMemo: memos.deleteMemo,
    favoriteMemo: memos.favoriteMemo,
    unfavoriteMemo: memos.unfavoriteMemo,
    addDocument: memos.addDocument,
  },
  attachments: {
    saveContent: (params: { content: string; fileName: string; memoId: string }) =>
      invoke<string>('mobile_save_attachment_content', params),
  },
} as const;

export type { CloudState, CloudSyncStatus, NotebookRecord, OpenMemoSession };
