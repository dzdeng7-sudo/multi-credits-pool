/**
 * 宿主插件入口：起一个回环的 OpenAI 兼容端点，并把它的地址登记成宿主
 * `llm-pi-ai` 的一个 provider 配置。
 *
 * 不声明 Config schema，也不 import 任何宿主包 —— 与宿主之间只有两样契约：
 * `ctx.get('settings')` 提供的配置服务，以及 settings 里 `llm-pi-ai` 段的
 * provider profile 形状（api/baseURL/headers/models）。进程内不新增任何
 * 模块依赖，插件可以独立在本机跑自测。
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChatProxy } from './proxy.js'
import { createChatUpstream } from './chat-upstream.js'
import { AccountRotator } from './rotation.js'
import { listAccounts, patchAccount, readPins } from './store.js'
import { ensureFresh } from './auth.js'
import { dataDir } from './paths.js'
import { readPluginConfig, peekPluginConfig, visibleModelsOf, writeModelCatalog, LEGACY_PROVIDER_IDS } from './plugin-config.js'
import { fetchModelCatalog } from './model-catalog.js'
import { sweep } from './schedule.js'
import { registerWebApi } from './web-routes.js'
import { isPastUtc8Time } from './protocol.js'
import { checkedInToday } from './store.js'
import { appendUsage } from './usage.js'
import { isReasoningEfforts } from './reasoning.js'
import { recordRuntime } from './runtime-info.js'

export const name = 'llm-multi-credits-pool'

/**
 * 只依赖 `settings`。
 *
 * cordis 对服务访问有硬约束：没声明 inject 就读 `ctx.settings` 会直接抛
 * `cannot get property "settings" without inject`，插件当场初始化失败。
 * 声明成注入依赖后，宿主没提供 settings 时插件挂 pending 而不是报错——但
 * 桌面 App 一定先装好 settings 再加载组合包，这条路径是稳的。
 */
export const inject = ['settings']

/**
 * 启动痕迹：宿主加载本模块、以及调用 apply，各写一行。插件起不来时先看这个
 * 文件——没有 module 行说明包没被导入，有 module 没 apply 说明注入的服务
 * 没就绪，两行都有但没 provider 才是登记环节的问题。
 */
function trace(stage) {
  try {
    mkdirSync(dataDir(), { recursive: true })
    appendFileSync(join(dataDir(), 'boot.log'), `${new Date().toISOString()} ${stage} pid=${process.pid}\n`)
  } catch {
    // 痕迹写不下去不影响插件本身
  }
}

trace('module-loaded')

/**
 * 把宿主自带运行时（node + pnpm）的位置记进数据目录。
 *
 * 命令行的 `update` 要找 pnpm 装新版本，而宿主的 pnpm 只存在于安装目录里、不进 PATH。
 * 宿主跑起来的时候顺手记一份，之后即使宿主已退出，`update` 也能拿它去装。
 */
if (recordRuntime() !== undefined) trace('runtime-recorded')

/** 宿主的 pi-ai 入口固定用这个 settings 命名空间（dsh-base 的补丁里 id 就是它）。 */
export const SETTINGS_NS = 'llm-pi-ai'

function pickLogger(ctx) {
  const candidate = ctx?.logger ?? ctx?.get?.('logger')
  if (candidate && typeof candidate.warn === 'function') return candidate
  return console
}

/**
 * provider profile：形状对齐 llm-pi-ai 的 z.dict(profile) 校验。
 *
 * 对话标识走请求体的 `prompt_cache_key`，不用会话亲和头。宿主只在 openrouter
 * 路由上自动发 `x-client-request-id` 那组头，而 `sendSessionAffinityHeaders`
 * 在 `COMPLETIONS_COMPAT_GATE` 里是 `withhold`——写了就被 `invalid()` 拒绝，
 * 整个 provider 注册失败。能配的只有 `supportsLongCacheRetention`（`offer`）：
 * 配合顶层 `cacheRetention: 'long'`，宿主会把 `prompt_cache_key` 与
 * `prompt_cache_retention: '24h'` 写进请求体，值就是会话 id。
 *
 * `cacheRetention` 缺省是 `short`，那时 body 里不带 `prompt_cache_key`，
 * 「对话固定」会退化成按 LRU 猜测——所以这里必须显式设成 `long`。
 *
 * `retryPolicy` 把欠费类错误码补进可重试列表。宿主默认只重试
 * `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`，
 * 欠费落成 `QUOTA`（deepseek 路由是 `ACCOUNT_QUOTA`）时直接判终态，
 * 任务就停在半路。补进来之后，重试会重新进代理，而代理已把欠费账号
 * 打进 6 小时冷却，于是自然换到下一个账号——上下文由宿主重发，不受影响。
 */

