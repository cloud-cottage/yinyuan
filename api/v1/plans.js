/**
 * `GET /api/v1/plans`（A16 `getPlans` ＋ A17 `getPricingTable` 共用）—— 套餐/价格表投影。
 *
 * 响应：200 `{ ok:true, data:{ currency, isDemoPrice, effectiveFrom, plans[], pricingTable{} } }`
 *   401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET`）/ 503 NOT_CONFIGURED
 *
 * ★ 单一数据源 `src/config/pricing.js`（本文件与 `api/_lib/plans.js` 均无金额/包量字面量）。
 * ★ 不查库：套餐是配置，不是账号数据。
 */
import { projectPlans } from '../_lib/plans.js'
import { createRouteHandler } from '../_lib/routeHandler.js'
import { sessionAuthenticator } from '../_lib/sessionRoute.js'

export function createPlansHandler(options = {}) {
  return createRouteHandler('v1/plans', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async () => ({ status: 200, body: { ok: true, data: projectPlans() } })
  })
}

export default createPlansHandler()
