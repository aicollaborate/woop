import { describe, expect, it } from 'vitest';

import { pickFirstAvailableAgent } from './agent-types';

describe('pickFirstAvailableAgent', () => {
  it('uses the requested priority when several runtimes are available', () => {
    expect(pickFirstAvailableAgent({
      'deepseek-harness': { available: true },
      opencode: { available: true },
      claude: { available: true },
      codex: { available: true },
    })).toBe('deepseek-harness');
  });

  it('falls through unavailable runtimes in priority order', () => {
    expect(pickFirstAvailableAgent({
      claude: { available: true },
      opencode: { available: true },
      'deepseek-harness': { available: false },
    })).toBe('claude');
  });

  it('returns DeepSeek Harness when it is the only preferred runtime', () => {
    expect(pickFirstAvailableAgent({
      'deepseek-harness': { available: true },
    })).toBe('deepseek-harness');
  });

  it('returns null when no runtime is available', () => {
    expect(pickFirstAvailableAgent({
      codex: { available: false },
      opencode: { available: false },
    })).toBeNull();
  });
});
