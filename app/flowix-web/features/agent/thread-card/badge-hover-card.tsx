import * as React from "react";
import { Check, Copy } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@shared/ui/hover-card";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { UsageInfo } from "@/types/agent";
import type { CodexRuntimeInfo } from "@platform/tauri/client/agent";

interface BadgeHoverCardProps {
  /**
   * Flowix-side instance thread id (a temporary local handle, e.g.
   * `codex-local-agent-inst-<uuid>`). Not shown in the popover — the popover
   * first row is the provider-side session id resolved lazily via
   * `onRequestRuntimeInfo`. Only used to:
   *   1. Track which card the open popover belongs to (resident snapshot),
   *   2. Detect threadId changes (effect deps + reset logic).
   */
  threadId: string;
  /** 当前 run 锁定的 LLM model id(由通用 metadata 协议填入) */
  model?: string;
  /** 当前 run 累计 token 用量(undefined 表示未上报) */
  usage?: UsageInfo;
  /**
   * Lazily loads the runtime snapshot on hover; the codex requester also
   * fetches account + rate limits. The returned `sessionId` is the only
   * value rendered in the popover's first row — the flowix instance
   * threadId stays internal so users never see the misleading local handle.
   */
  onRequestRuntimeInfo?: () => Promise<BadgeHoverCardRuntimeInfo | null>;
  codex?: boolean;
  cwd?: string;
  onOpenChange?: (open: boolean) => void;
}

export interface BadgeHoverCardRuntimeInfo {
  model?: string;
  usage: UsageInfo;
  codex?: CodexRuntimeInfo;
  /** Provider session id — the only value rendered in the popover's first row. */
  sessionId?: string;
}

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return n.toLocaleString("en-US");
  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" },
  ];
  const unit = units.find((item) => abs >= item.value)!;
  const value = n / unit.value;
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")}${unit.suffix}`;
}

function formatTokenCount(value: number | null | undefined): string {
  return typeof value === "number" ? formatTokens(value) : "";
}

