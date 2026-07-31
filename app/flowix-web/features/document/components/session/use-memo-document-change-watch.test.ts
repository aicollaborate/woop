import { describe, expect, it } from 'vitest';

import type { DocumentIdentity } from '@features/document';
import type { MemoEvent } from '@/types/memo';

import {
  classifyUpdatedMemoDocumentAction,
  shouldReloadDocumentForTagsRenamed,
} from './use-memo-document-change-watch';

function tagsRenamed(affectedMemoIds: string[]): Extract<MemoEvent, { kind: 'tags_renamed' }> {
  return {
    kind: 'tags_renamed',
    notebookId: 'nb',
    renamedTags: [['中国', '华']],
    affectedMemoIds,
  };
}

const memoIdentity: DocumentIdentity = { kind: 'memo', id: 'memo-1' };
const externalIdentity: DocumentIdentity = { kind: 'external', path: '/notes/ext.md' };

describe('shouldReloadDocumentForTagsRenamed', () => {
  it('returns true when the current memo id is in affectedMemoIds and the doc is clean', () => {
    expect(shouldReloadDocumentForTagsRenamed(tagsRenamed(['memo-1']), memoIdentity, false)).toBe(true);
  });

  it('returns true even when affectedMemoIds contains other ids alongside the current one', () => {
    expect(shouldReloadDocumentForTagsRenamed(
      tagsRenamed(['memo-2', 'memo-1', 'memo-3']),
      memoIdentity,
      false,
    )).toBe(true);
  });

  it('returns false when the current memo id is not in affectedMemoIds', () => {
    expect(shouldReloadDocumentForTagsRenamed(tagsRenamed(['memo-2']), memoIdentity, false)).toBe(false);
  });

  it('returns false when affectedMemoIds is empty (no-op rename)', () => {
    expect(shouldReloadDocumentForTagsRenamed(tagsRenamed([]), memoIdentity, false)).toBe(false);
  });

  it('returns false when the document has unsaved local changes', () => {
    // 用户的本地草稿优先, 磁盘新内容不应覆盖。 warnAboutConflict 由调用方
    // 在判定后单独触发, 纯函数只关心"是否应该 reload"。
    expect(shouldReloadDocumentForTagsRenamed(tagsRenamed(['memo-1']), memoIdentity, true)).toBe(false);
  });

  it('returns false for an external document identity', () => {
    // tags_renamed 只跟 memo body 改写相关, 外部 .md 不在范围内。
    expect(shouldReloadDocumentForTagsRenamed(tagsRenamed(['memo-1']), externalIdentity, false)).toBe(false);
  });
});

describe('classifyUpdatedMemoDocumentAction', () => {
  const updatedEvent: Extract<MemoEvent, { kind: 'updated' }> = {
    kind: 'updated',
    id: 'memo-1',
    path: '/notes/current.md',
    notebookId: 'nb',
    memo: {} as Extract<MemoEvent, { kind: 'updated' }>['memo'],
    derivedChanged: { tags: false, todos: false, agents: false },
    source: 'external_tool',
  };

  it('reloads a clean current memo for an external tool update', () => {
    expect(classifyUpdatedMemoDocumentAction(
      updatedEvent,
      memoIdentity,
      false,
    )).toBe('reload');
  });

  it('retains an external update while the current memo is dirty', () => {
    expect(classifyUpdatedMemoDocumentAction(
      updatedEvent,
      memoIdentity,
      true,
    )).toBe('defer');
  });

  it('ignores an update for a different memo even if its path matches', () => {
    expect(classifyUpdatedMemoDocumentAction(
      { ...updatedEvent, id: 'memo-2' },
      memoIdentity,
      false,
    )).toBe('ignore');
  });

  it('ignores a legacy user_edit event without origin metadata', () => {
    expect(classifyUpdatedMemoDocumentAction(
      { ...updatedEvent, source: 'user_edit' },
      memoIdentity,
      false,
    )).toBe('ignore');
  });

  it('ignores a user_edit from the current window', () => {
    expect(classifyUpdatedMemoDocumentAction(
      { ...updatedEvent, source: 'user_edit', originWindowLabel: 'main' },
      memoIdentity,
      false,
      'main',
    )).toBe('ignore');
  });

  it('reloads a user_edit from another window using the committed path', () => {
    expect(classifyUpdatedMemoDocumentAction(
      {
        ...updatedEvent,
        source: 'user_edit',
        path: '/notes/renamed.md',
        originWindowLabel: 'tab-host-1',
      },
      memoIdentity,
      false,
      'main',
    )).toBe('reload');
  });
});
