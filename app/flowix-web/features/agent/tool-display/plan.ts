import type { AppLanguage } from "@/lib/i18n";

/* ════════════════════════════════════════════════════════════════════════
 *  update_plan 派生 ── Codex CLI 的 todo/list 工具
 * ════════════════════════════════════════════════════════════════════════
 *
 *  arguments: { plan: Array<{ status: "pending"|"in_progress"|"completed", step: string }> }
 *
 *  - formatAgentPlanSummary → 给单行 header 显示用 ("3/5 · 正在做: …" / "3/5 · Working on: …")
 *  - parseAgentPlan         → 给 checklist 渲染用, 失败返回 null
 *  - 复用 TOOLS 元数据 ── toolName 走 agent.tools.* 的 i18n label
 */

export type AgentPlanStatus = "pending" | "in_progress" | "completed";
export interface AgentPlanStep {
  status: AgentPlanStatus;
  step: string;
}
export interface AgentPlan {
  plan: AgentPlanStep[];
}

const PLAN_STEP_MAX = 200;
const PLAN_SUMMARY_MAX = 60;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

const PLAN_KEYS = ["plan", "Plan", "items", "todos", "steps", "tasks"] as const;
const STATUS_KEYS = ["status", "state", "Status"] as const;
const STEP_KEYS = ["step", "content", "title", "text", "activeForm", "label"] as const;
const STATUS_ALIASES: Record<string, AgentPlanStatus> = {
  pending: "pending",
  todo: "pending",
  not_started: "pending",
  "not-started": "pending",
  queued: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  doing: "in_progress",
  running: "in_progress",
  active: "in_progress",
  executing: "in_progress",
  completed: "completed",
  done: "completed",
  finished: "completed",
  complete: "completed",
  success: "completed",
  succeeded: "completed",
};

function normalizeStatus(value: unknown): AgentPlanStatus | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return STATUS_ALIASES[key] ?? null;
}

function findPlanArray(value: unknown, depth: number): unknown[] | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of PLAN_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  // 深入一层找常见包壳 (input / arguments / data / payload)
  for (const wrap of ["input", "arguments", "data", "payload", "args"]) {
    const v = (value as Record<string, unknown>)[wrap];
    if (v && typeof v === "object") {
      const inner = findPlanArray(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

export function parseAgentPlan(
  input: unknown,
): AgentPlan | null {
  const arr = findPlanArray(input, 0);
  if (!arr || arr.length === 0) return null;
  const plan: AgentPlanStep[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    let status: AgentPlanStatus | null = null;
    for (const k of STATUS_KEYS) {
      status = normalizeStatus(obj[k]);
      if (status) break;
    }
    let step: string | null = null;
    if (typeof obj.step === "string" && obj.step.trim()) step = obj.step.trim();
    if (!step) {
      for (const k of STEP_KEYS) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) { step = v.trim(); break; }
      }
    }
    if (status && step) {
      plan.push({ status, step: truncate(step, PLAN_STEP_MAX) });
    } else if (step) {
      // 没有 status 也能渲染 ── 视作 pending (比丢弃好)
      plan.push({ status: "pending", step: truncate(step, PLAN_STEP_MAX) });
    }
  }
  return plan.length > 0 ? { plan } : null;
}

export function formatAgentPlanSummary(
  input: Record<string, unknown> | undefined,
  language: AppLanguage = "zh-CN",
): string {
  const parsed = parseAgentPlan(input);
  if (!parsed) return "";
  const total = parsed.plan.length;
  const done = parsed.plan.filter((s) => s.status === "completed").length;
  const current = parsed.plan.find((s) => s.status === "in_progress");
  const prefix = `${done}/${total}`;
  if (current) {
    const label =
      language === "zh-CN" ? "正在做" : "Working on";
    return `${prefix} · ${label}：${truncate(current.step, PLAN_SUMMARY_MAX)}`;
  }
  return prefix;
}

export function formatAgentPlanSummaryForDisplay(
  input: Record<string, unknown>,
): string {
  const parsed = parseAgentPlan(input);
  if (!parsed) return "";
  const total = parsed.plan.length;
  const done = parsed.plan.filter((step) => step.status === "completed").length;
  const current = parsed.plan.find((step) => step.status === "in_progress");
  if (current) return `${done}/${total} · ${truncate(current.step, PLAN_SUMMARY_MAX)}`;
  return `${done}/${total}`;
}

