import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

import {
  MobileRichMarkdownEditor,
  type MobileEditorToolbarAction,
} from './mobile-rich-markdown-editor';

interface EditorCommand {
  type?: string;
  memoId?: string;
  content?: string;
  emitUpdate?: boolean;
  action?: MobileEditorToolbarAction;
  enabled?: boolean;
}

interface EditorFormatState {
  focused: boolean;
  bold: boolean;
  italic: boolean;
  heading: 1 | 2 | null;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
}

interface EditorEvent {
  type: 'ready' | 'changed' | 'error' | 'diagnostic' | 'formatState' | 'motion' | 'attachmentBegin' | 'attachmentChunk' | 'attachmentFinish' | 'attachmentCancel';
  memoId?: string;
  markdown?: string;
  message?: string;
  state?: EditorFormatState;
  motion?: Record<string, unknown>;
}

interface NativeEditorResponse {
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

interface WebKitMessageHandler {
  postMessage: (message: EditorEvent) => void;
}

interface EditorWindow extends Window {
  flowixMotionDiagnosticsEnabled?: boolean;
  webkit?: {
    messageHandlers?: {
      flowixEditor?: WebKitMessageHandler;
    };
  };
}

function sendEditorEvent(event: EditorEvent): void {
  try {
    const handler = (window as EditorWindow).webkit?.messageHandlers?.flowixEditor;
    handler?.postMessage(event);
  } catch (error) {
    // Keep bridge failures visible to the native shell. This is intentionally
    // best-effort because the error itself may happen before the bridge exists.
    console.error('[NativeEditor] failed to post bridge event', error);
  }
}

function sendMotion(event: string, extra: Record<string, unknown> = {}): void {
  if (!(window as EditorWindow).flowixMotionDiagnosticsEnabled) return;
  const viewport = window.visualViewport;
  sendEditorEvent({
    type: 'motion',
    motion: {
      event,
      timestamp: Math.round(performance.now()),
      viewportHeight: Math.round(viewport?.height ?? window.innerHeight),
      viewportOffsetTop: Math.round(viewport?.offsetTop ?? 0),
      windowScrollY: Math.round(window.scrollY),
      ...extra,
    },
  });
}

function requestNativeAttachment<T>(payload: Record<string, unknown>): Promise<T> {
  const requestId = `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('flowix-editor-response', receiveResponse);
      reject(new Error('原生附件请求超时。'));
    }, 120_000);
    const receiveResponse = (event: Event) => {
      const response = (event as CustomEvent<NativeEditorResponse>).detail;
      if (!response || response.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener('flowix-editor-response', receiveResponse);
      if (!response.ok) reject(new Error(response.error || '原生附件请求失败。'));
      else resolve((response.result || {}) as T);
    };
    window.addEventListener('flowix-editor-response', receiveResponse);
    sendEditorEvent({ ...payload, requestId } as unknown as EditorEvent);
  });
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error('无法读取附件。'));
    reader.readAsDataURL(blob);
  });
}

function createNativeAttachmentUploader(memoId: string) {
  return async ({ file, fileName }: { file: File; fileName: string }): Promise<string> => {
    const maxBytes = 25 * 1024 * 1024;
    const chunkBytes = 512 * 1024;
    if (file.size <= 0 || file.size > maxBytes) throw new Error('单个附件不能超过 25 MB。');
    const started = await requestNativeAttachment<{ uploadId: string }>({
      type: 'attachmentBegin', fileName, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, memoId,
    });
    try {
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        const chunk = file.slice(offset, Math.min(offset + chunkBytes, file.size));
        await requestNativeAttachment({
          type: 'attachmentChunk', uploadId: started.uploadId, content: await readBlobAsBase64(chunk),
        });
      }
      const finished = await requestNativeAttachment<{ storageKey: string }>({
        type: 'attachmentFinish', uploadId: started.uploadId,
      });
      return finished.storageKey;
    } catch (error) {
      void requestNativeAttachment({ type: 'attachmentCancel', uploadId: started.uploadId }).catch(() => undefined);
      throw error;
    }
  };
}

export function NativeEditorWebViewApp() {
  const [memoId, setMemoId] = useState('native-preview');
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState(0);
  const [externalContent, setExternalContent] = useState<{
    value: string;
    emitUpdate: boolean;
    token: number;
  } | undefined>();
  const [nativeToolbarAction, setNativeToolbarAction] = useState<{
    action: MobileEditorToolbarAction;
    token: number;
  } | undefined>();
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const contentRef = useRef(content);
  const editorRef = useRef<Editor | null>(null);
  const toolbarActionTokenRef = useRef(0);
  contentRef.current = content;

  useEffect(() => {
    const receiveCommand = (event: Event) => {
      const command = (event as CustomEvent<EditorCommand>).detail;
      if (!command) return;
      if (command.type === 'setMotionDiagnostics') {
        (window as EditorWindow).flowixMotionDiagnosticsEnabled = command.enabled === true;
        if (command.enabled) sendMotion('enabled');
        return;
      }
      if (command.type === 'toolbarAction' && command.action) {
        setNativeToolbarAction({ action: command.action, token: ++toolbarActionTokenRef.current });
        return;
      }
      if (command.type === 'applyContent') {
        const nextContent = command.content || '';
        setContent(nextContent);
        setExternalContent({
          value: nextContent,
          emitUpdate: command.emitUpdate ?? false,
          token: Date.now(),
        });
        // `setContent` is deliberately silent for normal native loads. When
        // a caller explicitly asks for an emitting command, report the value
        // from Tiptap's document after applying it. This also keeps the
        // bridge deterministic across Tiptap versions where setContent does
        // not invoke onUpdate for programmatic transactions.
        if (command.emitUpdate && editorRef.current) {
          window.setTimeout(() => {
            sendEditorEvent({
              type: 'changed',
              memoId,
              markdown: editorRef.current?.getMarkdown() || nextContent,
            });
          }, 0);
        }
        return;
      }
      if (command.type !== 'setContent') return;
      setMemoId(command.memoId || 'native-preview');
      const nextContent = command.content || '';
      setContent(nextContent);
      setExternalContent({ value: nextContent, emitUpdate: false, token: Date.now() });
      if (!editorRef.current) {
        setRevision((value) => value + 1);
      }
    };

    window.addEventListener('flowix-editor-command', receiveCommand);
    sendEditorEvent({ type: 'ready' });
    return () => window.removeEventListener('flowix-editor-command', receiveCommand);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const reportViewportChange = () => sendMotion('visualViewport', { focused: editorRef.current?.isFocused ?? false });
    viewport?.addEventListener('resize', reportViewportChange);
    viewport?.addEventListener('scroll', reportViewportChange);
    window.addEventListener('scroll', reportViewportChange, { passive: true });
    sendMotion('webReady');
    return () => {
      viewport?.removeEventListener('resize', reportViewportChange);
      viewport?.removeEventListener('scroll', reportViewportChange);
      window.removeEventListener('scroll', reportViewportChange);
    };
  }, []);

  useEffect(() => {
    if (!editorInstance) return;
    let previousState = '';
    const reportFormatState = () => {
      const state: EditorFormatState = {
        focused: editorInstance.isFocused,
        bold: editorInstance.isActive('bold'),
        italic: editorInstance.isActive('italic'),
        heading: editorInstance.isActive('heading', { level: 1 })
          ? 1
          : editorInstance.isActive('heading', { level: 2 }) ? 2 : null,
        bulletList: editorInstance.isActive('bulletList'),
        orderedList: editorInstance.isActive('orderedList'),
        taskList: editorInstance.isActive('taskList'),
        blockquote: editorInstance.isActive('blockquote'),
        codeBlock: editorInstance.isActive('codeBlock'),
      };
      const serialized = JSON.stringify(state);
      if (serialized === previousState) return;
      previousState = serialized;
      sendEditorEvent({ type: 'formatState', memoId, state });
    };
    const reportFocus = () => {
      reportFormatState();
      sendMotion('editorFocus', { focused: true });
    };
    const reportBlur = () => {
      reportFormatState();
      sendMotion('editorBlur', { focused: false });
    };
    const reportSelection = () => {
      reportFormatState();
      sendMotion('selection', { focused: editorInstance.isFocused });
    };
    const scrollContainer = editorInstance.view.dom.closest<HTMLElement>('.mobile-markdown-editor__content');
    const reportScroll = () => sendMotion('editorScroll', {
      scrollTop: Math.round(scrollContainer?.scrollTop ?? 0),
      focused: editorInstance.isFocused,
    });
    editorInstance.on('focus', reportFocus);
    editorInstance.on('blur', reportBlur);
    editorInstance.on('selectionUpdate', reportSelection);
    editorInstance.on('transaction', reportFormatState);
    scrollContainer?.addEventListener('scroll', reportScroll, { passive: true });
    reportFormatState();
    return () => {
      editorInstance.off('focus', reportFocus);
      editorInstance.off('blur', reportBlur);
      editorInstance.off('selectionUpdate', reportSelection);
      editorInstance.off('transaction', reportFormatState);
      scrollContainer?.removeEventListener('scroll', reportScroll);
    };
  }, [editorInstance, memoId]);

  const handleChange = (markdown: string) => {
    contentRef.current = markdown;
    setContent(markdown);
    sendEditorEvent({ type: 'changed', memoId, markdown });
  };

  return (
    <MobileRichMarkdownEditor
      key={`${memoId}:${revision}`}
      memoId={memoId}
      content={content}
      onChange={handleChange}
      externalContent={externalContent}
      showToolbar={false}
      nativeKeyboardToolbar
      nativeToolbarAction={nativeToolbarAction}
      uploadAttachment={createNativeAttachmentUploader(memoId)}
      onEditorReady={(instance) => {
        editorRef.current = instance;
        setEditorInstance(instance);
      }}
    />
  );
}
