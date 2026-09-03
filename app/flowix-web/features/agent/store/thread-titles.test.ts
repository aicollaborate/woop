import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTypeKey } from "@/types/agent";

const languageState = vi.hoisted(() => ({ language: "en-US" as "en-US" | "zh-CN" }));

vi.mock("@features/preferences/store/user-settings-store", () => ({
  useUserSettingsStore: {
    getState: () => ({ settings: languageState }),
  },
}));

import {
  canPersistThreadTitle,
  defaultExternalThreadTitle,
  defaultThreadTitle,
  deriveThreadTitleFromPrompt,
  getConversationTitleForThread,
  isExternalAgentType,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";

describe("thread-titles helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    languageState.language = "en-US";
  });

  it("isExternalAgentType returns true for all supported runtimes", () => {
    expect(isExternalAgentType("deepseek-harness")).toBe(true);
    expect(isExternalAgentType("codex")).toBe(true);
    expect(isExternalAgentType("claude")).toBe(true);
    expect(isExternalAgentType("deepseek-harness")).toBe(true);
    expect(isExternalAgentType("gemini")).toBe(true);
    expect(isExternalAgentType("hermes")).toBe(true);
    expect(isExternalAgentType("openclaw")).toBe(true);
  });

  it("persists every agent title in the product database", () => {
    expect(canPersistThreadTitle("deepseek-harness")).toBe(true);
    expect(canPersistThreadTitle("codex")).toBe(true);
    expect(canPersistThreadTitle("claude")).toBe(true);
    expect(canPersistThreadTitle("deepseek-harness")).toBe(true);
    expect(canPersistThreadTitle("hermes")).toBe(true);
    expect(canPersistThreadTitle("gemini")).toBe(true);
    expect(canPersistThreadTitle("openclaw")).toBe(true);
  });

  it("defaultExternalThreadTitle returns type-specific translated text", () => {
    expect(defaultExternalThreadTitle("codex")).toBe("Codex session");
    // 注意: Claude agent name 是 "Claude Code" 不是 "Claude", 因此 i18n 词条返回
    // "Claude Code session".
    expect(defaultExternalThreadTitle("claude")).toBe("Claude Code session");
    expect(defaultExternalThreadTitle("deepseek-harness")).toBe(
      "DeepSeek Harness session",
    );
    // Session fallback titles are localized per agent type.
    expect(defaultExternalThreadTitle("hermes")).toBe("Hermes session");
    expect(defaultExternalThreadTitle("gemini")).toBe("Gemini CLI session");
    expect(defaultExternalThreadTitle("opencode")).toBe("OpenCode session");
    expect(defaultExternalThreadTitle("openclaw")).toBe("OpenClaw session");
  });

  it("defaultThreadTitle falls back per agent family", () => {
    expect(defaultThreadTitle("deepseek-harness")).toBe("DeepSeek Harness session");
    expect(defaultThreadTitle("hermes")).toBe("Hermes session");
    expect(defaultThreadTitle("codex")).toBe("Codex session");
    expect(defaultThreadTitle("claude")).toBe("Claude Code session");
    expect(defaultThreadTitle("deepseek-harness")).toBe("DeepSeek Harness session");
    expect(defaultThreadTitle("opencode")).toBe("OpenCode session");
    expect(defaultThreadTitle("hermes")).toBe("Hermes session");
    expect(defaultThreadTitle("gemini")).toBe("Gemini CLI session");
    expect(defaultThreadTitle("openclaw")).toBe("OpenClaw session");
  });

  it("localizes DeepSeek Harness card and session titles", () => {
    languageState.language = "zh-CN";
    expect(defaultExternalThreadTitle("deepseek-harness")).toBe(
      "DeepSeek Harness 会话",
    );
    expect(defaultThreadTitle("deepseek-harness")).toBe(
      "DeepSeek Harness 会话",
    );
    expect(defaultThreadTitle("opencode")).toBe("OpenCode 会话");
    expect(defaultThreadTitle("hermes")).toBe("Hermes 会话");
    expect(defaultThreadTitle("gemini")).toBe("Gemini CLI 会话");
    expect(defaultThreadTitle("openclaw")).toBe("OpenClaw 会话");
  });

  it("deriveThreadTitleFromPrompt strips system block, collapses whitespace, truncates", () => {
    // 系统块 (任意大小写) 被切掉, 只保留用户可见的首段。
    expect(
      deriveThreadTitleFromPrompt("检查可选清理\n<## CONTEXT PROMPT ##>\nignored"),
    ).toBe("检查可选清理");
    // 折叠换行 / 多空白为单空格。
    expect(deriveThreadTitleFromPrompt("hello\n\n  world")).toBe("hello world");
    // 截断到 28 字符。
    const long = "a".repeat(50);
    expect(deriveThreadTitleFromPrompt(long)).toBe("a".repeat(28));
    // 空内容回退 fallback (默认空串)。
    expect(deriveThreadTitleFromPrompt("")).toBe("");
    expect(deriveThreadTitleFromPrompt("   ")).toBe("");
    expect(deriveThreadTitleFromPrompt("", "fallback")).toBe("fallback");
    // 只剩系统块时也算空。
    expect(
      deriveThreadTitleFromPrompt("<## context prompt ##>\nonly system", "fb"),
    ).toBe("fb");
  });

  it("normalizeThreadTitle collapses whitespace and strips context marker", () => {
    expect(normalizeThreadTitle("  hello   world  ")).toBe("hello world");
    expect(normalizeThreadTitle(null)).toBe("");
    expect(normalizeThreadTitle(undefined)).toBe("");
    // stripSystemBlock 只切 <## CONTEXT PROMPT ##> ── 任意大小写。
    expect(
      normalizeThreadTitle("nice title\n<## CONTEXT PROMPT ##>\nignore this"),
    ).toBe("nice title");
    // 字符级变化也识别: 小写 p 也能切。
    expect(
      normalizeThreadTitle("head <## context prompt ##> tail"),
    ).toBe("head");
  });

  it("getConversationTitleForThread uses fallback chain", () => {
    const state = {
      threadLists: {
        codex: [{ threadId: "t1", title: "Codex specific title", createdAt: 1, updatedAt: 1 }],
      } as Partial<Record<AgentTypeKey, { threadId: string; title: string; createdAt: number; updatedAt: number }[]>>,
      activeThreadIds: {
        codex: "t1",
      } as Partial<Record<AgentTypeKey, string | undefined>>,
      currentThreadTitles: {
        codex: "Active title",
      } as Partial<Record<AgentTypeKey, string | undefined>>,
    };

    expect(
      getConversationTitleForThread(state, "codex", "t1"),
    ).toBe("Codex specific title");

    // 当 thread 不在 list 时 (active):
    const state2 = {
      threadLists: {} as Partial<Record<AgentTypeKey, { threadId: string; title: string; createdAt: number; updatedAt: number }[]>>,
      activeThreadIds: { codex: "t1" } as Partial<Record<AgentTypeKey, string | undefined>>,
      currentThreadTitles: { codex: "Active" } as Partial<Record<AgentTypeKey, string | undefined>>,
    };
    expect(getConversationTitleForThread(state2, "codex", "t1")).toBe("Active");

    // 完全没记录: external → type default, flowix → i18n "新对话" 词条 ("Untitled conversation" 在 en-US)。
    const state3 = {
      threadLists: {} as Partial<Record<AgentTypeKey, { threadId: string; title: string; createdAt: number; updatedAt: number }[]>>,
      activeThreadIds: {} as Partial<Record<AgentTypeKey, string | undefined>>,
      currentThreadTitles: {} as Partial<Record<AgentTypeKey, string | undefined>>,
    };
    expect(getConversationTitleForThread(state3, "codex", "t-missing")).toBe(
      "Codex session",
    );
    expect(getConversationTitleForThread(state3, "deepseek-harness", "t-missing")).toBe(
      "DeepSeek Harness session",
    );
  });
});
