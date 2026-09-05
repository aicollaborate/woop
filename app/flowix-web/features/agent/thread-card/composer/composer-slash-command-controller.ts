import type { Editor } from "@tiptap/core";
import {
  getComposerSlashToken,
  insertComposerSlashToken,
  removeComposerSlashToken,
} from "@features/agent/thread-card/composer/composer-slash-token";

export interface ComposerSlashCommand {
  name: string;
  description: string;
}

export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  { name: "compact", description: "压缩较早的对话上下文。" },
  { name: "export", description: "将当前会话导出为 ZIP 文件。" },
  { name: "feedback", description: "记录关于本次会话的反馈。" },
  { name: "goal", description: "设置或查看长时任务目标。" },
  { name: "permission", description: "切换权限预设。" },
  { name: "plan", description: "进入或退出计划模式。" },
  { name: "model", description: "选择本次会话使用的模型。" },
  { name: "dws", description: "使用钉钉工作空间能力。" },
];

export interface ComposerSlashCommandControllerOptions {
  editor: Editor;
  input: HTMLDivElement;
  composer: HTMLElement;
  commands?: readonly ComposerSlashCommand[];
  onCommandChange?: () => void;
  focusInput?: () => void;
}

/** UI-only slash command picker. Selected commands are intentionally not sent. */
export class ComposerSlashCommandController {
  private readonly editor: Editor;
  private readonly input: HTMLDivElement;
  private readonly composer: HTMLElement;
  private readonly commands: readonly ComposerSlashCommand[];
  private readonly onCommandChange: () => void;
  private readonly focusInput: () => void;
  private readonly inputRow: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private filtered: readonly ComposerSlashCommand[] = [];
  private activeIndex = 0;
  private dismissedValue: string | null = null;
  private disposed = false;

