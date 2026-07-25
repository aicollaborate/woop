import { tags } from '@platform/tauri/client';
import {
  filterMentionTags,
  type MentionTagItem,
} from '@features/editor/extensions/tag-mention/tag-mention-filter';

export { filterMentionTags };
export type { MentionTagItem };

let cachedTags: MentionTagItem[] | null = null;
let tagCachePromise: Promise<MentionTagItem[]> | null = null;
let notebookIdProvider: () => string | null = () => null;

async function fetchMentionTags(): Promise<MentionTagItem[]> {
  const response = await tags.getAll(notebookIdProvider() ?? undefined);
  return (response.tags ?? []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    create: false,
  }));
}

function loadMentionTags(): Promise<MentionTagItem[]> {
  if (cachedTags) return Promise.resolve(cachedTags);
  if (!tagCachePromise) {
    tagCachePromise = fetchMentionTags()
      .then((items) => {
        cachedTags = items;
        return items;
      })
      .catch((err) => {
        console.warn('[tag-mention] load failed:', err);
        tagCachePromise = null;
        return [];
      });
  }
  return tagCachePromise;
}

export function setNotebookIdProvider(provider: () => string | null): void {
  notebookIdProvider = provider;
  invalidateMentionTags();
}

export function invalidateMentionTags(): void {
  cachedTags = null;
  tagCachePromise = null;
}

export async function queryMentionTags(query: string): Promise<MentionTagItem[]> {
  const allTags = await loadMentionTags();
  return filterMentionTags(allTags, query);
}
