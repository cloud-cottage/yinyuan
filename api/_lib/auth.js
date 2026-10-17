/**
 * ApiKey 鉴权（印源对外只读 API v1）。
 *
 * 密钥唯一来源＝进程环境变量 `YINYUAN_API_KEY`（**绝不在仓内写死、不落日志、不入响应**）。
 * 请求头接受两种写法：
 *   - `Authorization: ApiKey <key>`
 *   - `X-API-Key: <key>`
 *
 * 分支（由 handler 统一落码）：
 *   - 未配置 `YINYUAN_API_KEY` ⇒ 503 NOT_CONFIGURED（含：请求带了任意 key 也一样）
 *   - key 缺失或不匹配         ⇒ 401 UNAUTHORIZED
 */
import { timingSafeEqual } from 'node:crypto'

export const API_KEY_ENV = 'YINYUAN_API_KEY'

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

/** 鉴权总判：{ ok:true } 或 { ok:false, status, reason }。 */
export function checkApiKey(req) {
  if (!isApiKeyConfigured()) {
    return { ok: false, status: 503, reason: 'NOT_CONFIGURED' }
  }
  const provided = extractApiKey(req)
  if (provided === '' || !safeEqual(provided, process.env[API_KEY_ENV])) {
    return { ok: false, status: 401, reason: 'UNAUTHORIZED' }
  }
  return { ok: true }
}
