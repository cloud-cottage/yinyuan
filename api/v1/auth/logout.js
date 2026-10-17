/**
 * POST /api/v1/auth/logout —— 结束会话（B2）。
 *
 * 响应：200 `{ ok:true }`（**无体也可调**）
 *   401 UNAUTHORIZED    未带/带了无效 `Authorization: Session <token>`
 *
 * ★ 服务端**不维护 jti 黑名单**（口径写死）：令牌是无状态 HMAC，登出＝客户端丢弃令牌。
 *   「登出后旧令牌仍能用」这件事的兜底不是黑名单，而是**每次请求回表复核 `status`**：
 *   要「立刻踢人」就把账号置 `disabled`（旧令牌与该账号的 API Key 同时失效）。
 *   这样做的代价与收益：省掉一张会无限增长的撤销表 + 每请求一次 Redis 查；换来的是
 *   「登出」只在客户端生效（被盗令牌在有效期内仍可用）—— 已知并接受，TTL 7 天封顶。
 */
import { authenticateSession } from '../../_lib/sessionAuth.js'
import { createRouteHandler } from '../../_lib/routeHandler.js'

export function createLogoutHandler(options = {}) {
  return createRouteHandler('v1/auth/logout', {
    methods: ['POST'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    authenticate: async ({ req, db }) =>
      authenticateSession(req, { db, nowSeconds: options.nowSeconds, secret: options.secret }),
    run: async () => ({ status: 200, body: { ok: true } })
  })
}

export default createLogoutHandler()
