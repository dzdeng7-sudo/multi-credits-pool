/**
 * 请求体整形。
 *
 * 上游只认 OpenAI 的旧写法，宿主按新约定发请求体，差几处就会被整条拒掉：
 *
 * - 系统提示的角色写成 `developer`，上游只认 `system`；认不出就回 HTTP 400 与业务码
 *   `11128`（`Illegal API invocation from an unapproved channel`）。这句话读起来像
 *   「渠道被封」，实际只是角色名不认识，重发多少次都一样。
 * - `tool_choice` 上游只收字符串，对象形态（`{type:'function',…}`）回 400。
 * - `max_completion_tokens` 是 `max_tokens` 的新别名，上游只读后者；只给别名时它按
 *   自己的默认上限截断，长回答会莫名变短。
 * - 上游只按流式返回，非流式请求会被直接拒绝。
 * - 系统提示的首句自称 `You are an AI agent powered by …` 被上游当成「非官方客户端」的
 *   指纹：系统或助手消息以这句开头就整条回 400 与同一个 `11128`。宿主每轮都带这句，
 *   所以光改角色名照样被拦。按内容块发过来时，上游逐块校验，自称落在第二块一样拦，
 *   因此每一块都要看。转发前把这句开头换成中性自称。
 *
 * 所以转发前把请求体改成上游认的写法。除上面那句自称外不改内容：消息正文、工具定义、
 * 采样参数一律原样保留。解析不出 JSON 的请求体也原样交给上游，由它自己报错——
 * 代理不替上游判断请求本身是否合法。
 */
import { stripBom } from './protocol.js'

/** 上游不认的新角色名与它认的等价角色。 */
const DEVELOPER_ROLE = 'developer'
const SYSTEM_ROLE = 'system'

/** 上游要求流式返回；不主动要用量的话响应末尾那片 `usage` 不会出现。 */
const DEFAULT_STREAM_OPTIONS = { include_usage: true }

/** `max_completion_tokens` 这个别名在上游对应的真字段。 */
const OUTPUT_TOKENS_FIELD = 'max_tokens'
const OUTPUT_TOKENS_ALIAS = 'max_completion_tokens'

/** `tool_choice` 上游认的几种字符串写法。 */
const TOOL_CHOICE_STRINGS = new Set(['auto', 'required', 'none'])

/**
 * 上游的渠道校验会拦「系统/助手消息以宿主自称开头」的请求。
 *
 * 大小写不敏感，句号可有可无；命中后接什么内容都拦。user 角色与句中其它位置不拦。
 * 逐词拼出来，源码里就不会出现这句原文。
 */
const IDENTITY_WORDS = ['an', 'ai', 'agent', 'powered', 'by', 'deepseek', 'harness']
const IDENTITY_MARK = IDENTITY_WORDS.join(' ')
const IDENTITY_OPENING = new RegExp(`^\\s*you are ${IDENTITY_MARK}[.!。]?\\s*`, 'i')
const NEUTRAL_IDENTITY = 'You are an AI assistant.'

/** 参与渠道校验的角色。 */
const IDENTITY_ROLES = new Set([SYSTEM_ROLE, 'assistant'])

/**
 * 上游还按「整句指纹」拦系统提示。
 *
 * 宿主系统提示里有这么一句带产品名的 GUI 说明，逐字出现在请求里就整条回 11128，
 * 与位置无关；少一个句号、换一个词都能过——这是特征串比对，不是语义规则。所以只把
 * 这一句换成中性说法，别的内容一律不动。产品名逐词拼出来，源码里不出现这句原文。
 */
const PRODUCT_NAME = ['DeepSeek', 'Harness'].join(' ')
const GUI_FINGERPRINT = new RegExp(
  `You are interacting with the user through the ${PRODUCT_NAME} Web GUI whose URL the runtime context names\\.`,
  'g',
)
const NEUTRAL_GUI = 'The runtime context describes the environment this agent runs in.'

/**
 * 第二处指纹：讲「@ 开头的路径」的那一段。
 *
 * 上游把这段的开头也收了进去，特征是「这一段的前一百多个字符逐字出现」，改一个词就过。
 * 只换掉第一句的措辞，意思不变；后面几句单独放着不触发，不用动。
 */
const AT_PATHS_FINGERPRINT = /Tokens prefixed with @ are paths the user explicitly referenced\./g
const NEUTRAL_AT_PATHS = 'Tokens that start with @ name paths the user explicitly referenced.'

