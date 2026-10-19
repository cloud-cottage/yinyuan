/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/usage/trend.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/usage/index.js（op=trend）` 按 `?op=` 分派。
 * `GET /api/v1/usage/trend?bucket=day|month`（A12）—— 按 CST 日 / 月序列。
 *
 * 响应：200 `{ ok:true, data:{ bucket:'day'|'month', series:[{bucket, calls, billableCalls,
 *            failedCalls, seededCalls, originalImages, imageBytes}], truncatedBuckets,
 *            range:{range,from,to} } }`
 *   ★ **缺桶补 0**：窗口内每一天 / 每一月都有元素（页面 X 轴不会塌陷）
 *   ★ 桶数以 `TREND_MAX_BUCKETS` 封顶；超出只保留最近 N 桶并透出 `truncatedBuckets:true`
 *   ★ 无数据 ⇒ 全部桶为 0（不 404）
 *   400 INVALID_PARAM / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET`）/ 503 NOT_CONFIGURED
 */
import { createRouteHandler } from '../routeHandler.js'
import { sessionAuthenticator } from '../sessionRoute.js'
import { getUsageTrend, parseBucket, parseUsageQuery } from '../usage.js'

export function createUsageTrendHandler(options = {}) {
  return createRouteHandler('v1/usage/trend', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ req, db, auth }) => {
      const query = parseUsageQuery(req, { nowMs: options.nowMs })
      const bucket = parseBucket(req)
      const data = await getUsageTrend(db, auth.user.id, query, bucket, {
        budgetMs: options.budgetMs,
        maxRows: options.maxRows
      })
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createUsageTrendHandler()
