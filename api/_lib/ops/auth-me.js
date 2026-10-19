/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/me.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/auth/index.js（op=me）` 按 `?op=` 分派。
 * GET /api/v1/me —— 当前会话对应的账号（B2）。
 *
 * 响应：200 `{ ok:true, user:{ id, phone, email, role, status, createdAt, lastLoginAt } }`
 *   401 UNAUTHORIZED   缺/坏/过期令牌，或账号已停用
 *   503 NOT_CONFIGURED 账号表不可用 / 服务端缺会话密钥
 *   405 METHOD_NOT_ALLOWED（`Allow: GET`）
 *
 * ★ 每次请求都回表复核（`sessionAuth.authenticateSession`）⇒ 停用即时生效。
 */
import { authenticateSession } from '../sessionAuth.js'
import { createRouteHandler } from '../routeHandler.js'

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