/**
 * `/api/usage` —— 用量五端点的**单入口 `?op=` 分派**（A10–A14 对外契约一字不改）。
 *
 * ★ 2026-10-19 函数合并（21→8，过 Vercel Hobby「12 个 Serverless Functions」上限）：
 *   原 5 个函数文件（`api/v1/usage/{summary,breakdown,trend,records,export}.js`）
 *   迁入 `api/_lib/ops/`（下划线目录**不注册为函数**），由本入口按 `?op=` 分派：
 *     op=summary | breakdown | trend | records | export
 *   对外 URL **逐字不变** —— `vercel.json` 把旧路径 rewrite 折成 `?op=`（新增条目位于
 *   keys/seals 既有 rewrite 之后、末条 `/api/(.*)` 兜底之前，既有条目逐字未动）：
 *     GET /api/v1/usage/summary    ⇒ /api/usage?op=summary
 *     GET /api/v1/usage/breakdown  ⇒ /api/usage?op=breakdown
 *     GET /api/v1/usage/trend      ⇒ /api/usage?op=trend
 *     GET /api/v1/usage/records    ⇒ /api/usage?op=records
 *     GET /api/v1/usage/export     ⇒ /api/usage?op=export
 *   每个 op 的 handler 仍由**原工厂**构造（`createRouteHandler` + `sessionAuthenticator`
 *   调用链逐字同构，只是入口从「文件」变「分派」）。分派判据只读 `?op=`（`req.url`
 *   查询串优先、兼容 `req.query` —— 与 `pagination.getSearchParams` 同口径），其余查询
 *   参数（limit / offset / dim / bucket / cursor 等）原样透传给各 op，与既有口径一致。
 *   未识别 op（含裸 `/api/usage` 直调）⇒ 与全站兜底同信封 404 `NOT_FOUND`（预检仍 204）。
 */
import { handlePreflight } from '../_lib/cors.js'
import { getSearchParams } from '../_lib/pagination.js'
import { failWith } from '../_lib/respond.js'
import { createUsageBreakdownHandler } from '../_lib/ops/usage-breakdown.js'
import { createUsageExportHandler } from '../_lib/ops/usage-export.js'
import { createUsageRecordsHandler } from '../_lib/ops/usage-records.js'
import { createUsageSummaryHandler } from '../_lib/ops/usage-summary.js'
import { createUsageTrendHandler } from '../_lib/ops/usage-trend.js'

/** op 表（键即对外 `?op=` 值；值即原单文件工厂，构造参数原样透传）。 */
const OP_FACTORIES = {
  summary: createUsageSummaryHandler,
  breakdown: createUsageBreakdownHandler,
  trend: createUsageTrendHandler,
  records: createUsageRecordsHandler,
  export: createUsageExportHandler
}

/** 请求的 op（`?op=`，trim 后精确匹配 —— 与 URL 契约逐字对应，不做大小写归一）。 */
export function usageOpOf(req) {
  const raw = getSearchParams(req).get('op')
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 单入口分派器：按 `?op=` 交给对应 handler。
 * 各 op 的方法门 / Allow / 会话鉴权仍由各自 `createRouteHandler` 负责 ⇒ 与逐文件时代逐字一致。
 */
export function createUsageDispatchHandler(options = {}) {
  const handlers = {}
  for (const [op, create] of Object.entries(OP_FACTORIES)) handlers[op] = create(options)

  return async function handler(req, res) {
    const chosen = handlers[usageOpOf(req)]
    if (chosen) return chosen(req, res)
    // 未识别 op：与全站兜底同信封（预检仍 204）
    if (handlePreflight(req, res)) return undefined
    failWith(res, 404, 'NOT_FOUND')
    return undefined
  }
}

export default createUsageDispatchHandler()
