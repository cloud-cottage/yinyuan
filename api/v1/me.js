/**
 * GET /api/v1/me —— 当前会话对应的账号（B2）。
 *
 * 响应：200 `{ ok:true, user:{ id, phone, email, role, status, createdAt, lastLoginAt } }`
 *   401 UNAUTHORIZED   缺/坏/过期令牌，或账号已停用
 *   503 NOT_CONFIGURED 账号表不可用 / 服务端缺会话密钥
 *   405 METHOD_NOT_ALLOWED（`Allow: GET`）
 *
 * ★ 每次请求都回表复核（`sessionAuth.authenticateSession`）⇒ 停用即时生效。
 */
import { authenticateSession } from '../_lib/sessionAuth.js'
import { createRouteHandler } from '../_lib/routeHandler.js'

export function createMeHandler(options = {}) {
  return createRouteHandler('v1/me', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: async ({ req, db }) =>
      authenticateSession(req, { db, nowSeconds: options.nowSeconds, secret: options.secret }),
    run: async ({ auth }) => ({ status: 200, body: { ok: true, user: auth.user } })
  })
}

export default createMeHandler()