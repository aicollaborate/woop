import type {
  AgentToolDisplay,
  AgentToolDisplayKind,
  AgentTypeKey,
} from "@/types/agent";
import { COMMAND_KEYS, normalizeToolInput, stringField } from "./tool-display/common";
import { formatAgentPlanSummaryForDisplay } from "./tool-display/plan";
export * from "./tool-display/command";
export { normalizeToolInput } from "./tool-display/common";
export {
  formatAgentPlanSummary,
  formatAgentPlanSummaryForDisplay,
  parseAgentPlan,
  type AgentPlan,
  type AgentPlanStatus,
  type AgentPlanStep,
} from "./tool-display/plan";


type ToolDisplayFormatter = (
  input: Record<string, unknown>,
  context: AgentToolDisplayContext,
) => AgentToolDisplay | undefined;

export interface AgentToolDisplayContext {
  agentType?: AgentTypeKey;
  toolName?: string;
  input: unknown;
}

function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function extractFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}


function deepStringField(
  input: unknown,
  keys: readonly string[],
  depth = 3,
): string | undefined {
  if (!input || depth < 0) return undefined;
  if (Array.isArray(input)) {
    for (const item of input) {
      const nested = deepStringField(item, keys, depth - 1);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof input !== "object") return undefined;

  const record = input as Record<string, unknown>;
  const direct = stringField(record, keys);
  if (direct) return direct;

  for (const value of Object.values(record)) {
    const nested = deepStringField(value, keys, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

interface StringLeaf {
  key?: string;
  path: string[];
  value: string;
}

const SEARCH_QUERY_KEYS = [
  "query",
  "search_query",
  "searchQuery",
  "search_terms",
  "searchTerms",
  "search_term",
  "searchTerm",
  "q",
  "term",
  "terms",
  "pattern",
  "regex",
  "keywords",
] as const;

const SEARCH_FALLBACK_KEYS = new Set([
  ...SEARCH_QUERY_KEYS,
  "text",
  "content",
  "value",
  "input",
  "title",
  "description",
]);

const SEARCH_NOISE_VALUES = new Set([
  "action",
  "completed",
  "done",
  "failed",
  "in_progress",
  "network_search",
  "open",
  "pending",
  "queued",
  "search",
  "search_query",
  "search_web",
  "succeeded",
  "success",
  "web_search",
  "web_search_call",
  "web_search_preview",
]);

function collectStringLeaves(
  input: unknown,
  depth = 5,
  path: string[] = [],
): StringLeaf[] {
  if (!input || depth < 0) return [];
  if (typeof input === "string") {
    const value = input.trim();
    return value ? [{ key: path[path.length - 1], path, value }] : [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item, index) =>
      collectStringLeaves(item, depth - 1, [...path, String(index)]),
    );
  }
  if (typeof input !== "object") return [];

  return Object.entries(input as Record<string, unknown>).flatMap(
    ([key, value]) => collectStringLeaves(value, depth - 1, [...path, key]),
  );
}

function isSearchNoiseString(value: string, key?: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || SEARCH_NOISE_VALUES.has(normalized)) return true;
  if (normalized.length <= 2 && !normalized.includes(":")) return true;
  if (key && /(^|_)(id|type|status|state|kind|name)$/.test(key)) return true;
  if (/^(call|item|tool|ws|run|msg)_[a-z0-9_-]+$/i.test(value)) return true;
  return false;
}

function scoreSearchCandidate(leaf: StringLeaf): number {
  const key = leaf.key ?? "";
  const path = leaf.path.join(".");
  const value = leaf.value;
  let score = 0;

  if (SEARCH_FALLBACK_KEYS.has(key)) score += 80;
  if (/query|search|term|keyword|pattern/i.test(path)) score += 40;
  if (/\bsite:/i.test(value)) score += 35;
  if (/https?:\/\//i.test(value)) score += 20;
  if (/\s/.test(value)) score += 15;
  if (value.length >= 12) score += 10;
  if (value.length >= 32) score += 5;
  if (/action|arguments|params|input/i.test(path)) score += 5;
  if (/status|state|type|kind|id/i.test(path)) score -= 60;

  return score;
}

function fallbackSearchQuery(input: unknown): string | undefined {
  const candidates = collectStringLeaves(input)
    .filter((leaf) => !isSearchNoiseString(leaf.value, leaf.key))
    .map((leaf) => ({ leaf, score: scoreSearchCandidate(leaf) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.leaf.value;
}

function display(
  summary: string | undefined,
  kind: AgentToolDisplayKind,
  title?: string,
): AgentToolDisplay | undefined {
  if (!summary) return undefined;
  return {
    summary,
    title: title || summary,
    kind,
  };
}


function fieldKind(key: string): AgentToolDisplayKind {
  if (
    key === "command" ||
    key === "command_text" ||
    key === "commandText" ||
    key === "cmd" ||
    key === "cmdline" ||
    key === "shell_command" ||
    key === "command_preview" ||
    key === "script"
  )
    return "command";
  if (key === "path" || key === "cwd") return "file";
  if (key === "query" || key === "pattern") return "search";
  if (key === "url" || key === "href") return "network";
  return "generic";
}

function fileDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  // OpenCode ACP 用 camelCase `filePath`, Claude Code 用 `file_path`, 其余
  // CLI 多用 `path` ── 全部尝试, 命中第一个非空字符串。
  const path = stringField(input, ["path", "filePath", "file_path", "filepath"]);
  return display(path ? extractFileName(path) : undefined, "file", path);
}

function directoryDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const path = stringField(input, ["path", "cwd", "directory"]);
  return display(path ? extractFileName(path) : undefined, "file", path);
}

function commandDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const command = stringField(input, COMMAND_KEYS);
  const cwd = stringField(input, ["workdir", "cwd", "working_directory"]);
  return display(command, "command", cwd ? `${command}\n${cwd}` : command);
}


function searchDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const query =
    deepStringField(input, SEARCH_QUERY_KEYS) ?? fallbackSearchQuery(input);
  const path = deepStringField(input, ["path", "cwd", "include"]);
  if (!query && deepStringField(input, ["type"]) === "other") {
    return display("Web search", "search");
  }
  return display(query, "search", path ? `${query}\n${path}` : query);
}

function skillDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  return display(
    stringField(input, ["name", "skill", "skill_name"]),
    "generic",
  );
}

function agentDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  return display(
    stringField(input, ["prompt", "task", "description", "message"]),
    "generic",
  );
}

function urlDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  return display(stringField(input, ["url", "href", "endpoint"]), "network");
}

function mcpToolDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const tool = deepStringField(input, ["tool", "tool_name", "name"]);
  const server = deepStringField(input, ["server"]);
  if (!tool) return undefined;
  const rawArguments = input.arguments;
  let args: Record<string, unknown> | undefined;
  if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    args = rawArguments as Record<string, unknown>;
  } else if (typeof rawArguments === "string" && rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = { input: rawArguments };
    }
  }

  const sensitive = /(^|_)(token|password|passwd|secret|authorization|api_?key)($|_)/i;
  const priority = [
    "command",
    "query",
    "uri",
    "path",
    "url",
    "title",
    "prompt",
    "pattern",
    "name",
    "id",
    "key",
    "input",
    "code",
    "stdin",
  ];
  const entries = Object.entries(args ?? {}).filter(
    ([key, value]) => !sensitive.test(key) && value !== undefined && value !== null,
  );
  entries.sort(([left], [right]) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    return (leftIndex < 0 ? priority.length : leftIndex) -
      (rightIndex < 0 ? priority.length : rightIndex);
  });
  const core = entries.slice(0, 2).flatMap(([key, value]) => {
    const text = valueToText(value).replace(/\s+/g, " ").trim();
    return text ? [`${key}: ${truncate(text, 72)}`] : [];
  });
  const summary = core.length > 0 ? `${tool} · ${core.join(" · ")}` : tool;
  return display(summary, "generic", server ? `${server} · ${summary}` : summary);
}

interface FileChangeSummaryEntry {
  path: string;
  action?: string;
}

