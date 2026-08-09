import { ArrowLeft, Check, CloudAlert, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MobileRichMarkdownEditor } from '@features/editor/mobile/mobile-rich-markdown-editor';
import {
  joinMobileDocumentContent,
  splitMobileDocumentContent,
} from '@features/editor/mobile/mobile-document-content';
import {
  calculateMobileViewportMetrics,
  MOBILE_EDITOR_VIEWPORT_CHANGE_EVENT,
} from '@features/editor/mobile/mobile-editor-viewport';
import { mobileClient } from '@platform/tauri/mobile-client';

interface MobileDocumentScreenProps {
  memoId: string;
  filename: string;
  content: string;
  manageHistory?: boolean;
  onBack: () => void;
  onBackRejected?: () => void;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
type SaveResult = 'saved' | 'conflict' | 'error';

interface MobileDocumentDraft {
  baseContent: string;
  content: string;
}

function draftKey(memoId: string): string {
  return `flowix:mobile-draft:${memoId}`;
}

function recoverDraft(memoId: string, diskContent: string): string {
  try {
    const raw = window.localStorage.getItem(draftKey(memoId));
    if (!raw) return diskContent;
    const draft = JSON.parse(raw) as Partial<MobileDocumentDraft>;
    return draft.baseContent === diskContent && typeof draft.content === 'string'
      ? draft.content
      : diskContent;
  } catch {
    return diskContent;
  }
}

function persistDraft(memoId: string, baseContent: string, content: string): void {
  try {
    window.localStorage.setItem(draftKey(memoId), JSON.stringify({ baseContent, content }));
  } catch {
    // Saving to the Rust backend remains authoritative when Web Storage is unavailable.
  }
}

function clearDraft(memoId: string): void {
  try {
    window.localStorage.removeItem(draftKey(memoId));
  } catch {
    // Ignore unavailable Web Storage.
  }
}

export function MobileDocumentScreen({
  memoId,
  content,
  manageHistory = true,
  onBack,
  onBackRejected,
}: MobileDocumentScreenProps) {
  const initialContent = useMemo(() => recoverDraft(memoId, content), [content, memoId]);
  const initialParts = useMemo(() => splitMobileDocumentContent(initialContent), [initialContent]);
  const [body, setBody] = useState(initialParts.body);
  const [saveState, setSaveState] = useState<SaveState>(initialContent === content ? 'saved' : 'dirty');
  const latestContentRef = useRef(initialContent);
  const savedContentRef = useRef(content);
  const savePromiseRef = useRef<Promise<SaveResult> | null>(null);
  const leavingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const root = document.documentElement;
    let animationFrame = 0;
    let resetLayoutBaseline = false;
    let layoutViewportWidth = Math.max(root.clientWidth, window.innerWidth);
    let layoutViewportHeight = Math.max(
      root.clientHeight,
      window.innerHeight,
      visualViewport?.height ?? 0,
    );

    const applyViewport = () => {
      animationFrame = 0;
      const currentLayoutWidth = Math.max(root.clientWidth, window.innerWidth);
      const currentLayoutHeight = Math.max(
        root.clientHeight,
        window.innerHeight,
        (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? 0),
      );
      if (resetLayoutBaseline || Math.abs(currentLayoutWidth - layoutViewportWidth) > 48) {
        layoutViewportHeight = currentLayoutHeight;
        layoutViewportWidth = currentLayoutWidth;
        resetLayoutBaseline = false;
      } else {
        layoutViewportHeight = Math.max(layoutViewportHeight, currentLayoutHeight);
      }

      const activeElement = document.activeElement;
      const editorFocused = activeElement instanceof Element
        && activeElement.closest('.mobile-markdown-editor__content') !== null;
      const metrics = calculateMobileViewportMetrics({
        layoutViewportHeight,
        visualViewportHeight: visualViewport?.height ?? window.innerHeight,
        visualViewportOffsetTop: visualViewport?.offsetTop ?? 0,
        editorFocused,
      });

      // Keep the document layout on the stable layout viewport. Only the
      // portalled keyboard toolbar follows this visual-viewport rectangle.
      // iOS pans offsetTop when focusing near the end of a long document, so
      // height without top/bottom is not a complete viewport description.
      root.style.setProperty('--mobile-visual-viewport-top', `${metrics.top}px`);
      root.style.setProperty('--mobile-visual-viewport-height', `${metrics.height}px`);
      root.style.setProperty('--mobile-visual-viewport-bottom', `${metrics.bottom}px`);
      root.style.setProperty('--mobile-keyboard-occlusion', `${metrics.keyboardOcclusion}px`);
      root.style.setProperty(
        '--mobile-editor-toolbar-safe-offset',
        metrics.keyboardOcclusion > 0 ? '0px' : 'env(safe-area-inset-bottom)',
      );
      window.dispatchEvent(new Event(MOBILE_EDITOR_VIEWPORT_CHANGE_EVENT));
    };

    const scheduleViewportUpdate = (resetBaseline = false) => {
      resetLayoutBaseline ||= resetBaseline;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(applyViewport);
    };

    const handleOrientationChange = () => scheduleViewportUpdate(true);
    const handleViewportChange = () => scheduleViewportUpdate();
    const handleFocusChange = () => scheduleViewportUpdate();

    applyViewport();
    visualViewport?.addEventListener('resize', handleViewportChange);
    visualViewport?.addEventListener('scroll', handleViewportChange);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('orientationchange', handleOrientationChange);
    document.addEventListener('focusin', handleFocusChange);
    document.addEventListener('focusout', handleFocusChange);
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      visualViewport?.removeEventListener('resize', handleViewportChange);
      visualViewport?.removeEventListener('scroll', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('orientationchange', handleOrientationChange);
      document.removeEventListener('focusin', handleFocusChange);
      document.removeEventListener('focusout', handleFocusChange);
      root.style.removeProperty('--mobile-visual-viewport-top');
      root.style.removeProperty('--mobile-visual-viewport-height');
      root.style.removeProperty('--mobile-visual-viewport-bottom');
      root.style.removeProperty('--mobile-keyboard-occlusion');
      root.style.removeProperty('--mobile-editor-toolbar-safe-offset');
    };
  }, []);

  const saveLatest = useCallback(async (): Promise<SaveResult> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const operation = (async (): Promise<SaveResult> => {
      while (savedContentRef.current !== latestContentRef.current) {
        const candidate = latestContentRef.current;
        const expected = savedContentRef.current;
        if (mountedRef.current) setSaveState('saving');
        try {
          const result = await mobileClient.memos.writeDocument({
            key: memoId,
            content: candidate,
            expectedContent: expected,
          });
          if (!result) {
            if (mountedRef.current) setSaveState('conflict');
            return 'conflict';
          }
          savedContentRef.current = result.content;
          if (latestContentRef.current === candidate) {
            latestContentRef.current = result.content;
          } else {
            persistDraft(memoId, result.content, latestContentRef.current);
          }
        } catch {
          if (mountedRef.current) setSaveState('error');
          return 'error';
        }
      }
      clearDraft(memoId);
      if (mountedRef.current) setSaveState('saved');
      return 'saved';
    })();
    savePromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      if (savePromiseRef.current === operation) savePromiseRef.current = null;
    }
  }, [memoId]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveLatest();
    }, 800);
  }, [saveLatest]);

  const handleBodyChange = useCallback((nextBody: string) => {
    setBody(nextBody);
    latestContentRef.current = joinMobileDocumentContent({
      frontmatter: initialParts.frontmatter,
      body: nextBody,
    });
    persistDraft(memoId, savedContentRef.current, latestContentRef.current);
    setSaveState('dirty');
    scheduleSave();
  }, [initialParts.frontmatter, memoId, scheduleSave]);

  useEffect(() => {
    if (latestContentRef.current !== savedContentRef.current) scheduleSave();
  }, [scheduleSave]);

  const handleBack = useCallback(async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const result = await saveLatest();
    if (result === 'saved') {
      onBack();
      return;
    }
    leavingRef.current = false;
    // history.back() has already consumed the document entry. Keep the user on
    // the editor after a failed/conflicting save and re-arm system Back.
    if (mountedRef.current) {
      window.history.pushState({ flowixMobileLayer: 'document' }, '');
      onBackRejected?.();
    }
  }, [onBack, onBackRejected, saveLatest]);
  const handleBackRef = useRef(handleBack);
  handleBackRef.current = handleBack;

  useEffect(() => {
    const handleSystemBack = () => void handleBackRef.current();
    if (manageHistory) window.history.pushState({ flowixMobileLayer: 'document' }, '');
    window.addEventListener('popstate', handleSystemBack);
    return () => window.removeEventListener('popstate', handleSystemBack);
  }, [manageHistory]);

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibility = () => {
      if (!document.hidden) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void saveLatest();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void saveLatest();
    };
  }, [saveLatest]);

  const status = saveState === 'saving'
    ? <><LoaderCircle className="is-spinning" size={16} /> 保存中</>
    : saveState === 'saved'
      ? <><Check size={16} /> 已保存</>
      : saveState === 'conflict'
        ? <><CloudAlert size={16} /> 发现同步冲突</>
        : saveState === 'error'
          ? <><CloudAlert size={16} /> 保存失败</>
          : '未保存';

  return (
    <main className="mobile-document-screen">
      <header className="mobile-topbar mobile-document-topbar">
        <button type="button" className="mobile-icon-button mobile-menu-button" aria-label="返回列表" onClick={() => window.history.back()}>
          <ArrowLeft size={21} />
        </button>
        <span />
        <span className={`mobile-save-status mobile-save-status--${saveState}`}>{status}</span>
      </header>
      <MobileRichMarkdownEditor key={memoId} memoId={memoId} content={body} onChange={handleBodyChange} />
    </main>
  );
}
