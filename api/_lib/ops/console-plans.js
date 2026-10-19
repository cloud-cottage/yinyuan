/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/plans.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/console/index.js（op=plans）` 按 `?op=` 分派。
 * `GET /api/v1/plans`（A16 `getPlans` ＋ A17 `getPricingTable` 共用）—— 套餐/价格表投影。
 *
 * ★ **公开只读面**（Zang 2026-10-19 裁定一）：**不要求会话**。
 *   理由：`/pricing` 与首页是未登录营销页面，价格表是公开商品信息；要求会话
 *   ⇒ 未登录访客看到的是错误态而非价格。公开后仍保留方法门（非 `GET` ⇒ 405 +
 *   `Allow: GET`）、统一信封、`Cache-Control: no-store` 与边缘缓存禁令。
 *   **其余 7 条控制台端点维持会话必填**（本裁决不外溢）。
 *
 * 响应：200 `{ ok:true, data:{ currency, isDemoPrice, effectiveFrom, plans[], pricingTable{} } }`
 *   405 METHOD_NOT_ALLOWED（`Allow: GET`）
 *
 * ★ 单一数据源 `src/config/pricing.js`（本文件与 `api/_lib/plans.js` 均无金额/包量字面量）。
 * ★ 不查库：套餐是配置，不是账号数据 ⇒ `dbAccess: false`，云库未配置时同样回 200。
 */
import { projectPlans } from '../plans.js'
import { createRouteHandler } from '../routeHandler.js'

export function createPlansHandler(options = {}) {
  return createRouteHandler('v1/plans', {
    methods: ['GET'],
    db: options.db || null,
    dbAccess: false,
    run: async () => ({ status: 200, body: { ok: true, data: projectPlans() } })
  })
}

export default createPlansHandler()
