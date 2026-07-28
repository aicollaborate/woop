const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
</svg>`;

const COPY_SUCCESS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <polyline points="20 6 9 17 4 12"></polyline>
</svg>`;

export class CodeBlockClipboardController {
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly getText: () => string,
  ) {
    button.innerHTML = COPY_ICON;
    button.addEventListener('click', this.handleClick);
  }

  destroy(): void {
    this.button.removeEventListener('click', this.handleClick);
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    void this.copy(this.getText());
  };

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.showSuccess();
    } catch {
      this.fallbackCopy(text);
    }
  }

  private fallbackCopy(text: string): void {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '-1000px';
    textArea.style.left = '-1000px';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();

    try {
      document.execCommand('copy');
      this.showSuccess();
    } catch (error) {
      console.error('Failed to copy:', error);
    } finally {
      textArea.remove();
    }
  }

  private showSuccess(): void {
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
    }
    this.button.innerHTML = COPY_SUCCESS_ICON;
    this.button.classList.add('copied');
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.button.innerHTML = COPY_ICON;
      this.button.classList.remove('copied');
    }, 2_000);
  }
}
