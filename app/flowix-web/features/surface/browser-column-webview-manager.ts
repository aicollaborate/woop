import { LogicalPosition, LogicalSize } from '@platform/tauri/dpi';
import { Webview } from '@platform/tauri/webview';

export interface BrowserColumnWebviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserColumnWebviewManagerOptions {
  label: string;
  url: string;
  bounds: BrowserColumnWebviewBounds;
  onCreated: () => void;
  onError: (event: unknown) => void;
}

function normalizeBounds(bounds: BrowserColumnWebviewBounds): BrowserColumnWebviewBounds {
  return {
    x: Math.max(0, bounds.x),
    y: Math.max(0, bounds.y),
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };
}

/**
 * Owns the native child WebView independently from React's render lifecycle.
 *
 * A child WebView is not a DOM child: position/size changes are asynchronous
 * native commands, and the child can finish creating after its React owner has
 * already unmounted. Keeping those concerns here prevents stale geometry and
 * orphaned native WebViews during fast tab/layout changes.
 */
export class BrowserColumnWebviewManager {
  private readonly child: Webview;
  private disposed = false;
  private created = false;
  private draining = false;
  private pendingBounds: BrowserColumnWebviewBounds | null;
  private pendingVisibility: boolean | null = null;

  constructor(
    window: ConstructorParameters<typeof Webview>[0],
    options: BrowserColumnWebviewManagerOptions,
  ) {
    this.pendingBounds = normalizeBounds(options.bounds);
    this.child = new Webview(window, options.label, {
      url: options.url,
      ...this.pendingBounds,
      focus: false,
    });

    void this.child.once('tauri://created', () => {
      this.created = true;
      if (this.disposed) {
        void this.child.close().catch(() => undefined);
        return;
      }
      options.onCreated();
      this.drain();
    });
    void this.child.once('tauri://error', options.onError);
  }

  setBounds(bounds: BrowserColumnWebviewBounds): void {
    if (this.disposed) return;
    this.pendingBounds = normalizeBounds(bounds);
    this.drain();
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.pendingVisibility = visible;
    this.drain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingBounds = null;
    this.pendingVisibility = null;
    // close() before tauri://created is racy and can leave an orphaned child.
    // The created handler above closes it if disposal won that race.
    if (this.created) {
      void this.child.close().catch(() => undefined);
    }
  }

  private drain(): void {
    if (!this.created || this.disposed || this.draining) return;
    this.draining = true;
    void this.drainAsync();
  }

  private async drainAsync(): Promise<void> {
    try {
      while (!this.disposed) {
        const visibility = this.pendingVisibility;
        const bounds = this.pendingBounds;
        if (visibility === null && bounds === null) break;

        this.pendingVisibility = null;
        this.pendingBounds = null;

        if (visibility !== null) {
          if (visibility) await this.child.show();
          else await this.child.hide();
        }

        if (bounds !== null && !this.disposed) {
          // Keep the two native operations ordered. Concurrent invoke calls can
          // otherwise apply an older position after a newer resize.
          await this.child.setPosition(new LogicalPosition(bounds.x, bounds.y));
          await this.child.setSize(new LogicalSize(bounds.width, bounds.height));
        }
      }
    } catch {
      // A native child may disappear while its last geometry command is in
      // flight. Cleanup is idempotent, so there is nothing useful to retry.
    } finally {
      this.draining = false;
      if (!this.disposed && (this.pendingBounds || this.pendingVisibility !== null)) {
        this.drain();
      }
    }
  }
}
