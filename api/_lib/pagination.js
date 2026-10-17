/**
 * 分页参数解析（印源对外只读 API v1）。
 *
 * 口径（三个分页端点一致）：
 *   - `limit`  缺省 50；超上限按上限**截断**（不报错）；0 合法（返回空 items）
 *   - `offset` 缺省 0；须 ≥ 0
 *   - 非「非负整数」的取值 ⇒ 400 INVALID_PARAM（**不静默兜底**，避免调用方误判）
 */
import { InvalidParamError } from './respond.js'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/** 解析查询串：优先 `req.url`，兼容 `req.query`（Vercel 两种形态都存在过）。 */
export function getSearchParams(req) {
  const url = req && typeof req.url === 'string' ? req.url : ''
  const qIndex = url.indexOf('?')
  if (qIndex >= 0) return new URLSearchParams(url.slice(qIndex + 1))
  const rawQuery = req && req.query
  if (rawQuery && typeof rawQuery === 'object') {
    const pairs = new URLSearchParams()
    for (const [k, v] of Object.entries(rawQuery)) {
      if (v === undefined || v === null) continue
      pairs.set(k, Array.isArray(v) ? String(v[0]) : String(v))
    }
    return pairs
  }
  return new URLSearchParams('')
}

function parseNonNegativeInteger(raw, name) {
  if (raw === null || raw === undefined || raw === '') return null
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new InvalidParamError(`参数 ${name} 必须是非负整数。`)
  }
  const n = Number(String(raw).trim())
  if (!Number.isSafeInteger(n)) throw new InvalidParamError(`参数 ${name} 超出可用范围。`)
  return n
}

/**
 * @returns {{ limit:number, offset:number, limitTruncated:boolean }}
 */
export function parsePaging(req, options = {}) {
  const defaultLimit = options.defaultLimit === undefined ? DEFAULT_LIMIT : options.defaultLimit
  const maxLimit = options.maxLimit === undefined ? MAX_LIMIT : options.maxLimit
  const params = getSearchParams(req)

  const rawLimit = parseNonNegativeInteger(params.get('limit'), 'limit')
  const offset = parseNonNegativeInteger(params.get('offset'), 'offset') || 0

  let limit = rawLimit === null ? defaultLimit : rawLimit
  let limitTruncated = false
  if (limit > maxLimit) {
    limit = maxLimit
    limitTruncated = true
  }
  return { limit, offset, limitTruncated }
}
