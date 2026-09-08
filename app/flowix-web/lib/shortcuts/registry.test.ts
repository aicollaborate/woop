import { describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ getPlatform: () => 'mac' }));

import { defineAction, resolveBindings } from './registry';

describe('resolveBindings', () => {
  it('returns Command+A and Ctrl+A for the same macOS action', () => {
    defineAction({
      id: 'test.selectAll',
      titleKey: 'preferences.shortcuts.action.editor.selectAll.title',
      group: 'editor',
      scope: 'editor',
      defaultBinding: { mac: 'Mod+A' },
      alternateBindings: { mac: ['Ctrl+A'] },
      run: () => true,
    });

    expect(resolveBindings('test.selectAll').map(binding => binding.chordString))
      .toEqual(['Mod+A', 'Ctrl+A']);
  });

  it('replaces both defaults when the user assigns a custom binding', () => {
    expect(resolveBindings('test.selectAll', { 'test.selectAll': 'Mod+Shift+A' })
      .map(binding => binding.chordString))
      .toEqual(['Mod+Shift+A']);
  });
});
