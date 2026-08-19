'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { getAgentType } from '@/lib/agent-types';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { deepseekHarness, windows } from '@platform/tauri/client';
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
  getAgentThreadCardUserHistoryMessagesFromMessages,
} from '@features/agent/thread-card/composer';
import { AgentRolePickerController } from '@features/agent/thread-card/role/agent-role-picker-controller';
import { ExternalAgentSettingsController } from '@features/agent/thread-card/settings/external-agent-settings-controller';
import { AgentConversationSurfaceController } from '@features/agent/thread-card/surface/agent-conversation-surface-controller';
import { BadgeHoverCard } from '@features/agent/thread-card/badge-hover-card';
import { computeAgentThreadCardBadgeData } from '@features/agent/thread-card/runtime/run-status-presenter';
import { createExternalAgentRuntimeHandle } from '@features/agent/services/external-agent-runtime-service';
import { ensureAgentConversationDetailThread } from '@features/agent/components/agent-conversation-detail-submit';
import { AgentIcon } from '@features/agent/components/agent-icon';

const BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 48;
const SCROLL_DELTA_EPSILON_PX = 0.5;
const INPUT_DRAFT_MAX_CHARS = 500;
const EMPTY_MESSAGES: ThreadState['messages'] = [];
const DETAIL_DRAFT_KEY_PREFIX = 'flowix:agent-conversation-draft:';
const logger = createLogger('agent-conversation-detail');

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
  const codexModel = useAgentSessionStore((state) => state.sessionMeta.settings.agentCodexModel);
  const messages = projection?.messages ?? EMPTY_MESSAGES;
  const isLoading = !!projection?.runs.isLoading;
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const domRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadingIndicatorRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const composerImagesRef = useRef<HTMLDivElement>(null);
  const composerRoleButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendButtonMountRef = useRef<HTMLSpanElement>(null);
  const messagesControllerRef = useRef<AgentThreadCardMessagesController | null>(null);
  const composerControllerRef = useRef<ComposerController | null>(null);
  const composerImagesControllerRef = useRef<ComposerImageController | null>(null);
  const rolePickerRef = useRef<AgentRolePickerController | null>(null);
  const surfaceRef = useRef<AgentConversationSurfaceController | null>(null);
  const draftRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const renderThreadIdRef = useRef<string | null>(renderThreadId);
  const typeKeyRef = useRef(instance?.agentType ?? 'flowix');
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
  typeKeyRef.current = instance?.agentType ?? 'flowix';
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
      void useAgentSessionStore.getState().sendMessageToThread(
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
    const composer = composerRef.current;
    const composerImages = composerImagesRef.current;
    const composerRoleButton = composerRoleButtonRef.current;
    const input = inputRef.current;
    const sendButtonMount = sendButtonMountRef.current;
    if (!dom || !body || !loadingIndicator || !composer || !composerImages || !composerRoleButton || !input || !sendButtonMount) return;

    destroyedRef.current = false;
    const settingsPopover = document.createElement('div');
    settingsPopover.className = 'agent-thread-card__codex-settings-popover';
    settingsPopover.setAttribute('role', 'menu');
    settingsPopover.hidden = true;
    document.body.append(settingsPopover);
    const rolePopover = document.createElement('div');
    rolePopover.className = 'agent-thread-card__composer-role-popover';
    rolePopover.setAttribute('role', 'menu');
    rolePopover.hidden = true;
    document.body.append(rolePopover);
    const externalSettings = new ExternalAgentSettingsController({
      popover: settingsPopover,
      getTypeKey: () => typeKeyRef.current,
      getInstanceId: () => instanceRef.current?.instanceId,
      getLanguage: () => languageRef.current,
      t: (key) => tRef.current(key),
      isDestroyed: () => destroyedRef.current,
    });
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
      t: (key) => tRef.current(key),
      isDestroyed: () => destroyedRef.current,
      getCurrentMemoId: () => instanceRef.current?.role?.memoId?.trim() || null,
      getCurrentName: () => instanceRef.current?.role?.name?.trim() || null,
      getMessageCount: () => messagesRef.current.length,
      updateRole: (role) => {
        const target = instanceRef.current;
        if (target) useAgentSessionStore.getState().upsertInstance(target.instanceId, { role });
      },
      consumeOutsidePointer: () => undefined,
      injectPrompt: (text) => {
        composerController.setHistoryValue(text, { persistDraft: true });
        composerController.resetHistoryNavigation();
        input.focus();
      },
      openPreferences: () => windows.openPreferences('tools'),
    });
    rolePicker.refreshIcon();
    messagesControllerRef.current = messageController;
    composerControllerRef.current = composerController;
    surfaceRef.current = surface;
    composerImagesControllerRef.current = composerImagesController;
    rolePickerRef.current = rolePicker;
    composerController.updateMultiLineState();

    return () => {
      destroyedRef.current = true;
      composerController.flushPendingDraft();
      surface.dispose();
      composerImagesController.dispose();
      rolePicker.dispose();
      externalSettings.dispose();
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
    });
    composerControllerRef.current?.setSendButtonState();
    rolePickerRef.current?.refreshIcon();
  }, [isLoading, messages]);

  if (!instance) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
        {t('status.agent.originUnavailable')}
      </div>
    );
  }

  const agent = getAgentType(instance.agentType);
  const badgeData = useMemo(
    () => computeAgentThreadCardBadgeData({
      threadState: projection
        ? {
            lastRun: projection.runs.lastRun,
            activeRunId: projection.runs.activeRunId,
            runs: projection.runs.runs,
          }
        : undefined,
      codexModel,
      typeKey: instance.agentType,
    }),
    [codexModel, instance.agentType, projection],
  );
  const runtimeCwd = (
    instance.runtimeConfig?.workspaceSnapshot?.cwd
    ?? instance.runtimeConfig?.cwd
    ?? ''
  ).trim() || undefined;
  const commitTitle = () => {
    const title = titleDraft.trim();
    if (title) {
      void useAgentSessionStore.getState().renameAgentConversation({
        instanceId: instance.instanceId,
        threadId: instance.threadId,
        title,
        typeKey: instance.agentType,
      });
    }
    setIsEditingTitle(false);
  };

  return (
    <section className="agent-conversation-detail markdown-editor flex h-full min-h-0 flex-col">
      <div className="agent-conversation-detail__header agent-thread-card__header">
        <div className="agent-thread-card__agent">
          <span className="agent-thread-card__badge-hover-wrapper">
            <BadgeHoverCard
              sessionId={renderThreadId ?? threadId ?? ''}
              model={badgeData.model}
              usage={badgeData.usage}
              onRequestRuntimeInfo={
                instance.agentType === 'deepseek-harness'
                  ? () =>
                      threadId
                        ? deepseekHarness.sessionUsage(threadId)
                        : Promise.resolve(null)
                  : undefined
              }
              cwd={runtimeCwd}
            />
            <span className="agent-type-badge" aria-hidden="true" title={agent.desc}>
              <AgentIcon typeKey={agent.key} alt="" className="agent-type-badge__icon" />
            </span>
          </span>
          {isEditingTitle ? (
            <div className="agent-thread-card__title">
              <input
                autoFocus
                value={titleDraft}
                className="agent-thread-card__title-input"
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitTitle();
                  }
                  if (event.key === 'Escape') setIsEditingTitle(false);
                }}
              />
            </div>
          ) : (
            <div
              className="agent-thread-card__title"
              onDoubleClick={() => {
                setTitleDraft(instance.title?.trim() || '');
                setIsEditingTitle(true);
              }}
            >
              {instance.title?.trim() || t('common.untitled')}
            </div>
          )}
        </div>
      </div>
      <div ref={domRef} className="agent-thread-card agent-conversation-detail__card flex min-h-0 flex-1 flex-col">
        <div ref={bodyRef} className="agent-thread-card__body" onScroll={() => messagesControllerRef.current?.handleScroll()}>
          <div ref={loadingIndicatorRef} className="agent-thread-card__loading-indicator" role="status" aria-live="polite">
            <span className="agent-thread-card__loading-cells" aria-hidden="true">
              {[0, 1, 2, 3].map((step) => (
                <span key={step} className="agent-thread-card__loading-cell" style={{ '--cell-step': String(step) } as CSSProperties} />
              ))}
            </span>
            <span className="agent-thread-card__loading-text" />
          </div>
        </div>
        <div ref={composerRef} className="agent-thread-card__composer">
          <div ref={composerImagesRef} className="agent-thread-card__composer-images" hidden />
          <button
            ref={composerRoleButtonRef}
            type="button"
            className="agent-thread-card__composer-role-icon"
            aria-haspopup="menu"
            aria-expanded="false"
            aria-label={t('editor.threadCard.selectRole')}
          />
          <textarea ref={inputRef} rows={1} placeholder={t('editor.threadCard.inputPlaceholder')} />
          <span ref={sendButtonMountRef} className="agent-thread-card__send-tooltip" />
        </div>
      </div>
    </section>
  );
}
