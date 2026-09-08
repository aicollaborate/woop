export function setLanguageButtonContent(button: HTMLButtonElement, label: unknown): void {
  button.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  const text = document.createElement('span');
  text.className = 'code-block-language-label';
  text.textContent = typeof label === 'string' ? label : 'Plain Text';
  button.prepend(text);
}
