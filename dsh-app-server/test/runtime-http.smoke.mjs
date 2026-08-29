// HTTP/SSE transport smoke against the installed Flowix DSH runtime: boots the
// plugin with the HTTP transport (no stdio) and covers /rpc dispatch, health
// endpoints, per-connection initialize isolation via x-dsh-client-id, SSE
// history replay with afterSeq cursors, and body-size limits.
import { prepareRuntimeTest, check } from './runtime/host.mjs'

const port = 20000 + Math.floor(Math.random() * 20000)
const test = await prepareRuntimeTest({ transport: { port } })
const base = `http://127.0.0.1:${port}`
const child = test.spawnHost()
child.stderr.on('data', chunk => { child.stderrText = (child.stderrText || '') + chunk })

async function rpc(method, params, clientId = 'a', { raw } = {}) {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-client-id': clientId },
    body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e9, method, ...(params === undefined ? {} : { params }) }),
  })
  return response.json()
}

/** Read SSE data frames until the predicate is satisfied or timeout. */
async function sse(path, { collectFor = ms => new Promise(r => setTimeout(r, ms)), stopWhen, timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events = []
  try {
    const response = await fetch(`${base}${path}`, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
    if (response.status !== 200) { clearTimeout(timer); return { status: response.status, events } }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try { events.push(JSON.parse(line.slice(6))) } catch { /* non-JSON frame */ }
          }
        }
      }
      if (stopWhen?.(events)) { controller.abort(); break }
    }
  } catch { /* aborted or closed */ }
  clearTimeout(timer)
  return { status: 200, events }
}

