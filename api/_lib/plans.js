/**
 * A16 `getPlans` / A17 `getPricingTable` 的投影（`GET /api/v1/plans` 单端点共用）。
 *
 * ★ 单一数据源：全部取自前端配置模块 `src/config/pricing.js` 的
 *   `getPlans()` / `getPricingTable()`（金额一律整数分、币种 CNY、`isDemoPrice`）。
 *   本模块**不写任何金额/包量字面量**，也不重算套餐字段。
 * ★ 一次响应带两段：`plans`（A16 列表语义）与 `pricingTable`（A17 对比表语义）。
 *   前端两个方法共用同一 URL 时各取所需，避免两处口径漂移。
 */
import { PRICING, getPlans, getPricingTable } from '../../src/config/pricing.js'

/** 配置来源（对拍用）。 */
export const PRICING_SOURCE = 'src/config/pricing.js'

/**
 * 严格按 planId 取档位（**未知档位返回 null**，不像前端 `getPlanById` 那样静默回落首档——
 * 服务端回包必须如实反映「账号挂的档位不在套餐表里」，不能替用户改档）。
 * @param {string} planId
 * @returns {object|null}
 */
export function findPlan(planId) {
  const wanted = typeof planId === 'string' ? planId.trim() : ''
  if (wanted === '') return null
  return getPlans().find((plan) => plan.planId === wanted) || null
}

/** 对外投影：`{ currency, isDemoPrice, effectiveFrom, plans, pricingTable }`。 */
export function projectPlans() {
  return {
    currency: PRICING.currency,
    isDemoPrice: PRICING.isDemoPrice,
    effectiveFrom: PRICING.effectiveFrom,
    plans: getPlans(),
    pricingTable: getPricingTable(),
    pricingSource: PRICING_SOURCE
  }
}
