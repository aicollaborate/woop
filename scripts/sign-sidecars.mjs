import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const binaries = resolve(repo, 'app/flowix-desktop/binaries')
const host = process.argv.find(value => value.startsWith('--host='))?.slice(7)
if (!host) throw new Error('usage: node scripts/sign-sidecars.mjs --host=<rust-target-triple>')

if (host.includes('windows')) await signWindows()
else if (host.includes('apple')) signMacos()
else if (!host.includes('linux')) throw new Error(`unsupported host triple: ${host}`)

async function signWindows() {
  if (!process.env.WINDOWS_CERTIFICATE) {
    console.log('[sign] WINDOWS_CERTIFICATE not set; leaving local Windows sidecars unsigned')
    return
  }
  const temporary = await mkdtemp(join(tmpdir(), 'flowix-signing-'))
  try {
    const pfx = join(temporary, 'flowix.pfx')
    await writeFile(pfx, Buffer.from(process.env.WINDOWS_CERTIFICATE, 'base64'), { mode: 0o600 })
    const timestamp = process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.sectigo.com'
    for (const name of ['flowix-cli', 'dsh-host']) {
      const file = join(binaries, `${name}-${host}.exe`)
      if (!existsSync(file)) continue
      run('signtool', ['sign', '/fd', 'sha256', '/tr', timestamp, '/td', 'sha256', '/f', pfx, '/p', process.env.WINDOWS_CERTIFICATE_PASSWORD || '', file])
      run('signtool', ['verify', '/pa', file])
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function signMacos() {
  const identity = process.env.APPLE_SIGNING_IDENTITY
  if (!identity) {
    console.log('[sign] APPLE_SIGNING_IDENTITY not set; leaving local macOS sidecars unsigned')
    return
  }
  const entitlements = resolve(repo, 'app/flowix-desktop/entitlements.plist')
  for (const name of ['flowix-cli', 'dsh-host', 'dsh-host-spawn-helper']) {
    const file = join(binaries, `${name}-${host}`)
    if (!existsSync(file)) continue
    const args = ['--force', '--options', 'runtime', '--entitlements', entitlements]
    if (identity !== '-') args.push('--timestamp')
    args.push('--sign', identity, file)
    run('codesign', args)
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}
