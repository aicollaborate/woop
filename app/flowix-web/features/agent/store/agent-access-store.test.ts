import { beforeEach, describe, expect, it, vi } from "vitest";

const agentAccessMock = vi.hoisted(() => ({
  config: { version: 1, entries: [] as Array<Record<string, unknown>> },
  get: vi.fn(),
  set: vi.fn(),
  addFolderFromPicker: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agentAccess: {
    get: agentAccessMock.get,
    set: agentAccessMock.set,
    addFolderFromPicker: agentAccessMock.addFolderFromPicker,
  },
}));

type TestEntry = {
  id: string;
  kind: "folder" | "notebook";
  path: string;
  name: string;
  enabled: boolean;
  workspace: boolean;
  missing: boolean;
  addedAt: number;
  updatedAt: number;
};

function makeFolder(
  overrides: Partial<TestEntry> & { id: string; path: string },
): TestEntry {
  return {
    id: overrides.id,
    kind: "folder",
    path: overrides.path,
    name: overrides.name ?? overrides.path,
    enabled: overrides.enabled ?? true,
    workspace: overrides.workspace ?? false,
    missing: overrides.missing ?? false,
    addedAt: overrides.addedAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

function entriesWithWorkspace(items: TestEntry[]): {
  version: 1;
  entries: TestEntry[];
} {
  return { version: 1, entries: items };
}

describe("agent-access-store workspace selection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    agentAccessMock.config = { version: 1, entries: [] };
    agentAccessMock.get.mockImplementation(async () => agentAccessMock.config);
    agentAccessMock.set.mockImplementation(async (config) => {
      agentAccessMock.config = config;
    });
    agentAccessMock.addFolderFromPicker.mockImplementation(async () => null);
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: { version: 1, entries: [] },
      isLoading: false,
    });
  });

  it("does NOT auto-promote a folder to workspace on initial load", async () => {
    // 新契约: workspace 完全由 setWorkspace 显式触发, loadInitial 不会把
    // 第一个 enabled folder 自动升为主空间。 磁盘原值原样落库。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    agentAccessMock.config = entriesWithWorkspace([
      makeFolder({
        id: "folder-1",
        path: "D:\\projects\\first",
        name: "First",
      }),
      makeFolder({
        id: "folder-2",
        path: "D:\\projects\\second",
        name: "Second",
      }),
    ]);

    await useAgentAccessStore.getState().loadInitial();

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries.every((entry) => entry.workspace === false)).toBe(true);
  });


  it("addFolder keeps new folders as non-workspace even when no workspace exists", async () => {
    // 不再隐式 promote: 加文件夹不会"顺手"抢占空缺的 workspace 槽位, 用
    // 户必须显式触发 setWorkspace 才能指派。
    const { useAgentAccessStore } =
      await import("@features/agent/store/agent-access-store");
    useAgentAccessStore.setState({
      config: { version: 1, entries: [] },
      isLoading: false,
    });

    const result = await useAgentAccessStore
      .getState()
      .addFolder("D:\\projects\\new");
    expect(result.ok).toBe(true);

    const entries = useAgentAccessStore.getState().config.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enabled).toBe(true);
    expect(entries[0]?.workspace).toBe(false);
  });
});