try {
  // ── readiness ───────────────────────────────────────────────────────────
  let ready = ''
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try {
      const response = await fetch(`${base}/readyz`)
      if (response.ok) ready = await response.text()
      else await new Promise(r => setTimeout(r, 500))
    } catch { await new Promise(r => setTimeout(r, 500)) }
  }
  check('host listens and /readyz reports ready', ready === 'ready', `${base}/readyz → "${ready}"`)

  const health = await fetch(`${base}/healthz`)
  check('GET /healthz → 200 ok', health.status === 200 && (await health.text()) === 'ok')

  const healthOrigin = await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example' } })
  check('GET /healthz with Origin → 403', healthOrigin.status === 403)

  const notFound = await fetch(`${base}/nope`)
  check('unknown path → 404', notFound.status === 404)

  const wrongMethod = await fetch(`${base}/rpc`, { method: 'GET' })
  check('GET /rpc → 404', wrongMethod.status === 404)

  // ── rpc dispatch and connection isolation ───────────────────────────────
  const badJson = await rpc('initialize', undefined, 'a', { raw: '{oops' })
  check('POST /rpc invalid JSON → -32700', badJson.error?.code === -32700, badJson.error)

  const beforeInit = await rpc('thread/list', {}, 'a')
  check('uninitialized → -32002', beforeInit.error?.code === -32002, beforeInit.error)

  const init = await rpc('initialize', {}, 'a')
  check('initialize via /rpc', init.result?.serverInfo?.name === 'dsh-app-server', init.result?.serverInfo)

  const dupInit = await rpc('initialize', {}, 'a')
  check('duplicate initialize on same client → -32003', dupInit.error?.code === -32003, dupInit.error)

  const bBefore = await rpc('thread/list', {}, 'b')
  check('second client isolated: uninitialized → -32002', bBefore.error?.code === -32002, bBefore.error)

  const bInit = await rpc('initialize', {}, 'b')
  check('second client initializes independently', bInit.result?.serverInfo?.name === 'dsh-app-server')

  // ── thread + turn over HTTP ─────────────────────────────────────────────
  const threadId = `http-smoke-${port}`
  const started = await rpc('thread/start', { threadId }, 'a')
  check('thread/start via /rpc', started.result?.thread?.id === threadId, started.error?.message ?? 'ok')

  const turn = await rpc('turn/start', { threadId, input: 'http smoke turn' }, 'a')
  check('turn/start via /rpc', turn.result?.turn?.status === 'inProgress', turn.result?.turn?.status)

  const noThread = await rpc('thread/read', { threadId: 'missing' }, 'a')
  check('unknown thread errors over HTTP', noThread.error !== undefined, noThread.error?.message)

  // Let the turn settle (it fails fast without model credentials).
  await new Promise(r => setTimeout(r, 4000))

  const read = await rpc('thread/read', { threadId, includeTurns: true }, 'a')
  const turns = read.result?.thread?.turns ?? []
  check('thread/read shows persisted turn', turns.length >= 1 && turns[0].items?.some(i => i.type === 'userMessage'), `turns=${turns.length}`)

  // ── SSE replay ──────────────────────────────────────────────────────────
  const replayAll = await sse(`/events?threadId=${threadId}&afterSeq=-1&clientId=a`, {
    stopWhen: events => events.some(e => e.method === 'turn/completed'),
  })
  const methods = replayAll.events.map(e => e.method)
  check('SSE replays full history',
    methods.includes('turn/started') && methods.includes('item/started') && methods.includes('turn/completed'),
    methods.join(','))

  const lastUserSeq = Math.max(...replayAll.events.filter(e => e.method === 'item/started' && e.params?.item?.type === 'userMessage').map(e => e.params.sourceSeq))
  const replayTail = await sse(`/events?threadId=${threadId}&afterSeq=${lastUserSeq}&clientId=a`, {
    stopWhen: events => events.some(e => e.method === 'turn/completed'),
  })
  const tailSeqs = replayTail.events.map(e => e.params?.sourceSeq).filter(s => s !== undefined)
  check('SSE afterSeq cursor skips replayed prefix', tailSeqs.length === 0 || Math.min(...tailSeqs) > lastUserSeq, `afterSeq=${lastUserSeq}, got ${tailSeqs.join(',')}`)

  const replayMissing = await sse(`/events?threadId=no-such-thread&clientId=a`, { collectFor: () => Promise.resolve() })
  check('SSE for unknown thread surfaces error frame', replayMissing.events.some(e => e.method === undefined || e.error), JSON.stringify(replayMissing.events[0] ?? null).slice(0, 80))

  // ── fork over HTTP ──────────────────────────────────────────────────────
  const events = await rpc('thread/events/list', { threadId, afterSeq: -1, limit: 100 }, 'a')
  const userSeq = [...(events.result?.page?.data ?? [])].reverse().find(e => e.type === 'user/message')?.seq
  const fork = await rpc('thread/fork', { threadId, boundarySeq: userSeq, newThreadId: `${threadId}-child` }, 'a')
  check('thread/fork via /rpc', fork.result?.thread?.parentThreadId === threadId, fork.error?.message ?? 'ok')

  // ── per-connection notification opt-out ────────────────────────────────
  const optOutInit = await rpc('initialize', { capabilities: { optOutNotificationMethods: ['thread/started'] } }, 'c')
  check('initialize with optOut capabilities', optOutInit.result?.serverInfo?.name === 'dsh-app-server')
  const optOutThreadId = `${threadId}-optout`
  const quietStream = sse(`/events?threadId=${optOutThreadId}&clientId=c`, { timeoutMs: 8000 })
  const loudStream = sse(`/events?threadId=${optOutThreadId}&clientId=a`, { timeoutMs: 8000 })
  await new Promise(r => setTimeout(r, 500)) // let both SSE subscriptions attach
  await rpc('thread/start', { threadId: optOutThreadId }, 'a')
  const [quiet, loud] = await Promise.all([quietStream, loudStream])
  check('opt-out client skips opted methods',
    !quiet.events.some(e => e.method === 'thread/started'),
    `c saw: ${quiet.events.map(e => e.method).join(',') || 'nothing'}`)
  check('other client still receives the notification',
    loud.events.some(e => e.method === 'thread/started'),
    `a saw: ${loud.events.map(e => e.method).join(',') || 'nothing'}`)

  // ── serverRequest/respond error path ────────────────────────────────────
  const bogus = await rpc('serverRequest/respond', { requestId: 'approval:999', decision: 'accept' }, 'a')
  check('serverRequest/respond unknown id errors', bogus.error !== undefined, bogus.error?.message)

  // ── body limit ──────────────────────────────────────────────────────────
  const bigResponse = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-client-id': 'a' },
    body: 'x'.repeat(2 * 1024 * 1024),
  })
  check('oversized body → 413', bigResponse.status === 413)

  const after = await rpc('thread/list', {}, 'a')
  check('server healthy after rejected body', Array.isArray(after.result?.threads), after.error?.message ?? 'ok')

  const shutdown = await rpc('shutdown', {}, 'a')
  check('shutdown via /rpc', shutdown.result !== undefined)
} catch (error) {
  console.error(`\nHTTP SMOKE ABORTED: ${error.message}\n--- host stderr ---\n${child.stderrText || '(empty)'}`)
  process.exitCode = 1
} finally {
  if (!child.killed) child.kill('SIGTERM')
  await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r() }, 5000) })
  await test.cleanup()
}

console.log(process.exitCode ? 'RUNTIME HTTP SMOKE: FAILED' : 'RUNTIME HTTP SMOKE: PASSED')
process.exit(process.exitCode ?? 0)
