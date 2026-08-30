import type { I18nKey } from '@/lib/i18n';

export interface AgentComposerDomFactoryOptions {
  inputDraft?: string;
  variant?: 'compact' | 'expanded';
  t: (key: I18nKey) => string;
}

export interface AgentComposerDomParts {
  composer: HTMLElement;
  composerImages: HTMLDivElement;
  composerActions: HTMLDivElement;
  composerRoleIcon: HTMLButtonElement;
  composerAddPopover: HTMLDivElement;
  input: HTMLTextAreaElement;
  codexSettingsPopover: HTMLDivElement;
  composerRolePopover: HTMLDivElement;
  sendButtonMount: HTMLSpanElement;
}

// ────────────────────────────────────────────────────────────────────
// Click-to-focus 委托
// ────────────────────────────────────────────────────────────────────
//
// composer 胶囊容器的空白区域 (尤其是 expanded / fullscreen grid 布局下,
// textarea 之外的 grid row 1 / row 2-col2 / row 3-col1 等缝隙) 必须能
// 一点就把焦点抢回输入框, 不然用户只能挤进 textarea 才能打字, 体感极差。
//
// 这里把委托逻辑封进工厂, 两个消费方 (note 内嵌 thread-card 与
// standalone agent-conversation-detail) 自动共享, 避免单边漏装导致
// "笔记内能点, 独立对话页点不动" 的诡异差。
//
// 选择 `pointerdown` 而不是 `mousedown` 的原因:
//   - pointerdown 在触摸 / 手写笔 / 鼠标上统一触发, 一次事件覆盖三条
//     路径; 旧 `mousedown` 在 webview 内对触屏有 300ms 延迟疑虑;
//   - pointerdown 触发比 click 更早, 焦点抢占先于按钮 click, 避免
//     "send 按钮被瞬间触到" 的二次 dispatch。
//
// 委托短路条件 (target 命中以下任一即放行, 不抢焦点):
//   - textarea / input / select ── 输入框本体
//   - button / a[href] / [role="button"] ── 显式交互元素
//   - [data-no-composer-focus] ── 显式逃生口 (例如未来某些 hover 装饰)
//   - popover 内 ── popover 挂在 body 上, 但 mousedown 可能在合成事件
//     阶段冒泡到 composer, 此处不需要管 (popover 自身 stopPropagation
//     已在 dom-factory:198-208 处理好)
//
// 抢焦后 caret 处理: 把 caret 钉在文本末尾 ── 用户的直觉是 "我把光标
// 拉到这里只是为了让键盘响应这个 composer", 而不是 "我要改这段中间的
// 某个字", 钉末尾省一次 setSelectionRange, 也避免在折叠态下用户明明
// 没碰 textarea 但 caret 莫名跳到行中的违和感。
// ────────────────────────────────────────────────────────────────────
const COMPOSER_FOCUS_INTERACTIVE_SELECTOR = [
  'textarea',
  'input',
  'select',
  'button',
  'a[href]',
  '[role="button"]',
  '[contenteditable="true"]',
  '[data-no-composer-focus]',
].join(',');

function focusComposerInput(composer: HTMLElement, input: HTMLTextAreaElement): void {
  if (document.activeElement === input) return;
  if (!composer.isConnected) return;
  input.focus({ preventScroll: true });
  // 钉末尾 ── 见上方注释
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    // type=number 等不支持的 input 才抛, 这里 textarea 不会, 留兜底
  }
}

function handleComposerPointerDown(event: PointerEvent): void {
  // 仅响应左键 / 主指针 ── 右键 (button=2) 留给浏览器原生 contextmenu,
  // 中键 (button=1) 留给可能的「在新标签打开」等扩展。
  if (event.button !== 0) return;
  const composer = event.currentTarget as HTMLElement;
  const target = event.target as Element | null;
  if (!target) return;
  if (target.closest(COMPOSER_FOCUS_INTERACTIVE_SELECTOR)) return;
  // 命中: 抢焦点并阻止默认行为/冒泡。preventDefault 会阻止后续原生
  // mousedown 在编辑器层继续参与选择处理；显式交互控件在上面已经放行,
  // 所以不会影响发送、角色选择、模型选择等按钮的 click 行为。
  event.preventDefault();
  event.stopPropagation();
  const input = composer.querySelector<HTMLTextAreaElement>('textarea');
  if (!input) return;
  focusComposerInput(composer, input);
}

