import { describe, expect, it } from 'vitest';
import { setLanguageButtonContent } from './language-button';

describe('code block language label', () => {
  it('renders untrusted language attributes as text rather than markup', () => {
    const button = document.createElement('button');
    const malicious = '</span><img src=x onerror=alert(1)>';
    setLanguageButtonContent(button, malicious);
    expect(button.querySelector('.code-block-language-label')?.textContent).toBe(malicious);
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('[onerror]')).toBeNull();
    expect(button.querySelectorAll('svg')).toHaveLength(1);
  });

  it('handles non-string attributes without coercing them to HTML', () => {
    const button = document.createElement('button');
    setLanguageButtonContent(button, { toString: () => '<script>bad</script>' });
    expect(button.textContent).toBe('Plain Text');
    expect(button.querySelector('script')).toBeNull();
  });
});
