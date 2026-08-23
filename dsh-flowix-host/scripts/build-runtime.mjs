import { spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

await import('./ensure-upstream.mjs')

const root = resolve(import.meta.dirname, '..')
const repo = resolve(root, '..')
const vendor = resolve(root, 'vendor/deepseek-harness')
const tooling = resolve(root, 'scripts/tooling')
const child = spawn('corepack', [
  'pnpm@11.7.0', 'exec', 'tsx', 'scripts/build-exe-for-python-sdk.ts', '--skip-build',
], {
  cwd: vendor,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true', PATH: `${tooling}:${process.env.PATH ?? ''}` },
})
const code = await new Promise(resolveExit => child.once('exit', resolveExit))
if (code !== 0) throw new Error(`DeepSeek Harness runtime build failed with exit code ${String(code)}`)

const platform = process.platform === 'darwin' ? 'macos' : process.platform
const upstream = resolve(vendor, `dist-exe/dsh-jsonrpc-agent-pkg-${platform}-${process.arch}`)
const outdir = resolve(repo, '.build/flowix-dsh-host')
await mkdir(outdir, { recursive: true })
await copyFile(upstream, resolve(outdir, process.platform === 'win32' ? 'dsh-runtime.exe' : 'dsh-runtime'))