/** Creates the shared, framework-independent composer DOM contract. */
export function createAgentComposerDom(
  options: AgentComposerDomFactoryOptions,
): AgentComposerDomParts {
  const composer = document.createElement('div');
  composer.className = 'agent-thread-card__composer';
  if (options.variant === 'expanded') {
    composer.classList.add('agent-composer--expanded');
  }
  const composerImages = document.createElement('div');
  composerImages.className = 'agent-thread-card__composer-images';
  composerImages.hidden = true;
  const composerRoleIcon = document.createElement('button');
  composerRoleIcon.type = 'button';
  composerRoleIcon.className = 'agent-thread-card__composer-role-icon';
  composerRoleIcon.setAttribute('aria-haspopup', 'menu');
  composerRoleIcon.setAttribute('aria-expanded', 'false');
  composerRoleIcon.setAttribute('aria-label', options.t('editor.threadCard.selectRole'));
  composerRoleIcon.title = options.t('editor.threadCard.roleIconTooltip');
  const input = document.createElement('textarea');
  input.rows = 1;
  input.placeholder = options.t('editor.threadCard.inputPlaceholder');
  input.value = options.inputDraft ?? '';
  const sendButtonMount = document.createElement('span');
  sendButtonMount.className = 'agent-thread-card__send-tooltip';
  const composerActions = document.createElement('div');
  composerActions.className = 'agent-thread-card__composer-actions';
  const codexSettingsPopover = document.createElement('div');
  codexSettingsPopover.className = 'agent-thread-card__codex-settings-popover';
  codexSettingsPopover.setAttribute('role', 'menu');
  codexSettingsPopover.hidden = true;
  const composerRolePopover = document.createElement('div');
  composerRolePopover.className = 'agent-thread-card__composer-role-popover';
  composerRolePopover.setAttribute('role', 'menu');
  composerRolePopover.hidden = true;
  const composerAddPopover = document.createElement('div');
  composerAddPopover.className = 'agent-thread-card__composer-add-popover';
  composerAddPopover.setAttribute('role', 'menu');
  composerAddPopover.hidden = true;
  composerActions.append(composerRoleIcon);
  // DOM 顺序 ── composerActions (role icon) 放在 input 之前, 让非全屏
  // flex (默认 row, DOM 顺序 = 视觉顺序) 状态下 role icon 显示在 input
  // 左侧, 跟全屏态 grid 布局 `grid-column: 1` 把 actions 显式钉在第一列
  // ── 视觉位置对齐。 send button 仍以 sendButtonMount 收尾, 留在最右。
  composer.append(composerImages, composerActions, input, sendButtonMount);
  document.body.append(codexSettingsPopover, composerAddPopover, composerRolePopover);
  // 空区域点击聚焦 ── 见上方 COMPOSER_FOCUS_INTERACTIVE_SELECTOR 注释。
  // 注意: 用 pointerdown 而非 click ── click 触发时浏览器已经先 focus
  // 到 body, 后续 focus() 会被某些 webview 忽略 (focus 漂移到按钮)。
  composer.addEventListener('pointerdown', handleComposerPointerDown);
  return {
    composer,
    composerImages,
    composerActions,
    composerRoleIcon,
    input,
    codexSettingsPopover,
    composerRolePopover,
    composerAddPopover,
    sendButtonMount,
  };
}

export function disposeAgentComposerDom(parts: AgentComposerDomParts): void {
  parts.composer.removeEventListener('pointerdown', handleComposerPointerDown);
  parts.codexSettingsPopover.remove();
  parts.composerRolePopover.remove();
  parts.composerAddPopover.remove();
  parts.composer.remove();
}
