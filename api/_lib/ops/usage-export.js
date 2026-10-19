/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/usage/export.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/usage/index.js（op=export）` 按 `?op=` 分派。
 * `GET /api/v1/usage/export`（A14）—— 导出 CSV（UTF-8 BOM，表尾双口径汇总）。
 *
 * 响应：200 `{ ok:true, data:{ fileName, mimeType, content, rowCount, truncated, summary } }`
 *   `summary` 含 `detailImageBytes` / `displayChannelBytes` / `imageBytes` / `note`（与 A10 同口径）。
 *
 * ★ 分批：`_id` 升序 keyset 游标，每批 500 行；受 `EXPORT_MAX_ROWS`（5000）与
 *   `EXPORT_BUDGET_MS`（20s < 函数 30s）双重约束。到点/到量即停，**如实回 `truncated:true`**，
 *   绝不假装导全（CSV 内容与 `rowCount` 一致）。
 * ★ 无数据 ⇒ 只有表头 + 汇总区（全 0），仍是合法 CSV（不 404）。
 * ★ `displayChannelBytes` 恒 0（后端暂无展示通道计量），注记行写明口径。
 *   400 INVALID_PARAM / 401 / 405（`Allow: GET`）/ 503
 */
import { createRouteHandler } from '../routeHandler.js'
import { sessionAuthenticator } from '../sessionRoute.js'
import { exportUsageCsv, loadKeyLabels, parseUsageQuery } from '../usage.js'

export function createUsageExportHandler(options = {}) {
  return createRouteHandler('v1/usage/export', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async ({ req, db, auth }) => {
      const startedAt = Date.now()
      const query = parseUsageQuery(req, { nowMs: options.nowMs })
      const keyLabels = await loadKeyLabels(db, auth.user.id)
      const data = await exportUsageCsv(db, auth.user.id, query, {
        keyLabels,
        startedAt,
        budgetMs: options.budgetMs,
        maxRows: options.maxRows,
        nowMs: options.nowMs
      })
      return { status: 200, body: { ok: true, data } }
    }
  })
}

export default createUsageExportHandler()
