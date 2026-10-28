/**
 * 命令行 `update`：把自己升级到 npm 上的新版本。
 *
 * 为什么不能在看板里一键升级：插件的 Host 半边跑在宿主进程里，代码已被加载进内存，
 * 文件还被锁着，自己替换自己只会在下次启动时炸掉——甚至中途把代理停在半路。
 * 所以升级分成两步，且必须由宿主的进程离开才能做第一步：
 *
 *   1. 关掉宿主（此时插件文件没有进程占用）
 *   2. 用本文件（`bin/credits.js`）把新版本装回 profile
 *
 * 第二步用的工具就是 profile 自己的包管理器，装法与宿主插件管理器一致
 * （`<profile>/package.json` 的 dependencies + `node_modules`），因此升级后
 * 宿主的插件清单不用改，provider 登记也照旧。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from '../src/paths.js'
import { explicitPnpm, resolvePnpm } from './runtime-info.js'
import { PACKAGE_NAME, REGISTRY_URL, fetchLatestVersion, localVersion, compareVersions } from '../src/update-check.js'

/** 宿主在 profile 里声明的依赖键；先读 package.json，读不到就按包名。 */
export function profileDependencySpec(profileDirPath) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDirPath, 'package.json'), 'utf8'))
    const declared = manifest.dependencies?.[PACKAGE_NAME] ?? manifest.devDependencies?.[PACKAGE_NAME]
    if (typeof declared === 'string' && declared !== '') return declared
  } catch {
    // profile 还没建或不认识这个包：按包名装，包管理器自己会解析成 latest。
  }
  return undefined
}

/**
 * 升级时安装的目标：`<包名>@<版本>`。
 *
 * 指向注册表的包名而不是本地路径，装完 profile 里是一份正常安装的副本，
 * 以后再 `update` 也还是同一条路。
 */
export function installTarget(version, registryUrl) {
  const base = `${PACKAGE_NAME}@${version}`
  return registryUrl === undefined ? base : `${base} --registry ${registryUrl}`
}

/** 装进 profile 的参数：`--dir` 让它落在 profile 自己的 node_modules 里。 */
export function installArgs(version, registryUrl) {
  const args = ['add', `${PACKAGE_NAME}@${version}`, '--dir', profileDir()]
  if (registryUrl !== undefined) args.push('--registry', registryUrl)
  return args
}

/**
 * 退回 npm 时用的参数。
 *
 * profile 是 pnpm 装的，但 npm 对「hoisted 布局 + package.json dependencies」这套
 * 同样能装出可用的 node_modules，所以 pnpm 实在找不到时先用 npm 顶上，
 * 并在输出里说明——比让用户卡在一条报错上强。
 */
export function installArgsNpm(version, registryUrl) {
  const args = ['install', `${PACKAGE_NAME}@${version}`, '--prefix', profileDir(), '--save-exact', '--no-fund', '--no-audit']
  if (registryUrl !== undefined) args.push('--registry', registryUrl)
  return args
}

/** 描述候选工具，报错时好让用户知道试过哪些。 */
function describeTool(tool) {
  return [tool.command, ...tool.args].join(' ')
}

function runTool(tool, args, cwd) {
  execFileSync(tool.command, [...tool.args, ...args], { cwd, stdio: 'inherit', windowsHide: true })
}

/**
 * 挑一个能用的包管理器：先 pnpm（PATH → 宿主自带 → 扫描安装目录），再 npm。
 *
 * 返回 `{ tool, args, fallback }`；都没有时返回 `{ tried }` 交给调用方报错。
 */
export function pickInstaller(version, registryUrl, options = {}) {
  if (typeof options.pnpmPath === 'string' && options.pnpmPath !== '') {
    const tool = explicitPnpm(options.pnpmPath, options.env ?? process.env)
    return { tool, args: installArgs(version, registryUrl), fallback: false }
  }
  const resolved = resolvePnpm(options)
  if (typeof resolved.command === 'string') {
    return { tool: resolved, args: installArgs(version, registryUrl), fallback: false, tried: resolved.tried }
  }
  const npm = options.npmProbe ?? probeNpm
  if (npm()) {
    return { tool: { command: 'npm', args: [], from: 'npm' }, args: installArgsNpm(version, registryUrl), fallback: true, tried: resolved.tried }
  }
  return { tried: resolved.tried }
}

