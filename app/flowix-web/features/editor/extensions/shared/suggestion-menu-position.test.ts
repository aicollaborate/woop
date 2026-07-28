import { describe, expect, it } from 'vitest';
import { clampSuggestionMenuLeft } from './suggestion-menu-position';

describe('clampSuggestionMenuLeft', () => {
  it('keeps the menu aligned with its anchor when there is enough room', () => {
    expect(clampSuggestionMenuLeft(120, 240, 1024)).toBe(120);
  });

  it('moves the menu left when the right viewport space is insufficient', () => {
    expect(clampSuggestionMenuLeft(900, 320, 1024)).toBe(696);
  });

  it('keeps the menu inside the left viewport padding', () => {
    expect(clampSuggestionMenuLeft(-40, 240, 1024)).toBe(8);
  });
});
