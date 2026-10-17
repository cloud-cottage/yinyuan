/**
 * ApiKey 鉴权（印源对外只读 API v1）。
 *
 * ★ 两条通道（**env 在前，DB 在后**）：
 *   ① **机构钥匙（第一通道，向后兼容）**：密钥唯一来源＝进程环境变量 `YINYUAN_API_KEY`。
 *      请求头接受两种写法：`Authorization: ApiKey …` 与 `X-API-Key: …`（取值相同，前者优先）。
 *      —— 命中即放行，**不触云库**（现网调用方的延迟与行为零变化）。
 *   ② **客户钥匙（第二通道，2026-10-17 方案 B）**：`yinyuan_api_keys` 里按
 *      `sha256(明文)` 查行、只认 `status:'active'`（见 `apiKeys.js`）。env 未命中时才会走到。
 *
 * ★ 两条通道任一生效即通行；返回值带身份上下文 `{ ok:true, via:'env'|'key', userId?, keyId? }`。
 *
 * ★ **两个入口，别混用**：
 *   - `checkApiKey(req)`        —— **同步、只认 env**（保留作回滚面与既有自检）。
 *   - `checkApiKeyAsync(req, …)` —— **异步、双通道**（`handler.js` 与所有新端点用这个）。
 *
 *   ⚠ 对 `handler.js` 的影响面（**B2 已接线，2026-10-18**）：`handler.js` 现为
 *     `const authResult = await checkApiKeyAsync(req, authOptions)`。
 *     影响面：① 该行必须 `await`（漏 await ⇒ `authResult.ok` 为 `undefined` ⇒ 四个数据端点全部变空响应）；
 *     ② DB 通道命中的请求多一次云库读（几十毫秒；限流计数与实例缓存都在鉴权之后，顺序不变）；
 *     ③ env 通道仍在任何 await 之前返回，机构钥匙延迟不变。
 *     风险：云库不可用时客户 key 全拒（fail-closed）；回滚：把该行改回 `checkApiKey(req)`
 *     （同步入口一直保留）。
 *
 * ★ **账号停用即时失效（B2）**：`checkKeyOwner(userId, options)` 复核 key 的归属账号
 *   `status === 'active'`。数据端点（`handler.js`）在客户钥匙命中后调用它 —— 停用账号的
 *   key **立即 401**，不等令牌/缓存过期。env 机构钥匙不触库、不走这条复核。
 *
 * ★ 失败形态（`{ok:false, status, reason}`，由 handler 统一落码）：
 *   - 同步入口：未配置 env ⇒ 503 NOT_CONFIGURED（含请求带了任意 key）；key 缺失/不匹配 ⇒ 401
 *   - 异步入口：缺凭据 ⇒ 401；env 与 DB 都不认 ⇒ 401；
 *     **env 未配置且 DB 查询不可用 ⇒ 503（fail-closed）**；env 已配置但 DB 查询不可用 ⇒ 401
 *     （不向探测者泄漏服务端状态）
 *   —— 任何情况下都不回落假数据/静态快照，也不回显调用方提交的 key。
 */
import { timingSafeEqual } from 'node:crypto'
import { touch, verifyKey } from './apiKeys.js'
import { findById as findUserById } from './users.js'

export const API_KEY_ENV = 'YINYUAN_API_KEY'

/** 身份来源（进鉴权结果的 `via` 字段）。 */
export const AUTH_VIA = Object.freeze({
  ENV: 'env',
  KEY: 'key'
})

/** 大小写无关地读请求头（Vercel 侧通常已小写化，这里两种都认）。 */
function readHeader(req, name) {
  const headers = (req && req.headers) || {}
  let value = headers[name]
  if (value === undefined) value = headers[name.toLowerCase()]
  if (Array.isArray(value)) value = value[0]
  return value
}

/** 从请求头提取调用方提交的 key；取不到返回 ''（**不回显**调用方原值）。 */
export function extractApiKey(req) {
  const authz = readHeader(req, 'authorization')
  if (typeof authz === 'string') {
    const m = /^\s*ApiKey\s+(\S+)\s*$/i.exec(authz)
    if (m) return m[1]
  }
  const headerKey = readHeader(req, 'x-api-key')
  if (typeof headerKey === 'string' && headerKey.trim() !== '') return headerKey.trim()
  return ''
}

/** 服务端是否已配置对外密钥。 */
export function isApiKeyConfigured() {
  return typeof process.env[API_KEY_ENV] === 'string' && process.env[API_KEY_ENV].trim() !== ''
}

/** 定长比较，避免用 `===` 泄露长度/前缀信息。 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 鉴权总判（**同步 · 仅 env 通道**；现网 `handler.js` 的既有调用面，语义逐字不变）。
 * 新代码请用 `checkApiKeyAsync`。
 * @returns {{ok:true, via:'env'}|{ok:false, status:number, reason:string}}
 */
export function checkApiKey(req) {
  if (!isApiKeyConfigured()) {
    return { ok: false, status: 503, reason: 'NOT_CONFIGURED' }
  }
  const provided = extractApiKey(req)
  if (provided === '' || !safeEqual(provided, process.env[API_KEY_ENV])) {
    return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
  }
  return { ok: true, via: AUTH_VIA.ENV }
}

/** 惰性取云库句柄（**动态 import**：不连云库的环境不加载 SDK，自检脚本也不受影响）。 */
async function defaultDb() {
  const { getDb } = await import('./cloudbase.js')
  return getDb()
}

