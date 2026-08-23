import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, delimiter, resolve } from 'node:path'

await import('./ensure-upstream.mjs')

const root = resolve(import.meta.dirname, '..')
const repo = resolve(root, '..')
const vendor = resolve(root, 'vendor/deepseek-harness')
const outdir = resolve(repo, '.build/flowix-dsh-host')
const tauriBins = resolve(repo, 'app/flowix-desktop/binaries')
// Keep only true entry points. The official dsh CLI/base manifests own the
// core and preset dependency graph; repeating every transitive package here
// would make each upstream roster change a Flowix maintenance task.
const FLOWIX_RUNTIME_ROOTS = [
  // dsh-base is a shipped profile bundle rather than a dependency of the
  // JSON-RPC entry point. Keep it explicitly so its cordis.patch.yml survives
  // the closed-graph prune and is available during runtime profile boot.
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh',
  // Flowix inserts these two independently of the official base roster.
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-mcp-client',
]

const requested = process.argv.filter(argument => argument.startsWith('--targets='))[0]?.slice('--targets='.length)
const targets = (requested ?? hostTarget()).split(',').filter(Boolean)
for (const target of targets) validateTarget(target)

await run('node', [resolve(root, 'scripts/build-host.mjs')], root)
await mkdir(outdir, { recursive: true })
await mkdir(tauriBins, { recursive: true })

const tooling = resolve(root, 'scripts/tooling')
const vendorBuildEnv = { ...process.env, NODE_ENV: 'development' }
await ensureVendorDevDependencies(vendorBuildEnv)
await run(corepackCommand(), ['pnpm@11.7.0', 'run', 'build:lib:host'], vendor, vendorBuildEnv)

// FLOWIX: a single pkg invocation with --launcher produces a dual-mode SEA.
// The dispatcher in scripts/build-exe-for-python-sdk.ts loads the CJS launcher
// by default and the vendored ESM packaged-bin entry when launched with
// DSH_EMBEDDED_RUNTIME_MODE=1. Both roles share one Node carrier, one V8 heap,
// and one copy of every shared dependency, so this halves the sidecar payload
// that the NSIS installer has to compress.
await run(vendorBin('tsx'), [
  'scripts/build-exe-for-python-sdk.ts',
  `--targets=${targets.join(',')}`,
  '--skip-build',
  `--keep-packages=${FLOWIX_RUNTIME_ROOTS.join(',')}`,
  `--launcher=${resolve(outdir, 'dsh-host.cjs')}`,
], vendor, { ...process.env, PATH: `${tooling}${delimiter}${process.env.PATH ?? ''}` })


// Single product per target. Stage it to both the .build mirror and the
// Tauri binaries dir under the dsh-host name; the host binary becomes the
// runtime when the host launches it with DSH_EMBEDDED_RUNTIME_MODE=1.
for (const target of targets) {
  const platform = targetPlatform(target)
  const arch = targetArch(target)
  const upstream = resolve(vendor, `dist-exe/dsh-jsonrpc-agent-pkg-${platform}-${arch}${productExtension(target)}`)
  if (!existsSync(upstream)) throw new Error(`upstream product is missing: ${upstream}`)

  await stripProduct(upstream, target)
  const hostOut = resolve(outdir, `dsh-host-${platform}-${arch}`)
  await copyFile(upstream, hostOut)
  await chmod(hostOut, 0o755)
  await copyFile(hostOut, resolve(tauriBins, tauriName('dsh-host', target)))
  const hostHelper = `${upstream}-spawn-helper`
  if (existsSync(hostHelper)) {
    // Keep the helper in the DSH release staging area. It is part of the
    // independently downloaded DSH archive, never a Flowix Tauri sidecar.
    await copyFile(
      hostHelper,
      resolve(outdir, `dsh-host-spawn-helper-${platform}-${arch}${productExtension(target)}`),
    )
    // Preserve the legacy staging copy for the standalone sidecar E2E and
    // signing scripts. Tauri no longer lists any dsh-host externalBin.
    await copyFile(hostHelper, resolve(tauriBins, tauriName('dsh-host-spawn-helper', target)))
  } else {
    await rm(resolve(outdir, `dsh-host-spawn-helper-${platform}-${arch}${productExtension(target)}`), { force: true })
    await rm(resolve(tauriBins, tauriName('dsh-host-spawn-helper', target)), { force: true })
  }

  // A stale dsh-runtime sidecar would shadow the dual-mode host at startup.
  // Wipe any prior install artifact so a downgrade cannot resurrect it.
  await rm(resolve(tauriBins, tauriName('dsh-runtime', target)), { force: true })
  await rm(resolve(tauriBins, tauriName('dsh-runtime-spawn-helper', target)), { force: true })
}
// Clean the staging aliases so a re-run does not double up.
for (const target of targets) {
  const platform = targetPlatform(target)
  const arch = targetArch(target)
  await rm(resolve(vendor, `dist-exe/.flowix-host-sea-${platform}-${arch}`), { force: true })
  await rm(resolve(vendor, `dist-exe/.flowix-host-sea-${platform}-${arch}-spawn-helper`), { force: true })
}

for (const target of targets) {
  await run('bash', [resolve(repo, 'scripts/sign-cli.sh'), `--host=${tauriTriple(target)}`], repo)
}

process.stdout.write(`Flowix DSH sidecars staged in ${tauriBins}\n`)

function hostTarget() {
  const platform = process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform
  if (!['macos', 'linux', 'windows'].includes(platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`unsupported DSH sidecar host ${process.platform}-${process.arch}`)
  }
  return `node24-${platform}-${process.arch}`
}

function validateTarget(target) {
  if (!/^node24-(macos|linux|windows)-(x64|arm64)$/.test(target)) {
    throw new Error(`unsupported target ${target}; expected node24-(macos|linux|windows)-(x64|arm64)`)
  }
}

function targetPlatform(target) { return target.split('-')[1] }
function targetArch(target) { return target.split('-')[2] }

function tauriName(name, target) {
  return `${name}-${tauriTriple(target)}${productExtension(target)}`
}

function productExtension(target) {
  return targetPlatform(target) === 'windows' ? '.exe' : ''
}

function tauriTriple(target) {
  const platform = targetPlatform(target)
  const arch = targetArch(target)
  if (platform === 'macos') {
    return `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  }
  if (platform === 'windows') {
    return `x86_64-pc-windows-msvc`
  }
  return `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
}

function vendorBin(name) {
  return resolve(vendor, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name)
}

async function stripProduct(product, target) {
  if (process.env.FLOWIX_DSH_STRIP === '0') return
  if (targetPlatform(target) === 'macos') {
    await run('strip', ['-x', product], repo)
    await run('codesign', ['--force', '--sign', '-', product], repo)
    return
  }
  if (targetPlatform(target) === 'windows') {
    // Windows executables ship unstripped; the Tauri installer step performs signing.
    return
  }
  await run('strip', ['--strip-unneeded', product], repo)
}

async function ensureVendorDevDependencies(env) {
  await run(corepackCommand(), ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--prod=false'], vendor, env)
}

function corepackCommand() {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

async function run(command, args, cwd, env = process.env) {
  process.stdout.write(`> ${basename(command)} ${args.join(' ')}\n`)
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...env, CI: 'true' },
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  })
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  if (code !== 0) throw new Error(`${command} exited with ${String(code)}`)
}
