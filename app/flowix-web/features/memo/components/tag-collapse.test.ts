import { describe, expect, it } from 'vitest';

import { markTagsCollapsedByAncestor } from '@features/memo/components/tag-collapse';
import type { MemoTagTreeItem } from '@features/memo/services/memo-list-metadata-service';

function tag(fullPath: string, parentId: string | null): MemoTagTreeItem {
  const lastSlash = fullPath.lastIndexOf('/');
  return {
    id: fullPath,
    parentId,
    name: lastSlash > 0 ? fullPath.slice(lastSlash + 1) : fullPath,
    fullPath,
    depth: (fullPath.match(/\//g) ?? []).length,
    count: 1,
  };
}

describe('markTagsCollapsedByAncestor', () => {
  it('hides every descendant of a collapsed tag', () => {
    const result = markTagsCollapsedByAncestor(
      [
        tag('AI', null),
        tag('AI/Agent', 'AI'),
        tag('AI/Agent/形态', 'AI/Agent'),
        tag('AI/Agent/形态/多智能体', 'AI/Agent/形态'),
      ],
      new Set(['AI/Agent']),
    );

    expect(result.map(({ id, collapsedByAncestor }) => [id, collapsedByAncestor])).toEqual([
      ['AI', false],
      ['AI/Agent', false],
      ['AI/Agent/形态', true],
      ['AI/Agent/形态/多智能体', true],
    ]);
  });

  it('does not let a nested collapsed tag expose a later branch', () => {
    const result = markTagsCollapsedByAncestor(
      [
        tag('AI', null),
        tag('AI/Agent', 'AI'),
        tag('AI/Agent/工程', 'AI/Agent'),
        tag('AI/Agent/形态', 'AI/Agent'),
        tag('AI/Agent/形态/多智能体', 'AI/Agent/形态'),
      ],
      new Set(['AI/Agent', 'AI/Agent/工程']),
    );

    expect(result.find((item) => item.id === 'AI/Agent/形态')?.collapsedByAncestor).toBe(true);
    expect(
      result.find((item) => item.id === 'AI/Agent/形态/多智能体')?.collapsedByAncestor,
    ).toBe(true);
  });

  it('uses parent relationships instead of array adjacency', () => {
    const result = markTagsCollapsedByAncestor(
      [
        tag('AI/Agent/形态/多智能体', 'AI/Agent/形态'),
        tag('其他', null),
        tag('AI/Agent', 'AI'),
        tag('AI', null),
        tag('AI/Agent/形态', 'AI/Agent'),
      ],
      new Set(['AI/Agent']),
    );

    expect(result[0].collapsedByAncestor).toBe(true);
  });
});
