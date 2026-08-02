const TAG_SEGMENT_RE = /^(?:[-_]|[^/\s\p{P}])+$/u;
const TAG_PATH_QUERY_RE = /^(?:[-_/]|[^/\s\p{P}])*$/u;

/** Keep the frontend tag grammar aligned with flowix-core's normalize_tag_path. */
export function isValidTagPath(value: string): boolean {
  if (!value || value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    return false;
  }

  return value.split('/').every((segment) => (
    TAG_SEGMENT_RE.test(segment)
    && [...segment].some((character) => character !== '-' && character !== '_')
  ));
}

/** Accept incomplete-but-typeable paths such as `project/` and `-` in mention queries. */
export function isValidTagPathQuery(value: string): boolean {
  return TAG_PATH_QUERY_RE.test(value);
}
