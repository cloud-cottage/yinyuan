/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/auth/login.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/auth/index.js（op=login）` 按 `?op=` 分派。
 * POST /api/v1/auth/login —— 客户登录（B2）。
 *
 * 体（`application/json`，≤8 KiB）：`{ phone?, email?, password }`（**手机号优先**，二选一必给）
 *
 * 响应：
 *   200 `{ ok:true, session:{token,token_type,expires_in,expires_at}, user:{...} }`
 *   400 INVALID_INPUT    标识形态非法 / 体不是合法 JSON 对象（**调用方错误**，非凭据错误）
 *   401 UNAUTHORIZED     **账号不存在 / 口令错 / 账号已停用 —— 同形同文案**，不给探测面
 *   429 RATE_LIMITED     同一 IP 10 分钟超 30 次，或同一标识 10 分钟超 10 次
 *   503 NOT_CONFIGURED   账号表不可用，或服务端未配置会话密钥
 *   405 METHOD_NOT_ALLOWED（`Allow: POST`）
 *
 * ★ 反探测：账号不存在时**照样跑一次 scrypt**（对固定假散列校验），使「不存在」与「口令错」
 *   的响应耗时同量级；对外 body 逐字相同（`reason: UNAUTHORIZED` + 同一中文文案）。
 * ★ 停用账号（`status !== 'active'`）登录 ⇒ 同样 401（内部日志记 `ACCOUNT_DISABLED`）。
 * ★ 口令**不 trim**：`' pass '` 与 `'pass'` 是两个不同口令（B1 口径）。
 */
import {
  SESSION_DEFAULT_TTL_SECONDS,
  failureOf,
  issueSession
} from '../accountContract.js'
import { hashPassword, verifyPassword } from '../passwordHash.js'
import { AUTH_THROTTLE } from '../ratelimit.js'
import { clientIpOf, createRouteHandler } from '../routeHandler.js'
import { findByEmail, findByPhone, normalizeEmail, normalizePhone, updateLastLogin } from '../users.js'

const LOGIN_FAILED = {
  ok: false,
  reason: 'UNAUTHORIZED',
  message: '手机号/邮箱或口令不正确。'
}

/** 假散列（惰性建一次）：给「账号不存在」分支烧掉同量级 CPU，抹平时间差。 */
let dummyHashPromise = null
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('yinyuan-login-timing-pad').catch(() => null)
  }
  return dummyHashPromise
}

/** 输入形状（类型/形态错 ⇒ 400；不做口令归一化）。 */
function readInput(body) {
  const phone = body.phone
  const email = body.email
  const password = body.password
  if (typeof password !== 'string' || password === '') return { ok: false }
  if (phone === undefined && email === undefined) return { ok: false }
  if (phone !== undefined && typeof phone !== 'string') return { ok: false }
  if (email !== undefined && typeof email !== 'string') return { ok: false }
  const phoneKey = phone === undefined ? '' : normalizePhone(phone)
  const emailKey = email === undefined ? '' : normalizeEmail(email)
  if (phone !== undefined && phoneKey === '') return { ok: false }
  if (email !== undefined && emailKey === '') return { ok: false }
  if (phoneKey === '' && emailKey === '') return { ok: false }
  return { ok: true, phoneKey, emailKey, password }
}

/** 节流标识：优先「归一化后的账号标识」，取不到才退 IP（不让格式噪音绕开按账号计数）。 */
function accountIdentifierOf(body, req) {
  const source = body || {}
  const key =
    (typeof source.phone === 'string' ? normalizePhone(source.phone) : '') ||
    (typeof source.email === 'string' ? normalizeEmail(source.email) : '')
  return key !== '' ? key : clientIpOf(req)
}

export function createLoginHandler(options = {}) {
  return createRouteHandler('v1/auth/login', {
    methods: ['POST'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    throttleOptions: options.throttleOptions,
    throttles: [
      { ...AUTH_THROTTLE.LOGIN_IP, identifierOf: ({ req }) => clientIpOf(req) },
      { ...AUTH_THROTTLE.LOGIN_ACCOUNT, identifierOf: ({ req, body }) => accountIdentifierOf(body, req) }
    ],
    run: async ({ body, db }) => {
      const input = readInput(body || {})
      if (!input.ok) {
        return { status: 400, body: { ok: false, reason: 'INVALID_INPUT', message: '手机号/邮箱或口令格式不正确。' } }
      }

      const found = input.phoneKey !== ''
        ? await findByPhone(db, input.phoneKey)
        : await findByEmail(db, input.emailKey)
      if (!found.ok) {
        console.error(`[api/v1/auth/login] storage unavailable reason=${found.reason}`)
        const failure = failureOf(found.reason)
        return { status: failure.status, body: { ok: false, reason: failure.reason, message: '登录服务暂时不可用，请稍后重试。' } }
      }

      const row = found.user
      const stored = row && row.password_hash
      if (!row || !stored) {
        // 账号不存在：照样烧一次 scrypt（时间同形），对外 401
        const pad = await dummyHash()
        if (pad) await verifyPassword(input.password, pad)
        console.warn('[api/v1/auth/login] rejected reason=USER_NOT_FOUND')
        return { status: 401, body: LOGIN_FAILED }
      }

      const matched = await verifyPassword(input.password, stored)
      if (!matched) {
        console.warn('[api/v1/auth/login] rejected reason=PASSWORD_MISMATCH')
        return { status: 401, body: LOGIN_FAILED }
      }
      if (String(row.status || '') !== 'active') {
        // 口令对但账号停用 ⇒ 仍是 401（不告诉调用方「你账号被停用了」）
        console.warn('[api/v1/auth/login] rejected reason=ACCOUNT_DISABLED')
        return { status: 401, body: LOGIN_FAILED }
      }

      // 登录时刻 best-effort（写失败不影响本次登录）
      void updateLastLogin(db, row._id, options.now).catch(() => {})

      const user = {
        id: row._id || null,
        phone: row.phone || null,
        email: row.email || null,
        role: row.role || 'user',
        status: row.status || 'active',
        createdAt: row.created_at || null,
        lastLoginAt: row.last_login_at || null
      }
      const issued = issueSession(user, {
        ttlSeconds: SESSION_DEFAULT_TTL_SECONDS,
        nowSeconds: options.nowSeconds,
        secret: options.secret
      })
      if (!issued.ok) {
        return { status: 503, body: { ok: false, reason: 'NOT_CONFIGURED', message: '登录服务暂时不可用，请稍后重试。' } }
      }
      return { status: 200, body: { ok: true, session: issued.session, user } }
    }
  })
}

export default createLoginHandler()
