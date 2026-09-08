import type { Platform } from './types';

/**
 * 平台识别 + 修饰键互转。
 *
 * - 优先读取 Chromium/WebKit 提供的平台字段，再降级到 user-agent。
 *   不能依赖 `window.__TAURI__`：生产配置可关闭 global Tauri 注入，而且
 *   Tauri OS API 是异步的，不适合在 keydown 热路径中临时查询。
 * - 结果缓存一次, 后续调用零成本。
 */

let cachedPlatform: Platform | null = null;

/** 取当前运行平台 — 同进程内结果稳定。 */
export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  cachedPlatform = detectPlatform();
  return cachedPlatform;
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  return detectNavigatorPlatform(navigator);
}

interface NavigatorPlatformSource {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** 纯函数版本便于覆盖不同 WebView 暴露字段的组合测试。 */
export function detectNavigatorPlatform(source: NavigatorPlatformSource): Platform {
  const candidates = [
    source.userAgentData?.platform,
    source.platform,
    source.userAgent,
  ];
  for (const candidate of candidates) {
    const value = candidate?.toLowerCase() ?? '';
    if (value.includes('mac') || value.includes('darwin')) return 'mac';
    if (value.includes('win')) return 'windows';
    if (value.includes('linux') || value.includes('x11')) return 'linux';
  }
  return 'unknown';
}

/** 便捷谓词 — 业务层用得最多的就是 "是不是 Mac"。 */
export function isMac(): boolean {
  return getPlatform() === 'mac';
}

/** 便捷谓词 — 仓库里 main-layout.tsx:39 / preferences-view.tsx:22 已有 isWindowsPlatform 的等价用法。 */
export function isWindowsPlatform(): boolean {
  return getPlatform() === 'windows';
}

/**
 * 检查 KeyboardEvent 的某个修饰字段是否被按下。
 *
 * - `mod`: Mac → metaKey (⌘), Windows / Linux → ctrlKey。
 * - `ctrl`: Mac → ctrlKey (^), Windows / Linux → ctrlKey (与 mod 互为别名)。
 *   在 Windows 上同时出现 'Mod' 和 'Ctrl' 等价于同一个键, 解析时已合并, 这里
 *   仍然忠实比对 ctrlKey, 因此 'Mod+K' 与 'Ctrl+K' 都能匹配同一事件 (行为符合预期)。
 * - `alt` / `shift`: 直接对应 altKey / shiftKey。
 */
export function matchesModifier(
  field: 'mod' | 'ctrl' | 'alt' | 'shift',
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: Platform = getPlatform(),
): boolean {
  switch (field) {
    case 'mod':
      return platform === 'mac' ? event.metaKey : event.ctrlKey;
    case 'ctrl':
      return event.ctrlKey;
    case 'alt':
      return event.altKey;
    case 'shift':
      return event.shiftKey;
  }
}

/**
 * 把 chord 字符串按平台格式化为显示文本。
 *
 *  - Mac:   'Mod+Shift+K' → '⌘⇧K'  (Unicode 修饰符符号 + 主键大写)
 *  - Win:   'Mod+Shift+K' → 'Ctrl+Shift+K'
 *  - Linux: 同 Win。
 *
 * 数字 / 字母键: Mac 上大写 (用户视觉习惯), Windows 上维持原样大小写。
 */
export function formatChord(chordString: string, platform: Platform = getPlatform()): string {
  const parts = chordString.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const mods: string[] = [];
  let key = '';
  for (const raw of parts) {
    const lower = raw.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'command' || lower === 'meta') {
      mods.push('mod');
    } else if (lower === 'ctrl' || lower === 'control') {
      mods.push('ctrl');
    } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
      mods.push('alt');
    } else if (lower === 'shift') {
      mods.push('shift');
    } else {
      key = raw;
    }
  }

  if (platform === 'mac') {
    const macMods = mods
      .map(m => {
        switch (m) {
          case 'mod':
            return '⌘';
          case 'ctrl':
            return '⌃';
          case 'alt':
            return '⌥';
          case 'shift':
            return '⇧';
        }
      })
      .join('');
    return macMods + displayKey(key, true);
  }

  const winMods = mods
    .map(m => {
      switch (m) {
        case 'mod':
        case 'ctrl':
          return 'Ctrl';
        case 'alt':
          return 'Alt';
        case 'shift':
          return 'Shift';
      }
    })
    .join('+');
  return winMods ? `${winMods}+${displayKey(key, false)}` : displayKey(key, false);
}

function displayKey(key: string, isMac: boolean): string {
  if (!key) return '';
  const k = key.toLowerCase();
  // 特殊名字 → 用户友好的显示
  const named: Record<string, string> = {
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    enter: isMac ? '↩' : 'Enter',
    escape: isMac ? '⎋' : 'Esc',
    tab: isMac ? '⇥' : 'Tab',
    backspace: isMac ? '⌫' : 'Backspace',
    delete: isMac ? '⌦' : 'Del',
    space: isMac ? '␣' : 'Space',
    pageup: isMac ? '⇞' : 'PageUp',
    pagedown: isMac ? '⇟' : 'PageDown',
    home: isMac ? '↖' : 'Home',
    end: isMac ? '↘' : 'End',
  };
  if (named[k]) return named[k];
  // 功能键 F1-F12
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
  // 单字符 / 其他: Mac 大写, Win 维持
  if (key.length === 1) {
    return isMac ? key.toUpperCase() : key.toUpperCase();
  }
  return key;
}
