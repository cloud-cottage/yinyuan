/**
 * ============================================================================
 * 套餐 / 价格表适配层（A16 / A17 / A18）—— `GET /api/v1/plans` 的前端唯一实现
 *
 * ★ 公开只读面（服务端已实现）：`GET /api/v1/plans` 不要求会话（`/pricing` 与首页
 *   是未登录营销页）⇒ 本层 `fetchPlansBundle` 一律 `authed: false`。
 *
 * 端点（B2）：
 *   GET /api/v1/plans   200 `{ ok:true, data:{ currency, isDemoPrice, effectiveFrom,
 *                          plans:[Plan], pricingTable:{...}, pricingSource } }`
 *   405 / 503 NOT_CONFIGURED
 *
 * 一次响应带两段（`plans` / `pricingTable`），前端两个方法各取所需：
 *   · A16 `getPlans()`        ⇒ `data.plans`（**裸数组**，与 mock 同形）；
 *   · A17 `getPricingTable()` ⇒ `data.pricingTable`（含 `rows` / `recharge` / `deduction` /
 *     `originalImageDownload` / `displaySlices` / `disclaimer` / `scenario*`，与 mock 同形）。
 *   · A18 `computeScenario()` ⇒ **不另发请求**：用同一响应的 `pricingTable` 作输入，
 *     复用 `@/config/pricing.js` 的同一套纯函数在本地计算（前后端一致性来源）。
 *
 * 纪律：本层**不重算、不补齐、不写任何金额或包量字面量** —— 金额一律整数分、逐字取自服务端
 * （服务端又取自 `src/config/pricing.js` 单一数据源）。缺字段 ⇒ 缺（页面按「—」展示）。
 * ============================================================================
 */
import { request } from './auth.js'
import { computeScenario as computeScenarioPure } from '@/config/pricing.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const PLANS_PATH = '/plans'

/**
 * 服务端信封 → `{ plans, pricingTable }`（**一次请求供两个契约方法**）。
 * @param {{fetchImpl?:Function}} [options]
 * @returns {Promise<{plans:Array<object>, pricingTable:object|null, currency:string|null,
 *                    isDemoPrice:boolean|null, effectiveFrom:string|null}>}
 */
export async function fetchPlansBundle(options = {}) {
  // ★ 公开只读面（与服务端 `GET /api/v1/plans` 同裁定）：`/pricing` 与首页是未登录营销页，
  //   价格表必须在无会话时可读 ⇒ `authed: false`（标成 `true` 会在本地直接 401、不发请求，
  //   未登录访客看到的是「读取定价配置失败」而非价格）。
  const { payload } = await request(PLANS_PATH, { method: 'GET', authed: false, ...options })
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

/** 算例输入不完整的结构化失败（如实报错，不回落本地配置、不编数）。 */
function pricingIncomplete(message, missing) {
  const error = new Error(message)
  error.name = 'ApiError'
  error.ok = false
  error.code = 'PRICING_INCOMPLETE'
  error.reason = 'PRICING_INCOMPLETE'
  error.missing = missing
  return error
}

/**
 * A18 —— 典型场景算例（**前端纯函数**，非端点；`ENDPOINTS.computeScenario` 已注明
 * 「可复用前端纯函数，前后端一致性来源」）。
 *
 * 复用 mock 同一套纯函数 `computeScenarioPure`（`@/config/pricing.js`），**不另写第二套算法**；
 * 金额 / 包量 / 单价 / 免费额度等输入**逐字取自服务端已下发的 `pricingTable`**（A17 同一响应），
 * 本层不硬编码任何价格或包量。
 * 输入缺失（未取到 `pricingTable` / 服务端数据缺字段）⇒ 抛 `PRICING_INCOMPLETE`，**不编数**。
 */
export async function computeScenario(input = {}, options = {}) {
  const bundle = await fetchPlansBundle(options)
  const table = bundle.pricingTable
  if (!table || typeof table !== 'object') {
    throw pricingIncomplete('算例计算失败：服务端未下发价目表（pricingTable 缺失），本层不回落本地配置。', ['pricingTable'])
  }
  return computeScenarioPure(input, {
    plans: table.rows,
    scenario: table.scenario,
    quota: table.originalImageDownload,
    currency: table.currency,
    isDemoPrice: table.isDemoPrice,
    setupFee: table.setupFee,
    disclaimer: table.disclaimer,
  })
}
