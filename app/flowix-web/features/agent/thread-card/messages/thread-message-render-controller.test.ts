import { describe, expect, it, vi } from "vitest";
import type { AgentTypeKey } from "@/types/agent";
import { ThreadMessageRenderController } from "@features/agent/thread-card/messages/thread-message-render-controller";
import { MessageViewportController } from "@features/agent/thread-card/messages/message-viewport-controller";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

function createController(typeKey: AgentTypeKey) {
  const body = document.createElement("div");
  const loadingIndicator = document.createElement("div");
  loadingIndicator.className = "agent-thread-card__loading";
  /*
   * 4 个 cell 的内联 --cell-step 对应 DOM 顺序 0..3。若不写,
   * var(--cell-step, 0) 回退到 0 → 4 个 cell 同步运行, 关键帧起始 0%
   * 即底色,视觉上"停在底色无动画"; text 的扫光是 background-position 位
   * 移,任何位置都是非底色,所以看起来正常。
   */
  loadingIndicator.innerHTML =
    '<span class="agent-thread-card__loading-cells" aria-hidden="true">' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:0"></span>' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:1"></span>' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:2"></span>' +
    '<span class="agent-thread-card__loading-cell" style="--cell-step:3"></span>' +
    '</span>' +
    '<span class="agent-thread-card__loading-text"></span>';
  body.append(loadingIndicator);

  const messageViewport = new MessageViewportController({
    body,
    bottomFollowThresholdPx: 64,
    topHistoryLoadThresholdPx: 64,
    scrollDeltaEpsilonPx: 2,
    isCollapsed: () => false,
    isFullscreen: () => false,
    getRuntimeThreadId: () => null,
    getConversationMessageState: () => null,
    loadMoreMessages: vi.fn(),
  });

  const createExternalAgentEmptySettings = vi.fn(() => {
    const el = document.createElement("div");
    el.className =
      "agent-thread-card__empty agent-thread-card__empty--codex-settings";
    el.append(document.createElement("button"));
    return el;
  });

  const controller = new ThreadMessageRenderController({
    body,
    loadingIndicator,
    messageViewport,
    getLanguage: () => "zh-CN",
    getTypeKey: () => typeKey,
    t: (key) => key,
    createThreadCacheSkeleton: () => document.createElement("div"),
    createExternalAgentEmptySettings,
  });

  return { body, controller, createExternalAgentEmptySettings };
}

describe("ThreadMessageRenderController empty settings", () => {
  it("flowix empty card no longer renders runtime settings (主空间由侧边栏资料决定)", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("flowix");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    // flowix 没有 model/permission/reasoning/files 等可配置项, supportsAgentEmptySettings
    // 返回 false ── 不再渲染空设置区。
    expect(createExternalAgentEmptySettings).not.toHaveBeenCalled();
    expect(
      body.querySelector(".agent-thread-card__empty--codex-settings"),
    ).toBeNull();
  });

  it("codex empty card renders runtime settings", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("codex");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(createExternalAgentEmptySettings).toHaveBeenCalledTimes(1);
    expect(
      body.querySelector(".agent-thread-card__empty--codex-settings"),
    ).not.toBeNull();
  });

  it("replaces the existing empty settings card on repeated empty renders", () => {
    const { body, controller } = createController("codex");
    const input = {
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    };

    controller.render(input);
    controller.render(input);

    expect(
      body.querySelectorAll(".agent-thread-card__empty--codex-settings"),
    ).toHaveLength(1);
  });

  it("removes the empty settings card when the first message renders", () => {
    const { body, controller } = createController("codex");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });
    controller.render({
      messages: [
        {
          id: "u1",
          role: "user",
          content: "hello",
          timestamp: new Date().toISOString(),
        },
      ],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: false,
    });

    expect(
      body.querySelector(".agent-thread-card__empty--codex-settings"),
    ).toBeNull();
    expect(body.querySelector(".agent-thread-card__messages")).not.toBeNull();
  });

  it("does not render runtime settings while thread cache is loading", () => {
    const { body, controller, createExternalAgentEmptySettings } =
      createController("flowix");

    controller.render({
      messages: [],
      isLoading: false,
      shouldRenderMessages: true,
      isThreadCachePresentationHidden: false,
      isThreadCacheLoading: true,
    });

    expect(createExternalAgentEmptySettings).not.toHaveBeenCalled();
    expect(body.textContent).toContain("editor.threadCard.loadingThreadCache");
  });
});

describe("ThreadMessageRenderController run-end re-parse", () => {
  it("re-parses the last assistant message on run end to canonicalize loose lists", () => {
    // rAF 同步执行, 让流式态 renderNow 立即落地 (更新 wasLoading)
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const { body, controller } = createController("flowix");
      const streaming = {
        id: "a1",
        role: "assistant" as const,
        content: "- item 1\n\n- item 2",
        timestamp: new Date().toISOString(),
      };

      // 流式中(isLoading=true): 末条 isStreaming=true -> 增量切分, 拆成两个 ul
      controller.render({
        messages: [streaming],
        isLoading: true,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      expect(body.querySelectorAll("ul")).toHaveLength(2);

      // run 结束(isLoading 下降沿): loadingJustEnded 触发 patch-last forceFinalize
      controller.render({
        messages: [streaming],
        isLoading: false,
        shouldRenderMessages: true,
        isThreadCachePresentationHidden: false,
        isThreadCacheLoading: false,
      });
      const uls = body.querySelectorAll("ul");
      expect(uls).toHaveLength(1);
      expect(uls[0].querySelectorAll("li")).toHaveLength(2);
      // loose list 条目被 <p> 包裹 (tight list 不会)
      expect(uls[0].querySelector("li p")).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
