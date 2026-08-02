import { ArrowLeft, Check, CloudAlert, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MobileMarkdownEditor } from '@features/editor/mobile/mobile-markdown-editor';
import {
  joinMobileDocumentContent,
  splitMobileDocumentContent,
} from '@features/editor/mobile/mobile-document-content';
import { memos } from '@platform/tauri/client';

interface MobileDocumentScreenProps {
  memoId: string;
  filename: string;
  content: string;
  onBack: () => void;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

function displayTitle(filename: string): string {
  return filename.replace(/\.(?:md|markdown)$/i, '') || '未命名笔记';
}

export function MobileDocumentScreen({
  memoId,
  filename,
  content,
  onBack,
}: MobileDocumentScreenProps) {
  const initialParts = useMemo(() => splitMobileDocumentContent(content), [content]);
  const [body, setBody] = useState(initialParts.body);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const latestContentRef = useRef(content);
  const savedContentRef = useRef(content);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const saveLatest = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (savedContentRef.current !== latestContentRef.current) {
        const candidate = latestContentRef.current;
        const expected = savedContentRef.current;
        if (mountedRef.current) setSaveState('saving');
        try {
          const result = await memos.writeDocument({
            key: memoId,
            content: candidate,
            expectedContent: expected,
          });
          if (!result) {
            if (mountedRef.current) setSaveState('conflict');
            return;
          }
          savedContentRef.current = result.content;
          if (latestContentRef.current === candidate) {
            latestContentRef.current = result.content;
          }
        } catch {
          if (mountedRef.current) setSaveState('error');
          return;
        }
      }
      if (mountedRef.current) setSaveState('saved');
    } finally {
      savingRef.current = false;
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
    setSaveState('dirty');
    scheduleSave();
  }, [initialParts.frontmatter, scheduleSave]);

  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveLatest();
    onBack();
  }, [onBack, saveLatest]);

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
        <button type="button" className="mobile-icon-button" aria-label="返回列表" onClick={() => void handleBack()}>
          <ArrowLeft size={21} />
        </button>
        <div className="mobile-document-heading">
          <strong>{displayTitle(filename)}</strong>
          <span className={`mobile-save-status mobile-save-status--${saveState}`}>{status}</span>
        </div>
        <span className="mobile-topbar-spacer" />
      </header>
      <MobileMarkdownEditor key={memoId} content={body} onChange={handleBodyChange} />
    </main>
  );
}
