export interface ComposerSlashCommand {
  name: string;
  description: string;
}

export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  { name: 'compact', description: '压缩较早的对话上下文。' },
  { name: 'export', description: '将当前会话导出为 ZIP 文件。' },
  { name: 'feedback', description: '记录关于本次会话的反馈。' },
  { name: 'goal', description: '设置或查看长时任务目标。' },
  { name: 'permission', description: '切换权限预设。' },
  { name: 'plan', description: '进入或退出计划模式。' },
  { name: 'model', description: '选择本次会话使用的模型。' },
  { name: 'dws', description: '使用钉钉工作空间能力。' },
];

export interface ComposerSlashCommandControllerOptions {
  input: HTMLTextAreaElement;
  composer: HTMLElement;
  commands?: readonly ComposerSlashCommand[];
}

/** UI-only slash command picker. Selected commands are intentionally not sent. */
export class ComposerSlashCommandController {
  private readonly input: HTMLTextAreaElement;
  private readonly composer: HTMLElement;
  private readonly commands: readonly ComposerSlashCommand[];
  private readonly inputRow: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private token: HTMLButtonElement | null = null;
  private filtered: readonly ComposerSlashCommand[] = [];
  private activeIndex = 0;
  private dismissedValue: string | null = null;
  private disposed = false;

  constructor(options: ComposerSlashCommandControllerOptions) {
    this.input = options.input;
    this.composer = options.composer;
    this.commands = options.commands ?? COMPOSER_SLASH_COMMANDS;

    this.inputRow = document.createElement('div');
    this.inputRow.className = 'agent-thread-card__composer-input-row';
    this.input.before(this.inputRow);
    this.inputRow.append(this.input);

    this.input.addEventListener('input', this.handleInput);
    this.input.addEventListener('keydown', this.handleKeydown, true);
    document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
    window.addEventListener('resize', this.updateMenuPosition);
    window.addEventListener('scroll', this.updateMenuPosition, true);
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeEventListener('input', this.handleInput);
    this.input.removeEventListener('keydown', this.handleKeydown, true);
    document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
    window.removeEventListener('resize', this.updateMenuPosition);
    window.removeEventListener('scroll', this.updateMenuPosition, true);
    this.closeMenu();
    this.token?.remove();
    this.token = null;
    if (this.inputRow.isConnected) {
      this.inputRow.before(this.input);
      this.inputRow.remove();
    }
  }

  private readonly handleInput = (): void => {
    this.dismissedValue = null;
    this.refresh();
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;

    if (this.menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        this.activeIndex =
          (this.activeIndex + direction + this.filtered.length) % this.filtered.length;
        this.renderMenuItems();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const command = this.filtered[this.activeIndex];
        if (command) this.select(command);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.dismissedValue = this.input.value;
        this.closeMenu();
        return;
      }
    }

    if (
      this.token &&
      (event.key === 'Backspace' || event.key === 'Delete') &&
      this.input.selectionStart === 0 &&
      this.input.selectionEnd === 0
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.removeToken();
    }
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.menu) return;
    const target = event.target as Node | null;
    if (target && (this.composer.contains(target) || this.menu.contains(target))) return;
    this.dismissedValue = this.input.value;
    this.closeMenu();
  };

  private refresh(): void {
    if (this.token || this.input.value === this.dismissedValue) {
      this.closeMenu();
      return;
    }
    const match = /^\/([a-z]*)$/i.exec(this.input.value);
    if (!match) {
      this.closeMenu();
      return;
    }
    const query = match[1].toLowerCase();
    this.filtered = this.commands.filter((command) =>
      command.name.toLowerCase().includes(query),
    );
    if (this.filtered.length === 0) {
      this.closeMenu();
      return;
    }
    this.activeIndex = 0;
    this.openMenu();
  }

  private openMenu(): void {
    if (!this.menu) {
      this.menu = document.createElement('div');
      this.menu.className = 'agent-composer-slash-menu';
      this.menu.setAttribute('role', 'listbox');
      this.menu.setAttribute('aria-label', 'Slash commands');
      document.body.append(this.menu);
    }
    this.renderMenuItems();
    this.updateMenuPosition();
  }

  private renderMenuItems(): void {
    if (!this.menu) return;
    this.menu.replaceChildren();
    this.filtered.forEach((command, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'agent-composer-slash-menu__item';
      item.classList.toggle('agent-composer-slash-menu__item--active', index === this.activeIndex);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === this.activeIndex));
      const name = document.createElement('span');
      name.className = 'agent-composer-slash-menu__name';
      name.textContent = `/${command.name}`;
      const description = document.createElement('span');
      description.className = 'agent-composer-slash-menu__description';
      description.textContent = command.description;
      item.append(name, description);
      item.addEventListener('pointerenter', () => {
        this.activeIndex = index;
        this.renderMenuItems();
      });
      item.addEventListener('pointerdown', (event) => event.preventDefault());
      item.addEventListener('click', () => this.select(command));
      this.menu?.append(item);
    });
    const activeItem = this.menu.children[this.activeIndex] as HTMLElement | undefined;
    activeItem?.scrollIntoView?.({ block: 'nearest' });
  }

  private readonly updateMenuPosition = (): void => {
    if (!this.menu || !this.composer.isConnected) return;
    const rect = this.composer.getBoundingClientRect();
    const viewportPadding = 8;
    const width = Math.max(240, Math.min(rect.width, window.innerWidth - viewportPadding * 2));
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - width - viewportPadding,
    );
    this.menu.style.width = `${width}px`;
    this.menu.style.left = `${left}px`;
    this.menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - rect.top + 8)}px`;
  };

  private select(command: ComposerSlashCommand): void {
    this.input.value = '';
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.closeMenu();

    this.token = document.createElement('button');
    this.token.type = 'button';
    this.token.className = 'agent-thread-card__slash-token';
    this.token.textContent = `/${command.name}`;
    this.token.title = '点击移除命令';
    this.token.setAttribute('aria-label', `移除 /${command.name} 命令`);
    this.token.addEventListener('click', this.removeToken);
    this.inputRow.prepend(this.token);
    this.input.focus({ preventScroll: true });
  }

  private readonly removeToken = (): void => {
    this.token?.removeEventListener('click', this.removeToken);
    this.token?.remove();
    this.token = null;
    this.input.focus({ preventScroll: true });
  };

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