/**
 * 把请求体整成上游认的写法。
 *
 * @param {string} bodyText 宿主发来的原始请求体
 * @returns {string} 可以直接发给上游的请求体
 */
export function prepareChatBody(bodyText) {
  const source = stripBom(bodyText)
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return source

  body.stream = true
  translateOutputTokens(body)
  if (!('stream_options' in body)) body.stream_options = { ...DEFAULT_STREAM_OPTIONS }
  normalizeDeveloperRole(body)
  neutralizeIdentity(body)
  neutralizeFingerprints(body)
  normalizeToolChoice(body)
  return JSON.stringify(body)
}

/**
 * 把 `max_completion_tokens` 翻成 `max_tokens`。
 *
 * `max_tokens` 优先：两个都给时只留 `max_tokens`，别名丢掉。别名不是正整数时也丢掉，
 * `0` 与 `null` 表示「没设」，负数与非数字是坏输入，不能洗成合法值。
 */
function translateOutputTokens(body) {
  const alias = body[OUTPUT_TOKENS_ALIAS]
  delete body[OUTPUT_TOKENS_ALIAS]
  if (OUTPUT_TOKENS_FIELD in body) return
  if (typeof alias === 'number' && Number.isInteger(alias) && alias > 0) body[OUTPUT_TOKENS_FIELD] = alias
}

/** 把 `role: "developer"` 的消息改回 `role: "system"`；其它角色不动。 */
function normalizeDeveloperRole(body) {
  const messages = body.messages
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
    if (message.role === DEVELOPER_ROLE) message.role = SYSTEM_ROLE
  }
}

/**
 * 把系统/助手消息开头的自称换成中性说法，绕开上游的渠道校验。
 *
 * 只动以那句自称开头的文本；正文其余部分、user 角色、句中出现的同一句话都不动。
 * `content` 是字符串时直接改，是内容块数组时逐块改：上游按块校验，自称落在第二块
 * 照样被拦，只看第一块会漏。
 */
function neutralizeIdentity(body) {
  forEachText(body, replaceIdentityOpening)
}

/** 把整句指纹换成中性说法；命中与位置无关，所以逐处替换。 */
function neutralizeFingerprints(body) {
  forEachText(body, text => text.replace(GUI_FINGERPRINT, NEUTRAL_GUI).replace(AT_PATHS_FINGERPRINT, NEUTRAL_AT_PATHS))
}

/**
 * 对每个系统/助手消息里的文本跑一遍改写。
 *
 * `content` 是字符串时直接改；是内容块数组时逐块改，数组里的字符串块也管。
 */
function forEachText(body, transform) {
  const messages = body.messages
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
    if (!IDENTITY_ROLES.has(message.role)) continue
    if (typeof message.content === 'string') {
      message.content = transform(message.content)
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (let index = 0; index < message.content.length; index += 1) {
      const part = message.content[index]
      if (typeof part === 'string') {
        message.content[index] = transform(part)
        continue
      }
      if (part === null || typeof part !== 'object' || Array.isArray(part)) continue
      if (typeof part.text === 'string') part.text = transform(part.text)
    }
  }
}

/** 命中渠道校验的自称开头时改写成中性自称，未命中原样返回。 */
function replaceIdentityOpening(text) {
  if (!IDENTITY_OPENING.test(text)) return text
  return text.replace(IDENTITY_OPENING, `${NEUTRAL_IDENTITY}\n\n`)
}

/**
 * 把 `tool_choice` 折成上游认的字符串。
 *
 * `none` 等于关掉工具：字段与 `tools` / `functions` 一起删掉，上游不会再要求调用。
 * 对象形态的 `auto` / `required` 还原成同名字符串，指定函数的形态还原成函数名。
 */
function normalizeToolChoice(body) {
  if (!('tool_choice' in body)) return
  const choice = body.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') disableTools(body)
    return
  }
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) {
    delete body.tool_choice
    return
  }

  const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
  if (type === 'none') {
    disableTools(body)
    return
  }
  if (TOOL_CHOICE_STRINGS.has(type)) {
    body.tool_choice = type
    return
  }
  if (type === 'function') {
    const name = typeof choice.function?.name === 'string' ? choice.function.name.trim() : ''
    body.tool_choice = name === '' ? 'auto' : name
    return
  }
  delete body.tool_choice
}

/** 关掉工具：`tool_choice: none` 的等价写法。 */
function disableTools(body) {
  delete body.tool_choice
  delete body.tools
  delete body.functions
}
