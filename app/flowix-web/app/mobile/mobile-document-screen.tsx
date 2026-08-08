import { ArrowLeft, Check, CloudAlert, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MobileRichMarkdownEditor } from '@features/editor/mobile/mobile-rich-markdown-editor';
import {
  joinMobileDocumentContent,
  splitMobileDocumentContent,
} from '@features/editor/mobile/mobile-document-content';
import { mobileClient } from '@platform/tauri/mobile-client';

interface MobileDocumentScreenProps {
  memoId: string;
  filename: string;
  content: string;
  onBack: () => void;
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
  onBack,
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
    if (!visualViewport) return;

    const updateViewport = () => {
      const keyboardHeight = Math.max(
        0,
        window.innerHeight - visualViewport.height - visualViewport.offsetTop,
      );
      const screen = document.querySelector<HTMLElement>('.mobile-document-screen');
      if (!screen) return;
      screen.style.setProperty('--mobile-visual-viewport-height', `${visualViewport.height}px`);
      screen.style.setProperty('--mobile-keyboard-height', `${keyboardHeight}px`);
    };

    updateViewport();
    visualViewport.addEventListener('resize', updateViewport);
    visualViewport.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      visualViewport.removeEventListener('resize', updateViewport);
      visualViewport.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
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
    }
  }, [onBack, saveLatest]);
  const handleBackRef = useRef(handleBack);
  handleBackRef.current = handleBack;

  useEffect(() => {
    window.history.pushState({ flowixMobileLayer: 'document' }, '');
    const handleSystemBack = () => void handleBackRef.current();
    window.addEventListener('popstate', handleSystemBack);
    return () => window.removeEventListener('popstate', handleSystemBack);
  }, []);

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
    ? <><LoaderCircle className="is-spinning" size={14} /> 保存中</>
    : saveState === 'saved'
      ? <><Check size={14} /> 已保存</>
      : saveState === 'conflict'
        ? <><CloudAlert size={14} /> 发现同步冲突</>
        : saveState === 'error'
          ? <><CloudAlert size={14} /> 保存失败</>
          : '未保存';

  return (
    <main className="mobile-document-screen">
      <header className="mobile-topbar mobile-document-topbar">
        <button type="button" className="mobile-icon-button" aria-label="返回列表" onClick={() => window.history.back()}>
          <ArrowLeft size={21} />
        </button>
        <span />
        <span className={`mobile-save-status mobile-save-status--${saveState}`}>{status}</span>
      </header>
      <MobileRichMarkdownEditor key={memoId} memoId={memoId} content={body} onChange={handleBodyChange} />
    </main>
  );
}
