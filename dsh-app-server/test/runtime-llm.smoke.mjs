// Real-model runtime smoke: provisions the user's DeepSeek key from the Flowix
// secret store into an isolated DSH home (exactly how a Flowix harness session
// does it) and exercises the paths that need live model traffic:
//
//   1. a streaming turn — assistant chunks arrive as item/agentMessage/delta
//      notifications and settle into a completed agentMessage item and turn
//   2. the approval accept loop — a sandbox-escaping command triggers a
//      server-initiated item/commandExecution/requestApproval; accepting
//      resolves it to allowed-once and the tool actually runs
//   3. the approval decline loop — declining resolves to rejected and the
//      command does not run
//
// The key is read at runtime from ~/.flowix/default.db and written only into
// the throwaway DSH home (mode 0600); it is never printed.
import { prepareRuntimeTest, JsonlClient, check } from './runtime/host.mjs'

const test = await prepareRuntimeTest({ transport: 'stdio', realLlm: true })
const child = test.spawnHost()
const client = new JsonlClient(child, { responseTimeoutMs: 30000, notificationTimeoutMs: 120000 })
const threadId = `llm-smoke-${process.pid}`

async function waitForTurnEnd(thread, turnId) {
  return client.waitForNotification(
    n => n.method === 'turn/completed' && n.params?.threadId === thread && (turnId === undefined || n.params?.turnId === turnId),
    { timeoutMs: 150000, label: `turn/completed for ${thread}` },
  )
}

