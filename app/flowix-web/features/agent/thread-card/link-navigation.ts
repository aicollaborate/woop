function decodeLocalFilePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type ComparablePath = {
  value: string;
  flavor: "posix" | "windows" | "relative";
};

/** Lexically normalize a user-visible path without requiring filesystem I/O. */
function comparablePath(value: string): ComparablePath {
  const slashed = value.replace(/\\/g, "/");
  const isUnc = slashed.startsWith("//");
  const drive = /^([a-z]):(?:\/|$)/i.exec(slashed)?.[1];
  const isPosix = !isUnc && slashed.startsWith("/");
  const flavor = isUnc || drive ? "windows" : isPosix ? "posix" : "relative";
  const body = isUnc
    ? slashed.slice(2)
    : drive
      ? slashed.slice(2).replace(/^\/+/, "")
      : isPosix
        ? slashed.slice(1)
        : slashed;
  const parts: string[] = [];
  // A UNC server/share pair is the volume root and cannot be escaped by `..`.
  const floor = isUnc ? 2 : 0;
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > floor && parts[parts.length - 1] !== "..") parts.pop();
      else if (flavor === "relative") parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = isUnc ? "//" : drive ? `${drive.toUpperCase()}:/` : isPosix ? "/" : "";
  const joined = `${prefix}${parts.join("/")}`;
  return {
    value: joined || (isPosix ? "/" : drive ? `${drive.toUpperCase()}:/` : isUnc ? "//" : "."),
    flavor,
  };
}

function pathContains(root: ComparablePath, target: ComparablePath): boolean {
  if (root.flavor !== target.flavor || root.flavor === "relative") return false;
  const fold = (path: string) => root.flavor === "windows" ? path.toLowerCase() : path;
  const rootValue = fold(root.value);
  const targetValue = fold(target.value);
  if (targetValue === rootValue) return true;
  const prefix = rootValue.endsWith("/") ? rootValue : `${rootValue}/`;
  return targetValue.startsWith(prefix);
}

/** Return the narrowest conversation workspace that contains a local path. */
export function agentFileScopePath(
  filePath: string,
  workspacePaths: readonly string[],
): string | null {
  const target = comparablePath(filePath);
  return workspacePaths
    .filter((path) => typeof path === "string" && path.trim())
    .map((path) => {
      return {
        original: path.trim(),
        comparable: comparablePath(path.trim()),
      };
    })
    .filter(({ comparable }) => pathContains(comparable, target))
    .sort((left, right) => right.comparable.value.length - left.comparable.value.length)[0]
    ?.original ?? null;
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
