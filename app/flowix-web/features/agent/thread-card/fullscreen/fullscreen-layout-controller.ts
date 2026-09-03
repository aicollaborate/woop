import type { ScrollSnapshot } from "@features/agent/thread-card/agent-thread-card-dom";
import {
  adjustEditorScrollToCardTop,
  captureAgentThreadCardScrollSnapshot,
  getAgentThreadCardEditorScrollContainer,
  getFullscreenExitFallbackTop,
  restoreAgentThreadCardScrollSnapshotAfterFocusChange,
} from "@features/agent/thread-card/fullscreen/fullscreen-scroll";

export interface FullscreenLayoutControllerOptions {
  dom: HTMLElement;
  isFullscreen: () => boolean;
  isDestroyed: () => boolean;
  minExitTopPx: number;
  maxExitTopPx: number;
  exitTopRatio: number;
  scrollDeltaEpsilonPx: number;
}

export class FullscreenLayoutController {
  private readonly dom: HTMLElement;
  private readonly isFullscreen: () => boolean;
  private readonly isDestroyed: () => boolean;
  private readonly minExitTopPx: number;
  private readonly maxExitTopPx: number;
  private readonly exitTopRatio: number;
  private readonly scrollDeltaEpsilonPx: number;
  private fullscreenContainer: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private boundsTrackingFrame: number | null = null;
  private lastFullscreenBounds: string | null = null;
  private readonly syncFullscreenBounds = (): void => {
    const container = this.fullscreenContainer;
    if (!container || !this.isFullscreen()) return;

    const rect = container.getBoundingClientRect();
    const boundsKey = `${rect.top}:${rect.left}:${rect.width}:${rect.height}`;
    if (boundsKey === this.lastFullscreenBounds) return;
    this.lastFullscreenBounds = boundsKey;
    this.dom.style.setProperty("--atc-fullscreen-top", `${rect.top}px`);
    this.dom.style.setProperty("--atc-fullscreen-left", `${rect.left}px`);
    this.dom.style.setProperty("--atc-fullscreen-width", `${rect.width}px`);
    this.dom.style.setProperty("--atc-fullscreen-height", `${rect.height}px`);
  };
  private readonly trackFullscreenBounds = (): void => {
    this.boundsTrackingFrame = null;
    if (!this.fullscreenContainer || !this.isFullscreen()) return;

    this.syncFullscreenBounds();
    this.boundsTrackingFrame = window.requestAnimationFrame(
      this.trackFullscreenBounds,
    );
  };

  private returnAnchor: {
    scrollContainer: HTMLElement;
    topWithinContainer: number;
  } | null = null;

  constructor(options: FullscreenLayoutControllerOptions) {
    this.dom = options.dom;
    this.isFullscreen = options.isFullscreen;
    this.isDestroyed = options.isDestroyed;
    this.minExitTopPx = options.minExitTopPx;
    this.maxExitTopPx = options.maxExitTopPx;
    this.exitTopRatio = options.exitTopRatio;
    this.scrollDeltaEpsilonPx = options.scrollDeltaEpsilonPx;
  }

  enter(): void {
    const container = this.dom.closest<HTMLElement>(".document-container");
    this.fullscreenContainer = container;
    if (!container) return;

    this.syncFullscreenBounds();
    window.addEventListener("resize", this.syncFullscreenBounds);
    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(this.syncFullscreenBounds);
      this.resizeObserver.observe(container);
    }
    this.boundsTrackingFrame = window.requestAnimationFrame(
      this.trackFullscreenBounds,
    );
  }

  exit(): void {
    this.stopTrackingFullscreenBounds();
    this.restoreReturnAnchor();
  }

  dispose(): void {
    this.stopTrackingFullscreenBounds();
    this.returnAnchor = null;
  }

  captureReturnAnchor(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer) {
      this.returnAnchor = null;
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    this.returnAnchor = {
      scrollContainer,
      topWithinContainer: cardRect.top - containerRect.top,
    };
  }

  captureScrollSnapshot(): ScrollSnapshot {
    return captureAgentThreadCardScrollSnapshot(this.getEditorScrollContainer());
  }

  restoreScrollSnapshotAfterFocusChange(snapshot: ScrollSnapshot): void {
    restoreAgentThreadCardScrollSnapshotAfterFocusChange(snapshot);
  }

  getEditorScrollContainer(): HTMLElement | null {
    return getAgentThreadCardEditorScrollContainer(this.dom);
  }

  private stopTrackingFullscreenBounds(): void {
    window.removeEventListener("resize", this.syncFullscreenBounds);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.boundsTrackingFrame !== null) {
      window.cancelAnimationFrame(this.boundsTrackingFrame);
      this.boundsTrackingFrame = null;
    }
    this.fullscreenContainer = null;
    this.lastFullscreenBounds = null;
    this.dom.style.removeProperty("--atc-fullscreen-top");
    this.dom.style.removeProperty("--atc-fullscreen-left");
    this.dom.style.removeProperty("--atc-fullscreen-width");
    this.dom.style.removeProperty("--atc-fullscreen-height");
  }

  private restoreReturnAnchor(): void {
    const anchor = this.returnAnchor;
    this.returnAnchor = null;

    window.requestAnimationFrame(() => {
      if (this.isDestroyed() || this.isFullscreen()) return;
      if (!anchor || !anchor.scrollContainer.isConnected || !this.dom.isConnected) {
        this.scrollCardToExitFallbackPosition();
        return;
      }

      const scrollContainer = anchor.scrollContainer;

      const containerRect = scrollContainer.getBoundingClientRect();
      const cardRect = this.dom.getBoundingClientRect();
      this.adjustEditorScrollToCardTop(
        scrollContainer,
        cardRect.top - containerRect.top,
        anchor.topWithinContainer,
      );
    });
  }

  private scrollCardToExitFallbackPosition(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer || !scrollContainer.isConnected || !this.dom.isConnected)
      return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    const targetTop = getFullscreenExitFallbackTop({
      containerHeight: containerRect.height,
      minTopPx: this.minExitTopPx,
      maxTopPx: this.maxExitTopPx,
      topRatio: this.exitTopRatio,
    });
    this.adjustEditorScrollToCardTop(
      scrollContainer,
      cardRect.top - containerRect.top,
      targetTop,
    );
  }

  private adjustEditorScrollToCardTop(
    scrollContainer: HTMLElement,
    currentTopWithinContainer: number,
    targetTopWithinContainer: number,
  ): void {
    adjustEditorScrollToCardTop({
      scrollContainer,
      currentTopWithinContainer,
      targetTopWithinContainer,
      epsilonPx: this.scrollDeltaEpsilonPx,
    });
  }
}