try {
  const init = await client.request('initialize', {})
  check('initialize', init.result?.serverInfo?.name === 'dsh-app-server')

  // ── 1. streaming turn against the live model ────────────────────────────
  {
    const started = await client.request('thread/start', { threadId })
    check('thread/start', started.result?.thread?.id === threadId)

    const turn = await client.request('turn/start', { threadId, input: 'Reply with exactly this single word and nothing else: ok' })
    const turnId = turn.result?.turn?.id
    check('turn/start accepted', turn.result?.turn?.status === 'inProgress', turnId)

    const deltas = []
    await waitForTurnEnd(threadId, turnId)
    for (const n of client.notifications) {
      if (n.method === 'item/agentMessage/delta' && n.params?.threadId === threadId) deltas.push(n.params.delta ?? '')
    }
    const completed = client.notifications.find(n => n.method === 'item/completed' && n.params?.threadId === threadId && n.params?.item?.type === 'agentMessage')
    const ended = client.notifications.find(n => n.method === 'turn/completed' && n.params?.threadId === threadId && n.params?.turnId === turnId)

    check('streaming deltas arrive over stdio', deltas.length > 0, `${deltas.length} delta chunks`)
    check('streamed text is non-empty', deltas.join('').trim().length > 0, JSON.stringify(deltas.join('')).slice(0, 60))
    check('agentMessage item completes', completed?.params?.item?.text?.trim().length > 0, JSON.stringify(completed?.params?.item?.text ?? '').slice(0, 60))
    check('turn completes successfully with the live model', ended?.params?.turn?.status === 'completed', ended?.params?.turn?.status)
  }

  // ── 2. approval accept loop ─────────────────────────────────────────────
  {
    const approveThread = `${threadId}-approve`
    await client.request('thread/start', { threadId: approveThread })
    // A write outside the workspace is never auto-allowed under the default
    // workspace-write sandbox, so the approval seam must fire. The command
    // removes its own marker file, so an accepted run leaves nothing behind.
    const marker = '~/Library/.appserver-approval-accept'
    const command = `echo appserver-approval-test > ${marker} && cat ${marker} && rm ${marker}`
    const turn = await client.request('turn/start', { threadId: approveThread, input: `Use your bash tool to run exactly this command, then report what it printed: ${command}` })
    const turnId = turn.result?.turn?.id

    const approval = await client.waitForNotification(
      n => n.method === 'item/commandExecution/requestApproval' && n.params?.threadId === approveThread,
      { label: 'item/commandExecution/requestApproval (accept case)' },
    )
    check('approval request reaches the owning stdio client',
      approval.params?.kind === 'commandExecution' && String(approval.params?.command ?? '').includes('appserver-approval-test'),
      `id=${approval.id} command=${JSON.stringify(approval.params?.command ?? '').slice(0, 70)}`)
    check('approval request carries turn linkage', typeof approval.params?.turnId === 'string' && approval.params.turnId.length > 0, approval.params?.turnId)

    client.respondTo(approval.id, { decision: 'accept' })
    const resolved = await client.waitForNotification(
      n => n.method === 'serverRequest/resolved' && n.params?.threadId === approveThread && n.params?.requestId === approval.id,
      { label: 'serverRequest/resolved (accept)' },
    )
    check('accepted approval resolves with serverRequest/resolved', resolved.params?.requestId === approval.id)

    await waitForTurnEnd(approveThread, turnId)
    const decided = client.notifications.find(n => n.method === 'item/completed' && n.params?.threadId === approveThread && n.params?.item?.type === 'approvalRequest' && n.params?.item?.outcome === 'allowed-once')
    check('approval decision recorded as allowed-once', decided !== undefined, decided?.params?.item?.outcome)
    const toolResult = [...client.notifications].filter(n => n.method === 'item/completed' && n.params?.threadId === approveThread && n.params?.item?.type === 'toolResult')
      .map(n => String(n.params?.item?.text ?? '')).join('\n')
    check('accepted command actually executed', toolResult.includes('appserver-approval-test'), JSON.stringify(toolResult).slice(0, 80))
    const ended = client.notifications.find(n => n.method === 'turn/completed' && n.params?.threadId === approveThread && n.params?.turnId === turnId)
    check('turn with approved command completes', ended?.params?.turn?.status === 'completed', ended?.params?.turn?.status)
  }

  // ── 3. approval decline loop ────────────────────────────────────────────
  {
    const declineThread = `${threadId}-decline`
    await client.request('thread/start', { threadId: declineThread })
    const marker = '~/Library/.appserver-approval-decline'
    const command = `echo decline-marker > ${marker} && cat ${marker} && rm ${marker}`
    const turn = await client.request('turn/start', { threadId: declineThread, input: `Use your bash tool to run exactly this command, then report what it printed: ${command}` })
    const turnId = turn.result?.turn?.id

    const approval = await client.waitForNotification(
      n => n.method === 'item/commandExecution/requestApproval' && n.params?.threadId === declineThread,
      { label: 'item/commandExecution/requestApproval (decline case)' },
    )
    client.respondTo(approval.id, { decision: 'decline' })
    await client.waitForNotification(
      n => n.method === 'serverRequest/resolved' && n.params?.threadId === declineThread,
      { label: 'serverRequest/resolved (decline)' },
    )
    await waitForTurnEnd(declineThread, turnId)

    const decided = client.notifications.find(n => n.method === 'item/completed' && n.params?.threadId === declineThread && n.params?.item?.type === 'approvalRequest' && n.params?.item?.outcome === 'rejected')
    check('declined approval records outcome rejected', decided !== undefined, decided?.params?.item?.outcome)
    const executed = [...client.notifications].filter(n => n.method === 'item/completed' && n.params?.threadId === declineThread && n.params?.item?.type === 'toolResult')
      .map(n => String(n.params?.item?.text ?? '')).join('\n')
    check('declined command does not run', !executed.includes('decline-marker'), JSON.stringify(executed).slice(0, 80))
    const ended = client.notifications.find(n => n.method === 'turn/completed' && n.params?.threadId === declineThread && n.params?.turnId === turnId)
    check('turn after rejection still terminates', ended !== undefined && ['completed', 'failed'].includes(ended.params?.turn?.status), ended?.params?.turn?.status)
  }

  // ── final projection ────────────────────────────────────────────────────
  const read = await client.request('thread/read', { threadId, includeTurns: true })
  const agentTexts = (read.result?.thread?.turns ?? []).flatMap(t => (t.items ?? []).filter(i => i.type === 'agentMessage').map(i => i.text))
  check('thread/read replays the live-model answer', agentTexts.some(t => (t ?? '').trim().length > 0), `${agentTexts.length} agent messages`)

  const shutdown = await client.request('shutdown', {})
  check('shutdown', shutdown.result !== undefined)
} catch (error) {
  console.error(`\nLLM SMOKE ABORTED: ${error.message}`)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await test.cleanup()
}

console.log(process.exitCode ? 'RUNTIME LLM SMOKE: FAILED' : 'RUNTIME LLM SMOKE: PASSED')
process.exit(process.exitCode ?? 0)
