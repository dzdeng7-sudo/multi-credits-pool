/**
 * 找到「装包用哪个包管理器」。
 *
 * `update` 要在 profile 里装新版本，宿主编排装包时用的是它自带的 pnpm——那个二进制
 * 躺在安装目录的 `resources/runtime/primary-runtime/dependencies` 里，从来不进 PATH。
 * 所以用户在普通命令行里敲 `multi-credits-pool update` 时，`pnpm` 往往根本不存在，
 * 直接 `spawnSync pnpm ENOENT`。
 *
 * 这里的顺序就是「最可能可用、最不需要用户操心」的顺序：
 *
 *   1. 环境变量显式指定（`MULTI_CREDITS_PNPM`，用户可以指自己的 pnpm 或 .cjs 入口）
 *   2. PATH 上的 `pnpm`
 *   3. 宿主上次启动时记下的自带 pnpm（`<数据目录>/runtime.json`）
 *   4. 在常见安装根目录里扫一遍宿主目录（`…\resources\runtime\primary-runtime\…`）
 *
 * 都找不到就交给调用方退回 `npm`，再不行才报错——报错里写明试过哪些路。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths.js'

export const RUNTIME_FILE_NAME = 'runtime.json'
export const ENV_PNPM = 'MULTI_CREDITS_PNPM'
export const ENV_NODE = 'MULTI_CREDITS_NODE'

/** 宿主运行时相对安装根目录的位置（Electron 的 `resources` 目录下一层）。 */
const RUNTIME_ROOT = join('runtime', 'primary-runtime', 'dependencies')
export const PNPM_RELATIVE = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.cjs')
export const NODE_RELATIVE = join(RUNTIME_ROOT, 'node', 'bin', 'node.exe')

/** 扫描深度与每个目录的孩子数上限：只探安装根下面两层的应用目录，不做全盘搜索。 */
const SCAN_DEPTH = 2
const SCAN_CHILDREN = 60

/**
 * 把「一个可执行的 pnpm」描述成 `{ command, args, from }`。
 *
 * `.cjs`/`.js` 入口必须借 node 跑，宿主自带的 node 就在旁边；找不到就叫 node 从 PATH 来。
 */
function pnpmEntry(pnpmPath, nodePath, from) {
  if (pnpmPath.endsWith('.cjs') || pnpmPath.endsWith('.js')) {
    const command = typeof nodePath === 'string' && nodePath !== '' ? nodePath : 'node'
    return { command, args: [pnpmPath], from }
  }
  return { command: pnpmPath, args: [], from }
}

/** 用户用 `--pnpm` 明确指定的入口；不探活，找不到就让执行本身报错。 */
export function explicitPnpm(path, env = process.env) {
  return pnpmEntry(String(path), env[ENV_NODE], 'flag')
}

/** 某个安装根目录下的自带 pnpm；目录不存在就是没有。 */
function bundledAt(appRoot) {
  const pnpmPath = join(appRoot, 'resources', PNPM_RELATIVE)
  if (!existsSync(pnpmPath)) return undefined
  const nodePath = join(appRoot, 'resources', NODE_RELATIVE)
  return pnpmEntry(pnpmPath, existsSync(nodePath) ? nodePath : undefined, `bundled:${appRoot}`)
}

/** 环境变量指定的那份；`.cjs` 时会顺带读 `MULTI_CREDITS_NODE`。 */
function fromEnv(env) {
  const raw = env[ENV_PNPM]
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return pnpmEntry(raw.trim(), env[ENV_NODE], 'env')
}