function lastPathSegment(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function hasUsageContent(usage: UsageInfo | undefined): boolean {
  if (!usage) return false;
  // Aggregate/context metadata alone is not enough for this card: DeepSeek
  // Harness may persist those fields before its token breakdown is available.
  // In that case the first hover must still query the SDK.
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
  ].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

function cacheHitRate(usage: UsageInfo | undefined, codex: boolean): number | undefined {
  const input = usage?.input_tokens;
  const cached = usage?.cached_input_tokens;
  if (
    typeof input !== "number" ||
    typeof cached !== "number" ||
    input < 0 ||
    cached < 0
  ) {
    return undefined;
  }
  const denominator = codex ? input : input + cached;
  return denominator > 0 ? Math.min(1, cached / denominator) : undefined;
}

function contextUsageRate(usage: UsageInfo | undefined): number | undefined {
  // Codex reports the latest request's input as the context currently sent to
  // the model; Harness may provide its own projected context_used_tokens.
  const used = usage?.context_used_tokens ?? usage?.input_tokens;
  const window = usage?.model_context_window;
  if (
    typeof used !== "number" ||
    typeof window !== "number" ||
    used < 0 ||
    window <= 0
  ) {
    return undefined;
  }
  return Math.min(1, used / window);
}

function percentageFromRate(rate: number | undefined): string {
  return rate === undefined ? "" : `${Math.round(rate * 100)}%`;
}

/** runtime info 懒加载期间的行内骨架块, 替代空值 "-" 占位。 */
function HoverCardSkeleton({ width }: { width: string }) {
  return (
    <span
      aria-hidden="true"
      className="agent-thread-card__hover-skeleton"
      style={{ width }}
    />
  );
}

/**
 * Agent Thread Card hover Agent 类型徽章弹出的卡片。
 *
 * 通用 metadata 协议字段均通过 props 传入,组件本身不读取 store ──
 * 由父级 (agent-thread-card.tsx) 负责从 useChatStore 抽取并定时刷新。
 *
 * 展示会话、模型和 token 明细 + 可选 cwd 行:
 *   1. Provider Session ID + 复制按钮(懒加载, 首帧骨架, 只展示 server-side id)
 *   2. Model(可选, 由 run.model 填充)
 *   3. 输入 / 输出 / 缓存命中
 *   4. 空间 (可选, instance.runtimeConfig 解出, 文本溢出走原生 title tooltip)
 *   5. Codex 会员 / 5小时 / 1周 配额 (可选, 仅 codex agent, 懒加载填入)
 */
export function BadgeHoverCard({
  threadId,
  model,
  usage,
  onRequestRuntimeInfo,
  codex = false,
  cwd,
  onOpenChange,
}: BadgeHoverCardProps) {
  const { t, language } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [displayModel, setDisplayModel] = React.useState(model);
  const [displayUsage, setDisplayUsage] = React.useState(usage);
  // Provider session id only — never the flowix instance handle. Starts as
  // null so the first frame renders a skeleton instead of the misleading
  // local id (`codex-local-agent-inst-<uuid>` and friends).
  const [displaySessionId, setDisplaySessionId] = React.useState<string | null>(null);
  const runtimeInfoLoadedRef = React.useRef(hasUsageContent(usage));
  const sessionIdLoadedRef = React.useRef(false);
  const accountLoadedRef = React.useRef(false);
  const [codexInfo, setCodexInfo] = React.useState<CodexRuntimeInfo>();
  // Default to pending when a requester exists: avoids flashing the local
  // threadId (or "-") before the first hover-triggered request resolves.
  const [runtimeInfoPending, setRuntimeInfoPending] = React.useState(
    Boolean(onRequestRuntimeInfo),
  );
  const runtimeInfoRequestRef = React.useRef<Promise<BadgeHoverCardRuntimeInfo | null> | null>(
    null,
  );
  const residentThreadIdRef = React.useRef(threadId);
  const observedThreadIdRef = React.useRef(threadId);
  const triggerHoveredRef = React.useRef(false);
  const hoverCardOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (residentThreadIdRef.current !== threadId) {
      residentThreadIdRef.current = threadId;
      runtimeInfoLoadedRef.current = hasUsageContent(usage);
      sessionIdLoadedRef.current = false;
      accountLoadedRef.current = false;
      setCodexInfo(undefined);
      // Reset to skeleton state for the new thread: if a requester exists,
      // we want to render skeleton until the new session id lands.
      setRuntimeInfoPending(Boolean(onRequestRuntimeInfo));
      runtimeInfoRequestRef.current = null;
      setDisplayModel(model);
      setDisplayUsage(usage);
      setDisplaySessionId(null);
      return;
    }
    // Parent controllers periodically re-render this component. Do not let an
    // empty projection erase a resident snapshot fetched on the first hover.
    if (!runtimeInfoLoadedRef.current || hasUsageContent(usage)) {
      setDisplayModel(model);
      setDisplayUsage(usage);
    }
    if (hasUsageContent(usage)) {
      runtimeInfoLoadedRef.current = true;
    }
  }, [model, threadId, usage, onRequestRuntimeInfo]);

  const requestRuntimeInfo = React.useCallback(() => {
    if (
      (runtimeInfoLoadedRef.current && sessionIdLoadedRef.current && (!codex || accountLoadedRef.current)) ||
      runtimeInfoRequestRef.current !== null ||
      !onRequestRuntimeInfo
    ) {
      return;
    }

    let request: Promise<BadgeHoverCardRuntimeInfo | null>;
    try {
      request = onRequestRuntimeInfo();
    } catch {
      return;
    }
    runtimeInfoRequestRef.current = request;
    setRuntimeInfoPending(true);
    const requestThreadId = threadId;
    void request
      .then((info) => {
        if (residentThreadIdRef.current !== requestThreadId) return;
        if (info === null) return;
        if (hasUsageContent(info.usage)) {
          runtimeInfoLoadedRef.current = true;
        }
        setDisplayModel(info.model ?? model);
        setDisplayUsage(info.usage);
        if (info.sessionId) {
          sessionIdLoadedRef.current = true;
          setDisplaySessionId(info.sessionId);
        }
        if (info.codex) {
          accountLoadedRef.current = true;
          setCodexInfo(info.codex);
        }
      })
      .catch(() => {
        // Keep the resident snapshot visible and allow the next hover to retry.
      })
      .finally(() => {
        // 只有仍是本次请求时才清 pending: threadId 切换可能已重置 ref 并
        // 发起下一轮请求, 旧请求的收尾不得把新一轮的骨架提前撤掉。
        if (runtimeInfoRequestRef.current === request) {
          runtimeInfoRequestRef.current = null;
          setRuntimeInfoPending(false);
        }
      });
  }, [model, onRequestRuntimeInfo, threadId]);

  React.useEffect(() => {
    if (observedThreadIdRef.current === threadId) return;
    observedThreadIdRef.current = threadId;
    if (triggerHoveredRef.current || hoverCardOpenRef.current) {
      requestRuntimeInfo();
    }
  }, [requestRuntimeInfo, threadId]);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      hoverCardOpenRef.current = open;
      onOpenChange?.(open);
      if (open) requestRuntimeInfo();
    },
    [onOpenChange, requestRuntimeInfo],
  );

  const hitRate = cacheHitRate(displayUsage, codex);
  const contextRate = contextUsageRate(displayUsage);
  // 懒加载在途时, 仍为空的 value 显示骨架块; 请求结束(或无请求能力)后回退 "-"。
  const sessionIdPending = runtimeInfoPending && displaySessionId === null;
  const modelPending = runtimeInfoPending && !displayModel;
  const tokensPending =
    runtimeInfoPending &&
    !formatTokenCount(displayUsage?.input_tokens) &&
    !formatTokenCount(displayUsage?.output_tokens);
  const cachePending = runtimeInfoPending && hitRate === undefined;
  const contextPending = runtimeInfoPending && contextRate === undefined;
  const codexPending = runtimeInfoPending && !codexInfo;
  const displayCwd = cwd ? lastPathSegment(cwd) : "";
  const quotaWindows = codex
    ? Object.values(codexInfo?.rateLimits?.rateLimitsByLimitId ?? {})
        .flatMap((limit) => [limit.primary, limit.secondary])
        .filter((window): window is NonNullable<typeof window> => Boolean(window))
    : [];
  const fiveHour = quotaWindows.find((window) => window.windowDurationMins === 300);
  const weekly = quotaWindows.find((window) => window.windowDurationMins === 10080);
  const quotaText = (window: typeof fiveHour) => {
    if (!window) return "-";
    const remaining = `${Math.max(0, 100 - window.usedPercent)}%`;
    if (!window.resetsAt) return remaining;
    const resetAt = new Date(window.resetsAt * 1000);
    if (window.windowDurationMins === 300) {
      return `${remaining} ${resetAt.toLocaleTimeString(language, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`;
    }
    return `${remaining} ${resetAt.toLocaleDateString(language, {
      month: "long",
      day: "numeric",
    })}`;
  };

  const handleCopy = React.useCallback(async () => {
    if (!displaySessionId) return;
    try {
      await navigator.clipboard.writeText(displaySessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 静默失败
    }
  }, [displaySessionId]);

  return (
    <HoverCard
      openDelay={120}
      closeDelay={150}
      onOpenChange={handleOpenChange}
    >
      <HoverCardTrigger asChild>
        <span
          aria-hidden="true"
          className="agent-thread-card__badge-hover-trigger"
          onPointerEnter={() => {
            triggerHoveredRef.current = true;
            requestRuntimeInfo();
          }}
          onPointerLeave={() => {
            triggerHoveredRef.current = false;
          }}
        />
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-[14.4rem] rounded-lg px-3 py-2.5"
      >
        <div className="flex flex-col gap-1.5">
          {/* Provider Session ID 行: 只展示服务端真实 id, 不展示 flowix
              本地 instance handle (例如 codex-local-agent-inst-<uuid>)。
              首帧在请求器存在时显示骨架, request 回来后填入 sessionId。 */}
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground)]"
              title={displaySessionId ?? ""}
            >
              {sessionIdPending ? (
                <HoverCardSkeleton width="8rem" />
              ) : (
                displaySessionId || "-"
              )}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!displaySessionId}
              aria-label={t("editor.threadCard.copySessionId")}
              className={cn(
                "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)]",
                "transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {copied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>

          {/* Model 行 */}
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.model")}
            </span>
            <span
              className={cn(
                "agent-thread-card__model-value min-w-0 font-mono",
                displayModel
                  ? "text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)]",
              )}
            >
              {modelPending ? <HoverCardSkeleton width="4rem" /> : displayModel || "-"}
            </span>
          </div>

          {/* Token 明细: Harness 的 inputTokens 不包含 cacheReadTokens。 */}
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.inputOutputTokens")}
            </span>
            <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
              {tokensPending ? (
                <HoverCardSkeleton width="3.5rem" />
              ) : (
                <>
                  {formatTokenCount(displayUsage?.input_tokens) || "-"} /{" "}
                  {formatTokenCount(displayUsage?.output_tokens) || "-"} tok
                </>
              )}
            </span>
          </div>

          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.cacheReadTokens")}
            </span>
            <span
              className="agent-thread-card__cache-hit-value"
              aria-label={percentageFromRate(hitRate) || "-"}
            >
              {cachePending ? (
                <HoverCardSkeleton width="1.75rem" />
              ) : (
                <span className="font-mono tabular-nums text-[var(--foreground)]">
                  {percentageFromRate(hitRate) || "-"}
                </span>
              )}
            </span>
          </div>

          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.contextUsage")}
            </span>
            <span
              className="agent-thread-card__cache-hit-value"
              aria-label={percentageFromRate(contextRate) || "-"}
            >
              {contextPending ? (
                <HoverCardSkeleton width="1.75rem" />
              ) : (
                <span className="font-mono tabular-nums text-[var(--foreground)]">
                  {percentageFromRate(contextRate) || "-"}
                </span>
              )}
              {contextRate === undefined ? null : (
                <span
                  aria-hidden="true"
                  className="agent-thread-card__context-ring"
                  style={{ "--proportion": `${contextRate * 100}%` } as React.CSSProperties}
                />
              )}
            </span>
          </div>

          {displayCwd ? (
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 text-[11px]">
              <span className="shrink-0 text-[var(--muted-foreground)]">
                {t("editor.threadCard.cwd")}
              </span>
              <span
                className="agent-thread-card__cwd-value"
                title={cwd}
              >
                {displayCwd}
              </span>
            </div>
          ) : null}
          {codex ? (
            <>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">
                  {t("editor.threadCard.codexPlan")}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
                  {codexPending ? (
                    <HoverCardSkeleton width="3rem" />
                  ) : (
                    codexInfo?.account?.planType ?? "-"
                  )}
                </span>
              </div>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">
                  {t("editor.threadCard.codexQuota5h")}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
                  {codexPending ? <HoverCardSkeleton width="4rem" /> : quotaText(fiveHour)}
                </span>
              </div>
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
                <span className="text-[var(--muted-foreground)]">
                  {t("editor.threadCard.codexQuotaWeekly")}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
                  {codexPending ? <HoverCardSkeleton width="3rem" /> : quotaText(weekly)}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