function fileChangeEntries(input: Record<string, unknown>): FileChangeSummaryEntry[] {
  const changes = input.changes ?? input.items ?? input;
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const record = change as Record<string, unknown>;
      const path = stringField(record, ["path", "file", "filename"]);
      if (!path) return [];
      return [{ path, action: stringField(record, ["kind", "type", "action"]) }];
    });
  }
  if (!changes || typeof changes !== "object") return [];
  const record = changes as Record<string, unknown>;
  const directPath = stringField(record, ["path", "file", "filename"]);
  if (directPath) {
    return [
      {
        path: directPath,
        action: stringField(record, ["kind", "type", "action"]),
      },
    ];
  }
  return Object.entries(record).flatMap(([path, detail]) => {
    if (!path.includes("/") && !path.includes("\\")) return [];
    const action =
      detail && typeof detail === "object"
        ? stringField(detail as Record<string, unknown>, ["kind", "type", "action"])
        : undefined;
    return [{ path, action }];
  });
}

function fileChangeDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const entries = fileChangeEntries(input);
  if (entries.length === 0) return undefined;
  const first = entries[0];
  const action = first.action?.toLowerCase();
  const verb =
    action === "add" || action === "create"
      ? "Add"
      : action === "delete" || action === "remove"
        ? "Delete"
        : action === "update" || action === "modify"
          ? "Update"
          : "Change";
  const name = extractFileName(first.path);
  const summary =
    entries.length === 1
      ? `${verb} ${name}`
      : `${verb} ${name} (+${entries.length - 1})`;
  return display(summary, "file", first.path);
}

function viewImageDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const directPath = deepStringField(input, ["path", "image_path", "file"]);
  if (directPath) return display(extractFileName(directPath), "file", directPath);
  const command = stringField(input, ["command", "script"]);
  const wrappedPath = command?.match(/\bpath\s*:\s*["']([^"']+)["']/)?.[1];
  return wrappedPath
    ? display(extractFileName(wrappedPath), "file", wrappedPath)
    : undefined;
}

/* ════════════════════════════════════════════════════════════════════════
 *  patchDisplay ── Codex apply_patch 工具
 *
 *  arguments: { command: string }  (command 字段值 = 完整 patch 文本)
 *
 *  patch 文本格式:
 *    apply_patch                  ← 可选前缀
 *    *** Begin Patch
 *    *** Update File: /abs/path
 *    @@
 *     context
 *    -removed
 *    +added
 *    *** End Patch
 *
 *  summary = "Update <basename>" / "Add <basename>" / "Delete <basename>"
 *  title   = 完整 patch 第一行
 *  kind    = "patch"
 * ════════════════════════════════════════════════════════════════════════ */
export interface AgentPatchEntry {
  action: "update" | "add" | "delete" | "move" | "unknown";
  path: string;
}

export function parseAgentPatch(
  input: Record<string, unknown> | undefined,
): AgentPatchEntry[] {
  const raw = input?.command;
  if (typeof raw !== "string" || !raw) return [];
  const entries: AgentPatchEntry[] = [];
  const re = /\*\*\* (?:(Update|Add|Delete) File:|(Move to):) ([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const actionRaw = m[1] || m[2];
    const path = m[3].trim();
    let action: AgentPatchEntry["action"] = "unknown";
    if (actionRaw === "Update") action = "update";
    else if (actionRaw === "Add") action = "add";
    else if (actionRaw === "Delete") action = "delete";
    else if (actionRaw === "Move to") action = "move";
    entries.push({ action, path });
  }
  return entries;
}


/* ════════════════════════════════════════════════════════════════════════
 *  requestUserInputDisplay ── Codex request_user_input 工具
 *
 *  arguments: { questions: Array<{ header, id, question, options }> }
 *
 *  summary = "问 1 个问题" / "问 3 个问题" / "问 1 个问题 (4 选项)"
 *  title   = "Question"
 *  kind    = "question"
 * ════════════════════════════════════════════════════════════════════════ */
export interface AgentRequestUserInputOption {
  label: string;
  description?: string;
}
export interface AgentRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: AgentRequestUserInputOption[];
}
export interface AgentRequestUserInput {
  questions: AgentRequestUserInputQuestion[];
}

const QUESTION_TEXT_MAX = 60;
const OPTION_LABEL_MAX = 40;
const HEADER_MAX = 24;

