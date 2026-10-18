/**
 * ============================================================================
 * API Key 适配层（B3）—— `/api/v1/keys` 五面的前端唯一实现
 *
 * 端点（逐字，B2 已上线）：
 *   GET    /api/v1/keys                  200 `{ok:true, items:[{id,prefix,label,status,created_at,last_used_at,call_count}]}`
 *   POST   /api/v1/keys                  201 `{ok:true, key:{id,prefix,label,plain}}`（`plain` **只此一次**）
 *   POST   /api/v1/keys/{kid}/rotate     201 同铸造形（先铸新、后撤旧）
 *   PATCH  /api/v1/keys/{kid}            200 `{ok:true, key:{...不含 plain}}`（体 `{status:'active'|'revoked'}`）
 *   DELETE /api/v1/keys/{kid}            200 `{ok:true}`（**逻辑撤销**，不物理删行）
 *
 * 本层职责（只此三件，不多做）：
 *   ① 把服务端 `snake_case` 投影映射成适配层 `ApiKey` 形状（`id`→`kid`、`created_at`→`createdAt` 等）；
 *   ② 把服务端状态值 `active|revoked` 映射成契约枚举 `ACTIVE|DISABLED`（`contract.API_KEY_STATUS`），
 *      使 mock / api 两种实现下页面只有一条渲染路径；
 *   ③ 把铸造 / 轮换响应里的 `plain` **原样改名**为 `plaintextOnce` 交给页面 —— **不落存储、不写日志、
 *      不再放进任何后续请求**（页面关闭弹层即丢弃）。
 *
 * 不造字段：后端没有 `env` / `scopes` / `ipAllowlist` ⇒ 本层不编造（缺就是没有，页面不展示）。
 * ============================================================================
 */
import { request } from './auth.js'

/** 服务端状态字面量（逐字，写进 PATCH 体）。 */
export const KEY_STATUS_RAW = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked' })

/** 契约枚举 `API_KEY_STATUS` 与服务端状态字的双向映射（页面只认枚举）。 */
const ENUM_BY_RAW = Object.freeze({ active: 'ACTIVE', revoked: 'DISABLED' })
const RAW_BY_ENUM = Object.freeze({ ACTIVE: 'active', DISABLED: 'revoked' })

/** 状态入参归一：枚举 / 原生字都收，非法值原样透传（由服务端判 400，本层不猜）。 */
export function rawStatusOf(status) {
  const value = String(status === undefined || status === null ? '' : status).trim()
  if (RAW_BY_ENUM[value.toUpperCase()]) return RAW_BY_ENUM[value.toUpperCase()]
  return value.toLowerCase()
}

/** kid → 路径段（**必须编码**：服务端 kid 可能含 `/` 等字符，裸拼会打错端点）。 */
export function keyPath(kid) {
  return `/keys/${encodeURIComponent(String(kid))}`
}

/**
 * 服务端密钥投影 → 适配层 `ApiKey` 形状。
 * 列表投影与变更投影同形（7 字段）；铸造 / 轮换投影另带 `plain`（本函数不消费）。
 */
export function normalizeKey(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id || raw.kid || null
  return {
    kid: id,
    id,
    /** 服务端只下发前缀（`prefix`）：页面按「前缀 + 省略号」展示，前端不拼装任何完整密钥。 */
    prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
    label: typeof raw.label === 'string' ? raw.label : '',
    status: ENUM_BY_RAW[raw.status] || String(raw.status || '').toUpperCase(),
    statusRaw: raw.status || null,
    createdAt: raw.created_at || raw.createdAt || null,
    lastUsedAt: raw.last_used_at || raw.lastUsedAt || null,
    callCount: Number.isFinite(Number(raw.call_count ?? raw.callCount))
      ? Number(raw.call_count ?? raw.callCount)
      : 0,
  }
}

/** A5 —— 列表（**无明文**）。返回裸数组（与 mock 实现一致）。 */
export async function list(options = {}) {
  const { payload } = await request('/keys', { method: 'GET', authed: true, ...options })
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.map(normalizeKey).filter(Boolean)
}

/**
 * A6 —— 新建（`plain` 只在本次响应里存在一次）。
 * @param {{label?:string, ttl?:number}} input
 *   `ttl` 为有效期秒数（服务端 60 ~ 365 天，缺省不过期）；页面当前不暴露该字段，
 *   但透传能力保留给后续（不传即不过期，服务端口径）。
 */
export async function create(input = {}) {
  const body = {}
  if (typeof input.label === 'string' && input.label.trim() !== '') body.label = input.label.trim()
  if (Number.isFinite(Number(input.ttl)) && Number(input.ttl) > 0) body.ttl = Math.floor(Number(input.ttl))
  const { payload } = await request('/keys', { method: 'POST', body, authed: true })
  return issuedOf(payload)
}

/** A7 —— 轮换（kid 不变；旧明文立即失效；新明文只此一次）。 */
export async function rotate(kid, options = {}) {
  const { payload } = await request(`${keyPath(kid)}/rotate`, { method: 'POST', authed: true, ...options })
  return issuedOf(payload)
}

/** A8 —— 启用 / 禁用（`ACTIVE` / `DISABLED`，也接受服务端原生 `active` / `revoked`）。 */
export async function setStatus(kid, status, options = {}) {
  const body = { status: rawStatusOf(status) }
  const { payload } = await request(keyPath(kid), { method: 'PATCH', body, authed: true, ...options })
  return normalizeKey(payload.key)
}

/** A9 —— 删除（服务端是逻辑撤销：只改 `status`，不物理删行）。 */
export async function remove(kid, options = {}) {
  await request(keyPath(kid), { method: 'DELETE', authed: true, ...options })
  return undefined
}

/**
 * 铸造 / 轮换响应 → `{key, plaintextOnce}`。
 * `plain` 只做改名，**不进**任何日志 / 存储 / 后续请求（本文件零 `console.*`）。
 */
function issuedOf(payload) {
  const key = normalizeKey(payload.key)
  const plain = payload && payload.key && typeof payload.key.plain === 'string' ? payload.key.plain : ''
  return { key, plaintextOnce: plain || null }
}
