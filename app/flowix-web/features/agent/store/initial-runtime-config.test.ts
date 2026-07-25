/**
 * 新模型下 buildInitialInstanceRuntimeConfig 只种子 model / access /
 * reasoningEffort 的全局默认 + 创建时所属 notebookId ── 文件区域 (cwd /
 * folders / notebooks) 在提交时由 agent-runtime-spec 实时推导, 不再烧录
 * 进 instance.files, 也无 _frozen / lockInstanceFileSeed / backfill 机制。
 *
 * 旧版本测的 cwd / files / frozen seed / backfill / defaults.files 权威
 * 快照等场景已不再适用, 这份测试只盯 model / access / reasoningEffort /
 * notebookId 四条。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const memoStateMock = vi.hoisted(() => ({
  selectedNotebook: null as null | { id: string; path: string } | unknown,
}));

const accessStateMock = vi.hoisted(() => ({
  config: {
    version: 1,
    entries: [] as Array<unknown>,
  } as {
    version: number;
    entries: Array<unknown>;
    defaults?: {
      runtime?: Record<
        string,
        {
          model?: { key: string };
          access?: { sandbox: string };
          reasoningEffort?: string;
        }
      >;
    };
  },
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({
      selectedNotebook: memoStateMock.selectedNotebook,
    }),
  },
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({
      config: accessStateMock.config,
    }),
  },
}));

describe("buildInitialInstanceRuntimeConfig — 仅种子 model/access/reasoning/notebookId", () => {
  beforeEach(() => {
    memoStateMock.selectedNotebook = null;
    accessStateMock.config = { version: 1, entries: [] };
  });

  it("默认返回无 model/access/reasoning/notebookId 的最小快照", async () => {
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.model).toBeUndefined();
    expect(config.access).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.notebookId).toBeUndefined();
    // cwd / files 不再由 helper 生成 ── 提交时实时推导。
    expect(config.cwd).toBeUndefined();
    expect(config.files).toBeUndefined();
  });

  it("selectedNotebook 已 hydrate 时, 快照其 id 为 notebookId", async () => {
    memoStateMock.selectedNotebook = { id: "nb-1", path: "/Users/notes/开发" };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig();

    expect(config.notebookId).toBe("nb-1");
  });

  it("defaults.runtime[agentType] 里的 model / access / reasoningEffort 种子进 instance", async () => {
    accessStateMock.config = {
      version: 1,
      entries: [],
      defaults: {
        runtime: {
          codex: {
            model: { key: "gpt-5.5" },
            access: { sandbox: "workspace-write" },
            reasoningEffort: "high",
          },
        },
      },
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig("codex");

    expect(config.model).toEqual({ key: "gpt-5.5" });
    expect(config.access).toEqual({ sandbox: "workspace-write" });
    expect(config.reasoningEffort).toBe("high");
  });

  it("未选 notebook 时 notebookId=undefined (提交侧 defaultFiles 回落当前笔记本)", async () => {
    accessStateMock.config = {
      version: 1,
      entries: [],
      defaults: {
        runtime: {
          codex: { model: { key: "gpt-5.5" } },
        },
      },
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig("codex");

    expect(config.notebookId).toBeUndefined();
    expect(config.model).toEqual({ key: "gpt-5.5" });
  });

  it("其它 agent type 的默认不会污染当前 agent", async () => {
    accessStateMock.config = {
      version: 1,
      entries: [],
      defaults: {
        runtime: {
          claude: { model: { key: "claude-opus-4-8" } },
        },
      },
    };
    const { buildInitialInstanceRuntimeConfig } =
      await import("@features/agent/store/initial-runtime-config");

    const config = buildInitialInstanceRuntimeConfig("flowix");

    expect(config.model).toBeUndefined();
  });
});