import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { NotebookAccessFilesList } from "@features/memo/components/notebook-access-files-list";
import type { Notebook } from "@features/memo/store/memo-store";
import type { AgentAccessConfig, AgentAccessEntry } from "@/lib/types/agent-access";

// ── Mocks ────────────────────────────────────────────────────────────────────

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMock }));

vi.mock(import("@/lib/i18n"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useI18n: () => ({
      language: "en-US",
      t: (key: string, params?: Record<string, string | number>) => {
        const labels: Record<string, string> = {
          "memo.navigation.files": "Files",
          "memo.navigation.addFolder": "Add",
          "agent.access.pathMissing": "Folder missing",
          "agent.access.workspaceBadge": "Workspace",
          "agent.access.setWorkspace": "Set as workspace",
          "agent.access.contextSetWorkspace": "Set as workspace",
          "agent.access.contextUnsetWorkspace": "Unset workspace",
          "agent.access.contextDelete": "Delete",
          "agent.access.folderDeleted": 'Folder "{{name}}" removed',
          "agent.access.addFolderHint": "Add to AI access",
          "agent.access.saveFailed": "Failed to save",
          "agent.access.alreadyTracked": "Already tracked",
          "agent.access.folderExists": "Already added",
        };
        let result = labels[key] ?? key;
        if (params && key === "agent.access.folderDeleted") {
          result = result.replace("{{name}}", String(params.name));
        }
        return result;
      },
    }),
  };
});

vi.mock("@shared/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
}));

// 不模拟"行归属"的菜单项 ── ContextMenuContent / Item 在 mock 里只挂
// `data-testid="menu-item:<label>"`, 通过 label 区分。 每个 folder 行的菜单
// 项都会渲染到 DOM, 通过 DOM 顺序 ([a, b]) 与 folders 数组顺序对应 ── 测试
// 用 queryAllByLabel + 索引点正确行的菜单。
vi.mock("@shared/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) =>
    createElement(React.Fragment, null, children),
  ContextMenuTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: ReactNode;
    asChild?: boolean;
  }) => createElement("div", { "data-testid": "row" }, children),
  ContextMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "context-content" }, children),
  ContextMenuItem: ({
    children,
    onClick,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => {
    const label = typeof children === "string" ? children : String(children);
    return createElement(
      "button",
      {
        type: "button",
        "data-testid": `menu-item:${label}`,
        className,
        onClick,
      },
      label,
    );
  },
  ContextMenuSeparator: () => createElement("hr", { "data-testid": "separator" }),
}));

const React = require("react");

const setDefaultFilesMock = vi.fn(async () => true);

beforeEach(() => {
  useAgentAccessStore.setState({
    config: { version: 1, entries: [], defaults: {} } as AgentAccessConfig,
    isLoading: false,
  });
  const original = useAgentAccessStore.getState();
  useAgentAccessStore.setState({
    ...original,
    setDefaultFiles: setDefaultFilesMock as unknown as typeof original.setDefaultFiles,
  });
  setDefaultFilesMock.mockClear();
  setDefaultFilesMock.mockResolvedValue(true);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeFolderEntry(
  path: string,
  overrides: Partial<AgentAccessEntry> = {},
): AgentAccessEntry {
  return {
    id: `fld_${path}`,
    kind: "folder",
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    enabled: true,
    workspace: false,
    missing: false,
    addedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeNotebook(overrides: Partial<Notebook> = {}): Notebook {
  return {
    id: "nb_1",
    name: "Notebook",
    icon: null,
    path: "/Users/notes/notebook",
    createdAt: 0,
    updatedAt: 0,
    isDefault: false,
    ...overrides,
  };
}

interface MountHandle {
  root: Root;
  host: HTMLDivElement;
}

function mountNotebookAccessFilesList(
  notebook: Notebook | undefined,
  folders: string[],
  workspace: string | null | undefined,
): MountHandle {
  const entries = folders.map((p) => makeFolderEntry(p));
  useAgentAccessStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      entries,
      defaults: {
        ...state.config.defaults,
        files: {
          ...state.config.defaults?.files,
          [notebook?.id ?? "nb_1"]: {
            folders,
            ...(workspace !== undefined ? { workspace } : {}),
            notebooks: [],
          },
        },
      },
    },
  }));

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  void act(() => {
    root.render(createElement(NotebookAccessFilesList, { notebook }));
  });
  return { root, host };
}

