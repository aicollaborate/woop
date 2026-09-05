import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  ComposerController,
  ComposerDraftController,
  createAgentComposerDom,
  disposeAgentComposerDom,
} from "./index";

const controllers: ComposerController[] = [];
const domParts: ReturnType<typeof createAgentComposerDom>[] = [];

function setup() {
  const parts = createAgentComposerDom({
    t: (key) => key,
  });
  document.body.append(parts.composer);

  let persistedDraft: string | null = null;
  const draft = new ComposerDraftController({
    persistDelayMs: 0,
    persist: (value) => {
      persistedDraft = value;
    },
  });
  const controller = new ComposerController({
    input: parts.input,
    composer: parts.composer,
    initialDraft: "",
    draft,
    sendButtonRoot: createRoot(parts.sendButtonMount),
    inputDraftMaxChars: 500,
    getCurrentInputDraft: () => "",
    getUserHistoryMessages: () => [],
    getSendLabel: () => "Send",
    getSendButtonWantsStop: () => false,
    getHasAttachments: () => false,
    getHasPendingAttachments: () => false,
    submit: () => undefined,
    stop: () => undefined,
  });
  controllers.push(controller);
  domParts.push(parts);
  return {
    controller,
    draft,
    getPersistedDraft: () => persistedDraft,
  };
}

afterEach(() => {
  while (controllers.length > 0) controllers.pop()?.dispose();
  while (domParts.length > 0) disposeAgentComposerDom(domParts.pop()!);
  document.body.replaceChildren();
});

describe("ComposerController note references", () => {
  it("focuses the Tiptap editor when clicking the input row", () => {
    const { controller } = setup();
    const row = controller
      .getInputElement()
      .parentElement;

    expect(row?.classList.contains("agent-thread-card__composer-input-row")).toBe(true);
    row?.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );

    expect(document.activeElement).toBe(controller.getInputElement());
    expect(controller.editorInstance.view.hasFocus()).toBe(true);
  });

  it("inserts a note card at the current cursor and persists its deep link", () => {
    const { controller, draft, getPersistedDraft } = setup();
    const editor = controller.editorInstance;

    editor.commands.setContent("before after", { contentType: "markdown" });
    editor.commands.setTextSelection(7);
    controller.insertMemoReference({
      id: "abc123",
      filename: "reference.md",
      title: "Reference",
    });
    draft.flush();

    expect(controller.getPrompt()).toBe(
      "before [Reference](flowix://memo/abc123) after",
    );
    expect(editor.getJSON().content?.[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "noteReference" }),
      ]),
    );
    expect(getPersistedDraft()).toBe(
      "before [Reference](flowix://memo/abc123) after",
    );
  });
});
