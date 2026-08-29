import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

function read(relative: string): string {
  return readFileSync(resolve(root, relative), 'utf8')
}

const SHARED_NEEDLES = [
  "id: dsh-flowix-memory",
  "name: '@deepseek-ai/dsh-mcp-client'",
  'serverName: flowix',
  'transport: stdio',
] as const

test('memory stays an independent profile bundle and is not duplicated in the host composition', () => {
  const product = read('config/flowix.cordis.yml')
  const appserver = read('profile/flowix/node_modules/dsh-appserver/cordis.patch.yml')
  const patch = read('../dsh-flowix-memory/cordis.patch.yml')
  const packageManifest = JSON.parse(read('../dsh-flowix-memory/package.json'))

  for (const needle of SHARED_NEEDLES) {
    assert.ok(patch.includes(needle), `bundle patch missing ${needle}`)
    assert.ok(!product.includes(needle), `product composition duplicates independent bundle row ${needle}`)
  }
  const profile = JSON.parse(read('profile/flowix/package.json'))
  assert.equal(profile.dsh.profile.bundles[0], '@deepseek-ai/dsh-base')
  assert.match(product, /\[\]\s*$/)
  assert.doesNotMatch(product, /sdk-jsonrpc-server|flowix-dsh-bridge/)
  assert.match(appserver, /id: dsh-appserver-extension/)
  assert.match(appserver, /name: 'dsh-appserver'/)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-flowix-memory'))
  assert.match(patch, /FLOWIX_DSH_MCP_CLI/)
  assert.match(patch, /FLOWIX_CLI_PATH/)
  assert.match(patch, /launcher\.mjs/)
  assert.ok(packageManifest.files.includes('launcher.mjs'))
})

test('Flowix profile keeps the headless non-interactive runtime boundary', () => {
  const patch = read('profile/flowix/cordis.patch.yml')

  for (const plugin of ['typert', 'typert-loader', 'typert-gateway', 'session-title-llm']) {
    assert.match(patch, new RegExp(`id: ${plugin}\\n  disabled: true`))
  }
  assert.match(patch, /policy: never/)
  assert.match(patch, /defaultPreset: !!js process\.env\.DSH_PERMISSION_MODE/)
  assert.equal((patch.match(/approval: never/g) ?? []).length, 3)
})

test('Flowix profile routes probe snapshots into official settings providers', () => {
  const patch = read('profile/flowix/cordis.patch.yml')
  const environment = read('src/runtime/environment.ts')

  assert.match(patch, /id: settings\n  config:\n    path: !!js process\.env\.DSH_SETTINGS_PATH/)
  assert.match(patch, /id: credentials\n  config:\n    path: !!js process\.env\.DSH_CREDENTIALS_PATH/)
  assert.match(environment, /if \(existsSync\(sourcePatchPath\)\) \{\n    copyFileSync\(sourcePatchPath, targetPatchPath\)/)
})

test('managed bundles keep Node and plugin package management private', () => {
  const builder = read('scripts/build-runtime-bundle.mjs')
  const closure = read('scripts/verify-runtime-closure.mjs')
  const launcher = read('../app/flowix-desktop/src/dsh.rs')
  const commands = read('../app/flowix-desktop/src/commands/dsh.rs')
  const manager = read('../app/flowix-desktop/src/agent_external/deepseek_harness/manager.rs')
  const packageGate = read('../scripts/verify-dsh-package.mjs')
  const privateLock = read('private-pnpm/pnpm-lock.yaml')

  assert.match(builder, /private-pnpm/)
  assert.match(builder, /pnpm\.mjs/)
  assert.match(builder, /await writePrivateShims\(bundle\)/)
  assert.match(builder, /verify-runtime-closure\.mjs/)
  assert.match(closure, /symbolic link is not allowed/)
  assert.match(closure, /development-machine absolute path is not allowed/)
  assert.match(launcher, /managed_child_environment\(&launch\.root\)/)
  assert.match(launcher, /fn health_check[\s\S]*?\.envs\(managed_child_environment\(root\)\)/)
  for (const field of ['pnpm_entrypoint', 'node_version', 'node_abi', 'pnpm_version']) {
    assert.match(launcher, new RegExp(`${field}: current\\.${field}\\.clone\\(\\)`))
  }
  assert.match(launcher, /health_check\(&launch\)[\s\S]*?before_publish\(\)/)
  assert.match(commands, /ensure_hosts_replaceable\(\)[\s\S]*?spawn_blocking/)
  assert.match(commands, /install_runtime_with_progress_before_publish/)
  assert.match(manager, /pub async fn ensure_hosts_replaceable/)
  assert.doesNotMatch(launcher, /set_var\(/)
  assert.match(packageGate, /SYSTEM-PNPM-MUST-NOT-RUN/)
  assert.match(packageGate, /private native addon\/ABI check failed/)
  assert.match(privateLock, /sha512-GcyFLBIMcSV2DyRD7mvgyltA\+fUFmN4a/)
})