function countMenuItems(host: HTMLElement, label: string): number {
  return host.querySelectorAll(`[data-testid="menu-item:${label}"]`).length;
}

function findMenuItem(host: HTMLElement, label: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="menu-item:${label}"]`);
}

// 行 index (与 folders 数组同序) → 第 N 个匹配 label 的菜单项
function nthMenuItem(host: HTMLElement, label: string, index: number): HTMLElement | null {
  const all = host.querySelectorAll<HTMLElement>(
    `[data-testid="menu-item:${label}"]`,
  );
  return all[index] ?? null;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("NotebookAccessFilesList — 右键菜单与主空间派生", () => {
  let activeHandle: MountHandle | null = null;

  afterEach(() => {
    if (activeHandle) {
      void act(() => {
        activeHandle!.root.unmount();
      });
      activeHandle.host.remove();
    }
    activeHandle = null;
  });

  it("多 folder + workspace=folder-a: 整体菜单出现 1×设为主空间 + 1×取消主空间 + 2×删除", () => {
    activeHandle = mountNotebookAccessFilesList(
      makeNotebook(),
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    expect(countMenuItems(host, "Set as workspace")).toBe(1);
    expect(countMenuItems(host, "Unset workspace")).toBe(1);
    expect(countMenuItems(host, "Delete")).toBe(2);
  });

  it("单 folder + workspace=only: 菜单 0×设为主空间 + 1×取消主空间 + 1×删除 (决策 4)", () => {
    activeHandle = mountNotebookAccessFilesList(
      makeNotebook(),
      ["/only-folder"],
      "/only-folder",
    );
    const { host } = activeHandle;

    expect(countMenuItems(host, "Set as workspace")).toBe(0);
    expect(countMenuItems(host, "Unset workspace")).toBe(1);
    expect(countMenuItems(host, "Delete")).toBe(1);
  });

  it("单 folder + workspace=null (用户取消主空间后): 菜单 1×设为主空间 + 0×取消主空间 + 1×删除, 用户可恢复主空间", () => {
    // 用户显式取消唯一 folder 的主空间后, 该 folder 仍在列表里, 但
    // effectiveWorkspace 已退到 notebook.path; 此时右键菜单需要能"再设为主空间"
    // 恢复标识 ── 之前的 canSetWorkspace = folderItems.length > 1 把整个
    // 单 folder 菜单都藏了, 这里修复。
    activeHandle = mountNotebookAccessFilesList(
      makeNotebook(),
      ["/only-folder"],
      null,
    );
    const { host } = activeHandle;

    expect(countMenuItems(host, "Set as workspace")).toBe(1);
    expect(countMenuItems(host, "Unset workspace")).toBe(0);
    expect(countMenuItems(host, "Delete")).toBe(1);
  });

  it("触发 '设为主空间' 恢复单 folder: setDefaultFiles 被以 workspace=only-folder 调用", async () => {
    const notebook = makeNotebook();
    activeHandle = mountNotebookAccessFilesList(
      notebook,
      ["/only-folder"],
      null,
    );
    const { host } = activeHandle;

    const setBtn = findMenuItem(host, "Set as workspace");
    expect(setBtn).not.toBeNull();

    await act(async () => {
      setBtn!.click();
      await Promise.resolve();
    });

    expect(setDefaultFilesMock).toHaveBeenCalledTimes(1);
    expect(setDefaultFilesMock).toHaveBeenCalledWith(notebook.id, {
      workspace: "/only-folder",
      folders: ["/only-folder"],
      notebooks: [],
    });
  });

  it("workspace=null (显式取消): 2×设为主空间 + 0×取消主空间 + 2×删除; 任何行无 workspace-mark", () => {
    activeHandle = mountNotebookAccessFilesList(
      makeNotebook({ path: "/Users/notes/main" }),
      ["/folder-a", "/folder-b"],
      null,
    );
    const { host } = activeHandle;

    expect(countMenuItems(host, "Set as workspace")).toBe(2);
    expect(countMenuItems(host, "Unset workspace")).toBe(0);
    expect(countMenuItems(host, "Delete")).toBe(2);

    const workspaceMarks = host.querySelectorAll(
      ".agent-thread-card__access-workspace-mark",
    );
    expect(workspaceMarks.length).toBe(0);
  });

  it("workspace=folder-a: 角标只出现在 folder-a 行 (1 个 workspace-mark)", () => {
    activeHandle = mountNotebookAccessFilesList(
      makeNotebook(),
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    const workspaceMarks = host.querySelectorAll(
      ".agent-thread-card__access-workspace-mark",
    );
    expect(workspaceMarks.length).toBe(1);
  });

  it("触发 '取消主空间' 后, setDefaultFiles 被以 workspace=null 调用, folders 保留", async () => {
    const notebook = makeNotebook();
    activeHandle = mountNotebookAccessFilesList(
      notebook,
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    const unsetBtn = findMenuItem(host, "Unset workspace");
    expect(unsetBtn).not.toBeNull();

    await act(async () => {
      unsetBtn!.click();
      await Promise.resolve();
    });

    expect(setDefaultFilesMock).toHaveBeenCalledTimes(1);
    expect(setDefaultFilesMock).toHaveBeenCalledWith(notebook.id, {
      workspace: null,
      folders: ["/folder-a", "/folder-b"],
      notebooks: [],
    });
  });

  it("触发 '设为主空间' 后, setDefaultFiles 被以 workspace=folder-b 调用", async () => {
    const notebook = makeNotebook();
    activeHandle = mountNotebookAccessFilesList(
      notebook,
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    const setBtn = findMenuItem(host, "Set as workspace");
    expect(setBtn).not.toBeNull();

    await act(async () => {
      setBtn!.click();
      await Promise.resolve();
    });

    expect(setDefaultFilesMock).toHaveBeenCalledTimes(1);
    expect(setDefaultFilesMock).toHaveBeenCalledWith(notebook.id, {
      workspace: "/folder-b",
      folders: ["/folder-a", "/folder-b"],
      notebooks: [],
    });
  });

  it("删除主空间 folder (index 0): workspace 显式置 null, folders 排除 folder-a", async () => {
    const notebook = makeNotebook();
    activeHandle = mountNotebookAccessFilesList(
      notebook,
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    const deleteA = nthMenuItem(host, "Delete", 0);
    expect(deleteA).not.toBeNull();

    await act(async () => {
      deleteA!.click();
      await Promise.resolve();
    });

    expect(setDefaultFilesMock).toHaveBeenCalledTimes(1);
    expect(setDefaultFilesMock).toHaveBeenCalledWith(notebook.id, {
      workspace: null,
      folders: ["/folder-b"],
      notebooks: [],
    });
    expect(toastMock.success).toHaveBeenCalledWith('Folder "folder-a" removed');
  });

  it("删除非主空间 folder (index 1): workspace 保留原值, folders 排除 folder-b", async () => {
    const notebook = makeNotebook();
    activeHandle = mountNotebookAccessFilesList(
      notebook,
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    const deleteB = nthMenuItem(host, "Delete", 1);
    expect(deleteB).not.toBeNull();

    await act(async () => {
      deleteB!.click();
      await Promise.resolve();
    });

    expect(setDefaultFilesMock).toHaveBeenCalledWith(notebook.id, {
      workspace: "/folder-a",
      folders: ["/folder-a"],
      notebooks: [],
    });
  });

  it("setDefaultFiles 失败时, toast.error 提示且不弹成功 toast", async () => {
    setDefaultFilesMock.mockResolvedValue(false);
    const notebook = makeNotebook();
    activeHandle = mountNotebookAccessFilesList(
      notebook,
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    const deleteA = nthMenuItem(host, "Delete", 0);
    expect(deleteA).not.toBeNull();
    await act(async () => {
      deleteA!.click();
      await Promise.resolve();
    });

    expect(toastMock.error).toHaveBeenCalledWith("Failed to save");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("未选 notebook: 不渲染 folder 行", () => {
    activeHandle = mountNotebookAccessFilesList(
      undefined,
      ["/folder-a", "/folder-b"],
      "/folder-a",
    );
    const { host } = activeHandle;

    expect(countMenuItems(host, "Delete")).toBe(0);
    expect(countMenuItems(host, "Set as workspace")).toBe(0);
    expect(countMenuItems(host, "Unset workspace")).toBe(0);
  });
});