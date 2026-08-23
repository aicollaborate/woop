import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPluginDisables, pluginKey } from '../src/runtime/plugin-composition.ts'

test('applies a persisted preset disable to the matching composition entry', () => {
  const source = [
    '- id: first',
    '  name: package-first',
    '- id: second',
    '  name: package-second',
    '',
  ].join('\n')
  const result = applyPluginDisables(
    source,
    'preset',
    'standard',
    new Set([pluginKey('preset', 1, 'second', 'standard')]),
  )

  assert.match(result, /- id: second\n  name: package-second\n  disabled: true/)
  assert.doesNotMatch(result, /- id: first\n  name: package-first\n  disabled: true/)
})

test('does not add a duplicate disabled field to an already platform-disabled entry', () => {
  const source = [
    '- id: shell',
    '  name: package-shell',
    '  disabled: !!js process.platform !== \'win32\'',
    '',
  ].join('\n')
  const result = applyPluginDisables(
    source,
    'preset',
    'standard',
    new Set([pluginKey('preset', 0, 'shell', 'standard')]),
  )

  assert.equal(result, source)
})

test('plugin keys remain stable when upstream reorders a preset', () => {
  assert.equal(pluginKey('preset', 0, 'filesystem', 'code'), 'preset:code:filesystem')
  assert.equal(pluginKey('preset', 12, 'filesystem', 'code'), 'preset:code:filesystem')
  assert.equal(pluginKey('host', 3, 'settings'), 'host:settings')
})
