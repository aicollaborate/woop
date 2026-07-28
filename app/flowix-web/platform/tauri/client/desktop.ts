import { invoke } from '@tauri-apps/api/core';
import type { ThemeId } from '@/lib/theme';

export interface DocTreeItem {
  id: string;
  fullPath: string;
  name: string;
  type: 'folder' | 'document';
  parentId: string | null;
  children: DocTreeItem[] | null;
}

export const files = {
  getTree: (spacePath: string) => invoke<DocTreeItem[] | null>('get_file_tree', { spacePath }),
  getDirChildren: (dirPath: string) => invoke<DocTreeItem[]>('get_dir_children', { dirPath }),
  read: (filePath: string, spacePath?: string) => invoke<string | null>('read_file', { filePath, spacePath }),
  write: (filePath: string, content: string, skipValidation?: boolean, spacePath?: string) =>
    invoke<boolean>('write_file', { filePath, content, skipValidation, spacePath }),
  delete: (filePath: string, spacePath?: string) => invoke<boolean>('delete_file', { filePath, spacePath }),
  createFolder: (spacePath: string, name: string, parentId?: string) =>
    invoke<DocTreeItem | null>('create_folder', { spacePath, name, parentId }),
  createDocument: (spacePath: string, name: string, parentId?: string) =>
    invoke<DocTreeItem | null>('create_document', { spacePath, name, parentId }),
};

// Dialogs
export interface SaveFileFilter {
  name: string;
  extensions: string[];
}

export const dialogs = {
  selectDirectory: () => invoke<string | null>('select_directory'),
  selectFiles: () => invoke<string[] | null>('select_files'),
  saveFile: (suggestedName?: string, filters?: SaveFileFilter[]) =>
    invoke<string | null>('save_file_dialog', {
      suggestedName,
      filters: filters?.map((f) => [f.name, ...f.extensions]),
    }),
  writeExportFile: (filePath: string, content: string) =>
    invoke<boolean>('write_export_file', { filePath, content }),
  copyAttachmentFile: (sourcePath: string, targetPath: string) =>
    invoke<boolean>('copy_attachment_file', { sourcePath, targetPath }),
};

// Windows
export type TabTarget =
  | {
      kind: 'memo';
      memoId: string;
      notebookId: string;
      notebookPath: string;
      filePath: string;
    }
  | {
      kind: 'external_markdown';
      filePath: string;
    }
  | {
      kind: 'web';
      url: string;
    };

export interface WindowTab {
  id: string;
  title: string;
  icon: string | null;
  target: TabTarget;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowRegion extends WindowPosition {
  width: number;
  height: number;
}

export interface TabDragResult {
  merged: boolean;
}

export interface ExternalDocumentChangedEvent {
  path: string;
  kind: 'modified' | 'deleted';
  revision: string;
}

export const windows = {
  showMain: () => invoke<void>('show_main_window'),
  openPreferences: (tab?: string) => invoke<void>('open_preferences_window', { tab }),
  applyWindowTheme: (theme: ThemeId) => invoke<void>('apply_window_theme', { theme }),
  openNoteWindow: (memoId: string) => invoke<void>('open_note_window', { memoId }),
  openNoteTab: (memoId: string) => invoke<void>('open_note_tab', { memoId }),
  openExternalMarkdownWindow: (filePath: string) =>
    invoke<void>('open_external_markdown_window', { filePath }),
  openExternalMarkdownTab: (filePath: string) =>
    invoke<void>('open_external_markdown_tab', { filePath }),
  openMarkdownPathTab: (filePath: string) =>
    invoke<void>('open_markdown_path_tab', { filePath }),
  watchExternalDocument: (filePath: string) =>
    invoke<string>('watch_external_document', { filePath }),
  unwatchExternalDocument: (leaseId: string) =>
    invoke<void>('unwatch_external_document', { leaseId }),
  tabWindowReady: () => invoke<WindowTab[]>('tab_window_ready'),
  ackTabWindowTransfer: (transferId: string, tabId: string) =>
    invoke<void>('tab_window_ack_transfer', { transferId, tabId }),
  setTabWindowRegion: (region: WindowRegion) =>
    invoke<void>('tab_window_set_tab_region', { region }),
  closeTabWindowTab: (tabId: string) => invoke<void>('tab_window_close_tab', { tabId }),
  reorderTabWindowTab: (tabId: string, beforeTabId: string | null) =>
    invoke<void>('tab_window_reorder_tab', { tabId, beforeTabId }),
  detachTabWindowTab: (
    tabId: string,
    position: WindowPosition,
    dragId: string,
  ) => invoke<TabDragResult>('tab_window_detach_tab', {
    tabId,
    position,
    dragId,
  }),
  beginTabItemDrag: (tabId: string, dragId: string) => invoke<void>('tab_window_begin_tab_item_drag', {
    tabId,
    dragId,
  }),
  cancelTabItemDrag: (tabId: string, dragId: string) =>
    invoke<void>('tab_window_cancel_tab_item_drag', { tabId, dragId }),
};

export interface ProductInfo {
  productName: string;
  version: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  os: string;
  arch: string;
}

export interface ProductUpdateNotice {
  id: string;
  title: string;
  body: string;
  version?: string | null;
  ctaUrl?: string | null;
  publishedAt?: string | null;
}

export const product = {
  getInfo: () => invoke<ProductInfo>('get_product_info'),
  checkUpdateNotice: (language?: string, region?: string) =>
    invoke<ProductUpdateNotice | null>('check_product_update_notice', { language, region }),
  openLogDir: () => invoke<void>('open_log_dir'),
};

// Agent
//
// AI model config is sourced from ~/.flowix/agent-config.toml; see aiConfig.set/get above.
// 骞舵儼鎬ф瀯寤?provider 瀹炰緥 (瑙?backend/src/agent.rs AgentManager::ensure_instance)銆?//
// 瀛楁鍛藉悕: 鍚庣 AiModelConfig 鐢?`#[serde(rename_all = "camelCase")]`, 鎵€浠?// IPC 浼犺繃鍘诲繀椤绘槸 camelCase 鈹€ snake_case 浼氳 serde 闈欓粯涓㈠純, 瀛楁鍏ㄩ儴鍥為€€
// 鍒?#[serde(default)] = 绌轰覆, 琛ㄧ幇灏辨槸"淇濆瓨鍚庡埛鏂?apiKey/apiUrl 閮界┖浜?銆?

