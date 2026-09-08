import { describe, expect, it } from 'vitest';
import { detectNavigatorPlatform } from './platform';

describe('detectNavigatorPlatform', () => {
  it('uses userAgentData when available', () => {
    expect(detectNavigatorPlatform({
      userAgentData: { platform: 'macOS' },
      platform: 'Linux x86_64',
      userAgent: 'Linux',
    })).toBe('mac');
  });

  it('recognizes macOS from navigator.platform', () => {
    expect(detectNavigatorPlatform({ platform: 'MacIntel' })).toBe('mac');
  });

  it('falls back to the WebView user agent', () => {
    expect(detectNavigatorPlatform({
      platform: '',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })).toBe('mac');
  });

  it('recognizes Windows and Linux and preserves unknown values', () => {
    expect(detectNavigatorPlatform({ platform: 'Win32' })).toBe('windows');
    expect(detectNavigatorPlatform({ userAgent: 'X11; Linux x86_64' })).toBe('linux');
    expect(detectNavigatorPlatform({ platform: '', userAgent: '' })).toBe('unknown');
  });
});
