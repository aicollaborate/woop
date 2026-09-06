import { canonicalPath } from '@/lib/path';

export interface FileBrowserBreadcrumbItem {
  label: string;
  path: string;
  type: 'folder' | 'file';
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function pathSegments(path: string): string[] {
  return canonicalPath(path).split('/').filter(Boolean);
}

/**
 * Build a compact path breadcrumb relative to the file-browser root.
 *
 * The root is intentionally represented by its last directory name, so an
 * absolute scope such as `/Users/rop/Desktop/vibe/flowix-main` starts with
 * `flowix-main` instead of exposing the whole host path.
 */
export function resolveFileBrowserBreadcrumbs(
  folderPath: string,
  activeFilePath: string | null,
): string[] {
  return resolveFileBrowserBreadcrumbItems(folderPath, activeFilePath).map((item) => item.label);
}

/**
 * Resolve breadcrumb labels together with their filesystem paths.
 *
 * Keeping the path on the item is important for folder popovers: labels alone
 * are ambiguous when a folder name appears more than once in a path, while
 * the clicked folder must become the tree's exact root.
 */
export function resolveFileBrowserBreadcrumbItems(
  folderPath: string,
  activeFilePath: string | null,
): FileBrowserBreadcrumbItem[] {
  const normalizedRoot = trimTrailingSeparators(canonicalPath(folderPath.trim()));
  const rootSegments = pathSegments(normalizedRoot);
  const rootLabel = rootSegments[rootSegments.length - 1] ?? (folderPath || '/');
  const rootItem: FileBrowserBreadcrumbItem = {
    label: rootLabel,
    path: normalizedRoot,
    type: 'folder',
  };
  if (!activeFilePath) return [rootItem];

  const normalizedFile = trimTrailingSeparators(canonicalPath(activeFilePath.trim()));
  if (!normalizedFile || normalizedFile === normalizedRoot) return [rootItem];

  const rootPrefix = normalizedRoot ? `${normalizedRoot}/` : '';
  const relativePath = normalizedFile.startsWith(rootPrefix)
    ? normalizedFile.slice(rootPrefix.length)
    : null;

  // The file tree should only select files below folderPath. Keep the
  // breadcrumb useful if an older/restored tab contains an out-of-scope path.
  if (relativePath === null) {
    return [rootItem, {
      label: pathSegments(normalizedFile).slice(-1)[0] ?? normalizedFile,
      path: normalizedFile,
      type: 'file',
    }];
  }

  let currentPath = normalizedRoot;
  const segments = pathSegments(relativePath);
  return [
    rootItem,
    ...segments.map((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      return {
        label: segment,
        path: currentPath,
        type: index === segments.length - 1 ? 'file' : 'folder',
      } satisfies FileBrowserBreadcrumbItem;
    }),
  ];
}
