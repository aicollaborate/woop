import { spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const vendor = resolve(root, 'vendor/deepseek-harness')
const child = spawn('corepack', [
  'pnpm@11.7.0', 'exec', 'tsx', 'scripts/build-exe-for-python-sdk.ts', '--skip-build',
], { cwd: vendor, stdio: 'inherit' })
const code = await new Promise(resolveExit => child.once('exit', resolveExit))
if (code !== 0) throw new Error(`DeepSeek Harness runtime build failed with exit code ${String(code)}`)

const platform = process.platform === 'darwin' ? 'macos' : process.platform
const upstream = resolve(vendor, `dist-exe/dsh-jsonrpc-agent-pkg-${platform}-${process.arch}`)
const outdir = resolve(root, 'dist')
await mkdir(outdir, { recursive: true })
await copyFile(upstream, resolve(outdir, process.platform === 'win32' ? 'dsh-runtime.exe' : 'dsh-runtime'))
