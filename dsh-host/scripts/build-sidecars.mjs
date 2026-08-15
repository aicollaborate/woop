import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const repo = resolve(root, '..')
const vendor = resolve(root, 'vendor/deepseek-harness')
const outdir = resolve(root, 'dist')
const tauriBins = resolve(repo, 'app/flowix-desktop/binaries')
const FLOWIX_RUNTIME_ROOTS = [
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-agent-tool-presentation',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-workflow',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-workflow-worker-thread',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-cordis',
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
await run('corepack', ['pnpm@11.7.0', 'run', 'build:lib:host'], vendor, vendorBuildEnv)
await run(vendorBin('tsx'), [
  'scripts/build-exe-for-python-sdk.ts',
  `--targets=${targets.join(',')}`,
  '--skip-build',
  `--keep-packages=${FLOWIX_RUNTIME_ROOTS.join(',')}`,
  `--launcher=${resolve(outdir, 'dsh-host.cjs')}`,
], vendor, { ...process.env, PATH: `${tooling}:${process.env.PATH ?? ''}` })

for (const target of targets) {
  const platform = targetPlatform(target)
  const arch = targetArch(target)
  const runtime = resolve(vendor, `dist-exe/dsh-jsonrpc-agent-pkg-${platform}-${arch}`)
  if (!existsSync(runtime)) throw new Error(`upstream runtime product is missing: ${runtime}`)
  await stripProduct(runtime, target)
  const output = resolve(outdir, `dsh-host-${platform}-${arch}`)
  await copyFile(runtime, output)
  await chmod(output, 0o755)
  await copyFile(output, resolve(tauriBins, tauriName('dsh-host', target)))
  const helper = `${runtime}-spawn-helper`
  if (existsSync(helper)) {
    await copyFile(helper, resolve(tauriBins, tauriName('dsh-host-spawn-helper', target)))
  }
  await rm(resolve(tauriBins, tauriName('dsh-runtime', target)), { force: true })
  await rm(resolve(tauriBins, tauriName('dsh-runtime-spawn-helper', target)), { force: true })
}

for (const target of targets) {
  await run('bash', [resolve(repo, 'scripts/sign-cli.sh'), `--host=${tauriTriple(target)}`], repo)
}

process.stdout.write(`Flowix DSH sidecars staged in ${tauriBins}\n`)

function hostTarget() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform
  if (!['macos', 'linux'].includes(platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`unsupported DSH sidecar host ${process.platform}-${process.arch}`)
  }
  return `node24-${platform}-${process.arch}`
}

function validateTarget(target) {
  if (!/^node24-(macos|linux)-(x64|arm64)$/.test(target)) {
    throw new Error(`unsupported target ${target}; expected node24-(macos|linux)-(x64|arm64)`)
  }
}

function targetPlatform(target) { return target.split('-')[1] }
function targetArch(target) { return target.split('-')[2] }

function tauriName(name, target) {
  return `${name}-${tauriTriple(target)}`
}

function tauriTriple(target) {
  const platform = targetPlatform(target)
  const arch = targetArch(target)
  return platform === 'macos'
    ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
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
  await run('strip', ['--strip-unneeded', product], repo)
}

async function ensureVendorDevDependencies(env) {
  await run('corepack', ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--prod=false'], vendor, env)
}

async function run(command, args, cwd, env = process.env) {
  process.stdout.write(`> ${basename(command)} ${args.join(' ')}\n`)
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...env, CI: 'true' } })
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  if (code !== 0) throw new Error(`${command} exited with ${String(code)}`)
}