  constructor(options: ComposerSlashCommandControllerOptions) {
    this.editor = options.editor;
    this.input = options.input;
    this.composer = options.composer;
    this.commands = options.commands ?? COMPOSER_SLASH_COMMANDS;
    this.onCommandChange = options.onCommandChange ?? (() => undefined);
    this.focusInput = options.focusInput ?? (() => {
      this.editor.commands.focus(null, { scrollIntoView: false });
      this.editor.view.focus();
    });

    this.inputRow = document.createElement("div");
    this.inputRow.className = "agent-thread-card__composer-input-row";
    this.input.before(this.inputRow);
    this.inputRow.append(this.input);

    this.input.addEventListener("keydown", this.handleKeydown, true);
    // The row is the actual expanded/fullscreen grid item. It has clickable
    // padding around the editor (and around a selected slash token), so do
    // not rely on the browser's default focus behavior for the row itself.
    // Tauri WebViews can deliver a mouse event without a usable pointer event;
    // keep all three paths on the same Tiptap-aware focus callback.
    this.inputRow.addEventListener("pointerdown", this.handleInputRowPointerDown);
    this.inputRow.addEventListener("mousedown", this.handleInputRowMouseDown);
    this.inputRow.addEventListener("click", this.handleInputRowClick);
    this.editor.on("update", this.handleEditorUpdate);
    this.editor.on("selectionUpdate", this.handleSelectionUpdate);
    document.addEventListener("pointerdown", this.handleOutsidePointerDown, true);
    window.addEventListener("resize", this.updateMenuPosition);
    window.addEventListener("scroll", this.updateMenuPosition, true);
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeEventListener("keydown", this.handleKeydown, true);
    this.inputRow.removeEventListener("pointerdown", this.handleInputRowPointerDown);
    this.inputRow.removeEventListener("mousedown", this.handleInputRowMouseDown);
    this.inputRow.removeEventListener("click", this.handleInputRowClick);
    this.editor.off("update", this.handleEditorUpdate);
    this.editor.off("selectionUpdate", this.handleSelectionUpdate);
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown, true);
    window.removeEventListener("resize", this.updateMenuPosition);
    window.removeEventListener("scroll", this.updateMenuPosition, true);
    this.closeMenu();
    removeComposerSlashToken(this.editor);
    if (this.inputRow.isConnected) {
      this.inputRow.before(this.input);
      this.inputRow.remove();
    }
  }

  refresh(): void {
    if (this.disposed || getComposerSlashToken(this.editor)) {
      this.closeMenu();
      return;
    }

    const { selection, doc } = this.editor.state;
    const value = this.editor.getMarkdown().trim();
    const cursorAtEnd = selection.empty && selection.from === doc.content.size - 1;
    const match = cursorAtEnd ? /^\/([a-z]*)$/i.exec(value) : null;
    if (!match || value === this.dismissedValue) {
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

  private readonly handleEditorUpdate = (): void => {
    this.dismissedValue = null;
    this.refresh();
  };

  private readonly handleInputRowPointerDown = (event: PointerEvent): void => {
    this.focusInputRow(event);
  };

  private readonly handleInputRowMouseDown = (event: MouseEvent): void => {
    this.focusInputRow(event);
  };

  private readonly handleInputRowClick = (event: MouseEvent): void => {
    this.focusInputRow(event);
  };

  private focusInputRow(event: MouseEvent): void {
    if (this.disposed || event.button !== 0) return;
    if (this.editor.isDestroyed || this.editor.view.hasFocus()) return;

    const target = event.target instanceof Element ? event.target : null;
    // Preserve normal caret placement/text selection inside the editor and
    // keep the slash command token (a real button) clickable/removable.
    if (
      target &&
      (
        this.input.contains(target) ||
        target.closest(
          "button, a[href], [role='button'], [data-no-composer-focus]",
        )
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.focusInput();
  }

  private readonly handleSelectionUpdate = (): void => {
    this.refresh();
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;

    if (this.menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        this.activeIndex =
          (this.activeIndex + direction + this.filtered.length) % this.filtered.length;
        this.renderMenuItems();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const command = this.filtered[this.activeIndex];
        if (command) this.select(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.dismissedValue = this.editor.getMarkdown().trim();
        this.closeMenu();
        return;
      }
    }

    if (
      getComposerSlashToken(this.editor) &&
      event.key === "Backspace" &&
      this.editor.state.selection.empty &&
      this.editor.state.selection.from === 1
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.removeSelectedToken();
    }
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.menu) return;
    const target = event.target as Node | null;
    if (target && (this.composer.contains(target) || this.menu.contains(target))) return;
    this.dismissedValue = this.editor.getMarkdown().trim();
    this.closeMenu();
  };

  private openMenu(): void {
    if (!this.menu) {
      this.menu = document.createElement("div");
      this.menu.className = "agent-composer-slash-menu";
      this.menu.setAttribute("role", "listbox");
      this.menu.setAttribute("aria-label", "Slash commands");
      document.body.append(this.menu);
    }
    this.renderMenuItems();
    this.updateMenuPosition();
  }

  private renderMenuItems(): void {
    const menu = this.menu;
    if (!menu) return;
    menu.replaceChildren();
    this.filtered.forEach((command, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-composer-slash-menu__item";
      item.classList.toggle("agent-composer-slash-menu__item--active", index === this.activeIndex);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.activeIndex));
      const name = document.createElement("span");
      name.className = "agent-composer-slash-menu__name";
      name.textContent = `/${command.name}`;
      const description = document.createElement("span");
      description.className = "agent-composer-slash-menu__description";
      description.textContent = command.description;
      item.append(name, description);
      item.addEventListener("pointerenter", () => {
        this.activeIndex = index;
        this.renderMenuItems();
      });
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => this.select(command));
      menu.append(item);
    });
    const activeItem = menu.children[this.activeIndex] as HTMLElement | undefined;
    activeItem?.scrollIntoView?.({ block: "nearest" });
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
    this.closeMenu();
    insertComposerSlashToken(this.editor, command.name);
    this.onCommandChange();
  }

  removeSelectedToken(): void {
    if (!getComposerSlashToken(this.editor)) return;
    removeComposerSlashToken(this.editor);
    this.editor.commands.focus(null, { scrollIntoView: false });
    this.onCommandChange();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
