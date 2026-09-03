import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposerSlashCommandController } from './composer-slash-command-controller';

function setup() {
  const composer = document.createElement('div');
  const input = document.createElement('textarea');
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
  const controller = new ComposerSlashCommandController({ input, composer });
  return { composer, input, controller };
}

function type(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ComposerSlashCommandController', () => {
  it('opens on slash and filters static commands', () => {
    const { input, controller } = setup();
    type(input, '/');
    expect(document.querySelectorAll('.agent-composer-slash-menu__item')).toHaveLength(8);

    type(input, '/pla');
    expect(document.querySelectorAll('.agent-composer-slash-menu__item')).toHaveLength(1);
    expect(document.querySelector('.agent-composer-slash-menu__name')?.textContent).toBe('/plan');
    controller.dispose();
  });

  it('selects with Enter and removes the command as one unit', () => {
    const { input, composer, controller } = setup();
    type(input, '/goal');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(input.value).toBe('');
    expect(composer.querySelector('.agent-thread-card__slash-token')?.textContent).toBe('/goal');

    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(composer.querySelector('.agent-thread-card__slash-token')).toBeNull();
    controller.dispose();
  });

  it('closes for whitespace, no matches, Escape, and outside clicks', () => {
    const { input, controller } = setup();
    type(input, '/no-such-command');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(input, '/goal now');
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(input, '/g');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();

    type(input, '/g');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.agent-composer-slash-menu')).toBeNull();
    controller.dispose();
  });
});
