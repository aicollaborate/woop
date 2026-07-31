import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentRuntimeConfig,
  AgentTypeKey,
  FilesConfig,
  RuntimeConfig,
  WorkspaceSnapshot,
} from "@/types/agent";
import { CODEX_ACCESS_OPTIONS } from "@features/agent/config/codex-options";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";

export type AgentRuntimeSettingKind = "model" | "reasoning" | "permission";

export interface AgentAccessOption {
  id: AgentPermissionMode;
  label: string;
}

export interface BuildAgentRuntimeConfigInput {
  typeKey: AgentTypeKey;
  /** 当前笔记本路径 (= systemReminderDirectory)。无资料时作主空间。 */
  notebookPath?: string;
  permissionMode: AgentPermissionMode;
  codexModel: AgentCodexModel;
  codexReasoningEffort: AgentCodexReasoningEffort;
  instanceRuntimeConfig?: RuntimeConfig;
  /** 当前笔记本的资料默认 (defaults.files[<notebookId>])。 */
  defaultFiles?: FilesConfig;
  /** Conversation-scoped path snapshot; takes precedence over live inputs. */
  workspaceSnapshot?: WorkspaceSnapshot | null;
}

export interface AgentRuntimeSpec {
  typeKey: AgentTypeKey;
  emptySettings: readonly AgentRuntimeSettingKind[];
  accessOptions: readonly AgentAccessOption[];
  buildRuntimeConfig: (
    input: Omit<BuildAgentRuntimeConfigInput, "typeKey"> & {
      cwd?: string;
      workspacePaths: string[];
    },
  ) => AgentRuntimeConfig;
}

const HERMES_ACCESS_OPTIONS: readonly AgentAccessOption[] = [
  { id: "inherit", label: "Default" },
  { id: "danger-full-access", label: "Full Access" },
];

const CLAUDE_ACCESS_OPTIONS: readonly AgentAccessOption[] = [
  { id: "yolo", label: "YOLO" },
  { id: "danger-full-access", label: "Full Access" },
  { id: "workspace-write", label: "Workspace Write" },
  { id: "read-only", label: "Read Only" },
];

const NO_ACCESS_OPTIONS: readonly AgentAccessOption[] = [];

export function normalizeCodexPermissionMode(
  mode: AgentPermissionMode | undefined,
): AgentPermissionMode {
  return mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "danger-full-access" ||
    mode === "yolo"
    ? mode
    : "danger-full-access";
}

const AGENT_RUNTIME_SPECS: Record<AgentTypeKey, AgentRuntimeSpec> = {
  flowix: {
    typeKey: "flowix",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      flowix: { cwd, workspacePaths },
    }),
  },
  codex: {
    typeKey: "codex",
    emptySettings: ["model", "reasoning", "permission"],
    accessOptions: CODEX_ACCESS_OPTIONS,
    buildRuntimeConfig: ({
      cwd,
      workspacePaths,
      permissionMode,
      codexModel,
      codexReasoningEffort,
    }) => ({
      codex: {
        cwd,
        workspacePaths,
        permissionMode: normalizeCodexPermissionMode(permissionMode),
        model: codexModel,
        reasoningEffort: codexReasoningEffort,
      },
    }),
  },
  claude: {
    typeKey: "claude",
    emptySettings: ["model", "permission"],
    accessOptions: CLAUDE_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode, codexModel }) => ({
      claude: { cwd, workspacePaths, permissionMode, model: codexModel },
    }),
  },
  gemini: {
    typeKey: "gemini",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      gemini: { cwd, workspacePaths },
    }),
  },
  hermes: {
    typeKey: "hermes",
    emptySettings: ["permission"],
    accessOptions: HERMES_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      hermes: { cwd, workspacePaths, permissionMode },
    }),
  },
  openclaw: {
    typeKey: "openclaw",
    emptySettings: [],
    accessOptions: NO_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths }) => ({
      openclaw: { cwd, workspacePaths },
    }),
  },
  opencode: {
    typeKey: "opencode",
    emptySettings: ["permission"],
    accessOptions: CODEX_ACCESS_OPTIONS,
    buildRuntimeConfig: ({ cwd, workspacePaths, permissionMode }) => ({
      opencode: { cwd, workspacePaths, permissionMode },
    }),
  },
};