/**
 * 鉴权总判（**异步 · 双通道**：env 优先，未命中才查 DB key）。
 *
 * @param {object} req 请求对象（只读 `authorization` / `x-api-key` 头）
 * @param {{db?:object, track?:boolean, now?:number|string|Date}} [options]
 *        db    注入式数据层（自检/测试用；缺省走 CloudBase）
 *        track 是否在 DB 通道命中后异步记一次使用（默认 true；测试可关）
 *        now   计入 `last_used_at` 的时刻（默认现在）
 * @returns {Promise<{ok:true, via:'env'|'key', userId?:string, keyId?:string}
 *                   |{ok:false, status:number, reason:string}>}
 */
export async function checkApiKeyAsync(req, options = {}) {
  const provided = extractApiKey(req)
  const envConfigured = isApiKeyConfigured()

  // ★ 第一通道：机构钥匙（同步、无 await ⇒ 现网调用方延迟不变）
  if (envConfigured && provided !== '' && safeEqual(provided, process.env[API_KEY_ENV])) {
    return { ok: true, via: AUTH_VIA.ENV }
  }

  // 缺凭据 ⇒ 调用方错误（503 只留给「没有任何可用鉴权通道」）
  if (provided === '') {
    return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
  }

  // ★ 第二通道：客户钥匙（只在此处触云库）
  let db = options.db || null
  let lookup = null
  try {
    if (!db) db = await defaultDb()
    lookup = await verifyKey(db, provided)
  } catch (error) {
    const name = (error && error.name) || 'Error'
    console.error(`[api] auth key-lookup unavailable error=${name} code=${(error && error.code) || '-'}`)
    lookup = { ok: false, reason: 'STORAGE_UNAVAILABLE' }
  }

  if (lookup && lookup.ok === true) {
    if (options.track !== false && db && lookup.keyId) {
      // 使用计数不参与鉴权判定 ⇒ 不阻塞主路径、失败也不影响本次请求
      void touch(db, lookup.keyId, { now: options.now }).catch(() => {})
    }
    return {
      ok: true,
      via: AUTH_VIA.KEY,
      userId: lookup.userId,
      keyId: lookup.keyId || undefined
    }
  }

  const detail = (lookup && lookup.reason) || 'STORAGE_UNAVAILABLE'
  // 只记判别码（**不含 key、不含摘要**）；对外仍是 UNAUTHORIZED
  console.warn(`[api] auth key-lookup rejected reason=${detail}`)
  if (detail === 'STORAGE_UNAVAILABLE' && !envConfigured) {
    // 无 env 可用、DB 又查不了 ⇒ 没有任何可用通道：fail-closed 且如实告知服务未就绪
    return { ok: false, status: 503, reason: 'NOT_CONFIGURED' }
  }
  return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
}

/**
 * ★ 客户 key 的**归属账号状态复核**（B2 安全硬要求：停用账号 ⇒ 其 API Key 立即失效）。
 *
 * 为什么不在 `verifyKey` 里做：`apiKeys.js` 是纯 key 存储模块（不该知道账号表）；
 * 也不在 `checkApiKeyAsync` 里默认做：那会把既有自检里「先停用账号、后验 key」的
 * 存储层断言翻掉，且隐式多一次读、调用方无从选择。⇒ 独立入口，由**数据端点**显式调用：
 * `handler.js` 在 `authResult.via === 'key'` 时调用本函数（env 机构钥匙零额外开销）。
 *
 * @param {string} userId key 行的 `user_id`
 * @param {{db?:object}} [options] 注入式数据层（自检/测试用；缺省走 CloudBase）
 * @returns {Promise<{ok:true, user:object}|{ok:false, status:number, reason:string}>}
 *   - 账号 `status !== 'active'` / 找不到账号 ⇒ 401 UNAUTHORIZED（**不泄漏停用事实**）
 *   - 存储不可用 ⇒ env 已配置时 401（不报告服务端状态），env 未配置时 503（fail-closed）
 */
export async function checkKeyOwner(userId, options = {}) {
  if (typeof userId !== 'string' || userId === '') {
    return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
  }
  let db = options.db || null
  let found = null
  try {
    if (!db) db = await defaultDb()
    found = await findUserById(db, userId)
  } catch (error) {
    const name = (error && error.name) || 'Error'
    console.error(`[api] auth key-owner lookup unavailable error=${name} code=${(error && error.code) || '-'}`)
    found = { ok: false, reason: 'STORAGE_UNAVAILABLE' }
  }

  if (!found || found.ok !== true) {
    // 复核不了就**不放行**；对外形态与「判据不可用」的既有口径一致（详见 checkApiKeyAsync）
    const envConfigured = isApiKeyConfigured()
    return envConfigured
      ? { ok: false, status: 401, reason: 'UNAUTHORIZED' }
      : { ok: false, status: 503, reason: 'NOT_CONFIGURED' }
  }
  if (!found.user) {
    // 孤儿 key（key 行在、账号行不在）：等同无效凭据
    console.warn('[api] auth key-owner rejected reason=OWNER_MISSING')
    return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
  }
  if (String(found.user.status || '') !== 'active') {
    console.warn('[api] auth key-owner rejected reason=ACCOUNT_DISABLED')
    return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
  }
  return { ok: true, user: found.user }
}
