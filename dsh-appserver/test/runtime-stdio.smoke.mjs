// Full-protocol runtime smoke over stdio against the installed Flowix DSH.
// Covers handshake discipline, error codes, thread/turn/fork lifecycle,
// approval policy, credential and model config CRUD, session aliases,
// event pagination, and crash-restart durability via the session log.
//
// No LLM credentials are provisioned: turns start, persist their user message,
// and fail fast on the model call — which is exactly the protocol surface
// under test. Real-model streaming/approval loops are covered separately.
import { prepareRuntimeTest, JsonlClient, check } from './runtime/host.mjs'

const test = await prepareRuntimeTest({ transport: 'stdio' })
const threadId = `smoke-${process.pid}`
const childId = `${threadId}-child`
let child = test.spawnHost()
let client = new JsonlClient(child, { responseTimeoutMs: 30000, notificationTimeoutMs: 45000 })

try {
  // ── framing and handshake discipline ────────────────────────────────────
  client.send('{ not json')
  const afterGarbage = await client.request('thread/list', {})
  check('invalid JSON line does not kill the host', afterGarbage.error?.code === -32002, afterGarbage.error)

  const beforeInit = await client.request('thread/list', {})
  check('uninitialized request → -32002', beforeInit.error?.code === -32002, beforeInit.error)

  const init = await client.request('initialize', {})
  check('initialize returns serverInfo + capabilities',
    init.result?.serverInfo?.name === 'dsh-appserver' && init.result?.capabilities?.approvals?.decisions?.length > 0,
    init.result?.serverInfo)

  const dupInit = await client.request('initialize', {})
  check('duplicate initialize → -32003', dupInit.error?.code === -32003, dupInit.error)

  const unknown = await client.request('no/such/method', {})
  check('unknown method → -32601', unknown.error?.code === -32601, unknown.error)

  const badParams = await client.request('thread/read', { threadId: 42 })
  check('invalid params → -32602', badParams.error?.code === -32602, badParams.error)

  const badShape = await client.request('thread/read', [])
  check('non-object params → -32602', badShape.error?.code === -32602, badShape.error)

  // ── runtime surface ─────────────────────────────────────────────────────
  const caps = await client.request('runtime/capabilities', {})
  check('runtime/capabilities lists features', Array.isArray(caps.result?.capabilities) && caps.result.capabilities.includes('session-control'), caps.result?.capabilities?.join(','))

  const status = await client.request('runtime/status', {})
  check('runtime/status reports idle server', status.result?.initialized === true && status.result?.protocolVersion === 1, status.result)

  // ── thread lifecycle ────────────────────────────────────────────────────
  const started = await client.request('thread/start', { threadId })
  check('thread/start returns idle thread', started.result?.thread?.id === threadId && started.result.thread.status === 'idle', started.result?.thread?.status)
  await client.waitForNotification(n => n.method === 'thread/started' && n.params?.thread?.id === threadId, { label: 'thread/started' })
  check('thread/started notification emitted', true)

  const live = await client.request('thread/resume', { threadId })
  check('thread/resume on live thread is idempotent', live.result?.thread?.id === threadId, live.result?.thread?.status)

  // ── approval policy ─────────────────────────────────────────────────────
  const policy = await client.request('thread/approvalPolicy/read', { threadId })
  check('approvalPolicy/read defaults to ask', policy.result?.policy === 'ask', policy.result)

  // Policy writes append approval/policy events to the session log, and DSH's
  // turn guard aborts a turn when the policy changed after it started. Use a
  // dedicated thread so the main thread's turn tests stay unaffected.
  const policyThreadId = `${threadId}-policy`
  await client.request('thread/start', { threadId: policyThreadId })
  const policyNever = await client.request('thread/approvalPolicy/write', { threadId: policyThreadId, policy: 'never' })
  check('approvalPolicy/write accepts never', policyNever.result?.policy === 'never', policyNever.result)

  const policyBack = await client.request('thread/approvalPolicy/write', { threadId: policyThreadId, policy: 'ask' })
  check('approvalPolicy/write restores ask', policyBack.result?.policy === 'ask', policyBack.result)

  const policyBad = await client.request('thread/approvalPolicy/write', { threadId: policyThreadId, policy: 'always' })
  check('approvalPolicy/write rejects unknown policy', policyBad.error !== undefined, policyBad.error?.message)

  // ── credential CRUD (isolated DSH_HOME credentials doc) ────────────────
  const credRead = await client.request('credential/read', { reference: 'DSH_SMOKE_TEST_KEY' })
  check('credential/read describes reference', credRead.result !== undefined, credRead.result ?? credRead.error?.message)

  const credSet = await client.request('credential/set', { reference: 'DSH_SMOKE_TEST_KEY', value: 'smoke-value' })
  check('credential/set persists value', credSet.result !== undefined, credSet.error?.message ?? 'ok')

  const credBad = await client.request('credential/set', { reference: 'not an env name!', value: 'x' })
  check('credential/set rejects non env-var reference', credBad.error !== undefined, credBad.error?.message)

  const credUnset = await client.request('credential/unset', { reference: 'DSH_SMOKE_TEST_KEY' })
  check('credential/unset removes value', credUnset.result !== undefined, credUnset.error?.message ?? 'ok')

  // ── model config CRUD (llm-pi-ai settings namespace) ───────────────────
  const modelsBefore = await client.request('model/config/read', {})
  const revision = modelsBefore.result?.revision
  check('model/config/read returns revision', typeof revision === 'number', `revision=${revision}`)

  const profile = { api: 'openai-completions', apiKeyEnv: 'DSH_SMOKE_TEST_KEY', baseURL: 'https://example.invalid', displayName: 'smoke', models: [{ id: 'smoke-model' }] }
  const upsert = await client.request('model/config/upsert', { route: 'smoke-route', profile, expectedRevision: revision })
  check('model/config/upsert adds provider route', upsert.result?.providers?.['smoke-route']?.displayName === 'smoke', upsert.error?.message ?? 'ok')

  const stale = await client.request('model/config/upsert', { route: 'smoke-route', profile, expectedRevision: revision })
  check('model/config/upsert with stale revision conflicts', stale.error !== undefined, stale.error?.message)

  const evilRoute = await client.request('model/config/upsert', { route: '__proto__', profile })
  check('model/config/upsert rejects prototype route', evilRoute.error !== undefined, evilRoute.error?.message)

  const discover = await client.request('model/list', { provider: 'deepseek' })
  // pi-ai ships an offline catalog for the deepseek route, so discovery needs
  // neither network nor credentials.
  check('model/list discovers catalog models',
    Array.isArray(discover.result?.models) && discover.result.models.length > 0,
    discover.error?.message ?? `${discover.result?.models?.length} models`)

  const remove = await client.request('model/config/remove', { route: 'smoke-route', expectedRevision: upsert.result?.revision })
  check('model/config/remove drops route', remove.result?.providers?.['smoke-route'] === undefined, remove.error?.message ?? 'ok')

  // ── turn lifecycle without model credentials ────────────────────────────
  const turn = await client.request('turn/start', { threadId, input: 'protocol smoke turn' })
  const turnId = turn.result?.turn?.id
  check('turn/start returns inProgress turn', turn.result?.turn?.status === 'inProgress', turn.result?.turn)

  await client.waitForNotification(n => n.method === 'turn/started' && n.params?.threadId === threadId, { label: 'turn/started' })
  check('turn/started notification emitted', true)

  const userItem = await client.waitForNotification(
    n => n.method === 'item/started' && n.params?.threadId === threadId && n.params?.item?.type === 'userMessage',
    { label: 'item/started userMessage' },
  )
  check('user message projected as item', userItem.params?.item?.text === 'protocol smoke turn', userItem.params?.item?.text)

  const turnEnd = await client.waitForNotification(
    n => n.method === 'turn/completed' && n.params?.threadId === threadId,
    { timeoutMs: 60000, label: 'turn/completed (model call fails without credentials)' },
  )
  check('turn reaches terminal projection', ['failed', 'completed', 'interrupted'].includes(turnEnd.params?.turn?.status), turnEnd.params?.turn?.status)

  // ── interrupt path (start then immediately cancel) ─────────────────────
  const turn2 = await client.request('turn/start', { threadId, input: 'interrupt me' })
  const interrupt = await client.request('turn/interrupt', { threadId })
  check('turn/interrupt answered', typeof interrupt.result?.interrupted === 'boolean', interrupt.result)
  await client.waitForNotification(
    n => n.method === 'turn/completed' && n.params?.threadId === threadId && n.params?.turnId === turn2.result?.turn?.id,
    { timeoutMs: 60000, label: 'interrupted turn/completed' },
  ).catch(() => check('interrupted turn reaches terminal projection', false, 'timeout'))
  check('turn/interrupt + terminal notification', true)

  // ── read projections and pagination ─────────────────────────────────────
  const read = await client.request('thread/read', { threadId, includeTurns: true })
  const turns = read.result?.thread?.turns ?? []
  check('thread/read projects persisted turns', turns.length >= 1 && turns[0].items.some(item => item.type === 'userMessage'), `turns=${turns.length}`)

  const readLean = await client.request('thread/read', { threadId, includeTurns: false })
  check('thread/read includeTurns=false omits turns', readLean.result?.thread?.turns?.length === 0, `turns=${readLean.result?.thread?.turns?.length}`)

  const page1 = await client.request('thread/turns/list', { threadId, limit: 1 })
  check('turn pagination yields cursor', page1.result?.page?.data?.length === 1 && typeof page1.result?.page?.nextCursor === 'string', page1.result?.page?.nextCursor)
  if (page1.result?.page?.nextCursor) {
    const page2 = await client.request('thread/turns/list', { threadId, cursor: page1.result.page.nextCursor, limit: 100 })
    check('turn pagination follows cursor', Array.isArray(page2.result?.page?.data), `next=${page2.result?.page?.nextCursor}`)
  }

  const missing = await client.request('thread/read', { threadId: 'no-such-thread' })
  check('thread/read of unknown thread errors', missing.error !== undefined, missing.error?.message)

  // ── events, fork boundaries ─────────────────────────────────────────────
  const events = await client.request('thread/events/list', { threadId, afterSeq: -1, limit: 1000 })
  const eventList = events.result?.page?.data ?? []
  check('thread/events/list returns session log', eventList.length > 0, `events=${eventList.length}`)

  const userSeq = [...eventList].reverse().find(e => e.type === 'user/message')?.seq
  const turnStartSeq = eventList.find(e => e.type === 'turn/start')?.seq
  check('found fork boundary candidates', userSeq !== undefined && turnStartSeq !== undefined, `userSeq=${userSeq} turnStartSeq=${turnStartSeq}`)

  const fork = await client.request('thread/fork', { threadId, boundarySeq: userSeq, newThreadId: childId })
  check('thread/fork at message boundary', fork.result?.thread?.id === childId && fork.result.thread.parentThreadId === threadId, fork.error?.message ?? fork.result?.thread?.parentThreadId)

  const forkBad = await client.request('thread/fork', { threadId, boundarySeq: turnStartSeq, newThreadId: `${childId}-bad` })
  check('thread/fork rejects non-message boundary', forkBad.error !== undefined, forkBad.error?.message)

  const forkRange = await client.request('thread/fork', { threadId, boundarySeq: 99999, newThreadId: `${childId}-range` })
  check('thread/fork rejects out-of-range boundary', forkRange.error !== undefined, forkRange.error?.message)

  const childRead = await client.request('thread/read', { threadId: childId, includeTurns: true })
  check('forked child inherits projected history', (childRead.result?.thread?.turns?.length ?? 0) >= 1, `turns=${childRead.result?.thread?.turns?.length}`)

  const list = await client.request('thread/list', {})
  const ids = (list.result?.threads ?? []).map(t => t.id)
  check('thread/list sees parent and child', ids.includes(threadId) && ids.includes(childId), ids.join(','))

  // ── session aliases ─────────────────────────────────────────────────────
  const flush = await client.request('session/flush', { threadId })
  check('session/flush flushes live session', flush.result?.flushed === true || flush.result?.flushed === undefined, flush.result)

  const ensure = await client.request('session/ensure', { sessionId: threadId })
  check('session/ensure returns existing thread', ensure.result?.id === threadId, ensure.result?.id)

  const history = await client.request('session/history', { sessionId: threadId })
  check('session/history returns events + snapshotSeq', Array.isArray(history.result?.events) && history.result.events.length > 0, `events=${history.result?.events?.length} snapshotSeq=${history.result?.snapshotSeq}`)

  const promptAlias = await client.request('session/prompt', { sessionId: threadId, modelText: 'alias prompt turn' })
  check('session/prompt alias starts turn', promptAlias.result?.turn?.status === 'inProgress', promptAlias.result?.turn?.status)
  await client.request('run/cancel', { sessionId: threadId })
  await client.waitForNotification(
    n => n.method === 'turn/completed' && n.params?.threadId === threadId && n.params?.turnId === promptAlias.result?.turn?.id,
    { timeoutMs: 60000, label: 'alias turn terminal' },
  ).catch(() => {})

  const dispose = await client.request('session/dispose', { sessionId: childId })
  check('session/dispose closes thread', dispose.result?.disposed === true, dispose.result)

  // ── legacy aliases ──────────────────────────────────────────────────────
  const legacyCaps = await client.request('flowix.bridge.capabilities', {})
  check('flowix.bridge.capabilities alias', Array.isArray(legacyCaps.result?.capabilities), legacyCaps.error?.message ?? 'ok')
  const legacyModels = await client.request('models/describe', {})
  check('models/describe alias', legacyModels.result?.revision !== undefined, legacyModels.error?.message ?? 'ok')

  // ── crash-restart durability (same DSH_HOME, fresh process) ────────────
  child.kill('SIGKILL')
  await new Promise(resolveKill => child.once('exit', resolveKill))
  await client.close().catch(() => {})

  child = test.spawnHost()
  client = new JsonlClient(child, { responseTimeoutMs: 30000, notificationTimeoutMs: 45000 })
  const reinit = await client.request('initialize', {})
  check('fresh host reinitializes', reinit.result?.serverInfo?.name === 'dsh-appserver')

  const persisted = await client.request('thread/list', {})
  const persistedIds = (persisted.result?.threads ?? []).map(t => t.id)
  check('thread/list recovers persisted threads after crash', persistedIds.includes(threadId), persistedIds.join(','))

  const resumed = await client.request('thread/resume', { threadId })
  const resumedTurns = resumed.result?.thread?.turns ?? []
  check('thread/resume replays persisted turns', resumedTurns.length >= 1 && resumedTurns.some(t => t.items?.some(i => i.text === 'protocol smoke turn')), `turns=${resumedTurns.length}`)

  const replay = await client.request('thread/events/list', { threadId, afterSeq: -1, limit: 1000 })
  check('event log survives crash', (replay.result?.page?.data?.length ?? 0) >= eventList.length, `events=${replay.result?.page?.data?.length}`)

  const shutdown = await client.request('shutdown', {})
  check('shutdown', shutdown.result !== undefined)
} catch (error) {
  console.error(`\nSMOKE ABORTED: ${error.message}`)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await test.cleanup()
}

console.log(process.exitCode ? 'RUNTIME STDIO SMOKE: FAILED' : 'RUNTIME STDIO SMOKE: PASSED')
process.exit(process.exitCode ?? 0)
