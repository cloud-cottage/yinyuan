/**
 * 方法分发路由工厂（B2：会话 / 密钥端点；**与 `createGetHandler` 并列，互不影响**）。
 *
 * ★ 为什么另起一个工厂：`createGetHandler` 的方法门写死 `GET`、且失败面绑着
 *   「仅支持 GET」的固定文案（现网四个数据端点的契约）。会话端点要 `GET/POST/PATCH/DELETE`，
 *   硬改它会把 `Allow` 头与 405 文案一起改掉 ⇒ **不改它**，新增本工厂。
 *
 * ★ 处理顺序（固定，勿改）：
 *   1) CORS 预检（`OPTIONS` + `Origin` + `Access-Control-Request-Method`）⇒ 204 三头齐
 *   2) 方法白名单                 ⇒ 非白名单 405 + `Allow: <名单>`（逗号分隔、大写、按声明序）
 *   3) JSON 体解析（**限长**）    ⇒ 超长 413 BODY_TOO_LARGE；非法 JSON / 非对象 400 INVALID_INPUT
 *   4) 节流（可配 0..n 道）       ⇒ 超限 429 RATE_LIMITED（存储不可用 ⇒ 放行，见 ratelimit.js）
 *   5) 认证（可配）               ⇒ 401 / 503 由 `authenticate` 决定
 *   6) 业务 `run`                 ⇒ 返回 `{status, body}`，由 `respond.sendJson` 统一落盘
 *   7) 异常                        ⇒ 400/413/503/500 统一信封（**细节只进服务端日志**）
 *
 * ★ 统一响应面（**全部复用 `respond.js`**）：成功与失败都走 `sendJson`
 *   ⇒ `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`、
 *     `X-Content-Type-Options: nosniff`、`Access-Control-Allow-Origin: *` 逐字一致。
 *
 * ★ 日志纪律：只记 `<路由> <状态码> <方法> <毫秒>`；**永不记请求体**（体里有口令）、
 *   不记令牌、不记 key 明文/摘要。
 *
 * ★ 可测性：`options.db` / `options.throttles[].identifierOf` / `options.throttleOptions`
 *   是**注入面**（自检用内存假 DB 与假计数存储），生产默认不传 ⇒ 走 CloudBase 与 Upstash。
 */
import { CORS_ALLOW_METHODS_SESSION, handlePreflight } from './cors.js'
import { enforceThrottle } from './ratelimit.js'
import { InvalidParamError, NotConfiguredError, fail, failWith, sendJson } from './respond.js'

/** JSON 体上限（8 KiB）：会话/密钥端点的体都很小；超限 ⇒ 413（防内存放大）。 */
export const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024

/** 体超长（⇒ 413）。 */
export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
    this.limit = limit
  }
}

/** 体不是合法 JSON 对象（⇒ 400 INVALID_INPUT）。 */
export class InvalidBodyError extends Error {
  constructor(reason) {
    super(String(reason))
    this.name = 'InvalidBodyError'
    this.reason = String(reason)
  }
}

/** 调用方 IP（Vercel 侧 `x-forwarded-for` 首个值；本地/直调回落 socket 地址）。 */
export function clientIpOf(req) {
  const headers = (req && req.headers) || {}
  const raw = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || headers['x-real-ip'] || ''
  const first = String(Array.isArray(raw) ? raw[0] : raw)
    .split(',')[0]
    .trim()
  if (first !== '') return first.slice(0, 64)
  const socket = req && req.socket
  const address = socket && (socket.remoteAddress || socket.address && socket.address().address)
  return typeof address === 'string' && address !== '' ? address : 'unknown'
}

/** 头部数字（`content-length`）。 */
function headerLength(req, name) {
  const headers = (req && req.headers) || {}
  const raw = headers[name] || headers[name.toLowerCase()]
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : -1
}

/** 读原始体（带上限；超限即抛，不再接着读）。 */
async function readRawBody(req, limit) {
  const declared = headerLength(req, 'content-length')
  if (declared > limit) throw new BodyTooLargeError(limit)

  if (typeof req.on !== 'function') {
    // 非流式请求对象（假 req / 已解析）：只有 string/undefined 两种可能
    const pre = req.body
    if (pre === undefined || pre === null) return ''
    const text = typeof pre === 'string' ? pre : JSON.stringify(pre)
    if (Buffer.byteLength(text, 'utf8') > limit) throw new BodyTooLargeError(limit)
    return text
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    size += buf.length
    if (size > limit) throw new BodyTooLargeError(limit)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 解析 JSON 体。空体 ⇒ `{}`（便于 `POST /logout` 无体调用）。
 * 非 `application/json`（当显式声明了别的 Content-Type）⇒ 400，避免把表单当 JSON 静默解。
 * @returns {Promise<object>} 一定是**普通对象**（数组 / null / 标量 ⇒ 400）
 */
export async function readJsonBody(req, limit = DEFAULT_BODY_LIMIT_BYTES) {
  const headers = (req && req.headers) || {}
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase()
  const text = (await readRawBody(req, limit)).trim()
  if (text === '') return {}
  if (contentType !== '' && !contentType.includes('json')) {
    throw new InvalidBodyError('CONTENT_TYPE_NOT_JSON')
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new InvalidBodyError('MALFORMED_JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidBodyError('NOT_OBJECT')
  }
  return parsed
}

/** 惰性取云库句柄（注入优先；不注入 ⇒ 动态 import，不连库的环境不加载 SDK）。 */
async function resolveDb(db) {
  if (db) return db
  const { getDb } = await import('./cloudbase.js')
  return getDb()
}

function describeError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error || '')
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 160)
}

