import type { EditorView } from "@tiptap/pm/view";
import type { AgentTypeKey } from "@/types/agent";
import type { I18nKey } from "@/lib/i18n";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import { AgentThreadCardHeaderChromeController } from "@features/agent/thread-card/chrome/header-chrome-controller";
import { AgentThreadCardTitleEditController } from "@features/agent/thread-card/chrome/title-edit-controller";
import { AgentThreadCardBadgeChromeController } from "@features/agent/thread-card/chrome/badge-chrome-controller";

export interface AgentThreadCardChromeControllerOptions {
  dom: HTMLElement;
  header: HTMLDivElement;
  titleEl: HTMLElement;
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLImageElement;
  badgeName: HTMLSpanElement;
  badgeHoverCardMount: HTMLSpanElement;
  view: EditorView;
  getPos: () => number | undefined;
  getNodeSize: () => number;
  isFullscreen: () => boolean;
  closeTransientUi: () => void;
  dragThresholdPx: number;
  getAttrTitle: () => string | null;
  getInstanceTitle: () => string | undefined;
  getFirstUserMessageText: () => string | undefined;
  getDefaultTitle: () => string;
  getThreadId: () => string | null;
  getInstanceId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getCwd: () => string | null;
  getThreadState: () => ThreadState | undefined;
  t: (key: I18nKey) => string;
}

export class AgentThreadCardChromeController {
  private readonly header: AgentThreadCardHeaderChromeController;
  private readonly title: AgentThreadCardTitleEditController;
  private readonly badge: AgentThreadCardBadgeChromeController;

  constructor(options: AgentThreadCardChromeControllerOptions) {
    this.header = new AgentThreadCardHeaderChromeController({
      dom: options.dom,
      header: options.header,
      view: options.view,
      getPos: options.getPos,
      getNodeSize: options.getNodeSize,
      isFullscreen: options.isFullscreen,
      closeTransientUi: options.closeTransientUi,
      dragThresholdPx: options.dragThresholdPx,
    });
    this.title = new AgentThreadCardTitleEditController({
      titleEl: options.titleEl,
      getAttrTitle: options.getAttrTitle,
      getInstanceTitle: options.getInstanceTitle,
      getFirstUserMessageText: options.getFirstUserMessageText,
      getDefaultTitle: options.getDefaultTitle,
      getThreadId: options.getThreadId,
      getInstanceId: options.getInstanceId,
      getTypeKey: options.getTypeKey,
    });
    this.badge = new AgentThreadCardBadgeChromeController({
      badgeEl: options.badgeEl,
      badgeIcon: options.badgeIcon,
      badgeName: options.badgeName,
      hoverCardMount: options.badgeHoverCardMount,
      getThreadId: options.getThreadId,
      getThreadState: options.getThreadState,
      getTypeKey: options.getTypeKey,
      getCwd: options.getCwd,
    });
  }

  get activeTitleInput(): HTMLInputElement | null {
    return this.title.activeInput;
  }

  getTitle(): string {
    return this.title.getTitle();
  }

  hasExplicitTitle(): boolean {
    return this.title.hasExplicitTitle();
  }

  attach(): void {
    this.header.attach();
    this.badge.renderHoverCard();
    // mount 节点默认 `display: none` (role-picker.css),需要把它定位到 badge
    // 上才能让 trigger 覆盖住图标。不能只在全屏切换时同步: 非全屏卡片可能在
    // editor 尚未完成布局时挂载,而 editor 滚动/resize 也会改变 badge 的 viewport
    // 坐标。Badge controller 会持续监听这些布局变化。
    this.badge.attachHoverCardPositioning();
  }

  startTitleEdit(): void {
    this.title.startEdit();
  }

  syncTitleText(): void {
    this.title.syncTitleText();
  }

  refreshBadge(): void {
    this.badge.refreshBadge();
  }

  syncRuntimeBadge(): void {
    this.badge.syncRuntimeState();
  }

  renderBadgeHoverCard(): void {
    this.badge.renderHoverCard();
  }

  syncBadgeHoverCardPosition(): void {
    this.badge.syncHoverCardPosition();
  }

  dispose(): void {
    this.header.dispose();
    this.badge.dispose();
  }
}
