import { describe, expect, it, vi } from "vitest";
import type { AgentTypeKey } from "@/types/agent";
import { ThreadMessageRenderController } from "@features/editor/extensions/agent-thread-card/messages/thread-message-render-controller";
import { MessageViewportController } from "@features/editor/extensions/agent-thread-card/messages/message-viewport-controller";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

function createController(typeKey: AgentTypeKey) {
  const body = document.createElement("div");
  const loadingIndicator = document.createElement("div");
  loadingIndicator.className = "agent-thread-card__loading";
  loadingIndicator.innerHTML =
    '<span class="agent-thread-card__loading-text"></span><span class="agent-thread-card__loading-dot"></span>';

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
