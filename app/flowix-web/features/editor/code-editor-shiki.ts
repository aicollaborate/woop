import {
  Decoration,
  DecorationSet,
  ViewPlugin,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import {
  RangeSetBuilder,
  type Extension,
  type Text,
} from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';

import {
  getShiki,
  loadHighlighter,
} from '@features/editor/extensions/codeblock-shiki/shiki/shiki-highlighter';

const THEME_CHANGE_EVENT = 'app-theme-changed';

// ── 扩展名 → Shiki 语言 id 映射 ─────────────────────────────────────────
//
// 只登记 SHIKI_LANGS (codeblock-shiki/shiki/shiki-languages.ts) 里真正预加载的
// 语言。未登记的扩展名返回 null, 由 code-editor.tsx 回退到 Lezer tagHighlighter
// (8 个语义 class), 即「冷门语言降级」——不新增 grammar、不特殊处理。
const EXTENSION_TO_SHIKI_LANGUAGE: Readonly<Record<string, string>> = {
  // Markdown
  md: 'markdown',
  markdown: 'markdown',
  // JavaScript 家族
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  xml: 'xml',
  // 数据 / 配置
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  // 语言
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  php: 'php',
  rb: 'ruby',
  lua: 'lua',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
};

/** Minimal token shape consumed from Shiki's `codeToTokensBase` output. */
export interface ShikiToken {
  content: string;
  color?: string;
}

/**
 * Resolve the Shiki language id for a file path, or `null` when the file's
 * extension is not among the preloaded Shiki languages (caller then falls back
 * to Lezer highlighting).
 */
export function shikiLanguageIdForPath(path: string): string | null {
  const filename = path.split(/[\\/]/).pop() ?? path;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_SHIKI_LANGUAGE[extension] ?? null;
}

/**
 * Pure, DOM-free helper: map Shiki's per-line tokens onto absolute document
 * positions and return a `DecorationSet` with an inline `color` mark per token.
 *
 * Kept separate from the view plugin so the position math (line boundaries,
 * newline handling, missing colors) is unit-testable without an EditorView.
 */
export function buildShikiDecorationSet(
  doc: Text,
  lines: readonly (readonly ShikiToken[])[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  let lineNumber = 1;
  for (const tokens of lines) {
    if (lineNumber > doc.lines) break;
    const line = doc.line(lineNumber);
    let pos = line.from;
    for (const token of tokens) {
      if (token.content.length === 0) continue;
      const to = pos + token.content.length;
      if (token.color) {
        builder.add(
          pos,
          to,
          Decoration.mark({ attributes: { style: `color: ${token.color}` } }),
        );
      }
      pos = to;
    }
    lineNumber += 1;
  }

  return builder.finish();
}

/**
 * Read the Shiki theme id currently selected by the app theme system. Mirrors
 * the `--shiki-theme` contract consumed by the Tiptap code-block path: the value
 * is one of the two preloaded themes (github-light / github-dark) and is rewritten
 * before 'app-theme-changed' is dispatched.
 */
function readShikiTheme(): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--shiki-theme')
    .trim();
}

/**
 * CodeMirror view plugin that renders a document through the shared Shiki
 * highlighter instead of the Lezer `syntaxHighlighting` path. The Lezer language
 * is still loaded separately (for folding / indentation / bracket matching), but
 * its tag-based coloring is suppressed by {@link shikiHighlighting}.
 *
 * Shiki is not incremental: `codeToTokensBase` re-tokenizes the whole document.
 * To keep typing responsive we (1) map the existing decoration set through each
 * doc change so positions stay correct for the current frame, and (2) batch the
 * full re-tokenize to a single `requestAnimationFrame` per frame — the same
 * strategy the Tiptap code-block path already uses.
 */
class ShikiDecorations {
  decorations: DecorationSet = Decoration.none;

  private readonly view: EditorView;
  private readonly language: string;
  private themeCache: string | null = null;
  private pendingRaf: number | null = null;
  private disposed = false;

  constructor(view: EditorView, language: string) {
    this.view = view;
    this.language = language;
    this.compute();
    // The Oniguruma WASM engine loads lazily; recolor once it is ready.
    void loadHighlighter().then(() => {
      if (this.disposed) return;
      this.compute();
    });
    window.addEventListener(THEME_CHANGE_EVENT, this.handleThemeChange);
  }

  update(update: ViewUpdate) {
    if (!update.docChanged) return;
    // Keep marks aligned with the edited document for the current frame.
    this.decorations = this.decorations.map(update.changes);
    this.scheduleRecompute();
  }

  destroy() {
    this.disposed = true;
    window.removeEventListener(THEME_CHANGE_EVENT, this.handleThemeChange);
    if (this.pendingRaf !== null) {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }
  }

  private handleThemeChange = () => {
    this.themeCache = null;
    this.compute();
  };

  private scheduleRecompute() {
    if (this.pendingRaf !== null) return;
    this.pendingRaf = requestAnimationFrame(() => {
      this.pendingRaf = null;
      if (this.disposed) return;
      this.compute();
    });
  }

  private compute() {
    if (this.disposed) return;
    const highlighter = getShiki();
    if (!highlighter) return;
    // Cold / unsupported language: leave the document uncolored by Shiki.
    if (!highlighter.getLoadedLanguages().includes(this.language)) return;

    if (this.themeCache === null) this.themeCache = readShikiTheme();
    const loadedThemes = highlighter.getLoadedThemes();
    let theme = this.themeCache;
    if (!theme || !loadedThemes.includes(theme)) theme = loadedThemes[0] ?? '';
    if (!theme) return;

    const doc = this.view.state.doc;
    const lines = highlighter.codeToTokensBase(doc.toString(), {
      lang: this.language,
      theme,
    });

    this.decorations = buildShikiDecorationSet(doc, lines);
    this.view.requestMeasure();
  }
}

const shikiDecorationsPlugin = ViewPlugin.fromClass(ShikiDecorations, {
  decorations: (plugin) => plugin.decorations,
});

/**
 * An empty, non-fallback highlight style. `basicSetup` installs
 * `defaultHighlightStyle` as `{fallback: true}`; CodeMirror prefers any
 * non-fallback highlighter over the fallback, so registering this empty style
 * disables tag-based coloring entirely — leaving Shiki decorations as the sole
 * color source while the Lezer language keeps providing structure.
 */
const noHighlightStyle = HighlightStyle.define([]);

/**
 * Shiki-powered syntax coloring for a single language. Bundles the token
 * decoration plugin with the highlight-style suppression described above.
 */
export function shikiHighlighting(language: string): Extension {
  return [
    shikiDecorationsPlugin.of(language),
    syntaxHighlighting(noHighlightStyle),
  ];
}
