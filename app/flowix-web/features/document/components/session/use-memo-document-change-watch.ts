import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@platform/tauri/window';

import {
  documentIdentityKey,
  hasDocumentUnsavedChanges,
  subscribeDocumentBufferChanges,
  type DocumentIdentity,
} from '@features/document';
import { translate } from '@/lib/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { toast } from '@/lib/toast';
import { canonicalPath } from '@/lib/path';
import { registerMemoEventHandler } from '@/lib/memo-dispatcher';
import type { MemoEvent } from '@/types/memo';
import {
  handleSiblingWindowContentUpdate,
  type MemoContentUpdatedEvent,
} from './sibling-window-document-sync';

interface Options {
  filePath: string;
  identity: DocumentIdentity;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options?: { preservePending?: boolean; showLoading?: boolean }) => Promise<void>;
}

const CONFLICT_WARNING_COOLDOWN_MS = 5000;

/**
 * `tags_renamed` 事件的 reload 判定 ── 抽成纯函数以便单测。
 *
 * `true` 表示应当把当前打开的 memo 文档 reload 到磁盘最新内容 (含新
 * `#tag` token); `false` 表示不该动 (无关 memo / dirty 草稿 / 不是
 * memo 文档)。
 */
export function shouldReloadDocumentForTagsRenamed(
  event: Extract<MemoEvent, { kind: 'tags_renamed' }>,
  identity: DocumentIdentity,
  isDirty: boolean,
): boolean {
  if (identity.kind !== 'memo') return false;
  if (!event.affectedMemoIds.includes(identity.id)) return false;
  if (isDirty) return false;
  return true;
}

/**
 * `tags_deleted` 事件的 reload 判定 ── 与 tags_renamed 同形, 但语义
 * 是 "tag token 被移除, 需要重新加载去掉这些 token 后的 body"。
 */
export function shouldReloadDocumentForTagsDeleted(
  event: Extract<MemoEvent, { kind: 'tags_deleted' }>,
  identity: DocumentIdentity,
  isDirty: boolean,
): boolean {
  if (identity.kind !== 'memo') return false;
  if (!event.affectedMemoIds.includes(identity.id)) return false;
  if (isDirty) return false;
  return true;
}

export type UpdatedMemoDocumentAction = 'ignore' | 'defer' | 'reload';

export function classifyUpdatedMemoDocumentAction(
  event: MemoEvent,
  identity: DocumentIdentity,
  filePath: string,
  isDirty: boolean,
): UpdatedMemoDocumentAction {
  if (identity.kind !== 'memo') return 'ignore';
  if (event.kind !== 'updated' || event.source === 'user_edit' || !event.path) return 'ignore';
  if (event.id !== identity.id) return 'ignore';
  if (canonicalPath(event.path) !== canonicalPath(filePath)) return 'ignore';
  return isDirty ? 'defer' : 'reload';
}

export function useMemoDocumentChangeWatch({
  filePath,
  identity,
  clearSaveTimer,
  reloadDocument,
}: Options) {
  const lastConflictWarningAtRef = useRef(0);
  const pendingExternalReloadRef = useRef(false);

  useEffect(() => {
    if (!filePath || identity.kind !== 'memo') return;
    let disposed = false;

    const reloadLatestExternalContent = async () => {
      pendingExternalReloadRef.current = false;
      clearSaveTimer();
      await reloadDocument(filePath, { preservePending: false, showLoading: false });
    };

    const deferExternalReloadUntilClean = () => {
      pendingExternalReloadRef.current = true;
    };

    const unsubscribeBufferChanges = subscribeDocumentBufferChanges((changedIdentity) => {
      if (disposed || !pendingExternalReloadRef.current) return;
      if (documentIdentityKey(changedIdentity) !== documentIdentityKey(identity)) return;
      if (hasDocumentUnsavedChanges(identity)) return;
      void reloadLatestExternalContent();
    });
    const warnAboutConflict = () => {
      if (!hasDocumentUnsavedChanges(identity)) return;
      if (Date.now() - lastConflictWarningAtRef.current < CONFLICT_WARNING_COOLDOWN_MS) return;
      lastConflictWarningAtRef.current = Date.now();
      const language = useUserSettingsStore.getState().settings.language;
      toast.warning(translate(language, 'document.external.changeWarning'), { duration: 5000 });
    };

    const unsubscribeMemoEvents = registerMemoEventHandler(
      async (event: MemoEvent) => {
        // tags_renamed: move_memo_tag 批量改写 .md body 完成后的一次性事件。
        // 当前打开的 memo 如果在被改写的 affectedMemoIds 列表里, 需要
        // reloadDocument 把磁盘最新内容 (含新 tag token) 拉进来, 否则
        // 编辑器还显示旧 #tag, 跟列表卡片不一致。
        if (event.kind === 'tags_renamed') {
          const isDirty = hasDocumentUnsavedChanges(identity);
          if (!shouldReloadDocumentForTagsRenamed(event, identity, isDirty)) {
            if (isDirty) warnAboutConflict();
            return;
          }
          clearSaveTimer();
          await reloadDocument(filePath, { preservePending: false, showLoading: false });
          return;
        }
        // tags_deleted: delete_memo_tag 一次性清理 YAML 与正文来源。当前
        // 打开的 memo 如果在 affectedMemoIds 里，需要 reload 最新内容。
        if (event.kind === 'tags_deleted') {
          const isDirty = hasDocumentUnsavedChanges(identity);
          if (!shouldReloadDocumentForTagsDeleted(event, identity, isDirty)) {
            if (isDirty) warnAboutConflict();
            return;
          }
          clearSaveTimer();
          await reloadDocument(filePath, { preservePending: false, showLoading: false });
          return;
        }
        const action = classifyUpdatedMemoDocumentAction(
          event,
          identity,
          filePath,
          hasDocumentUnsavedChanges(identity),
        );
        if (action === 'ignore') return;
        if (action === 'defer') {
          warnAboutConflict();
          deferExternalReloadUntilClean();
          return;
        }
        await reloadLatestExternalContent();
      },
      (event) =>
        // tags_renamed / tags_deleted: 接收 ── 但内部按 affectedMemoIds 收窄。
        // updated: 走 user_edit 排除分支 (与原行为一致)。
        event.kind === 'tags_renamed'
        || event.kind === 'tags_deleted'
        || (event.kind === 'updated' && event.source !== 'user_edit'),
    );

    let unsubscribeContentUpdates: (() => void) | null = null;
    void getCurrentWindow().listen<MemoContentUpdatedEvent>(
      'memo-content-updated',
      async ({ payload: event }) => {
        if (disposed) return;
        await handleSiblingWindowContentUpdate({
          event,
          identity,
          isDirty: hasDocumentUnsavedChanges(identity),
          onConflict: warnAboutConflict,
          clearSaveTimer,
          reloadDocument,
        });
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else unsubscribeContentUpdates = unlisten;
    }).catch((error) => {
      console.warn('[memo-content-updated] listen failed:', error);
    });

    return () => {
      disposed = true;
      pendingExternalReloadRef.current = false;
      unsubscribeBufferChanges();
      unsubscribeMemoEvents();
      unsubscribeContentUpdates?.();
    };
  }, [filePath, identity, clearSaveTimer, reloadDocument]);
}
