import { createRoot } from 'react-dom/client';

import { NativeEditorWebViewApp } from '@features/editor/mobile/native-editor-webview';
import '@/styles/mobile/index.css';

// Install diagnostics before React/Tiptap is evaluated. A runtime exception
// in an extension can otherwise leave the native shell stuck at “加载编辑器”.
const reportEditorError = (message: string) => {
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { flowixEditor?: { postMessage: (event: unknown) => void } } };
  }).webkit?.messageHandlers?.flowixEditor;
  try {
    handler?.postMessage({ type: 'error', message });
  } catch {
    // There is no useful fallback before the native bridge is available.
  }
};

window.addEventListener('error', (event) => {
  const error = event.error instanceof Error ? event.error : null;
  reportEditorError(`[window.error] ${error?.stack || event.message || '未知错误'}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason : String(event.reason);
  reportEditorError(`[unhandledrejection] ${reason}`);
});

document.documentElement.dataset.platform = 'non-mac';
document.documentElement.dataset.theme = 'rock';

try {
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { flowixEditor?: { postMessage: (event: unknown) => void } } };
  }).webkit?.messageHandlers?.flowixEditor;
  handler?.postMessage({ type: 'diagnostic', message: '[boot] editor entrypoint loaded' });
} catch {
  // Diagnostics are best-effort.
}

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('找不到编辑器根节点 #root');
  createRoot(root).render(<NativeEditorWebViewApp />);
} catch (error) {
  reportEditorError(`[render] ${error instanceof Error ? error.stack || error.message : String(error)}`);
}
