import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentComposerDom,
  disposeAgentComposerDom,
} from "./composer-dom-factory";

const noopT = (() => {
  const cache = new Map<string, string>();
  return (key: string): string => {
    if (!cache.has(key)) cache.set(key, key);
    return cache.get(key)!;
  };
})();

/**
 * 在 jsdom 里 `PointerEvent` 不内置 ── 大部分浏览器/Node 18+ 才有,
 * 所以这里手动 dispatch 一个带 button/isPrimary 等关键字段的
 * PointerEvent-like 事件, 只确保 composer 的 pointerdown 监听能
 * 正常拿到 `target` / `currentTarget` / `button`.
 */
function dispatchPointerDown(target: Element, button: number = 0): boolean {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button,
  }) as unknown as PointerEvent;
  const dispatched = target.dispatchEvent(event);
  // stopPropagation 已阻止冒泡 ── 验证用
  return dispatched && !event.cancelBubble;
}

describe("createAgentComposerDom click-to-focus delegation", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("focuses the textarea when clicking the empty composer padding", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);

    const padding = document.createElement("div");
    padding.style.padding = "20px";
    parts.composer.append(padding);

    dispatchPointerDown(padding);

    expect(document.activeElement).toBe(parts.input);
    disposeAgentComposerDom(parts);
  });

  it("focuses the textarea when clicking the composer root itself", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);

    dispatchPointerDown(parts.composer);

    expect(document.activeElement).toBe(parts.input);
    disposeAgentComposerDom(parts);
  });

  it("focuses the textarea from a click in a fullscreen composer", () => {
    const parts = createAgentComposerDom({ t: noopT });
    const card = document.createElement("section");
    card.className = "agent-thread-card agent-thread-card--fullscreen";
    card.append(parts.composer);
    document.body.append(card);

    const emptyArea = document.createElement("div");
    parts.composer.append(emptyArea);
    emptyArea.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));

    expect(document.activeElement).toBe(parts.input);
    disposeAgentComposerDom(parts);
  });

  it("focuses from fullscreen composer padding inside a contenteditable editor", () => {
    const parts = createAgentComposerDom({ t: noopT });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const card = document.createElement("section");
    card.className = "agent-thread-card agent-thread-card--fullscreen";
    card.append(parts.composer);
    editor.append(card);
    document.body.append(editor);

    const emptyArea = document.createElement("div");
    parts.composer.append(emptyArea);
    dispatchPointerDown(emptyArea);

    expect(document.activeElement).toBe(parts.input);
    disposeAgentComposerDom(parts);
  });

  it("still treats contenteditable descendants inside the composer as interactive", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    parts.composer.append(editable);

    const activeBefore = document.activeElement;
    dispatchPointerDown(editable);

    expect(document.activeElement).toBe(activeBefore);
    disposeAgentComposerDom(parts);
  });

  it("focuses the textarea when clicking inside composer-images container", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);
    parts.composerImages.hidden = false;
    const imageSlot = document.createElement("span");
    parts.composerImages.append(imageSlot);

    dispatchPointerDown(imageSlot);

    expect(document.activeElement).toBe(parts.input);
    disposeAgentComposerDom(parts);
  });

  it("does NOT focus the textarea when clicking the role icon button", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);

    const activeBefore = document.activeElement;
    dispatchPointerDown(parts.composerRoleIcon);
    expect(document.activeElement).toBe(activeBefore);
    disposeAgentComposerDom(parts);
  });

  it("does NOT focus when clicking an arbitrary descendant button", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);
    // composerActions 默认放 role icon, 后面再 append 一个外部按钮
    // 模拟外部 agent settings 注入的 model/workspace 按钮。
    const externalButton = document.createElement("button");
    externalButton.type = "button";
    parts.composerActions.append(externalButton);

    const activeBefore = document.activeElement;
    dispatchPointerDown(externalButton);
    expect(document.activeElement).toBe(activeBefore);
    disposeAgentComposerDom(parts);
  });

  it("does NOT focus when clicking inside a [role='button'] element", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);
    const roleButton = document.createElement("div");
    roleButton.setAttribute("role", "button");
    roleButton.tabIndex = 0;
    parts.composer.append(roleButton);

    const activeBefore = document.activeElement;
    dispatchPointerDown(roleButton);
    expect(document.activeElement).toBe(activeBefore);
    disposeAgentComposerDom(parts);
  });

  it("does NOT focus when clicking inside an [data-no-composer-focus] escape hatch", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);
    const escape = document.createElement("div");
    escape.dataset.noComposerFocus = "";
    parts.composer.append(escape);

    const activeBefore = document.activeElement;
    dispatchPointerDown(escape);
    expect(document.activeElement).toBe(activeBefore);
    disposeAgentComposerDom(parts);
  });

  it("does NOT focus on right-click (button=2)", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);

    const padding = document.createElement("div");
    parts.composer.append(padding);

    const activeBefore = document.activeElement;
    dispatchPointerDown(padding, /* button */ 2);
    expect(document.activeElement).toBe(activeBefore);
    disposeAgentComposerDom(parts);
  });

  it("keeps the initial draft on the editor mount point", () => {
    const parts = createAgentComposerDom({ t: noopT, inputDraft: "hello world" });
    document.body.append(parts.composer);

    const padding = document.createElement("div");
    parts.composer.append(padding);

    dispatchPointerDown(padding);
    expect(document.activeElement).toBe(parts.input);
    expect(parts.input.dataset.composerInitialDraft).toBe("hello world");
    disposeAgentComposerDom(parts);
  });

  it("removes the pointerdown listener on dispose", () => {
    const parts = createAgentComposerDom({ t: noopT });
    document.body.append(parts.composer);
    const composer = parts.composer;
    disposeAgentComposerDom(parts);
    // 移除后 ── body 已无 composer 子节点, 即使手动 dispatch 也不会
    // 走到 focus 路径。 这里只验证 removeEventListener 路径不抛错。
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    expect(() => composer.dispatchEvent(event)).not.toThrow();
  });

  it("applies agent-composer--expanded class when variant='expanded'", () => {
    const parts = createAgentComposerDom({ t: noopT, variant: "expanded" });
    expect(parts.composer.classList.contains("agent-composer--expanded")).toBe(true);
    disposeAgentComposerDom(parts);
  });
});
