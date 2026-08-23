import { describe, expect, it } from "vitest";
import {
  createInitialWorkspaceState,
  normalizeConversationWorkspaceState,
  selectDesiredWorkspace,
} from "./conversation-workspace";

const workspace = (cwd: string) => ({
  version: 1 as const,
  cwd,
  workspacePaths: [cwd],
  capturedAt: 1,
});

describe("conversation workspace state", () => {
  it("migrates a legacy snapshot as already applied", () => {
    const state = normalizeConversationWorkspaceState({ workspaceSnapshot: workspace("/a") });
    expect(state).toMatchObject({ revision: 1, appliedRevision: 1 });
    expect(state?.applied?.cwd).toBe("/a");
  });

  it("records desired separately from the applied workspace", () => {
    const initial = createInitialWorkspaceState(workspace("/a"));
    const applied = { ...initial, applied: initial.desired, appliedRevision: 1 };
    const next = selectDesiredWorkspace(applied, workspace("/b"));
    expect(next.desired.cwd).toBe("/b");
    expect(next.applied?.cwd).toBe("/a");
    expect(next.revision).toBe(2);
    expect(next.appliedRevision).toBe(1);
  });
});