export function getAgentRuntimeSpec(typeKey: AgentTypeKey): AgentRuntimeSpec {
  return AGENT_RUNTIME_SPECS[typeKey];
}

export function supportsAgentRuntimeSetting(
  typeKey: AgentTypeKey,
  kind: AgentRuntimeSettingKind,
): boolean {
  return getAgentRuntimeSpec(typeKey).emptySettings.includes(kind);
}

export function supportsAgentEmptySettings(typeKey: AgentTypeKey): boolean {
  // files 控件已移除 (主空间由侧边栏资料列表决定), 空状态设置区只看
  // model / permission / reasoning 是否有可配置项。
  const spec = getAgentRuntimeSpec(typeKey);
  return spec.emptySettings.length > 0;
}

export function getAgentAccessOptions(
  typeKey: AgentTypeKey,
): readonly AgentAccessOption[] {
  return getAgentRuntimeSpec(typeKey).accessOptions;
}

export function buildAgentRuntimeConfig({
  typeKey,
  notebookPath,
  permissionMode,
  codexModel,
  codexReasoningEffort,
  instanceRuntimeConfig,
  defaultFiles,
  workspaceSnapshot,
}: BuildAgentRuntimeConfigInput): AgentRuntimeConfig {
  // 文件区域 = 资料列表 (defaults.files[<notebookId>].folders) + 当前笔记本。
  // 主空间 (cwd) 由 resolvePrimaryWorkspace 决定: 资料主空间 -> 资料首
  // folder -> 当前笔记本。 主空间本身也留在 workspacePaths 里, 由后端
  // (claude/command.rs::normalized_additional_workspace_dirs) 去重 cwd,
  // 不会重复出现在 --add-dir。
  // Before the first run, workspaceSnapshot.cwd is the already-resolved
  // notebook workspace candidate (资料主空间 -> 资料首 folder -> 笔记本路径).
  // Send that exact cwd to the backend; once the run starts, the backend's
  // dedicated frozen_cwd column becomes the sole authority for later turns.
  // workspaceSnapshot.workspacePaths follows the same conversation snapshot.
  const frozenPaths = (workspaceSnapshot?.workspacePaths ?? [])
    .map(normalizeWorkspacePath)
    .filter(Boolean);
  const folderPaths = (defaultFiles?.folders ?? [])
    .map(normalizeWorkspacePath)
    .filter(Boolean);
  const notebookPathNorm = normalizeWorkspacePath(notebookPath) || undefined;

  const resolvedPrimary = resolvePrimaryWorkspace({ defaultFiles, notebookPath });
  const livePrimary = resolvedPrimary.kind === "empty" ? undefined : resolvedPrimary.path;
  const snapshotPrimary = normalizeWorkspacePath(workspaceSnapshot?.cwd) || undefined;
  const primaryWorkspace = snapshotPrimary ?? livePrimary;
  const workspacePaths = workspaceSnapshot
    ? Array.from(
        new Set([primaryWorkspace, ...frozenPaths].filter((p): p is string => Boolean(p))),
      )
    : Array.from(
        new Set([...folderPaths, ...(notebookPathNorm ? [notebookPathNorm] : [])]),
      );

  const effectivePermissionMode =
    instanceRuntimeConfig?.access?.sandbox ?? permissionMode;
  const effectiveModel =
    instanceRuntimeConfig?.model?.key ?? codexModel;
  const effectiveReasoningEffort =
    instanceRuntimeConfig?.reasoningEffort ?? codexReasoningEffort;
  return getAgentRuntimeSpec(typeKey).buildRuntimeConfig({
    cwd: primaryWorkspace,
    workspacePaths,
    permissionMode: effectivePermissionMode,
    codexModel: effectiveModel,
    codexReasoningEffort: effectiveReasoningEffort,
  });
}
