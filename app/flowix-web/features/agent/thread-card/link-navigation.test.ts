import { describe, expect, it } from "vitest";
import { agentFileScopePath, localFilePathFromAgentHref } from "./link-navigation";

describe("localFilePathFromAgentHref", () => {
  it("resolves tauri localhost links and removes the display line suffix", () => {
    expect(localFilePathFromAgentHref(
      "tauri://localhost/Users/rop/Desktop/vibe/flowix-main/app/flowix-web/features/agent/components/agent-conversation-detail.tsx:563",
    )).toBe(
      "/Users/rop/Desktop/vibe/flowix-main/app/flowix-web/features/agent/components/agent-conversation-detail.tsx",
    );
  });

  it("rejects tauri links for non-local hosts", () => {
    expect(localFilePathFromAgentHref("tauri://example.com/Users/rop/file.ts")).toBeNull();
  });
});

describe("agentFileScopePath", () => {
  it("treats the POSIX root as containing absolute descendants", () => {
    expect(agentFileScopePath("/Users/rop/file.ts", ["/"])).toBe("/");
  });

  it("uses path-segment boundaries and rejects lexical traversal", () => {
    expect(agentFileScopePath("/workspace-other/file.ts", ["/workspace"])).toBeNull();
    expect(agentFileScopePath("/workspace/../secret/file.ts", ["/workspace"])).toBeNull();
  });

  it("selects the narrowest containing workspace", () => {
    expect(agentFileScopePath("/workspace/packages/app/src/a.ts", [
      "/workspace",
      "/workspace/packages/app",
    ])).toBe("/workspace/packages/app");
  });

  it("compares Windows drive and UNC paths case-insensitively", () => {
    expect(agentFileScopePath("c:\\WORK\\src\\a.ts", ["C:\\Work"])).toBe("C:\\Work");
    expect(agentFileScopePath("\\\\SERVER\\Share\\src\\a.ts", ["\\\\server\\share"])).toBe(
      "\\\\server\\share",
    );
  });

  it("does not compare paths from different filesystem flavors", () => {
    expect(agentFileScopePath("/C:/Work/a.ts", ["C:\\Work"])).toBeNull();
  });
});
