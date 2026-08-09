import { AlertTriangle, ArrowLeft, LoaderCircle, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { mobileErrorMessage } from './error-message';

export type MobileDocumentFailureKind = 'missing' | 'failed' | 'rendered';

function MobileDocumentTopbar({ onBack }: { onBack: () => void }) {
  return (
    <header className="mobile-topbar mobile-document-topbar">
      <button type="button" className="mobile-icon-button mobile-menu-button" aria-label="返回列表" onClick={onBack}>
        <ArrowLeft size={21} />
      </button>
      <span />
      <span />
    </header>
  );
}

export function MobileDocumentLoadingScreen({
  onBack,
}: {
  onBack: () => void;
}) {
  return (
    <main className="mobile-document-state-screen" aria-busy="true">
      <MobileDocumentTopbar onBack={onBack} />
      <section className="mobile-document-state-content" aria-live="polite">
        <LoaderCircle className="mobile-loading-spinner is-spinning" size={30} aria-hidden="true" />
        <h1>正在打开笔记…</h1>
        <p>正在读取笔记内容，请稍候。</p>
      </section>
    </main>
  );
}

export function MobileDocumentFailureScreen({
  kind,
  message,
  onRetry,
  onBack,
}: {
  kind: MobileDocumentFailureKind;
  message: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  const title = kind === 'missing'
    ? '笔记已不存在'
    : kind === 'rendered'
      ? '笔记内容无法显示'
      : '无法打开笔记';
  const description = kind === 'missing'
    ? message
    : kind === 'rendered'
      ? ''
      : message;

  return (
    <main className="mobile-document-state-screen">
      <MobileDocumentTopbar onBack={onBack} />
      <section className="mobile-document-state-content mobile-document-error-content" role="alert">
        <div className="mobile-document-error-icon" aria-hidden="true">
          <AlertTriangle size={28} strokeWidth={1.8} />
        </div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        <div className="mobile-document-state-actions">
          {kind !== 'missing' && (
            <button type="button" className="mobile-document-state-primary" onClick={onRetry}>
              <RotateCcw size={17} aria-hidden="true" />
              重试
            </button>
          )}
          <button type="button" className="mobile-document-state-secondary" onClick={onBack}>
            返回列表
          </button>
        </div>
      </section>
    </main>
  );
}

interface MobileDocumentErrorBoundaryProps {
  children: ReactNode;
  onBack: () => void;
  onRetry?: () => void;
}

interface MobileDocumentErrorBoundaryState {
  error: Error | null;
}

/**
 * The editor is lazy-loaded and creates a Tiptap instance imperatively. Keep
 * failures inside the document layer so one malformed note cannot blank the
 * whole mobile WebView.
 */
export class MobileDocumentErrorBoundary extends Component<
  MobileDocumentErrorBoundaryProps,
  MobileDocumentErrorBoundaryState
> {
  state: MobileDocumentErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): MobileDocumentErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[MobileDocumentErrorBoundary] Caught error:', error, errorInfo);
  }

  private retry = (): void => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <MobileDocumentFailureScreen
          kind="rendered"
          message={mobileErrorMessage(this.state.error)}
          onRetry={this.retry}
          onBack={this.props.onBack}
        />
      );
    }

    return this.props.children;
  }
}
