export interface MobileDocumentParts {
  frontmatter: string;
  body: string;
}

const FRONTMATTER_OPEN_RE = /^---(?:\r?\n|$)/;
const FRONTMATTER_CLOSE_RE = /^---[ \t]*(?:\r?\n|$)/gm;

export function splitMobileDocumentContent(content: string): MobileDocumentParts {
  const opening = FRONTMATTER_OPEN_RE.exec(content);
  if (!opening) return { frontmatter: '', body: content };

  FRONTMATTER_CLOSE_RE.lastIndex = opening[0].length;
  const closing = FRONTMATTER_CLOSE_RE.exec(content);
  if (!closing) return { frontmatter: '', body: content };

  const end = closing.index + closing[0].length;
  return {
    frontmatter: content.slice(0, end),
    body: content.slice(end),
  };
}

export function joinMobileDocumentContent(parts: MobileDocumentParts): string {
  return `${parts.frontmatter}${parts.body}`;
}
