/**
 * 统一响应信封与错误码（印源对外只读 API v1）。
 *
 * 成功：200 { ok: true, data: ... }
 * 失败：{ status, ok: false, reason, message }
 *   - reason 为**机器可读**英文大写标识（对外稳定）
 *   - message 为**简体中文**人话，**不得**出现集合名、字段名、env 名、密钥等内部标识
 */
import { CORS_ALLOW_ORIGIN } from './cors.js'

export const REASONS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_PARAM: 'INVALID_PARAM',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // ★ 第七值（v1.43 §7.13-2 ④）：原六值及其码一一对应关系一字不改，仅追加 RATE_LIMITED(429)
  RATE_LIMITED: 'RATE_LIMITED'
})

/** 对外固定文案（简体中文、不含内部标识）。 */
export const MESSAGES = Object.freeze({
  NOT_CONFIGURED: '对外接口尚未配置完成，暂时不可用。',
  UNAUTHORIZED: '访问密钥缺失或无效。',
  METHOD_NOT_ALLOWED: '本接口仅支持 GET 请求。',
  NOT_FOUND: '接口不存在。',
  INTERNAL_ERROR: '数据读取失败，请稍后重试。',
  // ★ 唯一规范形态（v1.43 §7.13-2 ④）：简体、逐字、不含集合名/字段名/env 名/key/云库标识/堆栈
  RATE_LIMITED: '今日调用次数已达上限，请明日再试。'
})

/**
 * ★ 边缘缓存口径（2026-10-17 边缘缓存缺陷修复）。
 *
 * 本模块**不下发 `Vercel-CDN-Cache-Control`，也不下发 `Vary`**（原 `SUCCESS_CDN_CACHE_CONTROL`
 * ／ `SUCCESS_CACHE_VARY` 两个导出已随之删除）。
 *
 * 根因（线上实测）：200 面挂 `public, s-maxage=60, stale-while-revalidate=300` ⇒ 固定 URL 命中
 * CDN 边缘缓存时**函数根本不执行**，其后果有两条：① 限流不计次数（同一 URL 可无限刷、配额被绕过）；
 * ② `X-RateLimit-Remaining` 随缓存体一起冻结（客户读到「卡住」的错数）。API 响应因此一律不可边缘缓存。
 *
 * 延迟改由**实例级缓存**兜底（`instance-cache.js`：TTL 60s、键含鉴权指纹、只缓存 200），
 * 且在 `enforceRateLimit` **之后**读取 ⇒ 命中实例缓存仍然计次、Remaining 仍逐发递减。
 *
 * 契约面照旧（**逐字不变**）：`Cache-Control: no-store` 与 `Access-Control-Allow-Origin: *`
 * 在**三端点 × 全部状态码**上照旧（§7.10-2 ／ AC-102⑤ ／ §7.13-3 ⑦ ⑧）。
 * `Vary` 一并移除：来源恒 `*`、不反射 `Origin`；鉴权面由 key 校验 ＋ 实例缓存键内的鉴权指纹保证，
 * 已无边缘缓存条目需要区分。
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // ★ CORS（v1.42 §7.13-3 ⑦ ⑧）：**全部状态码**（含 400/401/404/405/500/503）一律带
  //   `Access-Control-Allow-Origin: *` —— 否则浏览器侧读不到错误体，客户端分不清
  //   「key 错」「超限」「服务端错」。来源恒 `*`、不反射 Origin ⇒ 不新增 `Vary: Origin`。
  res.setHeader('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN)
  res.end(body)
}

export function ok(res, data) {
  // ★ 200 面**不挂任何边缘缓存指令**（详见本文件顶部：CDN 命中会让函数不执行 ⇒ 限流不计次）。
  //   客户端 `Cache-Control: no-store` 与 CORS 头由 sendJson 统一挂，逐字不变。
  sendJson(res, 200, { ok: true, data })
}

export function fail(res, status, reason, message) {
  sendJson(res, status, { ok: false, reason, message })
}

export function failWith(res, status, reason) {
  fail(res, status, reason, MESSAGES[reason] || MESSAGES.INTERNAL_ERROR)
}

/** 参数非法（由 handler 统一转 400 INVALID_PARAM，message 直接沿用）。 */
export class InvalidParamError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidParamError'
  }
}

/** 数据源未配置（由 handler 统一转 503 NOT_CONFIGURED）。 */
export class NotConfiguredError extends Error {
  constructor(message) {
    super(message || 'NOT_CONFIGURED')
    this.name = 'NotConfiguredError'
  }
}
