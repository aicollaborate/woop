import assert from 'node:assert/strict'
import { NativeJsonRpcServer } from '../src/native-jsonrpc-server.js'

let revision = 3
const providers = { deepseek: { apiKey: 'redacted', model: 'deepseek-chat' } }
const credentials = new Map()
const ctx = {
  settings: {
    describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers }, applies: [] }],
    async mutate(_ns, operations, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('revision conflict')
      for (const operation of operations) {
        if (operation.op === 'set') providers[operation.path[1]] = operation.value
        if (operation.op === 'unset') delete providers[operation.path[1]]
      }
      revision++
    },
  },
  llm: { discoverModels: async (_namespace, request) => [{ id: request.prefix ? `${request.prefix}-model` : 'deepseek-chat' }] },
  credentials: {
    describe: reference => ({ reference, configured: credentials.has(reference) }),
    async set(reference, value) { credentials.set(reference, value) },
    async unset(reference) { credentials.delete(reference) },
  },
}

const server = new NativeJsonRpcServer({
  ...ctx,
  // Real Cordis resolves optional services dynamically through ctx.get(name);
  // direct property access is rejected unless declared in the plugin's inject
  // list. The mock mirrors that interface.
  get: name => ctx[name],
})
await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' })
assert.deepEqual((await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'model/config/read' })).result.providers, providers)
const catalog = (await server.dispatch({ jsonrpc: '2.0', id: 2.5, method: 'model/catalog' })).result.providers
assert.deepEqual(catalog.find(provider => provider.provider === 'deepseek'), {
  provider: 'deepseek', takesApiKey: true, models: [{ id: 'deepseek-chat' }],
})
assert.deepEqual((await server.dispatch({ jsonrpc: '2.0', id: 3, method: 'model/discover', params: { prefix: 'test' } })).result.models[0].id, 'test-model')
const configured = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'model/config/upsert', params: { route: 'local', profile: { model: 'local-model' }, expectedRevision: 3 } })
assert.equal(configured.result.providers.local.model, 'local-model')
const deleted = await server.dispatch({ jsonrpc: '2.0', id: 5, method: 'model/config/remove', params: { route: 'local', expectedRevision: 4 } })
assert.equal(deleted.result.providers.local, undefined)
const invalid = await server.dispatch({ jsonrpc: '2.0', id: 6, method: 'model/config/remove', params: { route: '__proto__' } })
assert.equal(invalid.error.code, -32603)
const capability = await server.dispatch({ jsonrpc: '2.0', id: 7, method: 'runtime/capabilities' })
assert.ok(capability.result.capabilities.includes('credentials-management'))
await server.dispatch({ jsonrpc: '2.0', id: 8, method: 'credential/set', params: { reference: 'DEEPSEEK_API_KEY', value: 'secret' } })
assert.equal((await server.dispatch({ jsonrpc: '2.0', id: 9, method: 'credential/read', params: { reference: 'DEEPSEEK_API_KEY' } })).result.configured, true)
await server.dispatch({ jsonrpc: '2.0', id: 10, method: 'credential/unset', params: { reference: 'DEEPSEEK_API_KEY' } })
assert.equal(credentials.has('DEEPSEEK_API_KEY'), false)
console.log('models smoke: ok')
