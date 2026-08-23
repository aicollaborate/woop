import { describe, expect, it } from 'vitest'

import {
  getShiki,
  loadLanguage,
} from './shiki-highlighter'

describe('Shiki grammar loading', () => {
  it('loads only the requested curated grammar and resolves aliases', async () => {
    expect(getShiki()).toBeUndefined()

    await expect(loadLanguage('js')).resolves.toBe(true)

    const loaded = getShiki()?.getLoadedLanguages() ?? []
    expect(loaded).toContain('javascript')
    expect(loaded).toContain('js')
    expect(loaded).not.toContain('python')
    await expect(loadLanguage('javascript')).resolves.toBe(false)
  })
})
