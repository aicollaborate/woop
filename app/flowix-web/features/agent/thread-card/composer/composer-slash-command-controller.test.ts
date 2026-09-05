import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposerSlashCommandController } from './composer-slash-command-controller';
import { ComposerSlashToken } from './composer-slash-token';

function setup() {
  const composer = document.createElement('div');
  const input = document.createElement('div');
  input.contentEditable = 'true';
  composer.append(input);
  document.body.append(composer);
  vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
    x: 20,
    y: 300,
    left: 20,
    top: 300,
    right: 420,
    bottom: 350,
    width: 400,
    height: 50,
    toJSON: () => ({}),
  });
  const editor = new Editor({
    // Use the same mount contract as ComposerController. The input itself is
    // ProseMirror's root; the slash controller then moves that root into the
    // input row without introducing a nested editor.
    element: { mount: input },
    extensions: [StarterKit, Markdown, ComposerSlashToken],
    content: '',
    contentType: 'markdown',
  });
  const controller = new ComposerSlashCommandController({ input, composer, editor });
  return { composer, input, editor, controller };
}

function type(editor: Editor, value: string) {
  editor.commands.setContent(value, { contentType: 'markdown' });
  editor.commands.focus('end');
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ComposerSlashCommandController', () => {
  it('focuses the Tiptap editor when the input row padding is pressed', () => {
    const { input, editor, controller } = setup();
    const row = input.parentElement;

    expect(row?.classList.contains('agent-thread-card__composer-input-row')).toBe(true);
    input.blur();
    row?.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));

    expect(document.activeElement).toBe(input);
    expect(editor.view.hasFocus()).toBe(true);
    controller.dispose();
    editor.destroy();
  });

  it('opens on slash and filters static commands', () => {
    const { editor, controller } = setup();
    type(editor, '/');
    expect(document.querySelectorAll('.agent-composer-slash-menu__item')).toHaveLength(8);

    type(editor, '/pla');
    expect(document.querySelectorAll('.agent-composer-slash-menu__item')).toHaveLength(1);
    expect(document.querySelector('.agent-composer-slash-menu__name')?.textContent).toBe('/plan');
    controller.dispose();
  });

  it('selects with Enter and removes the command as one unit', () => {
    const { input, composer, editor, controller } = setup();
    type(editor, '/goal');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/goal)');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe('/goal');

    editor.commands.focus('start');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(composer.querySelector('.agent-thread-card__slash-token')).toBeNull();
    controller.dispose();
    editor.destroy();
  });

  it('round-trips the selected command through Markdown draft content', () => {
    const { composer, editor, controller } = setup();
    editor.commands.setContent('[/goal](flowix://slash/goal)', { contentType: 'markdown' });

    expect(editor.getMarkdown()).toBe('[/goal](flowix://slash/goal)');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe('/goal');

    controller.dispose();
    editor.destroy();
  });

  it('closes for whitespace, no matches, Escape, and outside clicks', () => {
    const { input, editor, controller } = setup();
    type(editor, '/no-such-command');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(editor, '/goal now');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(editor, '/g');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(editor, '/g');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    controller.dispose();
    editor.destroy();
  });
});
