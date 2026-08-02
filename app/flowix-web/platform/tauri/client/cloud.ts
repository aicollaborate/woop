import { invoke } from '@tauri-apps/api/core';
import { subscribe } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
  systemRole: string;
}

export interface CloudMembership {
  active: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
  noteCount: number;
  readOnly: boolean;
}

export interface CloudState {
  enabled: boolean;
  authenticated: boolean;
  account?: {
    user: CloudUser;
    protocolEpoch: 2;
  } | null;
  membership?: CloudMembership | null;
  lastError?: string | null;
}

export interface CloudNotebookSyncState {
  notebookId: string;
  enabled: boolean;
  bootstrapRequired: boolean;
  updatedAt: number;
}

export interface CloudNotebook {
  id: string;
  name: string;
  icon?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  synced: boolean;
}

export interface CloudSyncResult {
  notebooks: number;
  uploaded: number;
  deleted: number;
  downloaded: number;
  conflicts: number;
}

export type CloudSyncStatusState =
  | 'idle'
  | 'queued'
  | 'checking'
  | 'syncing'
  | 'finalizing'
  | 'success'
  | 'error'
  | 'offline';

export interface CloudSyncStatus {
  notebookId: string;
  runId: string;
  state: CloudSyncStatusState;
  phase: string;
  uploaded: number;
  deleted: number;
  downloaded: number;
  startedAt: number;
  finishedAt?: number | null;
  lastError?: string | null;
}

export interface CloudProduct {
  id: string;
  name: string;
  description: string;
  price: { amount: number; currency: string };
  entitlement: {
    storageBytes: number;
    duration: { unit: string; count: number };
    features: Record<string, unknown>;
  };
}

export interface CloudCheckout {
  orderId: string;
  status: string;
  checkoutUrl: string;
  expiresAt?: number | null;
}

export const cloud = {
  getState: () => invoke<CloudState>('cloud_get_state'),
  register: (email: string, password: string, displayName: string) =>
    invoke<CloudState>('cloud_register', { email, password, displayName }),
  login: (email: string, password: string) =>
    invoke<CloudState>('cloud_login', { email, password }),
  signInWithApple: () => invoke<CloudState>('cloud_sign_in_with_apple'),
  linkApple: () => invoke<CloudState>('cloud_link_apple'),
  logout: () => invoke<CloudState>('cloud_logout'),
  setEnabled: (enabled: boolean) =>
    invoke<CloudState>('cloud_set_enabled', { enabled }),
  getNotebookState: (notebookId: string) =>
    invoke<CloudNotebookSyncState | null>('cloud_get_notebook_state', { notebookId }),
  listNotebookStates: () =>
    invoke<CloudNotebookSyncState[]>('cloud_list_notebook_states'),
  listNotebooks: () => invoke<CloudNotebook[]>('cloud_list_notebooks'),
  linkNotebook: (notebookId: string, cloudNotebookId: string) =>
    invoke<CloudNotebookSyncState>('cloud_link_notebook', { notebookId, cloudNotebookId }),
  setNotebookEnabled: (notebookId: string, enabled: boolean) =>
    invoke<CloudNotebookSyncState>('cloud_set_notebook_enabled', { notebookId, enabled }),
  refreshMembership: () =>
    invoke<CloudMembership>('cloud_refresh_membership'),
  listProducts: () => invoke<CloudProduct[]>('cloud_list_products'),
  createCheckout: (productId: string) =>
    invoke<CloudCheckout>('cloud_create_checkout', { productId }),
  syncNow: (notebookId?: string) =>
    invoke<CloudSyncResult>('cloud_sync_now', { notebookId }),
};

export function listenToCloudStateChanges(
  handler: (state: CloudState) => void,
): UnlistenFn {
  return subscribe<CloudState>('cloud-state-changed', handler);
}

export function listenToCloudSyncStatusChanges(
  handler: (status: CloudSyncStatus) => void,
): UnlistenFn {
  return subscribe<CloudSyncStatus>('cloud-sync-status-changed', handler);
}

// Files
