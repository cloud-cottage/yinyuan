/**
 * ============================================================================
 * 套餐 / 价格表适配层（A16 / A17）—— `GET /api/v1/plans` 的前端唯一实现
 *
 * 端点（B2，服务端已实现待部署）：
 *   GET /api/v1/plans   200 `{ ok:true, data:{ currency, isDemoPrice, effectiveFrom,
 *                          plans:[Plan], pricingTable:{...}, pricingSource } }`
 *   401 UNAUTHORIZED / 405 / 503 NOT_CONFIGURED
 *
 * 一次响应带两段（`plans` / `pricingTable`），前端两个方法各取所需：
 *   · A16 `getPlans()`        ⇒ `data.plans`（**裸数组**，与 mock 同形）；
 *   · A17 `getPricingTable()` ⇒ `data.pricingTable`（含 `rows` / `recharge` / `deduction` /
 *     `originalImageDownload` / `displaySlices` / `disclaimer` / `scenario*`，与 mock 同形）。
 *
 * 纪律：本层**不重算、不补齐、不写任何金额或包量字面量** —— 金额一律整数分、逐字取自服务端
 * （服务端又取自 `src/config/pricing.js` 单一数据源）。缺字段 ⇒ 缺（页面按「—」展示）。
 * ============================================================================
 */
import { request } from './auth.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const PLANS_PATH = '/plans'

/**
 * 服务端信封 → `{ plans, pricingTable }`（**一次请求供两个契约方法**）。
 * @param {{fetchImpl?:Function}} [options]
 * @returns {Promise<{plans:Array<object>, pricingTable:object|null, currency:string|null,
 *                    isDemoPrice:boolean|null, effectiveFrom:string|null}>}
 */
export async function fetchPlansBundle(options = {}) {
  const { payload } = await request(PLANS_PATH, { method: 'GET', authed: true, ...options })
  const data = (payload && payload.data) || {}
  return {
    plans: Array.isArray(data.plans) ? data.plans : [],
    pricingTable: data.pricingTable && typeof data.pricingTable === 'object' ? data.pricingTable : null,
    currency: typeof data.currency === 'string' ? data.currency : null,
    isDemoPrice: typeof data.isDemoPrice === 'boolean' ? data.isDemoPrice : null,
    effectiveFrom: typeof data.effectiveFrom === 'string' ? data.effectiveFrom : null,
  }
}

/** A16 —— 套餐档位列表（裸数组）。 */
export async function getPlans(options = {}) {
  const bundle = await fetchPlansBundle(options)
  return bundle.plans
}

/**
 * A17 —— 套餐对比表。
 * `pricingTable` 缺失 ⇒ 返回 `null`（**不拿 `plans` 拼一张假表**：页面会走「暂无充值配置」空态）。
 */
export async function getPricingTable(options = {}) {
  const bundle = await fetchPlansBundle(options)
  return bundle.pricingTable
}
