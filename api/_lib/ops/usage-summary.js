/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/usage/summary.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/usage/index.js（op=summary）` 按 `?op=` 分派。
 * `GET /api/v1/usage/summary`（A10）—— 用量汇总（**双口径**）。
 *
 * 查询参数：`range=1d|7d|30d|90d|all`（缺省 30d，CST 自然日含当日）、
 *          或 `from` / `to`（ISO8601；`YYYY-MM-DD` 按 CST 自然日解释）、
 *          `kid` / `endpoint`（可重复或逗号分隔）、`seeded=all|only|exclude`
 *
 * 响应：200 `{ ok:true, data:{ calls, billableCalls, failedCalls, originalImages, imageCount,
 *            detailImageBytes, displayChannelBytes, imageBytes, avgLatencyMs,
 *            seededCalls, realCalls, quotaTotalCalls, quotaUsedCalls, quotaRemainCalls,
 *            range:{range,from,to}, scannedCalls, truncated } }`
 *   ★ 无数据 ⇒ 全 0（不 404）；`displayChannelBytes` 恒 0（后端暂无展示通道计量）
 *   ★ `seededCalls` 让示例数据可区分，不静默冒充真实调用
 *   400 INVALID_PARAM / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET`）/ 503 NOT_CONFIGURED
 */
import { getAccountProjection } from '../account.js'
import { createRouteHandler } from '../routeHandler.js'
import { sessionAuthenticator } from '../sessionRoute.js'
import { getUsageSummary, parseUsageQuery } from '../usage.js'

export function createUsageSummaryHandler(options = {}) {
  return createRouteHandler('v1/usage/summary', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ req, db, auth }) => {
      const query = parseUsageQuery(req, { nowMs: options.nowMs })
      const data = await getUsageSummary(
        db,
        auth.user.id,
        query,
        { nowMs: options.nowMs, budgetMs: options.budgetMs, maxRows: options.maxRows },
        (userId) => getAccountProjection(db, userId, { nowMs: options.nowMs })
      )
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createUsageSummaryHandler()
