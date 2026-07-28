function decodeLocalFilePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localFilePathFromAgentHref(
  rawHref: string | null | undefined,
): string | null {
  const href = rawHref?.trim() ?? '';
  if (!href) return null;

  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.protocol !== 'file:') return null;
      let path = decodeLocalFilePath(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      if (url.hostname && url.hostname !== 'localhost') {
        path = `//${url.hostname}${path}`;
      }
      return path || null;
    } catch {
      return null;
    }
  }

  if (href.startsWith('/') || /^[a-z]:[\\/]/i.test(href)) {
    return decodeLocalFilePath(href);
  }
  return null;
}

export function isMarkdownFilePath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}
