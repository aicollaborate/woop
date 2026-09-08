import { describe, expect, it } from 'vitest';
import { chordMatches } from './matcher';
import { parseChord } from './parser';

function keyEvent(options: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'a',
    code: 'KeyA',
    ...options,
  });
}

describe('chordMatches Mod fallback', () => {
  const modA = parseChord('Mod+A');

  it('accepts Command when a Tauri WebView reports an unknown platform', () => {
    expect(chordMatches(keyEvent({ metaKey: true }), modA, { platform: 'unknown' }))
      .toBe(true);
  });

  it('does not treat Command as Mod on Windows', () => {
    expect(chordMatches(keyEvent({ metaKey: true }), modA, { platform: 'windows' }))
      .toBe(false);
  });

  it('does not treat Control as Mod on macOS', () => {
    expect(chordMatches(keyEvent({ ctrlKey: true }), modA, { platform: 'mac' }))
      .toBe(false);
  });

  it('keeps explicit Ctrl bindings distinct from Command on macOS', () => {
    const ctrlA = parseChord('Ctrl+A');
    expect(chordMatches(keyEvent({ metaKey: true }), ctrlA, { platform: 'mac' }))
      .toBe(false);
  });
});
