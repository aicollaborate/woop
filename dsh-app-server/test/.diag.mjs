import { prepareRuntimeTest, JsonlClient, check } from './runtime/host.mjs'

const test = await prepareRuntimeTest({ transport: 'stdio' })
let child = test.spawnHost()
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
child.stderr.on('data', d => process.stderr.write(`[${ts()}][stderr] ${d}`))
child.once('exit', (code, signal) => console.log(`[${ts()}] HOST EXITED code=${code} signal=${signal}`))
const client = new JsonlClient(child, { responseTimeoutMs: 15000 })
const step = async (label, fn) => { console.log(`[${ts()}] → ${label}`); try { const r = await fn(); console.log(`[${ts()}] ← ${label}: ${JSON.stringify(r).slice(0, 140)}`); return r } catch (e) { console.log(`[${ts()}] ✗ ${label}: ${e.message.split('\n')[0]}`); return null } }

await step('initialize', () => client.request('initialize', {}))
await step('capabilities', () => client.request('runtime/capabilities', {}))
await step('status', () => client.request('runtime/status', {}))
await step('thread/start', () => client.request('thread/start', { threadId: 'diag-1' }))
await new Promise(r => setTimeout(r, 3000))
await step('thread/read after wait', () => client.request('thread/read', { threadId: 'diag-1' }))
await client.close()
await test.cleanup()
