import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRuntimeConfig,
  getAgentAccessOptions,
  getAgentRuntimeSpec,
  normalizeCodexPermissionMode,
  normalizeDshPermissionMode,
  supportsAgentEmptySettings,
  supportsAgentRuntimeSetting,
} from "@features/agent/runtime/agent-runtime-spec";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@features/memo/components/notebook-icon", () => ({
  getNotebookIconMarkup: () => null,
}));

describe("workspace capabilities", () => {
  it("only DeepSeek Harness supports switching between runs", () => {
    expect(getAgentRuntimeSpec("deepseek-harness").workspace.switchBetweenRuns).toBe(true);
    for (const type of ["codex", "claude", "opencode"] as const) {
      expect(getAgentRuntimeSpec(type).workspace.switchBetweenRuns).toBe(false);
    }
  });
});

describe("buildAgentRuntimeConfig — 「资料列表 + 当前笔记本」派生", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("完全没输入时返回 cwd=undefined / workspacePaths=[] (dispatch 据此判断是否拦截)", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
    });
    expect(result.claude?.cwd).toBeUndefined();
    expect(result.claude?.workspacePaths).toEqual([]);
  });

  it("资料主空间存在时, cwd = 资料主空间, workspacePaths = 资料 folders + 当前笔记本", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: {
        workspace: "D:\\资料主空间",
        folders: ["D:\\资料主空间", "D:\\第二份资料"],
        notebooks: [],
      },
    });
    expect(result.deepseekHarness?.cwd).toBe("D:\\资料主空间");
    expect(result.deepseekHarness?.workspacePaths).toEqual([
      "D:\\资料主空间",
      "D:\\第二份资料",
      "D:\\当前笔记本",
    ]);
  });

  it("没设资料主空间, cwd 取资料 folders[0]", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: {
        workspace: undefined,
        folders: ["D:\\第一份", "D:\\第二份"],
        notebooks: [],
      },
    });
    expect(result.deepseekHarness?.cwd).toBe("D:\\第一份");
  });

  it("资料列表为空 (没添加资料), cwd 退到当前笔记本路径", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: { folders: [], notebooks: [], workspace: undefined },
    });
    expect(result.deepseekHarness?.cwd).toBe("D:\\当前笔记本");
    expect(result.deepseekHarness?.workspacePaths).toEqual(["D:\\当前笔记本"]);
  });

  it("未传 defaultFiles 时, 仅当前笔记本作为 cwd 与 workspacePaths", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      notebookPath: "D:\\当前笔记本",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
    });
    expect(result.claude?.cwd).toBe("D:\\当前笔记本");
    expect(result.claude?.workspacePaths).toEqual(["D:\\当前笔记本"]);
  });

  it("workspaceSnapshot keeps the notebook-configured workspace as first-run cwd", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      notebookPath: "/notes/changed",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "low",
      defaultFiles: {
        workspace: "/projects/changed",
        folders: ["/projects/changed"],
        notebooks: [],
      },
      workspaceSnapshot: {
        version: 1,
        cwd: "/projects/original",
        workspacePaths: ["/projects/original", "/notes/original"],
        notebookId: "nb-original",
        notebookPath: "/notes/original",
        capturedAt: 1,
      },
    });

    // The snapshot was resolved from the notebook's file settings immediately
    // before its first run. Live notebook/default changes must not replace it.
    expect(result.codex?.cwd).toBe("/projects/original");
    expect(result.codex?.workspacePaths).toEqual([
      "/projects/original",
      "/notes/original",
    ]);
  });

  it("instance 里的 model / permission / reasoningEffort 覆盖 chat-store 全局值", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
      instanceRuntimeConfig: {
        model: { key: "gpt-5.5" },
        access: { sandbox: "yolo" },
        reasoningEffort: "high",
      },
    });
    expect(result.codex?.model).toBe("gpt-5.5");
    expect(result.codex?.permissionMode).toBe("yolo");
    expect(result.codex?.reasoningEffort).toBe("high");
  });

  it("DeepSeek Harness exposes model before mode and permission and sends the card overrides", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/notebook",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
      instanceRuntimeConfig: {
        model: { key: "deepseek-v4-pro", providerId: "provider-b" },
        deepseekHarness: { mode: "code" },
      },
    });

    expect(result.deepseekHarness?.mode).toBe("code");
    expect(result.deepseekHarness?.model).toBe("deepseek-v4-pro");
    expect(result.deepseekHarness?.providerId).toBe("provider-b");
    expect(getAgentRuntimeSpec("deepseek-harness").emptySettings).toEqual([
      "model",
      "mode",
      "permission",
    ]);
  });

  it("DeepSeek Harness inherit 时不序列化模型, 选定后透传卡片模型", () => {
    const inherited = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });
    expect(inherited.deepseekHarness?.model).toBe("inherit");

    const selected = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "deepseek-v4-pro",
      codexReasoningEffort: "medium",
    });
    expect(selected.deepseekHarness?.model).toBe("deepseek-v4-pro");
  });

  it("DeepSeek Harness supports empty-card runtime settings for files (空状态设置区仍可用)", () => {
    expect(supportsAgentEmptySettings("deepseek-harness")).toBe(true);
    expect(supportsAgentEmptySettings("codex")).toBe(true);
    expect(supportsAgentEmptySettings("claude")).toBe(true);
    expect(supportsAgentEmptySettings("deepseek-harness")).toBe(true);
    expect(supportsAgentRuntimeSetting("deepseek-harness", "model")).toBe(true);
    expect(supportsAgentRuntimeSetting("deepseek-harness", "mode")).toBe(true);
    expect(supportsAgentRuntimeSetting("deepseek-harness", "permission")).toBe(true);
  });

  it("exposes yolo on Codex and Claude access options", () => {
    expect(getAgentAccessOptions("codex").map((option) => option.id)).toContain(
      "yolo",
    );
    expect(getAgentAccessOptions("claude").map((option) => option.id)).toContain(
      "yolo",
    );
  });

  it("passes yolo through Codex runtime config normalization", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "codex",
      notebookPath: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });

    expect(normalizeCodexPermissionMode("yolo")).toBe("yolo");
    expect(result.codex?.permissionMode).toBe("yolo");
  });

  it("passes yolo through Claude runtime config", () => {
    const result = buildAgentRuntimeConfig({
      typeKey: "claude",
      notebookPath: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });

    expect(result.claude?.permissionMode).toBe("yolo");
  });

  it("DeepSeek Harness 默认 fail closed 到 workspace-write, 不复用 Codex 兜底", () => {
    expect(normalizeDshPermissionMode(undefined)).toBe("workspace-write");
    expect(normalizeDshPermissionMode("inherit")).toBe("workspace-write");
    expect(normalizeDshPermissionMode("yolo")).toBe("workspace-write");
    expect(normalizeDshPermissionMode("unknown" as never)).toBe(
      "workspace-write",
    );
    expect(normalizeDshPermissionMode("read-only")).toBe("read-only");
    expect(normalizeDshPermissionMode("workspace-write")).toBe(
      "workspace-write",
    );
    expect(normalizeDshPermissionMode("danger-full-access")).toBe(
      "danger-full-access",
    );
  });

  it("DeepSeek Harness 前端全局默认 danger-full-access 不被继承", () => {
    // 全局 sessionMeta 默认是 danger-full-access (Codex 语义); DSH 卡片
    // 未显式选权限时使用自己的 workspace-write 默认, 不静默继承完全访问。
    const result = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "danger-full-access",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });
    expect(result.deepseekHarness?.permissionMode).toBe("workspace-write");

    // inherit / yolo 归一化到 workspace-write
    const inherited = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "inherit",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });
    expect(inherited.deepseekHarness?.permissionMode).toBe("workspace-write");

    const yolo = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "yolo",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
    });
    expect(yolo.deepseekHarness?.permissionMode).toBe("workspace-write");
  });

  it("DeepSeek Harness 卡片显式选择的权限仍生效", () => {
    const explicit = buildAgentRuntimeConfig({
      typeKey: "deepseek-harness",
      notebookPath: "/tmp/project",
      permissionMode: "workspace-write",
      codexModel: "inherit",
      codexReasoningEffort: "medium",
      instanceRuntimeConfig: {
        access: { sandbox: "read-only" },
      },
    });
    expect(explicit.deepseekHarness?.permissionMode).toBe("read-only");
  });

  it("DeepSeek Harness 权限选项不含 yolo", () => {
    expect(getAgentAccessOptions("deepseek-harness").map((o) => o.id)).toEqual([
      "workspace-write",
      "read-only",
      "danger-full-access",
    ]);
  });
});
