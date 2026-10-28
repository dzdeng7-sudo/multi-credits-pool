#!/usr/bin/env node
/**
 * multi-credits-pool 命令行。
 *
 * 设计原则：一条命令一个动作，全部可脚本化（计划任务、CI、批处理），交互只出现
 * 在需要人授权的那一步。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accountFromLogin,
  beginLogin,
  forgetLogin,
  importAccountFromJson,
  normalizeRegion,
  openExternal,
  pollLogin,
} from '../src/auth.js'
import { checkInAccount } from '../src/checkin.js'
import { dataDir, accountsFile, homeDir, profileName } from '../src/paths.js'
import {
  DEFAULT_CHECKIN_MINUTE,
  runDaemon,
  sweep,
} from '../src/schedule.js'
import {
  installScheduledTask,
  removeScheduledTask,
  TASK_NAME,
  taskExists,
  wrapperExists,
} from '../src/scheduler-task.js'
import { deleteAccount, findAccount, listAccounts, patchAccount, upsertAccount } from '../src/store.js'
import { cmdUpdate, installedInProfile } from '../src/self-update.js'
import {
  collectStatus,
  pendingAccounts,
  renderMarkdown,
  renderTable,
} from '../src/summary.js'
import { stripBom, parseMinuteOfDay, utc8Date } from '../src/protocol.js'

const sleep = ms => new Promise(done => setTimeout(done, ms))

// The version shown in help comes from the manifest, so a release bump only
// touches package.json.
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const HELP = `multi-credits-pool — 多账号 WorkBuddy 签到与积分汇总 v${PACKAGE.version}

用法：multi-credits-pool <命令> [选项]

账号
  login [--global] [--label 备注] [--no-open] [--timeout 秒]
        浏览器设备授权登录，可重复执行，每次追加一个账号
  import <文件.json> [--global] [--label 备注]
        从已有凭据文件导入一个账号
  list [--json]                账号清单
  rename <id|账号名> <新名字>   改显示名
  remove <id|账号名>            删除一个账号

签到
  checkin [--id <id>] [--force] [--quiet]
        给所有账号签到（默认跳过今天已签的；--force 强制重签）
  daemon [--at HH:MM] [--quiet]
        常驻进程，每天定时签到（UTC+8，默认 10:00）

计划任务（DSH 没开也能签）
  schedule-install [--at HH:MM] [--dry-run]
        注册 Windows 计划任务，每天定时跑 checkin
  schedule-status              查看计划任务是否已注册
  schedule-remove              删除计划任务

汇总
  status [--json] [--no-balance]   今日签到 + 每个账号余额
  report [--out 文件.md] [--json]  完整汇总报告

其它
  update [--check] [--to 版本] [--registry URL] [--pnpm 路径] [--dry-run]
        升级到 npm 上的新版本（先完全退出 DSH）；找不到 pnpm 时自动用 npm
  where                        显示数据目录
  help                         本帮助

示例
  multi-credits-pool login --label 主号
  multi-credits-pool login --global --label 国际号
  multi-credits-pool checkin
  multi-credits-pool report --out 汇总.md
  multi-credits-pool update --check
`

/** 极简参数解析：--key value / --key / 位置参数。 */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        index++
      }
    } else {
      positional.push(token)
    }
  }
  return { flags, positional }
}

function formatExpiry(expiresAtMs) {
  if (!expiresAtMs) return '-'
  const days = Math.ceil((expiresAtMs - Date.now()) / 86_400_000)
  return days > 0 ? `${days} 天` : '已过期'
}

function regionLabel(region) {
  return region === 'global' ? '国际' : '国内'
}

async function cmdLogin(flags) {
  const region = normalizeRegion(flags.global ? 'global' : (flags.cn ? 'cn' : 'cn'))
  const timeoutSec = Number(flags.timeout ?? 300)
  const attempt = await beginLogin(region)
  console.log('')
  console.log('请在浏览器里完成授权：')
  console.log(`  ${attempt.authUrl}`)
  console.log('')
  if (!flags['no-open']) openExternal(attempt.authUrl)
  console.log(`等待授权中（最长 ${timeoutSec} 秒）…`)

  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    await sleep(2000)
    const poll = await pollLogin(attempt)
    if (poll.status !== 'complete') continue
    forgetLogin(attempt.state)
    const account = accountFromLogin({
      region: attempt.region,
      tokens: poll.tokens,
      account: poll.account,
      label: typeof flags.label === 'string' ? flags.label : undefined,
    })
    const { account: saved, created } = upsertAccount(account)
    console.log('')
    console.log(`✔ 已${created ? '添加' : '更新'}账号 ${saved.id}  ${saved.label}  [${regionLabel(saved.region)}]${saved.uid ? `  uid=${saved.uid}` : ''}`)
    console.log(`  令牌有效期 ${formatExpiry(saved.expiresAtMs)}；下一步：multi-credits-pool checkin`)
    return 0
  }
  forgetLogin(attempt.state)
  throw new Error(`等待授权超时（${timeoutSec} 秒），账号未添加`)
}

