import { chmod, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outdir = resolve(root, 'dist')
await mkdir(outdir, { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(outdir, 'dsh-host.cjs'),
  bundle: true,
  platform: 'node',
  // @yao-pkg/pkg's SEA bootstrap evaluates its entry as CommonJS.
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  loader: { '.yml': 'text' },
  tsconfig: resolve(root, 'tsconfig.build.json'),
})
await chmod(resolve(outdir, 'dsh-host.cjs'), 0o755)
process.stdout.write(`built ${resolve(outdir, 'dsh-host.cjs')}\n`)
