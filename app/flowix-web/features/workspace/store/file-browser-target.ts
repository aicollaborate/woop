import { canonicalPath } from '@/lib/path';

export interface FileBrowserContext {
  folderPath: string | null;
  notebookId: string | null;
  scopePath: string | null;
  fileTreeVisible: boolean;
  fileTreeWidth: number;
}

export interface FileBrowserTarget extends FileBrowserContext {
  kind: 'file-browser';
  activeFilePath: string | null;
}

/** Longest directory-boundary match; preserve filesystem case semantics. */
export function resolveFileBrowserRoot(path: string | null, folders: readonly string[]): string | null {
  if (!path) return null;
  const normalized = canonicalPath(path);
  return folders.map(canonicalPath).filter((folder) => {
    const root = folder.replace(/\/+$/, '') || '/';
    return normalized === root || normalized.startsWith(root === '/' ? '/' : `${root}/`);
  }).sort((a, b) => b.length - a.length)[0] ?? null;
}
