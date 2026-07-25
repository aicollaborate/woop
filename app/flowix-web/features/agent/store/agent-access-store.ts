/**
 * Agent 可访问目录 store ── zustand 镜像后端
 * `~/.flowix/agent-access.json` 的整份 config。 与 `user-settings-store`
 * 不同, 本 store 没有 persist (后端是真源), 走 IPC + 跨窗口事件同步。
 *
 * 写操作 (`addFolder`) 走乐观更新: 本地先
 * 改 `entries` 再 `await agentAccess.set` 整份, 失败时 `loadInitial`
 * 回滚到磁盘真值。 跨窗口同步靠 app.tsx 顶层挂的 `listenToAgentAccessChanges`,
 * 收到事件后从磁盘拉整份覆盖内存。
 */

import { create } from "zustand";
import { agentAccess } from "@platform/tauri/client";
import { normalizeFilesDefaults } from "@/lib/agent-access-defaults";
import { DEFAULT_FILES_GLOBAL_KEY } from "@/lib/types/agent-access";
import type {
  AgentAccessConfig,
  AgentAccessDefaultRuntime,
  AgentAccessEntry,
} from "@/lib/types/agent-access";
import type { AgentTypeKey, FilesConfig } from "@/types/agent";

// This store mirrors `~/.flowix/agent-access.json`.
// It owns defaults for newly created agent-thread-card instances and keeps the
// global entries list (folder metadata pool: name / missing / bookmark).
// Real conversation runs derive cwd / workspacePaths from
// `defaults.files[<notebookId>]` + the current notebook (see
// agent-runtime-spec::buildAgentRuntimeConfig), not from instance.files.

export type AgentAccessErrorCode =
  "not-selected" | "already-tracked" | "save-failed";

export interface AgentAccessState {
  config: AgentAccessConfig;
  isLoading: boolean;

  /** 从磁盘拉整份 config ── 启动 / 跨窗口事件 / 写失败回滚都走它。 */
  loadInitial: () => Promise<void>;
/**
   * 加一个 folder。 走后端 picker 让用户挑本地目录, 后端同时保存
   * macOS security-scoped bookmark。路径已存在 (notebook 同路径或
   * 已加的 folder) 时后端返回 `PathConflict`, UI 弹 toast 但不动 store。
   */
  addFolderFromPicker: () => Promise<
    | { ok: true; entry: AgentAccessEntry }
    | { ok: false; code: AgentAccessErrorCode }
  >;

  /**
   * 直接以给定路径加 folder ── 跳过 dialog picker, 给测试 / 偏好窗口
   * 等场景复用。 UI 层用 `addFolderFromPicker`。
   */
  addFolder: (
    path: string,
    name?: string,
  ) => Promise<
    | { ok: true; entry: AgentAccessEntry }
    | { ok: false; code: AgentAccessErrorCode }
  >;

  setDefaultRuntime: (
    agentType: AgentTypeKey,
    patch: AgentAccessDefaultRuntime,
  ) => Promise<void>;
  /**
   * 把"卡片里确认的 files"写到所属 notebook 的默认 ── `defaults.files[<notebookId>]`。
   * notebookId 为 null/undefined (历史 instance / 未选笔记本) 时落 `_global` 兜底,
   * 保留其它 notebook 的默认不被覆盖。
   */
  setDefaultFiles: (
    notebookId: string | null | undefined,
    files: FilesConfig,
  ) => Promise<boolean>;
}

const EMPTY_CONFIG: AgentAccessConfig = { version: 1, entries: [], defaults: {} };

