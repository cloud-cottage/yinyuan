/**
 * 账号/密钥端点的**对外契约投影**（B2；单一来源，前端与斐萃照此写）。
 *
 * ★ 会话响应里 `session` 的形态（写死）：
 *      { token, token_type: 'Session', expires_in, expires_at }
 *   - `token`       原样放进 `Authorization: Session <token>`
 *   - `expires_in`  剩余秒数（整数）
 *   - `expires_at`  UTC ISO8601 绝对时刻
 *   客户端**只丢令牌**即等于登出（服务端不维护 jti 黑名单，见 `logout.js`）。
 *
 * ★ 密钥的两种投影（字段面写死，**永不出现明文/hash**）：
 *   列表/变更：`{ id, prefix, label, status, created_at, last_used_at, call_count }`（7 字段）
 *   铸造/轮换：`{ id, prefix, label, plain }`（`plain` **只此一次**）
 *
 * ★ 失败码映射（`users.js` / `apiKeys.js` 的结构化 reason ⇒ HTTP）：
 *      INVALID_INPUT        ⇒ 400 INVALID_INPUT
 *      ALREADY_EXISTS       ⇒ 409 ALREADY_EXISTS
 *      KEY_LIMIT            ⇒ 409 KEY_LIMIT（端点自判，非存储层）
 *      NOT_FOUND            ⇒ 404 NOT_FOUND
 *      KEY_NOT_ACTIVE       ⇒ 409 KEY_NOT_ACTIVE
 *      STORAGE_UNAVAILABLE  ⇒ 503 NOT_CONFIGURED（**只在服务端日志出现 STORAGE_UNAVAILABLE**）
 */
import { DEFAULT_TTL_SECONDS, signSession } from './session.js'

export const SESSION_TOKEN_TYPE = 'Session'

/** 单账号 active 密钥上限（B2 口径：10 把；revoked 的旧行不计入，否则轮换会被自己卡住）。 */
export const KEY_LIMIT_MAX = 10

/** 失败码 → HTTP 状态（端点统一查表，避免各处各写一遍）。 */
export const FAILURE_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  ALREADY_EXISTS: 409,
  KEY_LIMIT: 409,
  KEY_NOT_ACTIVE: 409,
  NOT_FOUND: 404,
  STORAGE_UNAVAILABLE: 503
})

/** 结构化失败 ⇒ `{status, body}`（错误面统一，文案不暴露内部状态）。 */
export function failureOf(reason) {
  const mapped = FAILURE_STATUS[String(reason)] || 503
  if (mapped === 503) return { status: 503, reason: 'NOT_CONFIGURED' }
  return { status: mapped, reason: String(reason) }
}

/**
 * 签发会话并把 `session` 投影成对外形态。
 * @returns {{ok:true, session:object, claims:object}|{ok:false, status:number, reason:string}}
 *   签不出来 ＝ 服务端缺 `YINYUAN_SESSION_SECRET` / 运行时不支持 ⇒ 503（**不是用户错**）
 */
export function issueSession(user, options = {}) {
  const signed = signSession({
    uid: user && user.id,
    role: (user && user.role) || 'user',
    ttlSeconds: options.ttlSeconds,
    nowSeconds: options.nowSeconds,
    secret: options.secret
  })
  if (!signed.ok) {
    console.error(`[api] session sign failed detail=${signed.detail}`)
    return { ok: false, status: 503, reason: 'NOT_CONFIGURED' }
  }
  const ttl = signed.claims.exp - signed.claims.iat
  return {
    ok: true,
    claims: signed.claims,
    session: {
      token: signed.token,
      token_type: SESSION_TOKEN_TYPE,
      expires_in: ttl,
      expires_at: new Date(signed.claims.exp * 1000).toISOString()
    }
  }
}

/** 默认 TTL（秒）导出给端点做文档与断言。 */
export const SESSION_DEFAULT_TTL_SECONDS = DEFAULT_TTL_SECONDS

/** 列表/变更投影（7 字段，逐字）。 */
export function projectKey(key) {
  if (!key || typeof key !== 'object') return null
  return {
    id: key.id || null,
    prefix: key.prefix || null,
    label: key.label || null,
    status: key.status || 'active',
    created_at: key.createdAt || null,
    last_used_at: key.lastUsedAt || null,
    call_count: typeof key.callCount === 'number' ? key.callCount : 0
  }
}

/** 铸造/轮换投影（`plain` 只在这一次响应里出现）。 */
export function projectIssuedKey(key, plain) {
  return {
    id: (key && key.id) || null,
    prefix: (key && key.prefix) || null,
    label: (key && key.label) || null,
    plain
  }
}

/** `kid` 形态（存储层 id 恒为 `k-` + 十六进制；其它一律按「不存在」处理，不给 400 探测面）。 */
const KID_PATTERN = /^k-[A-Za-z0-9]{1,96}$/

/**
 * 从请求里取 `kid`：优先 Vercel 注入的 `req.query.kid`，其次按路径取。
 * @param {object} req 请求对象
 * @param {''|'rotate'} tail 路径尾段（`rotate` 时取 `/keys/<kid>/rotate`）
 * @returns {string} 合法形态的 kid；取不到/形态不符 ⇒ `''`（端点按 404 处理）
 */
export function pathKidOf(req, tail = '') {
  const query = (req && req.query) || {}
  const raw = Array.isArray(query.kid) ? query.kid[0] : query.kid
  let kid = typeof raw === 'string' ? raw.trim() : ''
  if (kid === '') {
    const path = String((req && req.url) || '').split('?')[0]
    const pattern = tail === '' ? /\/keys\/([^/]+)\/?$/ : new RegExp(`/keys/([^/]+)/${tail}/?$`)
    const match = pattern.exec(path)
    if (match) {
      try {
        kid = decodeURIComponent(match[1]).trim()
      } catch (error) {
        kid = ''
      }
    }
  }
  return KID_PATTERN.test(kid) ? kid : ''
}