/**
 * 建一个路由处理器。
 *
 * @param {string} routeName 日志用路由名（如 `v1/auth/login`）
 * @param {{
 *   methods: string[],
 *   run: (ctx:{req:object, body:object|null, db:object|null, auth:object|null}) =>
 *         Promise<{status:number, body:object}>,
 *   authenticate?: (ctx:{req:object, db:object|null}) =>
 *         Promise<{ok:true, user?:object, claims?:object, token?:string}
 *                |{ok:false, status:number, reason:string}>,
 *   throttles?: Array<{scope:string, limit:number, windowSeconds:number,
 *                      identifierOf?: (ctx:{req:object, body:object|null}) => string}>,
 *   db?: object|null,
 *   bodyLimitBytes?: number,
 *   throttleOptions?: object
 * }} options
 * @returns {(req:object, res:object) => Promise<void>}
 */
export function createRouteHandler(routeName, options = {}) {
  const methods = Array.isArray(options.methods) && options.methods.length > 0
    ? options.methods.map((m) => String(m).toUpperCase())
    : ['GET']
  const allowHeader = methods.join(', ')
  const bodyLimitBytes = Number.isFinite(Number(options.bodyLimitBytes))
    ? Math.max(256, Math.floor(Number(options.bodyLimitBytes)))
    : DEFAULT_BODY_LIMIT_BYTES
  const throttles = Array.isArray(options.throttles) ? options.throttles.filter(Boolean) : []
  const throttleOptions = options.throttleOptions || {}
  const authenticate = typeof options.authenticate === 'function' ? options.authenticate : null
  const run = options.run
  const db = options.db || null
  // ★ `dbAccess: false`（公开面 config / plans）：**跳过云库句柄解析** ⇒ 云库未配置的环境
  //   也能回 200（否则 `resolveDb` 抛 NotConfiguredError ⇒ 公开价格表变 503）。
  //   缺省 true ＝ 既有全部路由逐字不变。
  const dbAccess = options.dbAccess !== false
  const methodsWithBody = new Set(['POST', 'PUT', 'PATCH'])
  if (typeof run !== 'function') throw new TypeError('createRouteHandler 需要 options.run')

  return async function handler(req, res) {
    const startedAt = Date.now()
    let method = String((req && req.method) || 'GET').toUpperCase()
    try {
      if (handlePreflight(req, res, CORS_ALLOW_METHODS_SESSION)) return

      if (!methods.includes(method)) {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', allowHeader)
        return fail(res, 405, 'METHOD_NOT_ALLOWED', '本接口不支持该方法。')
      }

      const body = methodsWithBody.has(method) ? await readJsonBody(req, bodyLimitBytes) : null

      for (const spec of throttles) {
        const identifier =
          typeof spec.identifierOf === 'function' ? String(spec.identifierOf({ req, body }) || '') : clientIpOf(req)
        const passed = await enforceThrottle(res, {
          scope: spec.scope,
          limit: spec.limit,
          windowSeconds: spec.windowSeconds,
          identifier,
          ...throttleOptions
        })
        if (!passed) return undefined
      }

      let auth = null
      if (authenticate) {
        auth = await authenticate({ req, db: await resolveDb(db) })
        if (!auth || auth.ok !== true) {
          const status = Number(auth && auth.status) || 401
          const reason = (auth && auth.reason) || 'UNAUTHORIZED'
          return failWith(res, status, reason)
        }
      }

      const result = await run({ req, body, db: dbAccess ? await resolveDb(db) : db, auth })
      if (!result || typeof result !== 'object' || typeof result.status !== 'number') {
        throw new Error('route handler did not return {status, body}')
      }
      sendJson(res, result.status, result.body)
      console.log(`[api/${routeName}] status=${result.status} method=${method} ms=${Date.now() - startedAt}`)
      return undefined
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // 体没读完就回 413：等响应 flush 后收连接，避免 keep-alive 里残留未读数据
        if (typeof res.once === 'function') {
          res.once('finish', () => {
            if (typeof req.destroy === 'function') req.destroy()
          })
        }
        console.warn(`[api/${routeName}] 413 BODY_TOO_LARGE limit=${error.limit} ms=${Date.now() - startedAt}`)
        return fail(res, 413, 'BODY_TOO_LARGE', '请求体过大。')
      }
      if (error instanceof InvalidBodyError) {
        console.warn(`[api/${routeName}] 400 INVALID_INPUT body-${error.reason} method=${method}`)
        return fail(res, 400, 'INVALID_INPUT', '请求体须为合法的 JSON 对象。')
      }
      if (error instanceof InvalidParamError) {
        return fail(res, 400, 'INVALID_PARAM', error.message)
      }
      if (error instanceof NotConfiguredError) {
        return failWith(res, 503, 'NOT_CONFIGURED')
      }
      console.error(
        `[api/${routeName}] 500 INTERNAL_ERROR method=${method} error=${(error && error.name) || 'Error'} message=${describeError(error)}`
      )
      return failWith(res, 500, 'INTERNAL_ERROR')
    }
  }
}
