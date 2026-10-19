/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/ledger.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/console/index.js（op=ledger）` 按 `?op=` 分派。
 * `GET /api/v1/ledger`（A24）—— 流水（`yinyuan_ledger_entries`）。
 *
 * 响应：200 `{ ok:true, data:{ items:[LedgerEntry], total, limit, offset, limitTruncated,
 *            hasMore, page, pageSize, totalPages, summary:{count,inboundCents,outboundCents,netCents},
 *            collectionReady } }`
 *
 * ★ 集合**尚不存在**（本单红线：不建集合、不写流水）⇒ 200 + `items: []` + 全 0 汇总 +
 *   `collectionReady:false`。**不 404、不 500**。
 * ★ 集合存在时也只读本用户；分页 `limit` 缺省 50 / 上限 200。
 *   400 INVALID_PARAM / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET`）/ 503 NOT_CONFIGURED
 */
import { listLedgerEntries } from '../ledger.js'
import { createRouteHandler } from '../routeHandler.js'
import { sessionAuthenticator } from '../sessionRoute.js'

export function createLedgerHandler(options = {}) {
  return createRouteHandler('v1/ledger', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ req, db, auth }) => {
      const data = await listLedgerEntries(db, auth.user.id, req)
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createLedgerHandler()
