/**
 * Build the SDK runtime executables and Python node carrier. The fixed
 * `@yao-pkg/pkg --sea` route, deploy flags, and artifact layout are owned by
 * .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.
 * The staged closure is symlink-free, and whole-tree assets cover Cordis's
 * runtime imports that pkg cannot discover statically.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** The closed-runtime app entry inside the deployed closure. */
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js'
const OUTPUT_BASENAME = 'dsh-jsonrpc-agent-pkg'
/** Default Node major; SEA mode requires at least Node 22. */
const DEFAULT_NODE_RANGE = 'node24'
/** Pinned for reproducible builds. */
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
const OUT_DIR = 'dist-exe'
/** Python package destination; created when absent. */
const PYTHON_RUNTIME_DIR = 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'
/** The deployed closure doubles as the node-mode carrier. */
const PYTHON_NODE_SUBDIR = 'node'
/** Legacy deploy may hoist peer-specialized workspace packages back here. */
const DEPLOY_SOURCE_NODE_MODULES = 'python/sdk-runtime/node_modules'
/** Documentation excluded from the generated runtime directory. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see. Package manifests are explicit because bare-name
 * resolution depends on them.
 */
const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * A parsed pkg target triple, constructed from `--targets` or the host.
 */
class Target {
  private constructor(
    /** pkg Node range (`node<major>`). */
    readonly nodeRange: string,
    /**
     * pkg platform tag. Windows is a documented non-goal
     * (.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
     */
    readonly platform: Platform,
    /** pkg CPU tag. */
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one target spec, rejecting malformed triples and unsupported platform or architecture.
   * @param spec - the raw triple, e.g. `node24-linux-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /**
   * Resolve the host-platform default on Node 24.
   * @returns the host target; throws on an unsupported host platform or arch.
   */
  static host(): Target {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
class BuildCli {
  private constructor(
    /** Build targets; defaults to the host platform only. */
    readonly targets: readonly Target[],
    /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
    /** Optional closed subset retained from the generic deployed closure. */
    readonly keepPackages: readonly string[],
    /** Optional CommonJS host launcher used to create a dual-mode executable. */
    readonly launcher: string | undefined,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid or colliding
   * targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-python-sdk: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-python-sdk: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-for-python-sdk: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
      }
      seen.add(key)
    }
    const keepPackages = values['keep-packages']
      ?.split(',')
      .map(value => value.trim())
      .filter(value => value !== '') ?? []
    for (const packageName of keepPackages) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) {
        throw new Error(`build-exe-for-python-sdk: invalid package name in --keep-packages: ${JSON.stringify(packageName)}.`)
      }
    }
    const launcher = values.launcher === undefined ? undefined : resolve(values.launcher)
    if (launcher !== undefined && !existsSync(launcher)) {
      throw new Error(`build-exe-for-python-sdk: launcher does not exist: ${launcher}.`)
    }
    return new BuildCli(
      targets,
      values['skip-build'],
      values['dry-run'],
      [...new Set(keepPackages)],
      launcher,
    )
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'keep-packages': { type: 'string' },
        'launcher': { type: 'string' },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-for-python-sdk.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg targets, e.g. node24-linux-x64,node24-linux-arm64,node24-macos-arm64.',
      '                         Default: the host platform only (on node24).',
      '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --dry-run              print every command and config patch without executing.',
      '  --keep-packages=<p,...> retain only the transitive graph rooted at these deployed packages.',
      '  --launcher=<path>       add a CommonJS host and dispatch it or the runtime from one executable.',
      '  --help                  print this help.',
      '',
      `Build route: ${PKG_SPEC} --sea; see .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.`,
      `Stages the node carrier in ${PYTHON_RUNTIME_DIR}/${PYTHON_NODE_SUBDIR} and writes executables to ${OUT_DIR}/.`,
    ].join('\n')
  }
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Sequential build pipeline. Subprocesses inherit stdio and errors include
 * the command; dry runs print commands and filesystem changes.
 */
class SingleExeBuild {
  /**
   * The cleared deploy target, pkg input, and Python node-mode carrier. The
   * checked-in default `cordis.yml` remains in its parent directory.
   */
  readonly staging = resolve(root, PYTHON_RUNTIME_DIR, PYTHON_NODE_SUBDIR)
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  /** Verify the closure before compiling or packaging. */
  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-python-sdk: skipping pnpm run build (--skip-build)')
      return
    }
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  /** Clear and deploy the runtime closure into the node carrier. */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-python-sdk: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.run('deploy', pnpmBin(), [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      this.staging,
    ])
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
    if (this.cli.dryRun) {
      for (const name of DEPLOY_ONLY_DOCS) console.log(`build-exe-for-python-sdk: [dry-run] rm -f ${join(this.staging, name)}`)
    } else {
      await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(this.staging, name), { force: true })))
    }
  }

  /**
   * Restore direct packages that pnpm's legacy hoister places beside the deploy
   * source instead of in the target. The runtime manifest supplies every peer,
   * so package-local node_modules trees are omitted to preserve one flat Cordis
   * instance and a symlink-free packaged payload.
   */
  private async restoreLegacyHoists(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] restore direct dependencies omitted by legacy deploy')
      return
    }
    const manifestPath = join(this.staging, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const sourceNodeModules = resolve(root, DEPLOY_SOURCE_NODE_MODULES)
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(this.staging, 'node_modules', dependency)
      if (existsSync(destination)) continue
      const source = join(sourceNodeModules, dependency)
      if (!existsSync(source)) {
        throw new Error(
          `build-exe-for-python-sdk: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      restored.push(dependency)
    }
    const stillMissing = Object.keys(manifest.dependencies ?? {})
      .filter(dependency => !existsSync(join(this.staging, 'node_modules', dependency)))
    if (stillMissing.length > 0) {
      throw new Error(`build-exe-for-python-sdk: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
    }
    if (restored.length > 0) {
      console.log(`build-exe-for-python-sdk: restored legacy deploy hoists: ${restored.join(', ')}`)
    }
  }

  /** Replace deploy-time package links with files and reject any remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] materialize staged package links')
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const destination = remaining
      const source = await realpath(destination)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /** Remove packages outside a downstream deployment's closed reachable graph. */
  async pruneStaging(): Promise<void> {
    if (this.cli.keepPackages.length === 0) return
    const nodeModules = join(this.staging, 'node_modules')
    const packages = new Map<string, { directory: string, manifest: PackageManifest }>()
    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const first = join(nodeModules, entry.name)
      if (entry.name.startsWith('@')) {
        for (const child of await readdir(first, { withFileTypes: true })) {
          if (child.isDirectory()) await this.recordPackage(packages, join(first, child.name))
        }
      } else {
        await this.recordPackage(packages, first)
      }
    }

    const keep = new Set<string>()
    const queue = [...this.cli.keepPackages]
    while (queue.length > 0) {
      const packageName = queue.shift()
      if (packageName === undefined || keep.has(packageName)) continue
      const deployed = packages.get(packageName)
      if (deployed === undefined) {
        throw new Error(`build-exe-for-python-sdk: retained package is absent from the deployed closure: ${packageName}.`)
      }
      keep.add(packageName)
      const manifest = deployed.manifest
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }
      for (const dependency of Object.keys(dependencies)) {
        if (manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue
        if (packages.has(dependency) && !keep.has(dependency)) queue.push(dependency)
      }
    }

    const removed: string[] = []
    for (const [packageName, deployed] of packages) {
      if (keep.has(packageName)) continue
      removed.push(packageName)
      if (!this.cli.dryRun) await rm(deployed.directory, { recursive: true, force: true })
    }
    if (!this.cli.dryRun) {
      for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('@')) continue
        const scope = join(nodeModules, entry.name)
        if ((await readdir(scope)).length === 0) await rm(scope, { recursive: true, force: true })
      }
      const manifestPath = join(this.staging, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
      manifest.dependencies = Object.fromEntries(
        Object.entries(manifest.dependencies ?? {}).filter(([packageName]) => keep.has(packageName)),
      )
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    console.log(
      `build-exe-for-python-sdk: retained ${keep.size} packages and removed ${removed.length} packages from the deployed closure`,
    )
  }

  /**
   * Remove dev-only files and non-target native prebuilds from the staged
   * closure before packaging. Source maps and TypeScript declaration files are
   * never loaded at runtime; Windows node-pty prebuilds are useless on the
   * supported macOS/Linux targets (Windows is a non-goal).
   */
  async stripDevOnlyArtifacts(): Promise<void> {
    const nodeModules = join(this.staging, 'node_modules')
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] strip dev-only files and non-target prebuilds')
      return
    }
    let removed = 0
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('win32-') && path.includes(`${sep}prebuilds${sep}`)) {
            await rm(path, { recursive: true, force: true })
            removed += 1
            continue
          }
          await walk(path)
        } else if (entry.name.endsWith('.map') || entry.name.endsWith('.ts')) {
          await rm(path, { force: true })
          removed += 1
        }
      }
    }
    await walk(nodeModules)
    console.log(`build-exe-for-python-sdk: stripped ${removed} dev-only / non-target files`)
  }

  /** Read one deployed package manifest into the pruning index. */
  private async recordPackage(
    packages: Map<string, { directory: string, manifest: PackageManifest }>,
    directory: string,
  ): Promise<void> {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    if (typeof manifest.name === 'string' && manifest.name !== '') {
      packages.set(manifest.name, { directory, manifest })
    }
  }

  /** Return the first symbolic link below a directory, if one exists. */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return path
      if (metadata.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /** Add the executable entry and pkg assets to the staged manifest. */
  async injectPkgConfig(): Promise<void> {
    let bin = ENTRY_BIN
    if (this.cli.launcher !== undefined) {
      const launcherName = 'flowix-host.cjs'
      const dispatcherName = 'flowix-entry.cjs'
      if (this.cli.dryRun) {
        console.log(`build-exe-for-python-sdk: [dry-run] cp ${this.cli.launcher} ${join(this.staging, launcherName)}`)
      } else {
        await copyFile(this.cli.launcher, join(this.staging, launcherName))
        await writeFile(join(this.staging, dispatcherName), [
          "if (process.env.FLOWIX_DSH_RUNTIME_MODE === '1') {",
          "  void import('@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin')",
          '} else {',
          `  require('./${launcherName}')`,
          '}',
          '',
        ].join('\n'))
      }
      bin = dispatcherName
    }
    const patch = {
      bin,
      pkg: {
        assets: ASSET_GLOBS,
        // Cordis loads settings providers from the external YAML at runtime.
        // Keep this provider in pkg's script snapshot so Node's package
        // resolver can execute the dynamic bare import in a SEA executable.
        scripts: ['node_modules/@deepseek-ai/dsh-settings-file/lib/**/*.js'],
      },
    }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-for-python-sdk: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    const entryPath = join(this.staging, ENTRY_BIN)
    if (!existsSync(entryPath)) {
      throw new Error(`build-exe-for-python-sdk: ${entryPath} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    const entrySource = await readFile(entryPath, 'utf8')
    const shebangEnd = entrySource.startsWith('#!') ? entrySource.indexOf('\n') + 1 : 0
    // pnpm deploy may materialize package files as hard links. Unlink the
    // staged entry before patching so the source-plane lib is never changed.
    await rm(entryPath)
    await writeFile(
      entryPath,
      `${entrySource.slice(0, shebangEnd)}process.env.DSH_SETTINGS_MODULE = new URL('../../dsh-settings-file/lib/index.js', import.meta.url).href\nimport '@deepseek-ai/dsh-settings-file'\n${entrySource.slice(shebangEnd)}`,
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`build-exe-for-python-sdk: injected pkg config into ${manifestPath}`)
  }

  /**
   * Package one target; SEA mode accepts one target per invocation.
   * @param target - the pkg target triple to build.
   * @returns the executable path and, on macOS, its helper path.
   */
  async pack(target: Target): Promise<string[]> {
    const product = join(this.outDir, `${OUTPUT_BASENAME}-${target.platform}-${target.arch}`)
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.outDir, { recursive: true })
    await this.run(`pkg ${target.spec}`, pnpmBin(), [
      'dlx',
      PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    if (!this.cli.dryRun && !existsSync(product)) {
      throw new Error(`build-exe-for-python-sdk: product ${product} is missing after the pkg run; inspect ${this.outDir}.`)
    }
    if (target.platform !== 'macos') return [product]
    const spawnHelper = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return [product, spawnHelper]
  }

  /**
   * Put the target node-pty addon in the staged closure. Linux npm installs
   * build it from source, but legacy deploy omits that side-effect directory.
   * @param target - the pkg target whose native addon is being staged.
   */
  private async prepareNativePty(target: Target): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const source = join(root, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    const destination = join(stagedBuild, 'Release', 'pty.node')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = Target.host()
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        'build-exe-for-python-sdk: build the Linux runtime on its target architecture; '
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Print each product path and, outside dry-run mode, its size.
   * @param products - the product paths returned by {@link pack}.
   */
  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-for-python-sdk: [dry-run] would produce:' : 'build-exe-for-python-sdk: products:')
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /**
   * Copy each product into the Python runtime package. The deployed node
   * carrier is already in place, and `dist-exe/` retains upload copies.
   * @param products - the product paths returned by {@link pack}.
   */
  async syncToPythonRuntime(products: string[]): Promise<void> {
    const destDir = resolve(root, PYTHON_RUNTIME_DIR)
    if (this.cli.dryRun) {
      for (const path of products) {
        console.log(`build-exe-for-python-sdk: [dry-run] cp ${path} ${join(destDir, basename(path))}`)
      }
      return
    }
    await mkdir(destDir, { recursive: true })
    for (const path of products) {
      const destination = join(destDir, basename(path))
      await copyFile(path, destination)
      await chmod(destination, statSync(path).mode & 0o777)
      console.log(`build-exe-for-python-sdk: synced ${destination}`)
    }
  }

  /**
   * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
   * include the command; dry runs only print it.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-python-sdk: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-python-sdk: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-python-sdk: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new SingleExeBuild(cli)
  console.log(`build-exe-for-python-sdk: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-python-sdk: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.pruneStaging()
  await pipeline.stripDevOnlyArtifacts()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  pipeline.printProducts(products)
  await pipeline.syncToPythonRuntime(products)
}

await main()
