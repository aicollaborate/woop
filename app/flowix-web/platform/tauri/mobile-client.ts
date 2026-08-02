import { cloud, listenToCloudStateChanges, type CloudState } from './client/cloud';
import {
  memos,
  notebooks,
  tags,
  type NotebookRecord,
  type OpenMemoSession,
} from './client/memos';
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
  cloud: {
    getState: cloud.getState,
    login: cloud.login,
    logout: cloud.logout,
    refreshMembership: cloud.refreshMembership,
  },
  notebooks: {
    getAll: notebooks.getAll,
  },
  tags: {
    getAll: tags.getAll,
  },
  memos: {
    getMemos: memos.getMemos,
    openMemoSession: memos.openMemoSession,
    writeDocument: memos.writeDocument,
    addDocument: memos.addDocument,
  },
} as const;

export type { CloudState, NotebookRecord, OpenMemoSession };