function cmdImport(flags, positional) {
  const file = positional[1]
  if (!file) throw new Error('用法：import <文件.json> [--global] [--label 备注]')
  const raw = JSON.parse(stripBom(readFileSync(resolve(file), 'utf8')))
  const account = importAccountFromJson(raw, {
    region: flags.global ? 'global' : (flags.cn ? 'cn' : (typeof flags.region === 'string' ? flags.region : undefined)),
    label: typeof flags.label === 'string' ? flags.label : undefined,
  })
  const { account: saved, created } = upsertAccount(account)
  console.log(`✔ 已${created ? '导入' : '更新'}账号 ${saved.id}  ${saved.label}  [${regionLabel(saved.region)}]`)
  if (!saved.refreshToken) console.log('  注意：这份凭据没有 refresh token，过期后只能重新导入或登录。')
  return 0
}

function cmdList(flags) {
  const accounts = listAccounts()
  if (flags.json) {
    // 凭据不能进日志或终端回显：只暴露「有没有」，不暴露令牌本身。
    const view = accounts.map(({ accessToken, refreshToken, ...rest }) => ({
      ...rest,
      hasAccessToken: typeof accessToken === 'string' && accessToken !== '',
      hasRefreshToken: typeof refreshToken === 'string' && refreshToken !== '',
    }))
    console.log(JSON.stringify({ dataDir: dataDir(), accounts: view }, null, 2))
    return 0
  }
  if (accounts.length === 0) {
    console.log(`账号库里没有账号。数据目录：${dataDir()}`)
    return 0
  }
  console.log(`数据目录：${dataDir()}`)
  console.log('')
  console.log(['ID'.padEnd(10), '账号'.padEnd(16), '区域'.padEnd(6), '令牌'.padEnd(8), '最近签到'].join('  '))
  console.log('─'.repeat(64))
  for (const account of accounts) {
    const last = account.lastCheckIn?.date ?? '-'
    console.log([
      String(account.id).padEnd(10),
      String(account.label ?? '').slice(0, 16).padEnd(16),
      regionLabel(account.region).padEnd(6),
      formatExpiry(account.expiresAtMs).padEnd(8),
      last,
    ].join('  '))
  }
  return 0
}

function cmdRemove(positional) {
  const target = positional[1]
  if (!target) throw new Error('用法：remove <id|账号名>')
  const account = findAccount(target)
  if (!account) throw new Error(`找不到账号：${target}`)
  deleteAccount(account.id)
  console.log(`✔ 已删除 ${account.id}  ${account.label}`)
  return 0
}

function cmdRename(positional) {
  const [target, name] = positional.slice(1)
  if (!target || !name) throw new Error('用法：rename <id|账号名> <新名字>')
  const account = findAccount(target)
  if (!account) throw new Error(`找不到账号：${target}`)
  patchAccount(account.id, { label: name })
  console.log(`✔ ${account.id} 改名为 ${name}`)
  return 0
}

async function cmdCheckin(flags) {
  if (typeof flags.id === 'string') {
    const account = findAccount(flags.id)
    if (!account) throw new Error(`找不到账号：${flags.id}`)
    const result = await checkInAccount(account)
    const line = `${result.accountId} ${account.label} → ${result.status}${result.amount !== undefined ? ` +${result.amount}` : ''}（${utc8Date()}）`
    if (result.status === 'error') {
      console.error(`✘ ${line}\n  ${result.message}`)
      return 1
    }
    if (!flags.quiet) console.log(`✔ ${line}`)
    return 0
  }
  const stats = await sweep({ force: flags.force === true, quiet: flags.quiet === true })
  if (stats.failed > 0) return 1
  if (flags.quiet && stats.claimed === 0 && stats.already === 0) return 0
  return 0
}

async function cmdStatus(flags) {
  const accounts = listAccounts()
  const status = await collectStatus(accounts, { balance: flags['no-balance'] !== true })
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2))
    return 0
  }
  if (accounts.length === 0) {
    console.log('账号库里没有账号，先运行 login 或 import。')
    return 0
  }
  console.log(renderTable(status))
  return 0
}

