import { afterEach, describe, expect, it, vi } from "vitest";

import { FullscreenLayoutController } from "@features/agent/thread-card/fullscreen/fullscreen-layout-controller";

describe("FullscreenLayoutController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("pins the card to the visible document container bounds", () => {
    const container = document.createElement("div");
    container.className = "document-container";
    const card = document.createElement("div");
    container.appendChild(card);
    document.body.appendChild(container);

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 48,
      left: 320,
      width: 960,
      height: 720,
      right: 1280,
      bottom: 768,
      x: 320,
      y: 48,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    let fullscreen = true;
    const controller = new FullscreenLayoutController({
      dom: card,
      isFullscreen: () => fullscreen,
      isDestroyed: () => false,
      minExitTopPx: 0,
      maxExitTopPx: 0,
      exitTopRatio: 0,
      scrollDeltaEpsilonPx: 0,
    });

    controller.enter();

    expect(card.style.getPropertyValue("--atc-fullscreen-top")).toBe("48px");
    expect(card.style.getPropertyValue("--atc-fullscreen-left")).toBe("320px");
    expect(card.style.getPropertyValue("--atc-fullscreen-width")).toBe("960px");
    expect(card.style.getPropertyValue("--atc-fullscreen-height")).toBe("720px");

    fullscreen = false;
    controller.exit();
    expect(card.style.getPropertyValue("--atc-fullscreen-height")).toBe("");
  });

  it("tracks document container bounds changed by sidebar layout", () => {
    const container = document.createElement("div");
    container.className = "document-container";
    const card = document.createElement("div");
    container.appendChild(card);
    document.body.appendChild(container);

    let rect = {
      top: 48,
      left: 320,
      width: 960,
      height: 720,
      right: 1280,
      bottom: 768,
      x: 320,
      y: 48,
      toJSON: () => ({}),
    };
    vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => rect);

    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const controller = new FullscreenLayoutController({
      dom: card,
      isFullscreen: () => true,
      isDestroyed: () => false,
      minExitTopPx: 0,
      maxExitTopPx: 0,
      exitTopRatio: 0,
      scrollDeltaEpsilonPx: 0,
    });

    controller.enter();
    rect = { ...rect, left: 80, width: 1200, right: 1280, x: 80 };
    frames.shift()?.(performance.now());

    expect(card.style.getPropertyValue("--atc-fullscreen-left")).toBe("80px");
    expect(card.style.getPropertyValue("--atc-fullscreen-width")).toBe("1200px");

    controller.dispose();
  });
});
