/**
 * 会话鉴权（印源客户账号；B2）。**只做「令牌 → 账号」的认证，不做业务授权**。
 *
 * ★ 传输口径（写死）：请求头 `Authorization: Session <token>`
 *   —— 与对外数据 API 的 `ApiKey <key>`、斐萃的 `Feicui <key>` **靠 scheme 区分**，
 *   三种凭据互不兼容：`Session` 令牌不能拿去调数据端点，`ApiKey` 也不能当会话用。
 *
 * ★ 每次请求都**回表复核** `yinyuan_users`（这是 B1 已知风险的正解：令牌无 jti 黑名单，
 *   停用账号只能靠「每次核对 status」即时生效）：
 *     1) 令牌形态/签名/有效期  ⇒ `session.verifySession`
 *     2) 账号存在                ⇒ `users.findById`
 *     3) `status === 'active'`   ⇒ 停用即 401（**不回「已停用」这种可探测信息**）
 *   代价：会话端点每请求多一次云库读（几十毫秒）；换来的是「停用后旧令牌立即失效」。
 *
 * ★ 对外失败面**只有两个 reason**：
 *     401 UNAUTHORIZED    —— 缺令牌 / 形态错 / 签名错 / 过期 / 账号不存在 / 账号已停用
 *     503 NOT_CONFIGURED  —— 服务端缺会话密钥、或账号表不可用（**fail-closed**，不误判成 401）
 *   内部判别码（`detail`）只进服务端日志，**永不回给客户端**。
 */
import { DETAILS, verifySession } from './session.js'
import { findById, toPublicUser } from './users.js'

/** 会话 scheme（`Authorization: Session <token>`）。 */
export const SESSION_SCHEME = 'Session'

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
  return typeof value === 'string' ? value : ''
}

/** 从请求头取会话令牌；不是 `Session` scheme 或取不到 ⇒ ''（**不回显**调用方原值）。 */
export function extractSessionToken(req) {
  const authz = readHeader(req, 'authorization')
  if (authz === '') return ''
  const m = /^\s*Session\s+(\S+)\s*$/i.exec(authz)
  return m ? m[1] : ''
}

/** 调用方 scheme（仅用于服务端日志判别，不对外）。 */
export function readAuthScheme(req) {
  const authz = readHeader(req, 'authorization').trim()
  if (authz === '') return 'none'
  const m = /^([A-Za-z]+)\s+\S+$/.exec(authz)
  return m ? m[1].toLowerCase() : 'malformed'
}

function unauthorized(detail) {
  console.warn(`[api] session rejected reason=${detail}`)
  return { ok: false, status: 401, reason: 'UNAUTHORIZED', detail }
}

/**
 * 认证会话。
 * @param {object} req 请求对象
 * @param {{db?:object, nowSeconds?:number, leewaySeconds?:number, secret?:string}} [options]
 * @returns {Promise<{ok:true, user:object, row:object, claims:object, token:string}
 *                   |{ok:false, status:number, reason:string, detail?:string}>}
 *   `user` 是**对外投影**（不含 password_hash）；`row` 仅服务端用（含 role/status）。
 */
export async function authenticateSession(req, options = {}) {
  const token = extractSessionToken(req)
  if (token === '') return unauthorized(`TOKEN_MISSING scheme=${readAuthScheme(req)}`)

  const verdict = verifySession({
    token,
    secret: options.secret,
    nowSeconds: options.nowSeconds,
    leewaySeconds: options.leewaySeconds
  })
  if (!verdict.ok) {
    // 缺密钥 ＝ 服务端没配好（不是调用方的错，也不是「令牌无效」）
    if (verdict.detail === DETAILS.SECRET_MISSING) {
      console.error('[api] session rejected reason=SECRET_MISSING')
      return { ok: false, status: 503, reason: 'NOT_CONFIGURED', detail: 'SECRET_MISSING' }
    }
    return unauthorized(verdict.detail || 'SESSION_INVALID')
  }

  let db = options.db || null
  let found = null
  try {
    if (!db) {
      const { getDb } = await import('./cloudbase.js')
      db = getDb()
    }
    found = await findById(db, verdict.claims.uid)
  } catch (error) {
    console.error(
      `[api] session user-lookup unavailable error=${(error && error.name) || 'Error'} code=${(error && error.code) || '-'}`
    )
    found = { ok: false, reason: 'STORAGE_UNAVAILABLE' }
  }
  if (!found || found.ok !== true) {
    // 账号表不可用 ⇒ fail-closed（503），不当成「令牌无效」（否则会把故障说成用户凭据错）
    return { ok: false, status: 503, reason: 'NOT_CONFIGURED', detail: 'STORAGE_UNAVAILABLE' }
  }
  if (!found.user) return unauthorized('USER_NOT_FOUND')
  if (String(found.user.status || '') !== 'active') return unauthorized('ACCOUNT_DISABLED')

  return {
    ok: true,
    user: toPublicUser(found.user),
    row: found.user,
    claims: verdict.claims,
    token
  }
}
