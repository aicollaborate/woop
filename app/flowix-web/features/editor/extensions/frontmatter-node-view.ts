import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { translate } from '@/lib/i18n';
import {
  FrontmatterPropertyError,
  parseVisibleFrontmatter,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { useTagStore } from '@features/memo/store/tag-store';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import {
  filterMentionTags,
  type MentionTagItem,
} from '@features/editor/extensions/tag-mention/tag-mention-filter';
import { appendTagMentionName } from '@features/editor/extensions/tag-mention/tag-mention-label';
import {
  scrollSelectedItemIntoView,
} from '@features/editor/extensions/shared/scroll-selected-item';
import { clampSuggestionMenuLeft } from '@features/editor/extensions/shared/suggestion-menu-position';
import { createOverlayScrollbarDom } from '@shared/ui/overlay-scrollbar-dom';

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class FrontmatterPropertyNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseMirrorNode;
  private isAddingTag = false;
  private tagDraft = '';
  private tagInputBaseWidth: number | null = null;
  private validationError: string | null = null;
  private cleanupTagMenuPosition: (() => void) | null = null;
  private cleanupTagScrollbar: (() => void) | null = null;
  private readonly unsubscribeSettings: () => void;
  private readonly handleDocumentPointerDown = (event: Event) => {
    if (!this.isAddingTag) return;
    const target = event.target;
    if (!(target instanceof globalThis.Node) || this.dom.contains(target)) return;
    this.saveTagAddition();
  };

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = createElement('div', 'frontmatter-property-node');
    this.dom.contentEditable = 'false';
    this.unsubscribeSettings = useUserSettingsStore.subscribe((state, previous) => {
      if (state.settings.language !== previous.settings.language) {
        this.render();
      }
    });
    this.dom.ownerDocument.addEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    );
    this.render();
  }

  private t(key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) {
    return translate(useUserSettingsStore.getState().settings.language, key, params);
  }

  private errorMessage(error: unknown): string {
    if (!(error instanceof FrontmatterPropertyError)) {
      return error instanceof Error ? error.message : String(error);
    }
    switch (error.code) {
      case 'empty-key':
        return this.t('document.properties.emptyKey');
      case 'duplicate-key':
        return this.t('document.properties.duplicateKey');
      case 'reserved-key':
        return this.t('document.properties.picker.reservedKeyError', { key: 'key' });
      case 'invalid-tag':
        return this.t('document.properties.invalidTag');
      default:
        return error.message;
    }
  }

  private updateTags(tags: string[], previousKey: string | null) {
    const yamlContent = String(this.node.attrs.yamlContent ?? '');
    try {
      const nextYamlContent = updateVisibleFrontmatterProperty(
        yamlContent,
        previousKey,
        'tags',
        tags.join(', '),
        'MultiSelect',
      );
      const pos = this.getPos();
      if (typeof pos !== 'number') return;
      this.isAddingTag = false;
      this.tagDraft = '';
      this.validationError = null;
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          yamlContent: nextYamlContent,
        }),
      );
    } catch (error) {
      this.validationError = this.errorMessage(error);
      this.render();
    }
  }

  private saveTagAddition() {
    if (!this.isAddingTag) return;
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const property = parsed.properties.find(
      (item) => canonicalizePropertyKey(item.key) === 'tags',
    );
    const currentTags = Array.isArray(property?.value)
      ? property.value.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const nextTag = this.tagDraft.trim();
    if (!nextTag || currentTags.includes(nextTag)) {
      this.isAddingTag = false;
      this.tagDraft = '';
      this.validationError = null;
      this.render();
      return;
    }
    this.updateTags([...currentTags, nextTag], property?.key ?? null);
  }

  private renderTags(container: HTMLElement, property?: { key: string; value: unknown }) {
    const tags = Array.isArray(property?.value)
      ? property.value.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const tagArea = createElement('div', 'frontmatter-property__tags');

    tags.forEach((tag) => {
      const chip = createElement(
        'span',
        'tag-node frontmatter-property__tag-chip',
      );
      chip.title = tag;
      chip.append(createElement('span', 'frontmatter-property__tag-label', `#${tag}`));
      const remove = createElement('button', 'frontmatter-property__tag-remove', '×');
      remove.type = 'button';
      remove.setAttribute(
        'aria-label',
        this.t('document.properties.deleteTag', { tag }),
      );
      remove.addEventListener('click', () => {
        this.updateTags(tags.filter((item) => item !== tag), property?.key ?? null);
      });
      chip.append(remove);
      tagArea.append(chip);
    });

    if (this.isAddingTag) {
      const inputWrap = createElement('div', 'frontmatter-property__tag-input-wrap');
      const input = createElement('input', 'frontmatter-property__tag-input');
      input.type = 'text';
      input.value = this.tagDraft;
      input.setAttribute('aria-label', this.t('document.properties.tagInputPlaceholder'));
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');

      const menu = createElement(
        'div',
        'mention-note-dropdown tag-mention-dropdown frontmatter-property__tag-suggestions',
      );
      menu.hidden = true;
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', this.t('editor.tagMention.header'));
      menu.append(createElement(
        'div',
        'mention-note-header',
        this.t('editor.tagMention.header'),
      ));
      const overlayScrollbar = createOverlayScrollbarDom(menu.ownerDocument, {
        frameClassName: 'mention-note-items-frame',
        scrollerClassName: 'mention-note-items frontmatter-property__tag-suggestion-items',
      });
      const items = overlayScrollbar.scroller;
      menu.append(overlayScrollbar.frame);
      this.cleanupTagScrollbar = overlayScrollbar.destroy;

      let menuOpen = false;
      let suggestions: MentionTagItem[] = [];
      let selectedIndex = 0;
      const updateMenuPosition = () => {
        if (!menuOpen || menu.hidden) return;
        const ownerWindow = menu.ownerDocument.defaultView;
        if (!ownerWindow) return;
        const anchorRect = input.getBoundingClientRect();
        const wrapRect = inputWrap.getBoundingClientRect();
        const menuWidth = menu.getBoundingClientRect().width;
        const viewportLeft = clampSuggestionMenuLeft(
          anchorRect.left,
          menuWidth,
          ownerWindow.innerWidth,
        );
        menu.style.left = `${viewportLeft - wrapRect.left}px`;
      };
      const ownerWindow = menu.ownerDocument.defaultView;
      ownerWindow?.addEventListener('resize', updateMenuPosition);
      this.cleanupTagMenuPosition = () => {
        ownerWindow?.removeEventListener('resize', updateMenuPosition);
      };

      const selectSuggestion = (item: MentionTagItem) => {
        input.value = item.name;
        this.tagDraft = item.name;
        this.saveTagAddition();
      };
      const updateSelectedItem = (nextIndex: number, scrollSelectedItem = false) => {
        selectedIndex = nextIndex;
        const optionElements = items.querySelectorAll<HTMLButtonElement>(
          '.mention-note-item',
        );
        optionElements.forEach((item, index) => {
          const selected = index === selectedIndex;
          item.classList.toggle('is-selected', selected);
          item.setAttribute('aria-selected', String(selected));
        });
        const selectedItem = optionElements[selectedIndex];
        if (scrollSelectedItem && selectedItem) {
          scrollSelectedItemIntoView(items, selectedItem);
        }
      };
      const renderSuggestions = () => {
        items.replaceChildren();
        menu.hidden = !menuOpen;
        input.setAttribute('aria-expanded', String(menuOpen));
        if (!menuOpen) return;

        if (suggestions.length === 0) {
          items.append(createElement(
            'div',
            'mention-note-empty',
            this.t('editor.tagMention.empty'),
          ));
          overlayScrollbar.update({ reveal: false, schedule: false });
          updateMenuPosition();
          return;
        }

        selectedIndex = Math.min(selectedIndex, suggestions.length - 1);
        suggestions.forEach((item, index) => {
          const option = createElement(
            'button',
            `mention-note-item${index === selectedIndex ? ' is-selected' : ''}`,
          );
          option.type = 'button';
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(index === selectedIndex));
          const title = createElement(
            'span',
            'mention-note-title mention-tag-title',
          );
          const name = createElement('span', 'mention-tag-name');
          appendTagMentionName(name, item.name);
          const icon = createElement('span', 'mention-tag-icon');
          icon.setAttribute('aria-hidden', 'true');
          title.append(
            icon,
            name,
          );
          option.append(title);
          if (item.create) {
            option.append(createElement(
              'span',
              'mention-note-notebook',
              this.t('editor.tagMention.create'),
            ));
          }
          option.addEventListener('mouseenter', () => updateSelectedItem(index));
          option.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            selectSuggestion(item);
          });
          items.append(option);
        });
        const selectedItem = items.querySelectorAll<HTMLButtonElement>(
          '.mention-note-item',
        )[selectedIndex];
        if (selectedItem) {
          scrollSelectedItemIntoView(items, selectedItem);
        }
        overlayScrollbar.update({ reveal: false, schedule: false });
        updateMenuPosition();
      };
      const refreshSuggestions = () => {
        suggestions = filterMentionTags(
          useTagStore.getState().tags,
          input.value,
        ).filter((item) => !tags.includes(item.name));
        selectedIndex = 0;
        renderSuggestions();
      };
      const resizeInput = () => {
        const baseWidth = this.tagInputBaseWidth;
        if (baseWidth !== null) {
          input.style.width = `${baseWidth}px`;
        }
        if (input.value && input.scrollWidth > (baseWidth ?? 0)) {
          input.style.width = `${input.scrollWidth + 1}px`;
        }
      };
      input.addEventListener('input', () => {
        this.tagDraft = input.value;
        resizeInput();
        menuOpen = true;
        refreshSuggestions();
      });
      input.addEventListener('focus', () => {
        menuOpen = true;
        refreshSuggestions();
      });
      input.addEventListener('keydown', (event) => {
        if (
          (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          && menuOpen
          && suggestions.length > 0
        ) {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          updateSelectedItem(
            (selectedIndex + direction + suggestions.length) % suggestions.length,
            true,
          );
        } else if (event.key === 'Escape' && menuOpen) {
          event.preventDefault();
          menuOpen = false;
          renderSuggestions();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.isAddingTag = false;
          this.tagDraft = '';
          this.validationError = null;
          this.render();
        } else if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          const selected = menuOpen ? suggestions[selectedIndex] : undefined;
          if (selected) {
            selectSuggestion(selected);
          } else {
            this.saveTagAddition();
          }
        }
      });
      input.addEventListener('blur', () => {
        queueMicrotask(() => this.saveTagAddition());
      });
      inputWrap.append(input, menu);
      tagArea.append(inputWrap);
      queueMicrotask(() => {
        resizeInput();
        input.focus();
      });
    } else {
      const addLabel = this.t('document.properties.addTag');
      const add = createElement('button', 'frontmatter-property__tag-add', addLabel);
      add.type = 'button';
      add.title = addLabel;
      add.setAttribute('aria-label', addLabel);
      add.addEventListener('click', () => {
        const renderedWidth = add.getBoundingClientRect().width || add.offsetWidth;
        this.tagInputBaseWidth = renderedWidth > 0 ? renderedWidth : null;
        this.isAddingTag = true;
        this.tagDraft = '';
        this.validationError = null;
        this.render();
      });
      tagArea.append(add);
    }

    container.append(tagArea);
  }

  private render() {
    this.cleanupTagMenuPosition?.();
    this.cleanupTagMenuPosition = null;
    this.cleanupTagScrollbar?.();
    this.cleanupTagScrollbar = null;
    const parsed = parseVisibleFrontmatter(String(this.node.attrs.yamlContent ?? ''));
    const container = createElement('div', 'frontmatter-property');

    if (parsed.parseError) {
      const error = createElement(
        'div',
        'frontmatter-property__error',
        this.t('document.properties.yamlParseError'),
      );
      error.title = parsed.parseError;
      container.append(error);
    } else {
      const list = createElement('div', 'frontmatter-property__list');
      const tagsProperty = parsed.properties.find(
        (property) => canonicalizePropertyKey(property.key) === 'tags',
      );
      this.renderTags(list, tagsProperty);
      if (this.validationError) {
        const validation = createElement(
          'span',
          'frontmatter-property__validation',
          this.validationError,
        );
        validation.title = this.validationError;
        list.append(validation);
      }
      container.append(list);
    }

    this.dom.replaceChildren(container);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const yamlChanged = node.attrs.yamlContent !== this.node.attrs.yamlContent;
    this.node = node;
    if (yamlChanged && this.isAddingTag) {
      this.isAddingTag = false;
      this.tagDraft = '';
      this.validationError = null;
    }
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.dom.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.cleanupTagMenuPosition?.();
    this.cleanupTagMenuPosition = null;
    this.cleanupTagScrollbar?.();
    this.cleanupTagScrollbar = null;
    this.dom.ownerDocument.removeEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    );
    this.unsubscribeSettings();
  }
}
