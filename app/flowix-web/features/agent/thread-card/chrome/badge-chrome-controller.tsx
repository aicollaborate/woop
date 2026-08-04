import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { type ThreadState } from "@features/agent/store/thread-runtime-state";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { BadgeHoverCard } from "@features/agent/thread-card/badge-hover-card";
import { computeAgentThreadCardBadgeData } from "@features/agent/thread-card/runtime/run-status-presenter";

export interface AgentThreadCardBadgeChromeControllerOptions {
  badgeEl: HTMLSpanElement;
  badgeIcon: HTMLImageElement;
  badgeName: HTMLSpanElement;
  hoverCardMount: HTMLSpanElement;
  getThreadId: () => string | null;
  getThreadState: () => ThreadState | undefined;
  getTypeKey: () => AgentTypeKey;
  getCwd: () => string | null;
}

export class AgentThreadCardBadgeChromeController {
  private readonly badgeEl: HTMLSpanElement;
  private readonly badgeIcon: HTMLImageElement;
  private readonly badgeName: HTMLSpanElement;
  private readonly hoverCardMount: HTMLSpanElement;
  private readonly hoverCardRoot: Root;
  private readonly getThreadId: () => string | null;
  private readonly getThreadState: () => ThreadState | undefined;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getCwd: () => string | null;
  private hoverCardTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: AgentThreadCardBadgeChromeControllerOptions) {
    this.badgeEl = options.badgeEl;
    this.badgeIcon = options.badgeIcon;
    this.badgeName = options.badgeName;
    this.hoverCardMount = options.hoverCardMount;
    this.hoverCardRoot = createRoot(options.hoverCardMount);
    this.getThreadId = options.getThreadId;
    this.getThreadState = options.getThreadState;
    this.getTypeKey = options.getTypeKey;
    this.getCwd = options.getCwd;
  }

  refreshBadge(): void {
    const type = getAgentType(this.getTypeKey());
    this.badgeIcon.src = type.icon;
    this.badgeIcon.alt = type.name;
    this.badgeName.textContent = type.name;
    this.syncRuntimeState();
  }

  syncRuntimeState(): void {
    const type = getAgentType(this.getTypeKey());
    const status = useAgentRuntimeStore.getState().statusByType[type.key];
    const unavailable = status?.available === false;
    this.badgeEl.classList.toggle("agent-type-badge--unavailable", unavailable);
    this.badgeIcon.classList.toggle(
      "agent-type-badge__icon--unavailable",
      unavailable,
    );
    this.badgeEl.title = unavailable
      ? (status?.reason ?? `${type.name} is unavailable`)
      : type.desc;
  }

  /**
   * 把 hover-card 内容挂到 mount 节点 ── 挂一次就够,组件本身用 HoverCard 自己的
   * openDelay / closeDelay 控制显隐。每次 `syncHoverCardPosition` 跑完会保证
   * trigger 覆盖在 badge 上,用户 hover 触发即可。
   *
   * 旧版这里 gate 在 `isFullscreen()` 后面,非全屏时返回 null 清空 React 树 ──
   * 那个限制是为了避免 mount 节点在 collapsed 卡片里的 0 尺寸触发 HoverCard 报
   * 错;现在 trigger 是 `position: absolute; inset: 0` 永远跟 badge 同尺寸,
   * 全屏 / 非全屏都可以挂,故直接 mount 不再 bailed out。
   */
  renderHoverCard(): void {
    if (this.disposed) return;
    this.renderHoverCardContent();
  }

  /**
   * 把 mount 节点绝对定位到 badge 上 ── trigger 是 absolute inset:0,
   * 跟着 mount 的位置覆盖整个 badge。
   *
   * 全屏切换 / 浏览器 resize / editor scroll 都会触发外部重新调用这个方法。
   */
  syncHoverCardPosition(): void {
    const badgeRect = this.badgeEl.getBoundingClientRect();
    const wrapRect = this.badgeEl.offsetParent?.getBoundingClientRect();
    if (!wrapRect) return;
    const top = badgeRect.top - wrapRect.top;
    const left = badgeRect.left - wrapRect.left;
    this.hoverCardMount.style.position = "absolute";
    this.hoverCardMount.style.top = `${top}px`;
    this.hoverCardMount.style.left = `${left}px`;
    this.hoverCardMount.style.width = `${badgeRect.width}px`;
    this.hoverCardMount.style.height = `${badgeRect.height}px`;
    this.hoverCardMount.style.display = "block";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHoverCardTimer();
    // 推迟到下一个 microtask 再 unmount React root ── ProseMirror destroy 可能
    // 在 React commit phase / passive effects 内被调用, 此时同步 unmount 会触发
    // "Attempted to synchronously unmount a root while React was already rendering"。
    const root = this.hoverCardRoot;
    queueMicrotask(() => {
      root.unmount();
    });
  }

  private startHoverCardTimer(): void {
    if (this.hoverCardTimer !== null) return;
    this.hoverCardTimer = setInterval(() => {
      this.renderHoverCardContent();
    }, 1000);
  }

  private handleHoverCardOpenChange(open: boolean): void {
    if (!open) {
      this.stopHoverCardTimer();
      return;
    }
    this.renderHoverCardContent();
    this.startHoverCardTimer();
  }

  private stopHoverCardTimer(): void {
    if (this.hoverCardTimer === null) return;
    clearInterval(this.hoverCardTimer);
    this.hoverCardTimer = null;
  }

  private renderHoverCardContent(): void {
    if (this.disposed) return;
    const { model, lastRunAt, totalTokens } =
      computeAgentThreadCardBadgeData({
        threadState: this.getThreadState(),
        // Phase 4 (2026-08-02): 真源是 session-store.sessionMeta.settings.
        codexModel:
          useAgentSessionStore.getState().sessionMeta.settings.agentCodexModel,
        typeKey: this.getTypeKey(),
      });
    this.hoverCardRoot.render(
      React.createElement(BadgeHoverCard, {
        sessionId: this.getThreadId() ?? "",
        model,
        lastRunAt,
        totalTokens,
        cwd: this.getCwd() ?? undefined,
        onOpenChange: (open: boolean) =>
          this.handleHoverCardOpenChange(open),
      }),
    );
  }
}