/** 宿主默认重试的五个码，加上欠费相关的两个。 */
export const RETRYABLE_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'QUOTA',
  'ACCOUNT_QUOTA',
]

/**
 * 重试次数：够走完几个账号，又不至于让一个真的空了的池子卡住十几秒。
 * 退避从 500ms 起翻倍，3 次合计约 3.5 秒。
 */
export const RETRY_LIMIT = 3

/**
 * 上游清单的刷新间隔：一天一次。
 *
 * 模型的上下线是上游按周算的节奏，一天一次足够及时；每次刷新只发一个 GET，
 * 不占对话额度。失败不重试——下一个周期自然还会再试一次。
 */
export const CATALOG_REFRESH_MS = 24 * 60 * 60_000

/**
 * 首次刷新的等待时间：启动时先让 provider 正常登记，再在后台补一次清单。
 *
 * 不放在登记前等，是因为网络慢时会把启动拖到十几秒，模型选择器空着更糟：
 * 先用文件里的缓存登记，刷新成功后再重登记一次。
 */
export const CATALOG_FIRST_DELAY_MS = 15_000

export function buildProfile(config, baseUrl) {
  const models = visibleModelsOf(config).map(model => {
    const entry = { id: model.id }
    if (typeof model.name === 'string' && model.name !== '') entry.name = model.name
    if (Number.isInteger(model.maxTokens)) entry.maxTokens = model.maxTokens
    // 推理等级随模型一起登记，模型选择器才会给出这一档下拉。宿主只认
    // `false` 或非空字典，老缓存里没有这个字段就整个不写。
    if (isReasoningEfforts(model.reasoningEfforts)) entry.reasoningEfforts = model.reasoningEfforts
    return entry
  })
  return {
    displayName: config.displayName,
    api: 'openai-completions',
    baseURL: `${baseUrl}/v1`,
    headers: { Authorization: `Bearer ${config.secret}` },
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    cacheRetention: 'long',
    compat: { supportsLongCacheRetention: true },
    retryPolicy: {
      mode: 'normal',
      maxRetries: RETRY_LIMIT,
      retryableCodes: RETRYABLE_CODES,
    },
    models,
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function readSection(settings) {
  try {
    return (typeof settings.get === 'function' ? settings.get(SETTINGS_NS) : undefined) ?? {}
  } catch {
    return {}
  }
}

/**
 * 登记 provider：先试 `mutate`（只动一个叶子节点，不碰其它 provider），
 * 宿主版本不接受这个操作时退回整段 `update`（把现有 providers 合并进去）。
 */
async function updateProvider(settings, providerId, profile) {
  const attempts = []
  if (typeof settings?.mutate === 'function') {
    try {
      await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', providerId], value: profile }])
      return 'mutate'
    } catch (error) {
      attempts.push(`mutate: ${errorText(error)}`)
    }
  }
  if (typeof settings?.update === 'function') {
    try {
      const current = await readSection(settings)
      const providers = { ...(current.providers ?? {}), [providerId]: profile }
      await settings.update(SETTINGS_NS, { ...current, providers })
      return 'update'
    } catch (error) {
      attempts.push(`update: ${errorText(error)}`)
    }
  }
  throw new Error(attempts.length > 0 ? attempts.join('；') : 'settings 服务没有 mutate/update')
}

async function removeProvider(settings, providerId) {
  if (typeof settings?.mutate === 'function') {
    try {
      await settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', providerId] }])
      return
    } catch {
      // 退回整段写
    }
  }
  if (typeof settings?.update !== 'function') return
  const current = await readSection(settings)
  const providers = { ...(current.providers ?? {}) }
  if (!(providerId in providers)) return
  delete providers[providerId]
  await settings.update(SETTINGS_NS, { ...current, providers })
}

/**
 * 插件主函数。异常一律吞掉并记日志：插件起不来时宿主必须照常可用，
 * 用户只是看不到「multi-credits-pool」这一个 provider。
 */
function resolveSettings(ctx) {
  const candidate = ctx?.settings
  return candidate && typeof candidate === 'object' ? candidate : undefined
}

export function apply(ctx) {
  trace('apply-entered')
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = `[multi-credits-pool] 初始化失败：${error instanceof Error ? error.message : String(error)}`
    trace(`apply-failed ${message}`)
    pickLogger(ctx).error?.(message)
    console.error(message)
    return undefined
  }
}

function applyInner(ctx) {
  const logger = pickLogger(ctx)
  const settings = resolveSettings(ctx)

  const config = readPluginConfig()
  const rotator = new AccountRotator({ strategy: config.strategy })
  // 手动固定的对话在重启后要还在：从落盘表里恢复，坏数据按空表处理。
  rotator.restorePins(readPins())

  /**
   * 当前生效的配置：进程启动读的那一份，清单刷新或勾选变更后换成新的。
   *
   * 代理的模型清单、重登记用的 profile、卸载时删的 provider 都从这里取，保证
   * `/v1/models` 与登记出去的那份是同一套模型——两者各读各的时候，盘上的清单
   * 换成了新的、选择器里还是旧的。
   */
  let live = config

  const proxy = createChatProxy({
    accountsOf: () => listAccounts(),
    upstream: createChatUpstream(),
    rotator,
    modelsOf: () => visibleModelsOf(live),
    prepareAccount: account => ensureFresh(account, (id, patch) => patchAccount(id, patch)),
    onUsage: entry => appendUsage(entry),
    onRejected: ({ shape, body, message }) => {
      // 上游的「非法调用」只看得出请求体不对，正文又不能写进日志：形状进 boot.log，
      // 整份请求体落到 rejected.json，事后能拿真身去复现，不用靠猜。
      trace(`chat-rejected shape=${shape} status=400 ${message}`)
      // 同一秒里会有两条被拒请求（宿主换连接头重试），直接覆盖写会互相截断，
      // 写临时文件再改名，落盘的那份永远是完整的一条。
      const target = join(dataDir(), 'rejected.json')
      const draft = `${target}.tmp`
      const record = { at: new Date().toISOString(), shape, message, body }
      writeFileSync(draft, JSON.stringify(record))
      renameSync(draft, target)
    },
    port: config.port,
    secret: config.secret,
    logger,
  })

  let disposed = false
  let autoRunning = false

  /**
   * 进程内自动签到：DSH 开着时到点签一次，启动时补当天。
   *
   * 每分钟看一次开关与签到时刻，用不落盘的 {@link peekPluginConfig} 读配置——设置卡片
   * 改完立刻生效，不需要重启。已经在今天签过的账号由 sweep 自己跳过。
   */
  const autoCheckin = async () => {
    if (disposed || autoRunning) return
    const live = peekPluginConfig()
    if (live.autoCheckin === false) return
    const minuteOfDay = Number.isInteger(live.minuteOfDay) ? live.minuteOfDay : 600
    if (!isPastUtc8Time(minuteOfDay)) return
    const accounts = listAccounts()
    if (accounts.length === 0) return
    if (accounts.every(account => checkedInToday(account.id))) return
    autoRunning = true
    try {
      const stats = await sweep({ minuteOfDay, catchUp: true, quiet: true })
      trace(`auto-checkin ${JSON.stringify(stats)}`)
    } catch (error) {
      logger.warn?.(`[multi-credits-pool] 自动签到失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      autoRunning = false
    }
  }

  const autoTimer = setInterval(() => void autoCheckin(), 60_000)
  if (typeof autoTimer.unref === 'function') autoTimer.unref()
  void autoCheckin()

  /**
   * 策略热更新：设置卡片改完策略立刻生效，不需要重启。
   *
   * 顺带补一次余额读数——「优先过期」和「优先用完一个」要看剩余积分与到期日。
   * 只在设置页打开时才有读数，所以这里顺手按需刷新一次，失败就跳过。
   */
  const syncStrategy = () => {
    const live = peekPluginConfig()
    rotator.setStrategy(live.strategy)
  }
  const strategyTimer = setInterval(syncStrategy, 60_000)
  if (typeof strategyTimer.unref === 'function') strategyTimer.unref()

  /**
   * 刷新上游模型清单：拿一个可用账号的身份去问服务端，把结果写回 plugin.json。
   *
   * 身份只用来过网关的鉴权，与「谁出账」无关；没有账号就直接跳过——连不上上游时
   * 清单保持原样，模型选择器仍是上次那份，不会突然空掉。刷新成功后重新登记 provider，
   * 宿主的模型选择器不用重启就能看到新模型。
   */
  const refreshCatalog = async ({ quiet = false } = {}) => {
    if (disposed) return undefined
    const accounts = listAccounts()
    if (accounts.length === 0) {
      trace('catalog-skipped no-account')
      return undefined
    }
    const region = peekPluginConfig().catalogRegion === 'global' ? 'global' : 'cn'
    const credential = await ensureFresh(accounts[0], (id, patch) => patchAccount(id, patch))
    const models = await fetchModelCatalog(credential, { region })
    if (!Array.isArray(models) || models.length === 0) return undefined
    live = writeModelCatalog(models, { region, nowMs: Date.now() })
    trace(`catalog-refreshed models=${models.length} region=${region}`)
    if (!quiet) {
      logger.info?.(`[multi-credits-pool] 模型清单已更新（${models.length} 个）`)
    }
    // 勾选状态不变的前提下换掉清单，宿主的模型选择器立刻跟着变。
    if (settings) {
      try {
        await updateProvider(settings, live.providerId, buildProfile(live, proxy.baseUrl()))
        trace(`catalog-registered models=${visibleModelsOf(live).length}`)
      } catch (error) {
        logger.warn?.(`[multi-credits-pool] 按新清单重登记 provider 失败：${errorText(error)}`)
      }
    }
    return models
  }

  /** 只跑一次、失败不抛的后台刷新：定时器与启动各调一次。 */
  const refreshCatalogQuietly = async () => {
    try {
      await refreshCatalog({ quiet: true })
    } catch (error) {
      trace(`catalog-failed ${errorText(error)}`)
    }
  }

  const catalogFirstTimer = setTimeout(() => void refreshCatalogQuietly(), CATALOG_FIRST_DELAY_MS)
  if (typeof catalogFirstTimer.unref === 'function') catalogFirstTimer.unref()
  const catalogTimer = setInterval(() => void refreshCatalogQuietly(), CATALOG_REFRESH_MS)
  if (typeof catalogTimer.unref === 'function') catalogTimer.unref()

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], webCtx => {
        registerWebApi(webCtx, {
          accountsOf: () => listAccounts(),
          logger,
          refreshModels: () => refreshCatalog({ quiet: true }),
          onModelsChange: () => {
            // 勾选变了就重登记一次：宿主的模型选择器读的是 provider 里的 models。
            live = readPluginConfig()
            if (settings) void updateProvider(settings, live.providerId, buildProfile(live, proxy.baseUrl()))
              .catch(error => logger.warn?.(`[multi-credits-pool] 重登记 provider 失败：${errorText(error)}`))
          },
          cooldownOf: accountId => rotator.snapshot().cooldownUntil[accountId],
          strategyOf: () => rotator.strategy,
          onStrategyChange: strategy => {
            rotator.setStrategy(strategy)
          },
          rotationState: rows => ({
            strategy: rotator.strategy,
            boundConversations: rotator.snapshot().bindings,
            // 下一次请求会依次尝试的账号。看板据此给第一个打「下一个出账」、
            // 其余的标顺位——用户不用猜现在是谁在出账。
            preview: Array.isArray(rows) ? rotator.order(rows).map(row => row.id) : [],
          }),
          observe: accounts => rotator.observe(accounts),
          balanceSink: (accountId, credits, expireAt) => rotator.noteBalance(accountId, credits, undefined, expireAt),
          pinsOf: () => rotator.listPins(),
          onPinChange: pins => rotator.setPins(pins),
        })
        trace('web-api-registered')
      })
    } catch (error) {
      logger.warn?.(`[multi-credits-pool] 注册 Web 接口失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    clearInterval(autoTimer)
    clearInterval(strategyTimer)
    clearInterval(catalogTimer)
    clearTimeout(catalogFirstTimer)
    if (settings) {
      try {
        await removeProvider(settings, config.providerId)
      } catch (error) {
        logger.warn?.(`[multi-credits-pool] 注销 provider 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await proxy.close()
    } catch (error) {
      logger.warn?.(`[multi-credits-pool] 关闭代理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose())
  else if (typeof ctx.on === 'function') ctx.on('dispose', () => void dispose())

  void proxy.ready
    .then(async () => {
      if (disposed) return
      if (!settings) {
        trace('settings-missing')
        logger.warn?.('[multi-credits-pool] 没有 settings 服务，provider 不会被登记')
        return
      }
      const baseUrl = proxy.baseUrl()
      const how = await updateProvider(settings, config.providerId, buildProfile(config, baseUrl))
      trace(`provider-registered ${config.providerId} via=${how} base=${baseUrl} models=${visibleModelsOf(config).length}`)
      logger.info?.(
        `[multi-credits-pool] provider ${config.providerId} 已登记（${how}），代理 ${baseUrl}，${visibleModelsOf(config).length} 个模型`,
      )
      // 改名前的 provider 条目留在设置里就是一个指向旧端口的死 provider，
      // 每次启动顺手删掉；删不掉也不影响本次启动。
      for (const legacy of LEGACY_PROVIDER_IDS) {
        if (legacy === config.providerId) continue
        try {
          await removeProvider(settings, legacy)
          trace(`provider-legacy-removed ${legacy}`)
        } catch (error) {
          logger.warn?.(`[multi-credits-pool] 清理旧 provider ${legacy} 失败：${errorText(error)}`)
        }
      }
    })
    .catch(error => {
      const message = `[multi-credits-pool] 启动失败：${error instanceof Error ? error.message : String(error)}`
      trace(message)
      logger.error?.(message)
      console.error(message)
    })

  return proxy
}
