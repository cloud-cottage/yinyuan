/**
 * 会话令牌（HMAC-SHA256 签名；印源客户账号内核；**只用 node:crypto**）。
 *
 * ★ 形态（写死）：
 *      v1.<base64url(payload)>.<base64url(hmac-sha256(secret, "v1.<base64url(payload)>"))>
 *   段数恒为 3；第一段是**格式版本**（`v1`），同时参与签名 ⇒ 版本不可降级伪造。
 *   payload JSON 键序固定为 { v, uid, role, jti, iat, exp }（同一声明 ⇒ 同一段，可逐字比对）。
 *   `iat` / `exp` 为**秒**级整数；TTL 默认 **7 天**（604800s）。
 *
 * ★ 密钥：**只从进程环境变量 `YINYUAN_SESSION_SECRET` 读**（≥32 字符才接受）。
 *   本文件不含任何密钥字面值，也不把密钥写进日志 / 返回值 / 异常。
 *   缺密钥或过短 ⇒ **fail-closed**：签发与验签都返回 `{ok:false, reason:'SESSION_INVALID'}`。
 *
 * ★ 对外 reason **统一 `SESSION_INVALID`**（细分只进日志）：`detail` 字段是**服务端诊断码**，
 *   调用方**只许记日志，不许回给客户端**（回给客户端＝把「签名错 / 过期 / 缺密钥」告诉探测者）。
 *   detail 取值面封闭：
 *     SECRET_MISSING      未配置 / 过短（服务端问题 ⇒ 部署方可判 503）
 *     TOKEN_MISSING       调用方没给令牌
 *     TOKEN_MALFORMED     段数、版本段、base64url 规范形态、JSON、字段类型任一不成立
 *     TOKEN_BAD_SIGNATURE 签名不匹配（含被篡改的 payload）
 *     TOKEN_EXPIRED       now > exp + leeway
 *     TOKEN_NOT_YET_VALID iat > now + leeway
 *     CLOCK_UNAVAILABLE   调用方给的 now 不是有限数
 *
 * ★ 严格 base64url：解码后**重编码必须逐字相等**（拒绝 `=` 填充、`+` `/`、非规范尾比特）。
 *   `timingSafeEqual` 定长比较；长度不等直接判否（签名恒 32 字节，长度不等只可能是伪造）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** 格式版本段（第一段字面值，也进 payload 的 `v`）。 */
export const TOKEN_VERSION = 'v1'

/** 会话密钥的环境变量名。 */
export const SECRET_ENV = 'YINYUAN_SESSION_SECRET'

/** 密钥最小长度（字符）。短于此视同未配置 —— 短密钥可被离线暴破。 */
export const MIN_SECRET_LENGTH = 32

/** 默认有效期：7 天（秒）。 */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60

/** 有效期上限（秒）：90 天。超上限的 exp 视为形态非法（防「永不过期」型令牌）。 */
export const MAX_TTL_SECONDS = 90 * 24 * 60 * 60

/** payload 里 `role` 的字符面（不校验具体角色集合 —— 那属路由/授权面）。 */
const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

/** uid 字符面（`u-` + 十六进制 / 通用安全字符；长度有界）。 */
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const DETAILS = Object.freeze({
  SECRET_MISSING: 'SECRET_MISSING',
  TOKEN_MISSING: 'TOKEN_MISSING',
  TOKEN_MALFORMED: 'TOKEN_MALFORMED',
  TOKEN_BAD_SIGNATURE: 'TOKEN_BAD_SIGNATURE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_NOT_YET_VALID: 'TOKEN_NOT_YET_VALID',
  CLOCK_UNAVAILABLE: 'CLOCK_UNAVAILABLE'
})

/** 对外唯一 reason。 */
export const REASON = 'SESSION_INVALID'

function fail(detail) {
  return { ok: false, reason: REASON, detail }
}

function encodeBase64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64urlStrict(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null
  if (segment.length % 4 === 1) return null
  const buffer = Buffer.from(segment, 'base64url')
  if (encodeBase64url(buffer) !== segment) return null
  return buffer
}

/** 读密钥（不回显值；过短视同缺失）。 */
function readSecret(explicit) {
  const raw = typeof explicit === 'string' ? explicit : process.env[SECRET_ENV]
  if (typeof raw !== 'string') return ''
  const secret = raw.trim()
  if (secret.length < MIN_SECRET_LENGTH) return ''
  return secret
}

/** 服务端是否已配置可用的会话密钥。 */
export function isSessionConfigured() {
  return readSecret() !== ''
}

/** 当前秒级时钟（可被调用方覆盖，便于测试与服务端时钟唯一判据）。 */
function nowSecondsOf(value) {
  if (value === undefined || value === null) return Math.floor(Date.now() / 1000)
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? n : NaN
}

function signPayload(version, payloadSegment, secret) {
  return encodeBase64url(
    createHmac('sha256', secret).update(`${version}.${payloadSegment}`, 'utf8').digest()
  )
}

