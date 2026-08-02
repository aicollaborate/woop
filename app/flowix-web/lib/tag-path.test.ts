import { describe, expect, it } from 'vitest';

import { isValidTagPath, isValidTagPathQuery } from './tag-path';

describe('tag path grammar', () => {
  it('accepts hyphens and underscores inside tag segments', () => {
    expect(isValidTagPath('Long-Term-Task')).toBe(true);
    expect(isValidTagPath('long_term_task')).toBe(true);
    expect(isValidTagPath('project_one/phase-2')).toBe(true);
  });

  it('still rejects unsupported punctuation and punctuation-only segments', () => {
    expect(isValidTagPath('long.term')).toBe(false);
    expect(isValidTagPath('---')).toBe(false);
    expect(isValidTagPath('project/___')).toBe(false);
  });

  it('keeps incomplete hyphenated and hierarchical mention queries typeable', () => {
    expect(isValidTagPathQuery('')).toBe(true);
    expect(isValidTagPathQuery('-')).toBe(true);
    expect(isValidTagPathQuery('project/')).toBe(true);
    expect(isValidTagPathQuery('project/phase_')).toBe(true);
    expect(isValidTagPathQuery('project.phase')).toBe(false);
  });
});