/** npm 探活：默认真跑一次 `npm --version`。 */
export function probeNpm(options = {}) {
  try {
    const result = spawnSync(options.command ?? 'npm', ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    return result.status === 0
  } catch {
    return false
  }
}

export async function cmdUpdate(flags) {
  const profileDirPath = profileDir()
  const current = localVersion()
  const wanted = typeof flags.to === 'string' ? flags.to : undefined
  const registryUrl = typeof flags.registry === 'string' ? flags.registry : undefined
  const pnpmPath = typeof flags.pnpm === 'string' ? flags.pnpm : undefined

  if (flags.check === true) {
    const latest = await fetchLatestVersion({ registryUrl: registryUrl ?? REGISTRY_URL })
    if (latest === undefined) {
      console.log(`✘ 没能从 ${registryUrl ?? REGISTRY_URL} 读到最新版本（网络或注册表不可用）`)
      return 1
    }
    const newer = typeof current === 'string' && compareVersions(latest, current) > 0
    console.log(`当前版本 ${current ?? '未知'}，npm 上是 ${latest}`)
    console.log(newer ? `可以升级：multi-credits-pool update --to ${latest}` : `已是最新版本${latest === current ? '' : '（本机比 npm 还新）'}`)
    return 0
  }

  const latest = wanted ?? (await fetchLatestVersion({ registryUrl: registryUrl ?? REGISTRY_URL }))
  if (latest === undefined) {
    console.log(`✘ 没能从 ${registryUrl ?? REGISTRY_URL} 读到最新版本；可以用 --to <版本号> 直接指定`)
    return 1
  }
  if (typeof current === 'string' && wanted === undefined && compareVersions(latest, current) <= 0) {
    const note = latest === current ? '' : `（本机比 npm 还新）`
    console.log(`已是最新版本 ${current}${note}，没有需要升级的`)
    return 0
  }

  const picked = pickInstaller(latest, registryUrl, { pnpmPath })
  if (picked.tool === undefined) {
    const tried = picked.tried === undefined || picked.tried.length === 0 ? '' : `（试过：${picked.tried.join('；')}）`
    console.log(`✘ 没找到可用的 pnpm 或 npm${tried}`)
    console.log('  最省事的办法：装一个 pnpm —— npm i -g pnpm')
    console.log('  或者用宿主自带的那个：multi-credits-pool update --pnpm "<DSH 安装目录>\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.cjs"')
    console.log('  也可以让宿主（桌面应用）的插件管理器把这个包重新装一次。')
    return 1
  }

  const line = `${describeTool(picked.tool)} ${picked.args.join(' ')}`
  if (flags['dry-run'] === true) {
    console.log(`将执行：${line}`)
    console.log(`  目标 profile：${profileDirPath}`)
    console.log(`  当前版本 ${current ?? '未知'} → ${latest}`)
    console.log('  提醒：宿主必须先完全退出，否则插件文件被占用，装完会留下半新半旧的副本。')
    return 0
  }

  console.log(`升级 ${PACKAGE_NAME}：${current ?? '未知'} → ${latest}`)
  console.log(`  profile：${profileDirPath}`)
  console.log(`  包管理器：${picked.tool.from === 'npm' ? 'npm（没找到 pnpm，退回 npm）' : describeTool(picked.tool)}`)
  console.log('  提醒：如果 DSH 还开着，请先完全退出，装完再启动。')
  try {
    runTool(picked.tool, picked.args, profileDirPath)
  } catch (error) {
    console.log(`✘ 安装失败：${error instanceof Error ? error.message : String(error)}`)
    if (picked.fallback === true) console.log('  可以用 --pnpm <路径> 指定一个 pnpm 再试一次。')
    else console.log('  可以改用宿主自带的 pnpm，或让宿主的插件管理器重新安装一次。')
    return 1
  }
  const installed = localVersion()
  if (typeof installed === 'string' && installed !== latest) {
    console.log(`✘ 装完后的版本是 ${installed}，不是 ${latest}；profile 里可能还指向别处的副本`)
    return 1
  }
  console.log(`✔ 已升级到 ${installed ?? latest}，重启 DSH 生效`)
  return 0
}

/** profile 目录里有没有本包的安装副本：判断「能不能升级」用的。 */
export function installedInProfile(profileDirPath) {
  return existsSync(join(profileDirPath, 'node_modules', PACKAGE_NAME, 'package.json'))
}
