import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('host drives the official SDK client across a runtime process', async () => {
  const root = resolve(import.meta.dirname, '..')
  const fixture = resolve(root, 'tests/fixture-runtime.mjs')
  await chmod(fixture, 0o755)
  const child = spawn(process.execPath, [resolve(root, '../../.build/flowix-dsh-host/dsh-host.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      FLOWIX_DSH_RUNTIME_PATH: fixture,
      FLOWIX_DSH_ROOT: root,
      FLOWIX_DSH_SESSION_ROOT: resolve(root, '.test-sessions'),
      FLOWIX_DSH_MAX_IDLE_RUNTIMES: '0',
      DSH_API_KEY: 'fixture-secret',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    frames.push(JSON.parse(line))
    for (const wake of waiters.splice(0)) wake()
  })
  let id = 0
  const request = (method, params = {}) => {
    id += 1
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return id
  }
  const waitFor = async predicate => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const found = frames.find(predicate)
      if (found !== undefined) return found
      await new Promise(resolveWait => waiters.push(resolveWait))
    }
    throw new Error(`timed out; frames=${JSON.stringify(frames)}`)
  }

  const initId = request('host.initialize', { protocolVersion: 1 })
  await waitFor(frame => frame.id === initId)
    const ensureId = request('runtime.ensure', {
      threadId: 'thread-1', sessionId: 'session-1', cwd: root, provider: 'flowix',
      providerName: 'fixture', apiProtocol: 'openai-completions', baseUrl: 'http://fixture.test/v1',
      model: 'fixture-model', permissionMode: 'read-only',
  })
  await waitFor(frame => frame.id === ensureId)
  const runId = request('run.start', { threadId: 'thread-1', runId: 'run-1', prompt: { text: 'hello' } })
  await waitFor(frame => frame.id === runId)
  await waitFor(frame => frame.method === 'run.event' && frame.params.event.type === 'run.completed')

  const events = frames.filter(frame => frame.method === 'run.event').map(frame => frame.params.event)
  assert.deepEqual(events.map(event => event.type), [
    'session.resolved', 'run.started', 'reasoning.delta', 'assistant.delta',
    'tool.started', 'tool.completed', 'usage', 'run.completed',
  ])
  assert.deepEqual(events.find(event => event.type === 'tool.started').input, { path: 'README.md' })
  assert.equal(events.at(-1).reason, 'completed')

  const statusId = request('runtime.status')
  const status = await waitFor(frame => frame.id === statusId)
  assert.deepEqual(status.result.runtimes, [])

  const shutdownId = request('host.shutdown')
  await waitFor(frame => frame.id === shutdownId)
  await new Promise((resolveExit, reject) => {
    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`host exited ${code}`)))
  })
})
