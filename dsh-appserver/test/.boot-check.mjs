import { prepareRuntimeTest, JsonlClient, check } from './runtime/host.mjs'

const test = await prepareRuntimeTest({ transport: 'stdio' })
const child = test.spawnHost()
const client = new JsonlClient(child, { responseTimeoutMs: 60000 })
try {
  const init = await client.request('initialize', {})
  check('boot + initialize', init.result?.serverInfo?.name === 'dsh-appserver', JSON.stringify(init.result?.serverInfo))
  await client.waitForNotification(n => n.method === 'initialized')
  check('initialized notification', true)
  const caps = await client.request('runtime/capabilities', {})
  check('runtime/capabilities', Array.isArray(caps.result?.capabilities), caps.result?.capabilities?.join(','))
  const shutdown = await client.request('shutdown', {})
  check('shutdown', shutdown.result !== undefined)
  console.log('BOOT CHECK OK')
} catch (error) {
  console.error('BOOT CHECK FAILED:', error.message)
  console.error('--- host stderr ---')
  console.error(String(child.stderr))
  process.exitCode = 1
} finally {
  await client.close()
  await test.cleanup()
}
