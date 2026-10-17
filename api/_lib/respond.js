/**
 * 统一响应信封与错误码（印源对外只读 API v1）。
 *
 * 成功：200 { ok: true, data: ... }
 * 失败：{ status, ok: false, reason, message }
 *   - reason 为**机器可读**英文大写标识（对外稳定）
 *   - message 为**简体中文**人话，**不得**出现集合名、字段名、env 名、密钥等内部标识
 */
export const REASONS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_PARAM: 'INVALID_PARAM',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
})

/** 对外固定文案（简体中文、不含内部标识）。 */
export const MESSAGES = Object.freeze({
  NOT_CONFIGURED: '对外接口尚未配置完成，暂时不可用。',
  UNAUTHORIZED: '访问密钥缺失或无效。',
  METHOD_NOT_ALLOWED: '本接口仅支持 GET 请求。',
  NOT_FOUND: '接口不存在。',
  INTERNAL_ERROR: '数据读取失败，请稍后重试。'
})

/**
 * ★ 200 面的边缘缓存指令（2026-10-17 并发修复）。
 *
 * 契约面（**逐字不变**）：`Cache-Control: no-store` 在**三端点 × 全部状态码**上照旧（§7.10-2 ／ AC-102⑤）。
 * 并发面（新增）：仅 **200** 追加 `Vercel-CDN-Cache-Control`（Vercel 专属 CDN 缓存指令）
 *   ＋ `Vary: Authorization, X-API-Key`（把鉴权头值纳入边缘缓存键）。
 *
 * 三条硬约束：
 *  1) **错误面不缓存**：400 / 401 / 404 / 405 / 500 / 503 **不追加** CDN 指令 ⇒ 平台按
 *     `Cache-Control: no-store` 处理，不入边缘缓存（反证读数见 qa-recheck 报告）。
 *  2) **鉴权不降级**：`Vary` 让「带正确 key 的请求」与「无 key / 错 key 的请求」落在**不同**缓存条目上
 *     ⇒ 无 key 请求永远拿不到别人的 200 缓存体（且它本来就该拿 401）。
 *  3) **客户端可见面不变**：`Vercel-CDN-Cache-Control` 由 Vercel 代理消费后**不回传客户端**
 *     ⇒ 客户端看到的响应头与修复前**逐字一致**（`Cache-Control: no-store` 仍是那个值）。
 */
export const SUCCESS_CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300'
export const SUCCESS_CACHE_VARY = 'Authorization, X-API-Key'

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

export function ok(res, data) {
  // ★ 只有 200 走这里 ⇒ 只有成功面挂边缘缓存指令；错误面（fail / failWith）永远不挂。
  res.setHeader('Vercel-CDN-Cache-Control', SUCCESS_CDN_CACHE_CONTROL)
  res.setHeader('Vary', SUCCESS_CACHE_VARY)
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