export const useAgentAccessStore = create<AgentAccessState>((set, get) => ({
  config: EMPTY_CONFIG,
  isLoading: false,

  loadInitial: async () => {
    set({ isLoading: true });
    try {
      // 直接以磁盘真值落库 ── workspace 不再做"第一个 enabled 自动升主空间"
      // 的派生。 历史数据如果已经写入过 workspace, 这里原样保留; 新装或
      // 用户主动清空的情况下, 没有 workspace 也合法 (允许用户完全不要主
      // 空间, 由其它 entry 单独决定访问范围)。
      const config = await agentAccess.get();
      set({ config, isLoading: false });
    } catch (e) {
      // 静默失败 ── 与 `user-settings-store.loadInitial` 同形, 把
      // 错误信息留给后续用户操作触发。 UI 在 config.entries 为空时
      // 会渲染空状态, 不会卡死。
      console.error("agentAccess.loadInitial failed:", e);
      set({ isLoading: false });
    }
  },  addFolder: async (path: string, name?: string) => {
    const entry = makeLocalFolderEntry(path, name);
    const prev = get().config;
    // 新加的 folder: enabled=true, workspace=false ── 不再隐式自动升级为
    // workspace (避免"加文件夹就变主空间"的副作用)。
    const optimistic = {
      ...prev,
      entries: [...prev.entries, entry],
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
      return { ok: true, entry };
    } catch (e) {
      const reason = extractReason(e);
      if (reason === "path conflict") {
        // 用户选了一个已经跟踪的路径, 不写盘也不留乐观条目 ── 回滚到
        // 真正的"没加"状态, 让用户看到原列表。
        set({ config: prev });
        return { ok: false, code: "already-tracked" };
      }
      console.error("agentAccess.addFolder failed, rolling back:", e);
      await get().loadInitial();
      return { ok: false, code: "save-failed" };
    }
  },

  addFolderFromPicker: async () => {
    try {
      const entry = await agentAccess.addFolderFromPicker();
      if (!entry) {
        return { ok: false, code: "not-selected" };
      }
      await get().loadInitial();
      return { ok: true, entry };
    } catch (e) {
      const reason = extractReason(e);
      if (reason === "path conflict") {
        await get().loadInitial();
        return { ok: false, code: "already-tracked" };
      }
      console.error("agentAccess.addFolderFromPicker failed:", e);
      await get().loadInitial();
      return { ok: false, code: "save-failed" };
    }
  },
  setDefaultRuntime: async (agentType, patch) => {
    const prev = get().config;
    const optimistic: AgentAccessConfig = {
      ...prev,
      defaults: {
        ...(prev.defaults ?? {}),
        runtime: {
          ...(prev.defaults?.runtime ?? {}),
          [agentType]: {
            ...(prev.defaults?.runtime?.[agentType] ?? {}),
            ...patch,
          },
        },
      },
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
    } catch (e) {
      console.error("agentAccess.setDefaultRuntime failed, rolling back:", e);
      await get().loadInitial();
    }
  },

  setDefaultFiles: async (notebookId, files) => {
    const prev = get().config;
    const key = notebookId ?? DEFAULT_FILES_GLOBAL_KEY;
    // 归一化老 schema (单对象 FilesConfig) 到索引, 保留其它 notebook 的默认。
    const prevIndexed = normalizeFilesDefaults(prev.defaults?.files);
    const optimistic: AgentAccessConfig = {
      ...prev,
      defaults: {
        ...(prev.defaults ?? {}),
        files: {
          ...prevIndexed,
          [key]: {
            workspace: files.workspace,
            folders: [...files.folders],
            notebooks: [...files.notebooks],
          },
        },
      },
    };
    set({ config: optimistic });
    try {
      await agentAccess.set(optimistic);
      return true;
    } catch (e) {
      console.error("agentAccess.setDefaultFiles failed, rolling back:", e);
      await get().loadInitial();
      return false;
    }
  },
}));
/** 在前端构造一条 Folder entry ── 路径 / 名字都是用户给的值, id 用时间戳
 * + 随机段保证与后端 `fld_<6位>` 不冲突即可 (后端写盘后会刷新 missing 字段)。 */
function makeLocalFolderEntry(path: string, name?: string): AgentAccessEntry {
  const trimmed = path.replace(/[\\/]+$/, "");
  const derived = name?.trim() || trimmed.split(/[\\/]/).pop() || trimmed;
  const now = Date.now();
  return {
    id: `fld_${now}_${Math.random().toString(36).slice(2, 6)}`,
    kind: "folder",
    path: trimmed,
    name: derived,
    enabled: true,
    workspace: false,
    addedAt: now,
    updatedAt: now,
    missing: false,
  };
}

/** 后端 IPC 失败时, Tauri 抛的 Error 里 `message` 是 `String`, 我们要
 * 识别 "path already tracked" 这条 user-facing 消息 → 走"回滚 + 友好
 * 提示"分支。 */
function extractReason(e: unknown): string | null {
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message: unknown }).message;
    if (typeof msg === "string") {
      if (msg.includes("path already tracked")) return "path conflict";
      return msg;
    }
  }
  return null;
}
