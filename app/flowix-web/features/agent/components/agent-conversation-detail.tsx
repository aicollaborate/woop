'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';

import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { acquireThreadInterest } from '@features/agent/store/thread-interest';
import type { ThreadState } from '@features/agent/store/thread-runtime-state';
import {
  AgentThreadCardMessagesController,
  createThreadCacheSkeleton,
} from '@features/agent/thread-card/messages';
import {
  ComposerController,
  ComposerDraftController,
  ComposerImageController,
  createAgentComposerDom,
  disposeAgentComposerDom,
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from '@features/agent/thread-card/composer';
import { AgentRolePickerController } from '@features/agent/thread-card/role/agent-role-picker-controller';
import { ExternalAgentSettingsController } from '@features/agent/thread-card/settings/external-agent-settings-controller';
import { AgentConversationSurfaceController } from '@features/agent/thread-card/surface/agent-conversation-surface-controller';
import { createExternalAgentRuntimeHandle } from '@features/agent/services/external-agent-runtime-service';
import { ensureAgentConversationDetailThread } from '@features/agent/components/agent-conversation-detail-submit';
import { markConversationWorkspaceStarted } from '@features/agent/runtime/workspace-snapshot';

const BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 48;
const SCROLL_DELTA_EPSILON_PX = 0.5;
const INPUT_DRAFT_MAX_CHARS = 500;
const EMPTY_MESSAGES: ThreadState['messages'] = [];
const DETAIL_DRAFT_KEY_PREFIX = 'flowix:agent-conversation-draft:';
const logger = createLogger('agent-conversation-detail');

function shouldShowInitialHistorySkeleton(
  threadId: string | null,
  messageCount: number,
  status: 'idle' | 'loading' | 'ready' | 'error' | undefined,
): boolean {
  return Boolean(threadId)
    && messageCount === 0
    && status !== 'ready'
    && status !== 'error';
}

function detailDraftKey(instanceId: string): string {
  return `${DETAIL_DRAFT_KEY_PREFIX}${instanceId}`;
}

function readDetailDraft(instanceId: string): string {
  try {
    return window.localStorage.getItem(detailDraftKey(instanceId)) ?? '';
  } catch {
    return '';
  }
}

function persistDetailDraft(instanceId: string, draft: string | null): void {
  try {
    if (draft) window.localStorage.setItem(detailDraftKey(instanceId), draft);
    else window.localStorage.removeItem(detailDraftKey(instanceId));
  } catch {
    // Draft persistence is a convenience; a blocked storage backend must not
    // prevent an existing conversation from being resumed.
  }
}

/**
 * A document-independent host for an existing agent thread.
 *
 * Unlike the first implementation, this surface now uses the exact same
 * message viewport and composer controllers as the note-embedded Thread Card.
 * ProseMirror-only concerns (node attrs, collapse and delete) deliberately
 * remain in AgentThreadCardView; this host keeps the shared conversation
 * chrome, including title editing, above its message viewport.
 */
export function AgentConversationDetail({
  instanceId,
}: {
  instanceId: string;
}) {
  const { language, t } = useI18n();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const threadId = instance?.threadId ?? null;
  const renderThreadId = threadId;
  const projection = useAgentSessionStore((state) => (
    renderThreadId ? state.threadProjections[renderThreadId] : undefined
  ));
  const messages = projection?.messages ?? EMPTY_MESSAGES;
  const isLoading = !!projection?.runs.isLoading;
  const initialHistoryStatus = projection?.pagination.initialStatus ?? 'idle';
  const isInitialHistoryLoading = shouldShowInitialHistorySkeleton(
    threadId,
    messages.length,
    initialHistoryStatus,
  );
  const domRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadingIndicatorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesControllerRef = useRef<AgentThreadCardMessagesController | null>(null);
  const composerControllerRef = useRef<ComposerController | null>(null);
  const composerImagesControllerRef = useRef<ComposerImageController | null>(null);
  const externalSettingsRef = useRef<ExternalAgentSettingsController | null>(null);
  const rolePickerRef = useRef<AgentRolePickerController | null>(null);
  const surfaceRef = useRef<AgentConversationSurfaceController | null>(null);
  const draftRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const renderThreadIdRef = useRef<string | null>(renderThreadId);
  const typeKeyRef = useRef<AgentTypeKey>(instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY);
  const messagesRef = useRef(messages);
  const isLoadingRef = useRef(isLoading);
  const instanceRef = useRef(instance);
  const threadIdRef = useRef(threadId);
  const runtimeHandleRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const languageRef = useRef(language);
  const tRef = useRef(t);
  const submitRef = useRef<() => void>(() => undefined);

  renderThreadIdRef.current = renderThreadId;
  typeKeyRef.current = instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY;
  messagesRef.current = messages;
  isLoadingRef.current = isLoading;
  instanceRef.current = instance;
  threadIdRef.current = threadId;
  languageRef.current = language;
  tRef.current = t;

  const submit = useCallback(async () => {
    // 线程绑定是异步的; submittingRef 挡住"创建中"期间的重入, 避免快速双击
    // 在 threadId 尚未回写时重复 createThread (笔记内嵌卡片的 isCreating 同理)。
    if (submittingRef.current || isLoadingRef.current) return;
    const input = inputRef.current;
    const currentInstance = instanceRef.current;
    const content = input?.value.trim() ?? '';
    const imagePaths = composerImagesControllerRef.current?.readyImages.map((image) => image.path) ?? [];
    if (!input || (!content && imagePaths.length === 0) || !currentInstance) return;

    submittingRef.current = true;
    try {
      let targetThreadId = threadIdRef.current;
      let conversationTitle = currentInstance.title;
      let runtimeConfig = currentInstance.runtimeConfig ?? null;
      const isFirstMessage = !targetThreadId;

      if (!targetThreadId) {
        // 空独立对话的首条消息: 先绑定产品线程 (flowix -> createThread;
        // 外部 CLI -> local thread id), 再冻结 workspace snapshot, 最后才 dispatch。
        if (!runtimeHandleRef.current) {
          runtimeHandleRef.current = createExternalAgentRuntimeHandle();
        }
        const ensured = await ensureAgentConversationDetailThread({
          instanceId: currentInstance.instanceId,
          typeKey: currentInstance.agentType,
          prompt: content || 'Analyze the attached image(s).',
          runtimeHandleId: runtimeHandleRef.current,
        });
        targetThreadId = ensured.threadId;
        conversationTitle = ensured.title;
        runtimeConfig = ensured.runtimeConfig;
      }

      input.value = '';
      persistDetailDraft(currentInstance.instanceId, null);
      composerControllerRef.current?.resetHistoryNavigation();
      composerControllerRef.current?.clearDraft();
      composerControllerRef.current?.updateMultiLineState();
      composerImagesControllerRef.current?.clearAfterSubmit();
      await useAgentSessionStore.getState().sendMessageToThread(
        targetThreadId,
        content || 'Analyze the attached image(s).',
        currentInstance.agentType,
        {
          instanceId: currentInstance.instanceId,
          conversationTitle,
          isFirstMessage,
          runtimeConfig,
          imagePaths,
        },
      );
      // Keep desired/applied revision bookkeeping correct on follow-up turns.
      // The send action has accepted the request at this point; runtime errors
      // are still represented by the normal stream error event.
      markConversationWorkspaceStarted(currentInstance.instanceId);
    } catch (err) {
      // 仅线程创建/绑定失败会走到这里; 输入与草稿保持原样以便重试。
      logger.error('Failed to create conversation thread', { error: String(err) });
      toast.error(tRef.current('agent.chat.sendFailed'));
    } finally {
      submittingRef.current = false;
    }
  }, []);
  submitRef.current = submit;

  useEffect(() => {
    if (!threadId || !instance) return;
    const store = useAgentSessionStore.getState();
    const release = acquireThreadInterest(threadId);
    void store.loadMessages(instance.agentType, threadId);
    return release;
  }, [instance, threadId]);

  useLayoutEffect(() => {
    const dom = domRef.current;
    const body = bodyRef.current;
    const loadingIndicator = loadingIndicatorRef.current;
    if (!dom || !body || !loadingIndicator) return;

    const composerParts = createAgentComposerDom({
      variant: 'expanded',
      t: (key) => tRef.current(key),
    });
    dom.append(composerParts.composer);
    const {
      composer,
      composerImages,
      composerActions,
      composerRoleIcon: composerRoleButton,
      input,
      codexSettingsPopover: settingsPopover,
      composerRolePopover: rolePopover,
      sendButtonMount,
    } = composerParts;
    inputRef.current = input;

    destroyedRef.current = false;
    const externalSettings = new ExternalAgentSettingsController({
      popover: settingsPopover,
      getTypeKey: () => typeKeyRef.current,
      getInstanceId: () => instanceRef.current?.instanceId,
      getLanguage: () => languageRef.current,
      t: (key) => tRef.current(key),
      isDestroyed: () => destroyedRef.current,
      isRunning: () => isLoadingRef.current || submittingRef.current,
    });
    externalSettingsRef.current = externalSettings;
    const composerModelButton = externalSettings.createComposerModelButton();
    if (composerModelButton) composerActions.append(composerModelButton);
    const composerPermissionButton = externalSettings.createComposerPermissionButton();
    if (composerPermissionButton) composerActions.append(composerPermissionButton);
    const composerWorkspaceButton = externalSettings.createComposerWorkspaceButton();
    if (composerWorkspaceButton) composerActions.append(composerWorkspaceButton);
    externalSettings.loadDefaultModel();
    const composerDraft = new ComposerDraftController({
      persistDelayMs: 0,
      persist: (draft) => {
        draftRef.current = draft;
        persistDetailDraft(instanceId, draft);
      },
    });
    const restoredDraft = readDetailDraft(instanceId);
    if (restoredDraft) {
      input.value = restoredDraft;
      draftRef.current = restoredDraft;
    }
    const composerImagesController = new ComposerImageController({
      input,
      container: composerImages,
      initialImages: [],
      onChange: () => undefined,
      onStateChange: () => composerControllerRef.current?.setSendButtonState(),
      onError: (message) => toast.error(message),
      onLimitExceeded: (kind) => toast.warning(tRef.current(
        kind === 'size' ? 'editor.threadCard.imageSizeLimit' : 'editor.threadCard.imageCountLimit',
      )),
    });
    let messageController: AgentThreadCardMessagesController;
    const surface = new AgentConversationSurfaceController({
      dom,
      body,
      loadingIndicator,
      composer,
      input,
      sendButtonMount,
      messageOptions: {
        bottomFollowThresholdPx: BOTTOM_FOLLOW_THRESHOLD_PX,
        topHistoryLoadThresholdPx: TOP_HISTORY_LOAD_THRESHOLD_PX,
        scrollDeltaEpsilonPx: SCROLL_DELTA_EPSILON_PX,
        isDestroyed: () => destroyedRef.current,
        isCollapsed: () => false,
        isFullscreen: () => true,
        getThreadId: () => threadIdRef.current,
        getRuntimeThreadId: () => renderThreadIdRef.current,
        getConversationMessageState: () => {
          const id = renderThreadIdRef.current;
          return id ? useAgentSessionStore.getState().getMessageState(id) : null;
        },
        loadMoreMessages: (id) => {
          void useAgentSessionStore.getState().loadMoreMessages(typeKeyRef.current, id);
        },
        getLanguage: () => languageRef.current,
        getTypeKey: () => typeKeyRef.current,
        getMessageCount: () => messagesRef.current.length,
        shouldLoadThreadMessages: () => false,
        renderThreadState: () => {
          messageController.render({
            messages: messagesRef.current,
            isLoading: isLoadingRef.current,
            shouldRenderMessages: true,
            isInitialHistoryLoading: shouldShowInitialHistorySkeleton(
              renderThreadIdRef.current,
              messagesRef.current.length,
              renderThreadIdRef.current
                ? useAgentSessionStore.getState()
                    .threadProjections[renderThreadIdRef.current]?.pagination.initialStatus
                : undefined,
            ),
          });
        },
        renderResolvedSessionMessages: (resolvedMessages) => {
          const id = renderThreadIdRef.current;
          if (id) useAgentSessionStore.getState().mergeMessages(typeKeyRef.current, id, resolvedMessages);
        },
        applyResolvedSession: (localThreadId, sessionId, typeKey) => {
          useAgentSessionStore.getState().applySessionResolved({
            kind: 'session_resolved', agentType: typeKey, threadId: localThreadId,
            sessionId, runId: sessionId, timestamp: Date.now(),
          });
        },
        t: (key) => tRef.current(key),
        createThreadCacheSkeleton: () => createThreadCacheSkeleton(tRef.current('editor.threadCard.loadingThreadCache')),
        createExternalAgentEmptySettings: () => externalSettings.createEmptySettings(),
      },
      composerOptions: {
        draft: composerDraft,
        inputDraftMaxChars: INPUT_DRAFT_MAX_CHARS,
        getCurrentInputDraft: () => draftRef.current ?? '',
        getUserHistoryMessages: () => getAgentThreadCardUserHistoryMessagesFromMessages(messagesRef.current),
        getSendLabel: (wantStop) => tRef.current(wantStop ? 'editor.threadCard.stop' : 'editor.threadCard.send'),
        getSendButtonWantsStop: () => isLoadingRef.current,
        getHasAttachments: () => composerImagesController.hasImages,
        getHasPendingAttachments: () => composerImagesController.hasPending,
        submit: () => submitRef.current(),
        stop: () => {
          const id = renderThreadIdRef.current;
          if (id) void useAgentSessionStore.getState().stopThreadRun(id);
        },
      },
    });
    messageController = surface.messages;
    const composerController = surface.composer;
    const rolePicker = new AgentRolePickerController({
      trigger: composerRoleButton,
      popover: rolePopover,
      // 必须把 params 透传给 tRef.current ── formatTimeAgo 走的是
      // t('memo.time.minutesAgo', { m }) 这种带参调用, 老 wrapper
      // (key) => tRef.current(key) 会丢掉 params, 让 translate 拿到
      // undefined, 文案就只剩 "{m} 分钟前" 字面量, 数字永远不替换。
      t: (key, params) => tRef.current(key, params),
      isDestroyed: () => destroyedRef.current,
      getCurrentMemoId: () => instanceRef.current?.role?.memoId?.trim() || null,
      getCurrentName: () => instanceRef.current?.role?.name?.trim() || null,
      getMessageCount: () => messagesRef.current.length,
      updateRole: (role) => {
        const target = instanceRef.current;
        if (target) useAgentSessionStore.getState().upsertInstance(target.instanceId, { role });
      },
      consumeOutsidePointer: () => undefined,
      injectMemoReference: (ref) => {
        // 文档引用注入到当前 composer, 以 markdown 深链形式追加,
        // 与 thread-card-view 里的 injectMemoReference 走相同 pattern。
        const link = `[${ref.title}](flowix://memo/${ref.id})`;
        const current = input.value;
        const needsLeadingSpace = current.length > 0 && !/\s$/.test(current);
        const separator = needsLeadingSpace ? '\n\n' : '';
        composerController.setHistoryValue(current + separator + link, { persistDraft: true });
        composerController.resetHistoryNavigation();
        input.focus();
      },
    });
    rolePicker.refreshIcon();
    messagesControllerRef.current = messageController;
    composerControllerRef.current = composerController;
    surfaceRef.current = surface;
    composerImagesControllerRef.current = composerImagesController;
    rolePickerRef.current = rolePicker;
    composerController.updateMultiLineState();
    // Paint the selected thread's initial state in the same layout pass. The
    // history request starts in a passive effect, so waiting for the normal
    // subscription effect would leave one blank frame between item selection
    // and the skeleton.
    messageController.render({
      messages: messagesRef.current,
      isLoading: isLoadingRef.current,
      shouldRenderMessages: true,
      isInitialHistoryLoading: shouldShowInitialHistorySkeleton(
        renderThreadIdRef.current,
        messagesRef.current.length,
        renderThreadIdRef.current
          ? useAgentSessionStore.getState()
              .threadProjections[renderThreadIdRef.current]?.pagination.initialStatus
          : undefined,
      ),
    });

    return () => {
      destroyedRef.current = true;
      composerController.flushPendingDraft();
      surface.dispose();
      composerImagesController.dispose();
      rolePicker.dispose();
      externalSettings.dispose();
      externalSettingsRef.current = null;
      disposeAgentComposerDom(composerParts);
      inputRef.current = null;
      messagesControllerRef.current = null;
      composerControllerRef.current = null;
      surfaceRef.current = null;
      composerImagesControllerRef.current = null;
      rolePickerRef.current = null;
    };
  }, []);

  useEffect(() => {
    messagesControllerRef.current?.render({
      messages,
      isLoading,
      shouldRenderMessages: true,
      isInitialHistoryLoading,
    });
    composerControllerRef.current?.setSendButtonState();
    rolePickerRef.current?.refreshIcon();
  }, [isInitialHistoryLoading, isLoading, messages]);

  useEffect(() => {
    externalSettingsRef.current?.refreshEmptySettings();
  }, [instance?.threadId, isLoading]);

  if (!instance) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
        {t('status.agent.conversationNotFound')}
      </div>
    );
  }

  return (
    <section className="agent-conversation-detail markdown-editor flex h-full min-h-0 flex-col">
      <div ref={domRef} className="agent-thread-card agent-conversation-detail__card flex min-h-0 flex-1 flex-col">
        <div
          ref={bodyRef}
          className="agent-thread-card__body"
          data-no-context-menu-scroll
          onScroll={() => messagesControllerRef.current?.handleScroll()}
        >
          <div ref={loadingIndicatorRef} className="agent-thread-card__loading-indicator" role="status" aria-live="polite">
            <span className="agent-thread-card__loading-cells" aria-hidden="true">
              {[0, 1, 2, 3].map((step) => (
                <span key={step} className="agent-thread-card__loading-cell" style={{ '--cell-step': String(step) } as CSSProperties} />
              ))}
            </span>
            <span className="agent-thread-card__loading-text" />
          </div>
        </div>
      </div>
    </section>
  );
}
