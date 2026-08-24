import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'

test('packaged host drives the packaged Harness runtime through a mock provider turn', async () => {
  const root = resolve(import.meta.dirname, '../..')
  const triple = hostTriple()
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const host = resolve(root, `app/flowix-desktop/binaries/dsh-host-${triple}${suffix}`)
  assert.ok(existsSync(host), `missing sidecar: ${host}`)

  const mock = await startMockProvider()
  const sessionRoot = await mkdtemp(resolve(tmpdir(), 'flowix-dsh-sidecar-e2e-'))
  const dshHome = resolve(sessionRoot, 'dsh-home')
  const credentialsPath = resolve(dshHome, '.credentials.yaml')
  const settingsPath = resolve(dshHome, 'settings.yaml')
  await mkdir(dshHome, { recursive: true })
  await writeFile(credentialsPath, 'DSH_API_KEY: fixture-secret\n', { mode: 0o600 })
  // llm-pi-ai is configured through the official settings seam. The test
  // deliberately uses a native `openai` route instead of the removed
  // Flowix alias.
  await writeFile(settingsPath, `llm-pi-ai:\n  providers:\n    openai:\n      displayName: fixture\n      apiKeyEnv: DSH_API_KEY\n      api: openai-completions\n      baseURL: ${mock.url}\n      models:\n        - id: fixture-model\n`, { mode: 0o600 })
  const child = spawn(host, [], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      FLOWIX_DSH_SESSION_ROOT: sessionRoot,
      FLOWIX_DSH_ROOT: resolve(root, 'dsh-flowix-host'),
      // The sidecar used here is copied into the desktop development
      // binaries directory, while the release archive keeps profile/flowix
      // beside dsh-host. Point the packaged-host test at the same source
      // payload so it exercises the profile installation path without
      // pretending that the development binaries directory is a release
      // archive.
      FLOWIX_DSH_PROFILE_SOURCE: resolve(root, 'dsh-flowix-host/profile/flowix'),
      FLOWIX_DSH_MCP_CLI: resolve(root, `app/flowix-desktop/binaries/flowix-cli-${triple}`),
      DSH_HOME: dshHome,
      DSH_SETTINGS_PATH: settingsPath,
      DSH_CREDENTIALS_PATH: credentialsPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  const waiters = []
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
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
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const found = frames.find(predicate)
      if (found !== undefined) return found
      await new Promise(resolveWait => {
        const timer = setTimeout(resolveWait, 250)
        waiters.push(() => { clearTimeout(timer); resolveWait() })
      })
    }
    throw new Error(`timed out; stderr=${stderr}; frames=${JSON.stringify(frames)}`)
  }

  try {
    const initializeId = request('host.initialize', { protocolVersion: 1 })
    await waitFor(frame => frame.id === initializeId)
    const ensureId = request('runtime.ensure', {
      threadId: 'thread-sidecar', sessionId: 'session-sidecar', cwd: root,
      provider: 'openai', providerName: 'fixture', apiProtocol: 'openai-completions',
      baseUrl: mock.url, model: 'fixture-model', agentPreset: 'minimal', permissionMode: 'read-only',
    })
    const ensured = await waitFor(frame => frame.id === ensureId)
    assert.equal(ensured.error, undefined, stderr)

    const bridgeId = request('runtime.bridge.capabilities', { threadId: 'thread-sidecar' })
    const bridge = await waitFor(frame => frame.id === bridgeId)
    assert.equal(bridge.error, undefined, stderr)
    assert.deepEqual(bridge.result.capabilities, [
      'runtime-events', 'session-control', 'session-dispose', 'run-cancel', 'profile',
    ])
    const startId = request('run.start', {
      threadId: 'thread-sidecar', runId: 'run-sidecar', prompt: { modelText: 'reply briefly', displayText: 'reply briefly', clientMessageId: 'run-sidecar' },
    })
    const started = await waitFor(frame => frame.id === startId)
    assert.equal(started.error, undefined, stderr)
    await waitFor(frame => frame.method === 'run.event'
      && frame.params.runId === 'run-sidecar'
      && frame.params.event.type === 'run.completed')

    const events = frames.filter(frame => frame.method === 'run.event').map(frame => frame.params.event)
    assert.equal(events.find(event => event.type === 'assistant.delta')?.text, 'hello from packaged runtime', JSON.stringify({ events, stderr, requests: mock.requests, tools: mock.toolNames }))
    for (const tool of ['bash', 'mcp__dsh-flowix-memory__flowix_memo', 'str_replace_editor']) {
      assert.equal(mock.toolNames.includes(tool), true, `missing ${tool}; tools=${JSON.stringify([...mock.toolNames].sort())}`)
    }
    assert.equal(events.find(event => event.type === 'usage')?.outputTokens, 4)
    assert.equal(events.at(-1)?.reason, 'completed')
    assert.equal(mock.requests, 1)

    const shutdownId = request('host.shutdown')
    await waitFor(frame => frame.id === shutdownId)
    await new Promise((resolveExit, reject) => {
      child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`host exited ${code}: ${stderr}`)))
    })
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await mock.close()
    await rm(sessionRoot, { recursive: true, force: true })
  }
})

function hostTriple() {
  if (process.platform === 'darwin') return `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  if (process.platform === 'linux') return `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc'
  throw new Error(`unsupported sidecar test host ${process.platform}-${process.arch}`)
}

async function startMockProvider() {
  let requests = 0
  let toolNames = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      assert.equal(request.url, '/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer fixture-secret')
      const payload = JSON.parse(body)
      assert.equal(payload.stream, true)
      toolNames = (payload.tools ?? []).map(tool => tool.function?.name ?? tool.name)
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
        { choices: [{ delta: { content: 'hello from packaged runtime' } }] },
        { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      ]
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() { return requests },
    get toolNames() { return toolNames },
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}
