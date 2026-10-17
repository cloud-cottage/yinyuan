/**
 * CORS（浏览器直连）—— 规范 v1.42 §7.13-3（Kevin 2026-10-17 亲定「开浏览器直连」）。
 *
 * 口径（逐条对应 §7.13-3 ① ② ③ ④ ⑤ ⑦ ⑧ ⑨）：
 *   - 来源恒为 `*`（公开只读 API，不设白名单）⇒ **不反射 `Origin`**，
 *     故**不新增 `Vary: Origin`**（§7.13-3 ⑨）；**不带 `Access-Control-Allow-Credentials`**
 *     （与 `*` 不可共存；本 API 无 cookie 鉴权，§7.13-3 ①）。
 *   - 允许方法 `GET, OPTIONS`（与 AC-103 方法门一致；不含 POST/PUT/PATCH/DELETE/HEAD）。
 *   - 允许请求头 `Authorization, X-API-Key, Content-Type`（**不以 `*` 代替**）。
 *   - 预检（`OPTIONS` ＋ `Origin` ＋ `Access-Control-Request-Method`）⇒ **204、无响应体、三头齐**，
 *     `Access-Control-Max-Age: 600`（§7.13-3 ④ 允许项，取值只可为 600）。
 *   - 非预检 `OPTIONS`（缺 `Origin` 或缺 `Access-Control-Request-Method`）⇒ **不进本模块的成功分支**，
 *     仍由各处方法门落 `405` ＋ `Allow: GET` ＋ JSON 信封（§7.13-3 ⑤）。
 *   - 实际请求与**全部错误面**（400/401/404/405/429/500/503）一律带 `Allow-Origin`，
 *     否则浏览器侧读不到错误体（§7.13-3 ⑦ ⑧）。不带 `Origin` 的请求是否返回该头不判负
 *     （§7.13-3 ⑦ 明写允许「始终返回」）⇒ 本实现选择**始终返回**，减少分支、无反射风险。
 *
 * 注意：本模块**只加头、不做鉴权、不涉及缓存口径**。`Cache-Control: no-store` 继续由
 * `respond.js` 持有，一字不改（§7.13-3 ⑨）；**边缘缓存指令已于 2026-10-17 缺陷修复中整体移除**
 * （CDN 命中会让函数不执行 ⇒ 限流不计次），故本模块也不再有 `Vary` 相关口径。
 */

export const CORS_ALLOW_ORIGIN = '*'
export const CORS_ALLOW_METHODS = 'GET, OPTIONS'
export const CORS_ALLOW_HEADERS = 'Authorization, X-API-Key, Content-Type'
export const CORS_MAX_AGE = '600'

/** 大小写无关地读单值请求头（Vercel 通常已小写化，本地 harness / 直调可能传混合大小写）。 */
function readHeader(req, name) {
  const headers = (req && req.headers) || {}
  const wanted = String(name).toLowerCase()
  let value = headers[name]
  if (value === undefined) value = headers[wanted]
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) {
        value = headers[key]
        break
      }
    }
  }
  if (Array.isArray(value)) value = value[0]
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 实际请求 / 错误面：统一挂 `Access-Control-Allow-Origin: *`（幂等）。 */
export function applyCorsHeaders(res) {
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN)
  }
  return res
}

/** 预检判定（机械判据，§7.13-3 ④ ／ ⑤）：方法 = OPTIONS **且** 带 Origin **且** 带 ACRM。 */
export function isPreflight(req) {
  const method = String((req && req.method) || '').toUpperCase()
  if (method !== 'OPTIONS') return false
  if (readHeader(req, 'origin') === '') return false
  if (readHeader(req, 'access-control-request-method') === '') return false
  return true
}

/**
 * 预检短路：命中即写 204（无体）并返回 true；未命中返回 false，由调用方继续走方法门。
 * 调用点：`createGetHandler`（三个端点）＋ `api/index.js` ／ `api/[...path].js`（404 兜底）。
 */
export function handlePreflight(req, res) {
  if (!isPreflight(req)) return false
  res.statusCode = 204
  res.setHeader('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
  res.setHeader('Access-Control-Max-Age', CORS_MAX_AGE)
  // 与全站口径一致：预检响应不入客户端 / 边缘缓存（真正管预检复用的是 Max-Age）。
  res.setHeader('Cache-Control', 'no-store')
  res.end()
  return true
}