/** 宿主上次启动时写下的信息；没有或读坏了都当作没有。 */
export function readRuntime(dirPath = dataDir()) {
  try {
    const parsed = JSON.parse(readFileSync(join(dirPath, RUNTIME_FILE_NAME), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 记下宿主自己的位置，供之后的命令行 `update` 使用。
 *
 * 只有宿主进程里才有 `process.resourcesPath`；插件被当普通模块加载（测试、命令行）
 * 时它不存在，这时什么也不写。
 */
export function recordRuntime(options = {}) {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const execPath = options.execPath ?? process.execPath
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return undefined
  const dirPath = options.dir ?? dataDir()
  const info = {
    at: new Date(typeof options.nowMs === 'number' ? options.nowMs : Date.now()).toISOString(),
    resourcesPath,
    execPath: typeof execPath === 'string' ? execPath : undefined,
    pnpm: existsSync(join(resourcesPath, PNPM_RELATIVE)) ? join(resourcesPath, PNPM_RELATIVE) : undefined,
    node: existsSync(join(resourcesPath, NODE_RELATIVE)) ? join(resourcesPath, NODE_RELATIVE) : undefined,
  }
  try {
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, RUNTIME_FILE_NAME), `${JSON.stringify(info, undefined, 2)}\n`)
    return info
  } catch {
    return undefined
  }
}

/** 记录里的自带 pnpm，转成可执行描述。 */
function fromRecorded(recorded) {
  if (recorded === undefined) return undefined
  if (typeof recorded.pnpm === 'string' && recorded.pnpm !== '') {
    return pnpmEntry(recorded.pnpm, recorded.node, 'recorded')
  }
  if (typeof recorded.resourcesPath === 'string' && recorded.resourcesPath !== '') {
    const appRoot = join(recorded.resourcesPath, '..')
    return bundledAt(appRoot)
  }
  return undefined
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function childDirs(path, limit = SCAN_CHILDREN) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .slice(0, limit)
      .map(entry => join(path, entry.name))
  } catch {
    return []
  }
}

/** 在给定根目录下按 `SCAN_DEPTH` 找带 `resources/runtime/...` 的安装目录。 */
export function scanInstallRoots(roots, depth = SCAN_DEPTH) {
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || !isDirectory(root)) continue
    const direct = bundledAt(root)
    if (direct !== undefined) return direct
    if (depth <= 0) continue
    for (const child of childDirs(root)) {
      const found = scanInstallRoots([child], depth - 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * 常见安装根：用户级 Programs、两个 Program Files、LOCALAPPDATA，最后是各盘根目录。
 *
 * 盘根放最后是因为便携版会装在任意盘（比如整个应用直接在某个盘的根目录下），
 * 而盘根扫描要多看几层；先试前面几个命中率高的，命中就停。
 */
export function defaultRoots(env = process.env, platform = process.platform) {
  const roots = []
  if (platform !== 'win32') return roots
  if (typeof env.LOCALAPPDATA === 'string') roots.push(join(env.LOCALAPPDATA, 'Programs'))
  if (typeof env.ProgramFiles === 'string') roots.push(env.ProgramFiles)
  if (typeof env['ProgramFiles(x86)'] === 'string') roots.push(env['ProgramFiles(x86)'])
  if (typeof env.LOCALAPPDATA === 'string') roots.push(env.LOCALAPPDATA)
  for (const letter of 'CDEFGH') {
    const drive = `${letter}:\\`
    if (existsSync(drive)) roots.push(drive)
  }
  return roots
}

/** 默认探活：真跑一次 `--version`，跑得通才算找到。 */
function probeByVersion(candidate) {
  try {
    const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    return result.status === 0 && String(result.stdout ?? '').trim() !== ''
  } catch {
    return false
  }
}

/**
 * 按顺序试，返回第一个跑得通的 `{ command, args, from }`；全都不可用返回 `undefined`。
 *
 * `probe` 可注入，测试里不需要真起进程。
 */
export function resolvePnpm(options = {}) {
  const env = options.env ?? process.env
  const probe = options.probe ?? probeByVersion
  const tried = []
  const consider = candidate => {
    if (candidate === undefined) return undefined
    const key = `${candidate.command} ${candidate.args.join(' ')}`.trim()
    if (tried.includes(key)) return undefined
    tried.push(key)
    return probe(candidate) ? candidate : undefined
  }

  const explicit = consider(fromEnv(env))
  if (explicit !== undefined) return { ...explicit, tried }

  const onPath = consider({ command: 'pnpm', args: [], from: 'PATH' })
  if (onPath !== undefined) return { ...onPath, tried }

  const recorded = consider(fromRecorded(options.recorded ?? readRuntime(options.dataDir)))
  if (recorded !== undefined) return { ...recorded, tried }

  const scanned = consider(scanInstallRoots(options.roots ?? defaultRoots(env, options.platform)))
  if (scanned !== undefined) return { ...scanned, tried }

  return { tried }
}
