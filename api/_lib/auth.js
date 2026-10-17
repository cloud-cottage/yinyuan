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
 *   - `checkApiKey(req)`        —— **同步、只认 env**（现网 `handler.js` 正在用；本单不改它）。
 *   - `checkApiKeyAsync(req, …)` —— **异步、双通道**（新路由/新端点用这个）。
 *
 *   ⚠ 对 `handler.js` 的影响面（**本单刻意不改**）：`handler.js:63` 是
 *     `const authResult = checkApiKey(req)` 的**同步**用法。若把 `checkApiKey` 直接改成 async，
 *     该处会拿到 Promise ⇒ `authResult.ok` 为 `undefined` ⇒ 落到
 *     `failWith(res, undefined, undefined)` ⇒ 现网四个数据端点**全部变成无状态码的空响应**，
 *     等于破坏对外契约。⇒ 正确做法是**另起 async 入口**（本文件已提供），由路由单把
 *     `handler.js` 那一行改成 `const authResult = await checkApiKeyAsync(req)`。
 *     影响面：① 该行必须加 `await`；② DB 通道命中的请求多一次云库读（几十毫秒；实例缓存与
 *     限流计数都在鉴权之后，顺序不变）；③ env 通道仍在任何 await 之前返回，机构钥匙延迟不变。
 *     风险：云库不可用时客户 key 全拒（fail-closed）；回滚：把该行改回 `checkApiKey(req)`
 *     （同步入口一直保留）。
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
