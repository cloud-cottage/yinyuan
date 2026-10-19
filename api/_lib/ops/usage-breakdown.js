/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/usage/breakdown.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/usage/index.js（op=breakdown）` 按 `?op=` 分派。
 * `GET /api/v1/usage/breakdown?dim=endpoint|day|key`（A11）—— 三维聚合。
 *
 * 查询参数：`dim`（缺省 endpoint）、区间与筛选同 A10。
 *
 * 响应：200 `{ ok:true, data:{ dim, rows:[{ dimValue, label, calls, billableCalls, failedCalls,
 *            seededCalls, originalImages, imageCount, imageBytes, avgLatencyMs, share }],
 *            total, truncatedBuckets } }`
 *   ★ 聚合**显式 `.limit(500)`**（CloudBase `aggregate()` 默认只回 20 桶且不报错）；
 *     触顶 ⇒ `truncatedBuckets:true` + 服务端告警，数值不做任何「补齐」
 *   ★ 无数据 ⇒ `rows: []`（不 404）
 *   400 INVALID_PARAM / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET`）/ 503 NOT_CONFIGURED
 */
import { createRouteHandler } from '../routeHandler.js'
import { sessionAuthenticator } from '../sessionRoute.js'
import { getUsageBreakdown, loadKeyLabels, parseDim, parseUsageQuery } from '../usage.js'

export function createUsageBreakdownHandler(options = {}) {
  return createRouteHandler('v1/usage/breakdown', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ req, db, auth }) => {
      const query = parseUsageQuery(req, { nowMs: options.nowMs })
      const dim = parseDim(req)
      const keyLabels = dim === 'key' ? await loadKeyLabels(db, auth.user.id) : {}
      const data = await getUsageBreakdown(db, auth.user.id, query, dim, { keyLabels })
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createUsageBreakdownHandler()
