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

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

export function ok(res, data) {
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