function truncateField(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function parseAgentRequestUserInput(
  input: Record<string, unknown> | undefined,
): AgentRequestUserInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AgentRequestUserInputQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : "";
    const header = typeof obj.header === "string" ? obj.header : "";
    const question = typeof obj.question === "string" ? obj.question : "";
    const rawOptions = obj.options;
    if (!Array.isArray(rawOptions)) continue;
    const options: AgentRequestUserInputOption[] = [];
    for (const opt of rawOptions) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string" || !o.label.trim()) continue;
      options.push({
        label: truncateField(o.label.trim(), OPTION_LABEL_MAX),
        description:
          typeof o.description === "string" && o.description.trim()
            ? o.description.trim()
            : undefined,
      });
    }
    if (!question.trim() || options.length === 0) continue;
    questions.push({
      id,
      header: header ? truncateField(header, HEADER_MAX) : "Question",
      question: question.trim(),
      options,
    });
  }
  return questions.length > 0 ? { questions } : null;
}

function requestUserInputDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const parsed = parseAgentRequestUserInput(input);
  if (!parsed) return undefined;
  const n = parsed.questions.length;
  const totalOptions = parsed.questions.reduce(
    (sum, q) => sum + q.options.length,
    0,
  );
  // 多个 question 时 summary 拼出选项总数, 单 question 保留 header 提示
  const firstHeader = parsed.questions[0]?.header;
  const summary =
    n === 1
      ? firstHeader
        ? truncateField(firstHeader, QUESTION_TEXT_MAX)
        : truncateField(parsed.questions[0].question, QUESTION_TEXT_MAX)
      : `${n} questions (${totalOptions} options)`;
  return display(summary, "question", "Question");
}

function patchDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const entries = parseAgentPatch(input);
  if (entries.length === 0) return undefined;
  const first = entries[0];
  const verb =
    first.action === "update"
      ? "Update"
      : first.action === "add"
        ? "Add"
        : first.action === "delete"
          ? "Delete"
          : "Patch";
  const name = extractFileName(first.path) || first.path;
  const summary =
    entries.length === 1
      ? `${verb} ${name}`
      : `${verb} ${name} (+${entries.length - 1})`;
  return display(summary, "patch", first.path);
}

/* ════════════════════════════════════════════════════════════════════════
 *  todoDisplay ── Codex update_plan 工具 (含 TodoWrite / todo_list 等别名)
 *
 *  arguments: { plan: Array<{ status, step }> }
 *
 *  summary = "N/M · 正在做: <current step>"   (单行展示)
 *  title   = "Todo" / "待办"                  (卡片标题)
 *  kind    = "todo"                            (新加的 kind, 给 renderer 分支用)
 *
 *  与其它 formatter 同构: 失败返回 undefined, 让 createAgentToolDisplay
 *  走 getAgentToolInputSummary fallback 路径.
 * ════════════════════════════════════════════════════════════════════════ */

function todoDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const summary = formatAgentPlanSummaryForDisplay(input);
  if (!summary) return undefined;
  return display(summary, "todo", "Todo");
}