async function cmdReport(flags) {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    console.log('账号库里没有账号，先运行 login 或 import。')
    return 0
  }
  const status = await collectStatus(accounts, { balance: true })
  if (flags.json) {
    const text = JSON.stringify(status, null, 2) + '\n'
    if (typeof flags.out === 'string') {
      writeFileSync(resolve(flags.out), text, 'utf8')
      console.log(`✔ 已写入 ${resolve(flags.out)}`)
    } else {
      process.stdout.write(text)
    }
    return 0
  }
  const markdown = renderMarkdown(status)
  if (typeof flags.out === 'string') {
    writeFileSync(resolve(flags.out), markdown, 'utf8')
    console.log(`✔ 已写入 ${resolve(flags.out)}`)
  } else {
    process.stdout.write(markdown)
  }
  return 0
}

async function cmdDaemon(flags) {
  const at = typeof flags.at === 'string' ? flags.at : undefined
  if (at === undefined) {
    const minute = DEFAULT_CHECKIN_MINUTE
    console.log(`默认签到时刻 ${formatMinuteOfDay(minute)}（UTC+8），可用 --at HH:MM 覆盖。`)
  }
  await runDaemon({ at, quiet: flags.quiet === true })
  return 0
}

function formatMinuteOfDay(minuteOfDay) {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`
}

function cmdScheduleInstall(flags) {
  const at = typeof flags.at === 'string' ? flags.at : formatMinuteOfDay(DEFAULT_CHECKIN_MINUTE)
  const minuteOfDay = parseMinuteOfDay(at)
  if (minuteOfDay === undefined) throw new Error(`--at 需要 HH:MM 格式，收到 ${at}`)
  const result = installScheduledTask({
    nodePath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    home: homeDir(),
    profile: profileName(),
    minuteOfDay,
    dryRun: flags['dry-run'] === true,
  })
  if (flags['dry-run']) {
    console.log(`将创建计划任务「${result.taskName}」，每天 ${result.at} 执行：`)
    console.log(`  ${result.command.join(' ')}`)
    console.log('')
    console.log(`${result.wrapper}：`)
    console.log(result.wrapperContent)
    console.log(`${result.script}：`)
    console.log(result.scriptContent)
    return 0
  }
  console.log(`✔ 已注册计划任务「${result.taskName}」：每天 ${result.at}（本机时区）`)
  console.log(`  入口 ${result.wrapper}`)
  console.log(`  脚本 ${result.script}`)
  console.log(`  运行日志 ${result.log}`)
  console.log('  建议先手动跑一次 checkin 确认，再等下一次自动执行。')
  return 0
}

function cmdScheduleStatus() {
  console.log(`计划任务「${TASK_NAME}」：${taskExists() ? '已注册' : '未注册'}`)
  console.log(`包装脚本：${wrapperExists() ? '存在' : '不存在'}`)
  console.log(`数据目录：${dataDir()}`)
  return 0
}

function cmdScheduleRemove() {
  const removed = removeScheduledTask()
  console.log(removed ? `✔ 已删除计划任务「${TASK_NAME}」` : `计划任务「${TASK_NAME}」不存在，未做改动`)
  return 0
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv)
  const command = positional[0] ?? 'help'

  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP)
      return 0
    case 'login':
      return await cmdLogin(flags)
    case 'import':
      return cmdImport(flags, positional)
    case 'list':
      return cmdList(flags)
    case 'remove':
      return cmdRemove(positional)
    case 'rename':
      return cmdRename(positional)
    case 'checkin':
      return await cmdCheckin(flags)
    case 'status':
      return await cmdStatus(flags)
    case 'report':
      return await cmdReport(flags)
    case 'daemon':
      return await cmdDaemon(flags)
    case 'schedule-install':
      return cmdScheduleInstall(flags)
    case 'schedule-status':
      return cmdScheduleStatus()
    case 'schedule-remove':
      return cmdScheduleRemove()
    case 'where':
      console.log(`数据目录：${dataDir()}`)
      console.log(`账号库：  ${accountsFile()}`)
      return 0
    case 'update':
      return await cmdUpdate(flags)
    case 'pending':
      console.log(pendingAccounts(listAccounts()).map(a => a.id).join('\n'))
      return 0
    default:
      process.stderr.write(`未知命令：${command}\n\n${HELP}`)
      return 2
  }
}

main(process.argv.slice(2))
  .then(code => {
    process.exitCode = code
  })
  .catch(error => {
    process.stderr.write(`✘ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
