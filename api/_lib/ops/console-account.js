/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/account.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/console/index.js（op=account）` 按 `?op=` 分派。
 * `GET /api/v1/account`（A15）—— 额度账户（只读 `yinyuan_accounts` 当前用户行）。
 *
 * 响应：200 `{ ok:true, data:{ userId, planId, planName, monthKey, quotaTotalCalls,
 *            quotaUsedCalls, quotaRemainCalls, balanceCents, originalImageUsedThisMonth,
 *            annualFeePaidUntil, updatedAt, accountExists } }`
 *   ★ 行缺失 ⇒ `accountExists:false` + 全 0（**不 404 / 不 500**，也不替用户默认挂套餐）
 *   ★ `monthKey` 按 Asia/Shanghai；包量不跨月结转（行月 ≠ 当前月 ⇒ 本月已用量按 0）
 *   401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET`）/ 503 NOT_CONFIGURED
 *   （存储故障 ⇒ 500 INTERNAL_ERROR，绝不把故障说成「零额度」）
 */
import { getAccountProjection } from '../account.js'
import { createRouteHandler } from '../routeHandler.js'
import { sessionAuthenticator } from '../sessionRoute.js'

export function createAccountHandler(options = {}) {
  return createRouteHandler('v1/account', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ db, auth }) => {
      const data = await getAccountProjection(db, auth.user.id, { nowMs: options.nowMs })
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createAccountHandler()
