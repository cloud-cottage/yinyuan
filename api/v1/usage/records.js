/**
 * `GET /api/v1/usage/records`（A13）—— 调用明细（按 `requestedAt` 倒序分页）。
 *
 * 查询参数：`limit`（缺省 50 / 上限 200，**超出截断不报错**）、`offset`（≥ 0），
 *          区间与筛选同 A10。
 *
 * 响应：200 `{ ok:true, data:{ items:[UsageRecord + seeded], total, limit, offset,
 *            limitTruncated, hasMore, page, pageSize, totalPages, range } }`
 *   ★ 无数据 ⇒ `items: []`、`total: 0`（不 404）
 *   ★ 每行透出 `seeded`（示例数据可区分）
 *   400 INVALID_PARAM（`limit=abc` / `offset=-1`）/ 401 / 405（`Allow: GET`）/ 503
 */
import { parsePaging } from '../../_lib/pagination.js'
import { createRouteHandler } from '../../_lib/routeHandler.js'
import { sessionAuthenticator } from '../../_lib/sessionRoute.js'
import { listUsageRecords, parseUsageQuery } from '../../_lib/usage.js'

export function createUsageRecordsHandler(options = {}) {
  return createRouteHandler('v1/usage/records', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ req, db, auth }) => {
      const query = parseUsageQuery(req, { nowMs: options.nowMs })
      const paging = parsePaging(req)
      const data = await listUsageRecords(db, auth.user.id, query, paging)
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createUsageRecordsHandler()
