export interface MentionTagItem {
  id: string;
  name: string;
  /** 是否是“新建”占位项 */
  create: boolean;
}

function normalizeTagName(query: string): string {
  return query.trim().replace(/^#+/, '').replace(/\s+/g, '');
}

export function filterMentionTags(
  tags: readonly Pick<MentionTagItem, 'id' | 'name'>[],
  query: string,
): MentionTagItem[] {
  const normalizedName = normalizeTagName(query);
  const normalizedQuery = normalizedName.toLowerCase();
  const allTags = tags.map((tag) => ({ ...tag, create: false }));
  if (!normalizedQuery) return allTags;

  const matched = allTags.filter(
    (tag) => tag.name.toLowerCase().includes(normalizedQuery),
  );
  const exact = matched.some(
    (tag) => tag.name.toLowerCase() === normalizedQuery,
  );
  if (!exact && normalizedName) {
    matched.unshift({
      id: normalizedQuery,
      name: normalizedName,
      create: true,
    });
  }
  return matched;
}
