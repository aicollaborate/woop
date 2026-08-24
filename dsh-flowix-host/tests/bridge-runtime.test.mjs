import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bridgeRoot = resolve(root, 'profile/flowix/node_modules/@flowix/dsh-flowix-bridge')

test('flowix-dsh-bridge is a DSH bundle and keeps the runtime side UI-free', async () => {
  const packageJson = JSON.parse(await readFile(resolve(bridgeRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.name, '@flowix/dsh-flowix-bridge')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  const patch = await readFile(resolve(bridgeRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: flowix-dsh-bridge/)
  assert.match(patch, /name: '@flowix\/dsh-flowix-bridge'/)

  const source = await readFile(resolve(bridgeRoot, 'index.js'), 'utf8')
  const profileManifest = JSON.parse(await readFile(resolve(root, 'profile/flowix/package.json'), 'utf8'))
  assert.deepEqual(profileManifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@flowix/dsh-flowix-bridge', 'dsh-flowix-memory',
  ])
  assert.doesNotMatch(source, /from ['"](?:react|@tauri-apps|sqlite|flowix)/i)
  assert.doesNotMatch(source, /^\s*import\s+/m)
})

test('flowix-dsh-bridge emits native DSH events through its attached transport', async () => {
  const plugin = (await import(pathToFileURL(resolve(bridgeRoot, 'index.js')).href)).default
  const listeners = new Map()
  const ctx = {
    provide(key, value) { this[key] = value },
    emit() {},
    on(name, callback) {
      listeners.set(name, callback)
      return () => listeners.delete(name)
    },
    get(key) {
      if (key !== 'sessionPersistence') return undefined
      return { async inspect(sessionId) { return { events: [
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, time: 2, data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
        { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ], meta: { id: sessionId } } } }
    },
  }
  plugin(ctx)
  const notifications = []
  const sessions = new Map()
  ctx.flowixDshBridge.attach(
    { notify: (method, params) => notifications.push({ method, params }) },
    {
      async status() { return { provider: 'openai', model: 'test', cwd: '/tmp', sessions: [] } },
      async ensureSession(sessionId) { sessions.set(sessionId, true); return { sessionId } },
      async prompt(sessionId, prompt) {
        assert.deepEqual(prompt, { modelText: 'model hello', displayText: 'hello', clientMessageId: 'client-1' })
        return { messageId: `message-${sessionId}` }
      },
      async disposeSession(sessionId) { return sessions.delete(sessionId) },
      async cancel() { return true },
    },
  )
  listeners.get('session/event')({ id: 'session-1' }, { type: 'assistant/chunk', data: {} })
  listeners.get('agent/status')({ agent: { session: { id: 'session-1' } }, status: 'running' })
  assert.equal(notifications[0].method, 'flowix.bridge.ready')
  assert.deepEqual(notifications.slice(1).map(item => item.params.kind), ['session.event', 'agent.status'])
  assert.equal(ctx.flowixDshBridge.protocolVersion, 1)
  assert.equal((await ctx.flowixDshBridge.handle('flowix.bridge.session.ensure', { sessionId: 'session-2' })).sessionId, 'session-2')
  assert.equal((await ctx.flowixDshBridge.handle('flowix.bridge.session.prompt', {
    sessionId: 'session-2', modelText: 'model hello', displayText: 'hello', clientMessageId: 'client-1',
  })).messageId, 'message-session-2')
  const history = await ctx.flowixDshBridge.handle('flowix.bridge.session.history', { sessionId: 'session-2' })
  assert.equal(history.events.length, 3)
  assert.equal(history.snapshotSeq, 3)
  assert.equal((await ctx.flowixDshBridge.handle('flowix.bridge.run.cancel', { sessionId: 'session-2' })).cancelled, true)
})
