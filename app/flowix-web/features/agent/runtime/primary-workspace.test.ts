import { describe, expect, it } from "vitest";
import { resolvePrimaryWorkspace } from "@features/agent/runtime/primary-workspace";

describe("resolvePrimaryWorkspace", () => {
  it("1. 资料主空间 (defaults.files.workspace) 优先", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: {
          workspace: "D:\\资料主空间",
          folders: ["D:\\资料主空间", "D:\\其它"],
          notebooks: [],
        },
        notebookPath: "D:\\当前笔记本",
      }),
    ).toEqual({ kind: "default.workspace", path: "D:\\资料主空间" });
  });

  it("2. 资料主空间空时, 退到资料列表第一个 folder", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: {
          workspace: undefined,
          folders: ["D:\\第一份资料", "D:\\第二份资料"],
          notebooks: [],
        },
        notebookPath: "D:\\当前笔记本",
      }),
    ).toEqual({ kind: "default.folders[0]", path: "D:\\第一份资料" });
  });

  it("3. 资料列表为空 (没添加资料), 退到当前笔记本路径", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: { folders: [], notebooks: [], workspace: undefined },
        notebookPath: "D:\\当前笔记本",
      }),
    ).toEqual({ kind: "notebook", path: "D:\\当前笔记本" });
  });

  it("4. folders 里全是非法路径 (normalize 后空) 也退到当前笔记本", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: { folders: [""], notebooks: [], workspace: undefined },
        notebookPath: "D:\\当前笔记本",
      }),
    ).toEqual({ kind: "notebook", path: "D:\\当前笔记本" });
  });

  it("5. workspace === null (显式取消主空间) 跳过 folders[0], 退到当前笔记本", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: {
          workspace: null,
          folders: ["D:\\第一份资料", "D:\\第二份资料"],
          notebooks: [],
        },
        notebookPath: "D:\\当前笔记本",
      }),
    ).toEqual({ kind: "notebook", path: "D:\\当前笔记本" });
  });

  it("6. workspace === null + 没 notebookPath 退到 empty", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: {
          workspace: null,
          folders: ["D:\\资料"],
          notebooks: [],
        },
      }),
    ).toEqual({ kind: "empty" });
  });

  it("7. 全空时返回 empty (dispatch 层据此判断是否拦截)", () => {
    expect(resolvePrimaryWorkspace({})).toEqual({ kind: "empty" });
  });

  it("尾部斜杠被 normalize", () => {
    expect(
      resolvePrimaryWorkspace({
        defaultFiles: {
          workspace: "D:\\with-slash\\",
          folders: [],
          notebooks: [],
        },
      }),
    ).toEqual({ kind: "default.workspace", path: "D:\\with-slash" });
  });
});