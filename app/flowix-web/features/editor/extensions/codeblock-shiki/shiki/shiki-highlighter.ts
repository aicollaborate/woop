import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { BundledLanguage, BundledTheme } from 'shiki'

import { findChildren } from '@tiptap/core'

import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import { SHIKI_LANGS, SHIKI_THEMES } from './shiki-languages'

// createHighlighterCore 返回 HighlighterCore, 类型从 shiki/core 推导,
// 避免额外引入 shiki 全量包的类型面。
type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighterCore>>

let highlighter: ShikiHighlighter | undefined
let highlighterPromise: Promise<void> | undefined

export function getShiki() {
  return highlighter
}

/**
 * Load the highlighter once. Uses Shiki's fine-grained core (no bundled
 * languages/themes) with the curated language + theme set and the same
 * Oniguruma WASM engine that shiki's full `createHighlighter` uses internally.
 *
 * All curated languages and themes are loaded upfront, so later `loadLanguage`
 * / `loadTheme` calls are no-ops; unsupported (cold) languages fall back to
 * plaintext in the decorations layer via `getLoadedLanguages()`.
 */
export async function loadHighlighter() {
  if (highlighter) return

  if (!highlighter && !highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: SHIKI_THEMES,
      langs: SHIKI_LANGS,
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).then((h) => {
      highlighter = h
    })
  }

  return highlighterPromise
}

/**
 * Loads a theme if it's valid and not yet loaded.
 * Curated themes are all preloaded in {@link loadHighlighter}; nothing to do.
 */
export async function loadTheme(_theme: BundledTheme): Promise<boolean> {
  return false
}

/**
 * Loads a language if it's valid and not yet loaded.
 * Curated languages are all preloaded; unsupported (cold) languages are left
 * to the decorations layer, which degrades them to plaintext.
 */
export async function loadLanguage(_language: BundledLanguage): Promise<boolean> {
  return false
}

interface InitHighlighterOptions {
  doc: ProseMirrorNode
  name: string
  language: BundledLanguage | 'plaintext' | null
  theme: BundledTheme
  themes?: BundledTheme[]
}

/**
 * Initializes the highlighter based on the prose-mirror document, with the
 * themes and languages in the document.
 */
export async function initHighlighter({
  doc,
  name,
  language,
}: InitHighlighterOptions) {
  const codeBlocks = findChildren(doc, node => node.type.name === name)
  if (codeBlocks.length === 0 && language === 'plaintext') return

  await loadHighlighter()
}
