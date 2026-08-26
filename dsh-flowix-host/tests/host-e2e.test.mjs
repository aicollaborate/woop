import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('host drives the official SDK client across a runtime process', async () => {
  const root = resolve(import.meta.dirname, '..')
  const fixture = resolve(root, 'tests/fixture-runtime.mjs')
  const dshHome = await mkdtemp(join(tmpdir(), 'flowix-dsh-e2e-'))
  const sessionRoot = await mkdtemp(join(tmpdir(), 'flowix-dsh-e2e-sessions-'))
  await chmod(fixture, 0o755)
  const child = spawn(process.execPath, [resolve(root, '../.build/flowix-dsh-host/dsh-host.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      FLOWIX_DSH_RUNTIME_PATH: process.platform === 'win32' ? process.execPath : fixture,
      ...(process.platform === 'win32' ? { FLOWIX_DSH_RUNTIME_ARGS: JSON.stringify([fixture]) } : {}),
      FLOWIX_DSH_ROOT: root,
      FLOWIX_DSH_SESSION_ROOT: sessionRoot,
      FLOWIX_DSH_MAX_IDLE_RUNTIMES: '1',
      FLOWIX_DSH_HOME: dshHome,
      DSH_HOME: dshHome,
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

  try {
    child.stdin.write('{}\n')
    const invalidRequest = await waitFor(frame => frame.id === null && frame.error?.code === -32600)
    assert.deepEqual(invalidRequest, {
      jsonrpc: '2.0', id: null,
      error: { code: -32600, message: 'invalid JSON-RPC request' },
    })
    const pingAfterInvalidRequestId = request('host.ping')
    assert.deepEqual(await waitFor(frame => frame.id === pingAfterInvalidRequestId), {
      jsonrpc: '2.0', id: pingAfterInvalidRequestId, result: { ok: true },
    })
    const unknownMethodId = request('missing.method')
    const unknownMethod = await waitFor(frame => frame.id === unknownMethodId)
    assert.equal(unknownMethod.error.code, -32601)
    const invalidParamsId = request('run.start')
    const invalidParams = await waitFor(frame => frame.id === invalidParamsId)
    assert.equal(invalidParams.error.code, -32602)

    const initId = request('host.initialize', { protocolVersion: 1 })
    await waitFor(frame => frame.id === initId)
    const ensureId = request('runtime.ensure', {
      threadId: 'thread-1', sessionId: 'session-1', cwd: root, provider: 'openai',
      providerName: 'fixture', apiProtocol: 'openai-completions', baseUrl: 'http://fixture.test/v1',
      model: 'fixture-model', permissionMode: 'read-only',
    })
    await waitFor(frame => frame.id === ensureId)
    const installedProfile = JSON.parse(await readFile(resolve(dshHome, 'profiles/flowix/package.json'), 'utf8'))
    assert.deepEqual(installedProfile.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@flowix/dsh-flowix-bridge', 'dsh-flowix-memory',
    ])
    assert.equal(await readFile(resolve(dshHome, 'profiles/flowix/node_modules/@flowix/dsh-flowix-bridge/index.js'), 'utf8')
      .then(source => source.includes("name = 'flowix-dsh-bridge'")), true)
    const pluginCatalogId = request('plugins.catalog')
    const pluginCatalog = await waitFor(frame => frame.id === pluginCatalogId)
    assert.deepEqual(pluginCatalog.result.plugins.profile.map(plugin => plugin.id), [
      '@deepseek-ai/dsh-base', '@flowix/dsh-flowix-bridge', 'dsh-flowix-memory',
    ])
    const bridgeId = request('runtime.bridge.capabilities', { threadId: 'thread-1' })
    const bridge = await waitFor(frame => frame.id === bridgeId)
    assert.deepEqual(bridge.result.capabilities, [
      'runtime-events', 'session-control', 'session-history', 'session-dispose', 'run-cancel', 'profile',
    ])
    const runId = request('run.start', { threadId: 'thread-1', runId: 'run-1', prompt: { modelText: 'hello', displayText: 'hello', clientMessageId: 'run-1' } })
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
    assert.deepEqual(status.result.runtimes, [{
      threadId: 'thread-1', sessionId: 'session-1', generation: 1,
    }])

    // A follow-up must reuse the live runtime/session. Previously the pool
    // checked a nonexistent SDK property (`isRuntimeRunning`), closed this
    // slot after the first turn, and recreated the same persisted session id.
    const secondRunId = request('run.start', {
      threadId: 'thread-1', runId: 'run-2', prompt: { modelText: 'follow-up', displayText: 'follow-up', clientMessageId: 'run-2' },
    })
    await waitFor(frame => frame.id === secondRunId)
    await waitFor(frame => frame.method === 'run.event'
      && frame.params.event.type === 'run.completed'
      && frame.params.event.reason === 'completed'
      && frame.params.runId === 'run-2')
    const secondStatusId = request('runtime.status')
    const secondStatus = await waitFor(frame => frame.id === secondStatusId)
    assert.deepEqual(secondStatus.result.runtimes, [{
      threadId: 'thread-1', sessionId: 'session-1', generation: 1,
    }])

    const shutdownId = request('host.shutdown')
    await waitFor(frame => frame.id === shutdownId)
    await new Promise((resolveExit, reject) => {
      child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`host exited ${code}`)))
    })
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolveExit => child.once('exit', resolveExit))
    }
    await rm(dshHome, { recursive: true, force: true })
    await rm(sessionRoot, { recursive: true, force: true })
  }
})