const FORMATTERS: Record<string, ToolDisplayFormatter> = {
  "*:read": fileDisplay,
  "*:read_file": fileDisplay,
  "*:write": fileDisplay,
  "*:write_file": fileDisplay,
  "*:create_file": fileDisplay,
  "*:edit": fileDisplay,
  "*:edit_file": fileDisplay,
  "*:delete": fileDisplay,
  "*:delete_file": fileDisplay,
  "*:ls": directoryDisplay,
  "*:list_directory": directoryDisplay,
  "*:list_notebooks": directoryDisplay,
  "*:glob": searchDisplay,
  "*:search_files": searchDisplay,
  "*:grep": searchDisplay,
  "codex:web_search": searchDisplay,
  "codex:web_search_preview": searchDisplay,
  "codex:web_search_call": searchDisplay,
  "codex:search_query": searchDisplay,
  "*:web_search": searchDisplay,
  "*:web_search_preview": searchDisplay,
  "*:web_search_call": searchDisplay,
  "*:search_query": searchDisplay,
  "*:web search": searchDisplay,
  "*:search_web": searchDisplay,
  "*:network_search": searchDisplay,
  "*:shell": commandDisplay,
  "*:bash": commandDisplay,
  "*:exec_command": commandDisplay,
  "*:command_execute": commandDisplay,
  "*:run_command": commandDisplay,
  "*:execute": commandDisplay,
  "*:terminal": commandDisplay,
  "*:powershell": commandDisplay,
  "*:cmd": commandDisplay,
  "codex:command_execution": commandDisplay,
  "codex:shell_command": commandDisplay,
  "claude:bash": commandDisplay,
  "claude:shell": commandDisplay,
  "claude:run_command": commandDisplay,
  "hermes:shell": commandDisplay,
  "hermes:bash": commandDisplay,
  "hermes:run_command": commandDisplay,
  "flowix:shell": commandDisplay,
  "flowix:bash": commandDisplay,
  "flowix:run_command": commandDisplay,
  "*:execute_command": commandDisplay,
  "*:command_execution": commandDisplay,
  "*:shell_command": commandDisplay,
  "codex:mcp_tool_call": mcpToolDisplay,
  "codex:file_change": fileChangeDisplay,
  "codex:view_image": viewImageDisplay,
  "*:load_skill": skillDisplay,
  "*:sub_agent": agentDisplay,
  "*:server": urlDisplay,
  "*:api": urlDisplay,
  // update_plan / TodoWrite / todo_list 统一走 todoDisplay
  "*:update_plan": todoDisplay,
  "*:update_todo_list": todoDisplay,
  "*:todo_list": todoDisplay,
  "*:todowrite": todoDisplay,
  "*:todolist": todoDisplay,
  "*:todo": todoDisplay,
  "*:plan": todoDisplay,
  "codex:update_plan": todoDisplay,
  "codex:update_todo_list": todoDisplay,
  "codex:todo_list": todoDisplay,
  "codex:todowrite": todoDisplay,
  "codex:todolist": todoDisplay,
  "codex:todo": todoDisplay,
  "codex:plan": todoDisplay,
  // apply_patch 工具 ── Codex 实际 function_call.name
  "*:apply_patch": patchDisplay,
  "codex:apply_patch": patchDisplay,
  "*:request_user_input": requestUserInputDisplay,
  "codex:request_user_input": requestUserInputDisplay,
};

function formatterKeys(
  agentType: AgentTypeKey | undefined,
  toolName: string,
): string[] {
  return agentType
    ? [`${agentType}:${toolName}`, `*:${toolName}`]
    : [`*:${toolName}`];
}

export function getAgentToolInputSummary(
  input?: Record<string, unknown>,
): string {
  if (!input || typeof input !== "object") return "";

  const preferred =
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    input.command_preview ??
    input.command ??
    input.command_text ??
    input.commandText ??
    input.cmd ??
    input.cmdline ??
    input.shell_command ??
    input.script ??
    input.cwd;
  if (typeof preferred === "string" && preferred.length > 0) {
    const kind = fieldKind(
      Object.keys(input).find((key) => input[key] === preferred) ?? "",
    );
    return kind === "file" ? extractFileName(preferred) : preferred;
  }

  const first = Object.entries(input)[0];
  return first ? `${first[0]}: ${valueToText(first[1]).split("\n")[0]}` : "";
}

export function createAgentToolDisplay(
  context: AgentToolDisplayContext,
): AgentToolDisplay | undefined {
  const { agentType, toolName, input } = context;
  const normalized = normalizeToolInput(input);
  if (!normalized) return undefined;

  const normalizedToolName = (toolName ?? "").toLowerCase();
  for (const key of formatterKeys(agentType, normalizedToolName)) {
    const formatted = FORMATTERS[key]?.(normalized, {
      agentType,
      toolName: normalizedToolName,
      input,
    });
    if (formatted) return formatted;
  }

  const summary = getAgentToolInputSummary(normalized);
  if (!summary) return undefined;

  const firstPreferredKey = [
    "path",
    "pattern",
    "query",
    "url",
    "command_preview",
    "command",
    "command_text",
    "commandText",
    "cmd",
    "cmdline",
    "shell_command",
    "script",
    "cwd",
  ].find(
    (key) =>
      typeof normalized[key] === "string" && String(normalized[key]).length > 0,
  );

  const inferredKind = firstPreferredKey
    ? fieldKind(firstPreferredKey)
    : toolName === "web_search"
      ? "search"
      : "generic";
  return {
    summary,
    title: summary,
    kind: inferredKind,
  };
}
