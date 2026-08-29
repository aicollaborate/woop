import { prepareRuntimeTest, JsonlClient } from './runtime/host.mjs'
const test = await prepareRuntimeTest({ transport: 'stdio', realLlm: true })
const child = test.spawnHost()
const client = new JsonlClient(child, { responseTimeoutMs: 30000, notificationTimeoutMs: 90000 })
try {
  await client.request('initialize', {})
  const t = 'diag-' + process.pid
  await client.request('thread/start', { threadId: t })
  const turn = await client.request('turn/start', { threadId: t, input: 'Reply with exactly: ok' })
  await client.waitForNotification(n => n.method === 'turn/completed' && n.params?.threadId === t, { timeoutMs: 90000, label: 'turn end' })
  const events = await client.request('thread/events/list', { threadId: t, afterSeq: -1, limit: 1000 })
  for (const e of events.result?.page?.data ?? []) {
    const brief = JSON.stringify(e.data ?? {}).slice(0, 300)
    console.log(e.seq, e.type, brief)
  }
  console.log('--- notifications ---')
  for (const n of client.notifications) console.log(n.method, JSON.stringify(n.params ?? {}).slice(0, 200))
} catch (e) {
  console.error('DIAG FAILED:', e.message)
  console.error('stderr:', (child.stderrText || '').slice(-2000))
} finally {
  await client.close().catch(() => {})
  await test.cleanup()
}
