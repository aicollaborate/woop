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

interface BadgeHoverCardProps {
  /** SESSION ID (agent thread id) */
  sessionId: string;
  /** 当前 run 锁定的 LLM model id(由通用 metadata 协议填入) */
  model?: string;
  /** 当前 run 累计 token 用量(undefined 表示未上报) */
  usage?: UsageInfo;
  /** Loads the runtime snapshot only when this card has no loaded usage yet. */
  onRequestRuntimeInfo?: () => Promise<BadgeHoverCardRuntimeInfo | null>;
  cwd?: string;
  onOpenChange?: (open: boolean) => void;
}

export interface BadgeHoverCardRuntimeInfo {
  model?: string;
  usage: UsageInfo;
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

function cacheHitRate(usage: UsageInfo | undefined): number | undefined {
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
  const totalInput = input + cached;
  return totalInput > 0 ? cached / totalInput : undefined;
}

function contextUsageRate(usage: UsageInfo | undefined): number | undefined {
  const used = usage?.context_used_tokens;
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

/**
 * Agent Thread Card hover Agent 类型徽章弹出的卡片。
 *
 * 通用 metadata 协议字段均通过 props 传入,组件本身不读取 store ──
 * 由父级 (agent-thread-card.tsx) 负责从 useChatStore 抽取并定时刷新。
 *
 * 展示会话、模型和 token 明细 + 可选 cwd 行:
 *   1. Session ID + 复制按钮
 *   2. Model(可选, 由 run.model 填充)
 *   3. 输入 / 输出 / 缓存命中
 *   4. 空间 (可选, instance.runtimeConfig 解出, 文本溢出走原生 title tooltip)
 */
export function BadgeHoverCard({
  sessionId,
  model,
  usage,
  onRequestRuntimeInfo,
  cwd,
  onOpenChange,
}: BadgeHoverCardProps) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [displayModel, setDisplayModel] = React.useState(model);
  const [displayUsage, setDisplayUsage] = React.useState(usage);
  const runtimeInfoLoadedRef = React.useRef(hasUsageContent(usage));
  const runtimeInfoRequestRef = React.useRef<Promise<BadgeHoverCardRuntimeInfo | null> | null>(
    null,
  );
  const residentSessionIdRef = React.useRef(sessionId);
  const observedSessionIdRef = React.useRef(sessionId);
  const triggerHoveredRef = React.useRef(false);
  const hoverCardOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (residentSessionIdRef.current !== sessionId) {
      residentSessionIdRef.current = sessionId;
      runtimeInfoLoadedRef.current = hasUsageContent(usage);
      runtimeInfoRequestRef.current = null;
      setDisplayModel(model);
      setDisplayUsage(usage);
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
  }, [model, sessionId, usage]);

  const requestRuntimeInfo = React.useCallback(() => {
    if (
      runtimeInfoLoadedRef.current ||
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
    const requestSessionId = sessionId;
    void request
      .then((info) => {
        if (residentSessionIdRef.current !== requestSessionId) return;
        if (info === null) return;
        if (hasUsageContent(info.usage)) {
          runtimeInfoLoadedRef.current = true;
        }
        setDisplayModel(info.model ?? model);
        setDisplayUsage(info.usage);
      })
      .catch(() => {
        // Keep the resident snapshot visible and allow the next hover to retry.
      })
      .finally(() => {
        if (runtimeInfoRequestRef.current === request) {
          runtimeInfoRequestRef.current = null;
        }
      });
  }, [model, onRequestRuntimeInfo, sessionId]);

  React.useEffect(() => {
    if (observedSessionIdRef.current === sessionId) return;
    observedSessionIdRef.current = sessionId;
    if (triggerHoveredRef.current || hoverCardOpenRef.current) {
      requestRuntimeInfo();
    }
  }, [requestRuntimeInfo, sessionId]);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      hoverCardOpenRef.current = open;
      onOpenChange?.(open);
      if (open) requestRuntimeInfo();
    },
    [onOpenChange, requestRuntimeInfo],
  );

  const hitRate = cacheHitRate(displayUsage);
  const contextRate = contextUsageRate(displayUsage);
  const displayCwd = cwd ? lastPathSegment(cwd) : "";

  const handleCopy = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 静默失败
    }
  }, [sessionId]);

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
          {/* Session ID 行: 复制按钮在右 */}
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground)]"
              title={sessionId || ""}
            >
              {sessionId || "-"}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!sessionId}
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
              {displayModel || "-"}
            </span>
          </div>

          {/* Token 明细: Harness 的 inputTokens 不包含 cacheReadTokens。 */}
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <span className="text-[var(--muted-foreground)]">
              {t("editor.threadCard.inputOutputTokens")}
            </span>
            <span className="text-right font-mono tabular-nums text-[var(--foreground)]">
              {formatTokenCount(displayUsage?.input_tokens) || "-"} /{" "}
              {formatTokenCount(displayUsage?.output_tokens) || "-"} tok
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
              <span className="font-mono tabular-nums text-[var(--foreground)]">
                {percentageFromRate(hitRate) || "-"}
              </span>
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
              <span className="font-mono tabular-nums text-[var(--foreground)]">
                {percentageFromRate(contextRate) || "-"}
              </span>
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
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