/**
 * 签发会话令牌。
 * @param {{uid:string, role:string, ttlSeconds?:number, nowSeconds?:number,
 *          secret?:string, jti?:string}} input
 * @returns {{ok:true, token:string, claims:object}|{ok:false, reason:string, detail:string}}
 */
export function signSession(input) {
  const { uid, role } = input || {}
  const secret = readSecret(input && input.secret)
  if (secret === '') return fail(DETAILS.SECRET_MISSING)
  const now = nowSecondsOf(input && input.nowSeconds)
  if (!Number.isFinite(now)) return fail(DETAILS.CLOCK_UNAVAILABLE)
  if (typeof uid !== 'string' || !UID_PATTERN.test(uid)) return fail(DETAILS.TOKEN_MALFORMED)
  if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) return fail(DETAILS.TOKEN_MALFORMED)
  const rawTtl = input && input.ttlSeconds !== undefined ? input.ttlSeconds : DEFAULT_TTL_SECONDS
  const ttl = Math.floor(Number(rawTtl))
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    return fail(DETAILS.TOKEN_MALFORMED)
  }
  const claims = {
    v: 1,
    uid,
    role,
    jti: input && typeof input.jti === 'string' && input.jti !== '' ? input.jti : randomUUID(),
    iat: now,
    exp: now + ttl
  }
  const payloadSegment = encodeBase64url(Buffer.from(JSON.stringify(claims), 'utf8'))
  const signature = signPayload(TOKEN_VERSION, payloadSegment, secret)
  return { ok: true, token: `${TOKEN_VERSION}.${payloadSegment}.${signature}`, claims }
}

/**
 * 验签 + 校验有效期（**不做授权判定**：是否允许该 role 访问某资源属路由面）。
 * @param {{token:string, nowSeconds?:number, secret?:string, leewaySeconds?:number}} input
 * @returns {{ok:true, claims:object}|{ok:false, reason:string, detail:string}}
 */
export function verifySession(input) {
  const secret = readSecret(input && input.secret)
  if (secret === '') return fail(DETAILS.SECRET_MISSING)
  const now = nowSecondsOf(input && input.nowSeconds)
  if (!Number.isFinite(now)) return fail(DETAILS.CLOCK_UNAVAILABLE)

  const raw = input && input.token
  if (typeof raw !== 'string' || raw.trim() === '') return fail(DETAILS.TOKEN_MISSING)
  const parts = raw.trim().split('.')
  if (parts.length !== 3) return fail(DETAILS.TOKEN_MALFORMED)
  const [versionSegment, payloadSegment, signatureSegment] = parts
  if (versionSegment !== TOKEN_VERSION) return fail(DETAILS.TOKEN_MALFORMED)

  const payloadBytes = decodeBase64urlStrict(payloadSegment)
  const signatureBytes = decodeBase64urlStrict(signatureSegment)
  if (payloadBytes === null || signatureBytes === null) return fail(DETAILS.TOKEN_MALFORMED)

  // 先用「重算的签名」比一次：长度不等 ⇒ 必是伪造（本模块签名恒 32 字节）
  const expectedSignature = Buffer.from(signPayload(TOKEN_VERSION, payloadSegment, secret), 'base64url')
  if (signatureBytes.length !== expectedSignature.length) return fail(DETAILS.TOKEN_BAD_SIGNATURE)
  if (!timingSafeEqual(signatureBytes, expectedSignature)) return fail(DETAILS.TOKEN_BAD_SIGNATURE)

  let claims = null
  try {
    claims = JSON.parse(payloadBytes.toString('utf8'))
  } catch (error) {
    return fail(DETAILS.TOKEN_MALFORMED)
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return fail(DETAILS.TOKEN_MALFORMED)
  }
  if (Number(claims.v) !== 1) return fail(DETAILS.TOKEN_MALFORMED)
  if (typeof claims.uid !== 'string' || !UID_PATTERN.test(claims.uid)) {
    return fail(DETAILS.TOKEN_MALFORMED)
  }
  if (typeof claims.role !== 'string' || !ROLE_PATTERN.test(claims.role)) {
    return fail(DETAILS.TOKEN_MALFORMED)
  }
  if (typeof claims.jti !== 'string' || claims.jti.length === 0 || claims.jti.length > 128) {
    return fail(DETAILS.TOKEN_MALFORMED)
  }
  const iat = Number(claims.iat)
  const exp = Number(claims.exp)
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return fail(DETAILS.TOKEN_MALFORMED)
  if (exp <= iat) return fail(DETAILS.TOKEN_MALFORMED)
  if (exp - iat > MAX_TTL_SECONDS) return fail(DETAILS.TOKEN_MALFORMED)

  const leewayRaw = input && input.leewaySeconds
  const leeway = Number.isFinite(Number(leewayRaw)) ? Math.max(0, Math.floor(Number(leewayRaw))) : 0
  if (now > exp + leeway) return fail(DETAILS.TOKEN_EXPIRED)
  if (iat > now + leeway) return fail(DETAILS.TOKEN_NOT_YET_VALID)

  return { ok: true, claims }
}

/** 契约别名（`sign` / `verify`）。 */
export { signSession as sign, verifySession as verify }
