/**
 * `/api/console` —— 控制台五端点的**单入口 `?op=` 分派**（A1/A10 组对外契约一字不改）。
 *
 * ★ 2026-10-19 函数合并（21→8，过 Vercel Hobby「12 个 Serverless Functions」上限）：
 *   原 5 个函数文件（`api/v1/{config,plans,account,ledger}.js`、`api/v1/seals.js`）
 *   迁入 `api/_lib/ops/`（下划线目录**不注册为函数**），由本入口按 `?op=` 分派：
 *     op=config | plans | account | ledger | seals
 *   对外 URL **逐字不变** —— `vercel.json` 把旧路径 rewrite 折成 `?op=`（新增条目位于
 *   keys/seals 既有 rewrite 之后、末条 `/api/(.*)` 兜底之前，既有条目逐字未动）：
 *     GET /api/v1/config        ⇒ /api/console?op=config
 *     GET /api/v1/plans         ⇒ /api/console?op=plans
 *     GET /api/v1/account       ⇒ /api/console?op=account
 *     GET /api/v1/ledger        ⇒ /api/console?op=ledger
 *     GET /api/v1/seals         ⇒ /api/console?op=seals          （列表）
 *     GET /api/v1/seals/{id}    ⇒ /api/console?op=seals&id={id}   （单条）
 *   seals 单条**继续用 `?id=`**：op=seals 交给 `createSealsCatchAllHandler`
 *   （其「`?id=` 优先 ⇒ 单条，否则列表」的内部分派与逐文件时代逐字同构）。
 *   每个 op 的 handler 仍由**原工厂**构造（`createRouteHandler` 调用链、方法门 / Allow 头 /
 *   统一信封逐字同构，只是入口从「文件」变「分派」）。分派判据只读 `?op=`（`req.url`
 *   查询串优先、兼容 `req.query` —— 与 `pagination.getSearchParams` 同口径）。
 *   未识别 op（含裸 `/api/console` 直调）⇒ 与全站兜底同信封 404 `NOT_FOUND`（预检仍 204）。
 */
import { handlePreflight } from '../_lib/cors.js'
import { getSearchParams } from '../_lib/pagination.js'
import { failWith } from '../_lib/respond.js'
import { createSealsCatchAllHandler } from '../_lib/ops/console-seals.js'
import { createAccountHandler } from '../_lib/ops/console-account.js'
import { createConfigHandler } from '../_lib/ops/console-config.js'
import { createLedgerHandler } from '../_lib/ops/console-ledger.js'
import { createPlansHandler } from '../_lib/ops/console-plans.js'

/** op 表（键即对外 `?op=` 值；值即原单文件工厂，构造参数原样透传）。 */
const OP_FACTORIES = {
  config: createConfigHandler,
  plans: createPlansHandler,
  account: createAccountHandler,
  ledger: createLedgerHandler,
  // seals 是自带「列表/单条」两形态的单入口分派（`?id=` 优先），与 keys 同一套结论
  seals: createSealsCatchAllHandler
}

/** 请求的 op（`?op=`，trim 后精确匹配 —— 与 URL 契约逐字对应，不做大小写归一）。 */
export function consoleOpOf(req) {
  const raw = getSearchParams(req).get('op')
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 单入口分派器：按 `?op=` 交给对应 handler。
 * 各 op 的方法门 / Allow / 会话鉴权仍由各自 `createRouteHandler` 负责 ⇒ 与逐文件时代逐字一致。
 */
export function createConsoleDispatchHandler(options = {}) {
  const handlers = {}
  for (const [op, create] of Object.entries(OP_FACTORIES)) handlers[op] = create(options)

  return async function handler(req, res) {
    const chosen = handlers[consoleOpOf(req)]
    if (chosen) return chosen(req, res)
    // 未识别 op：与全站兜底同信封（预检仍 204）
    if (handlePreflight(req, res)) return undefined
    failWith(res, 404, 'NOT_FOUND')
    return undefined
  }
}

export default createConsoleDispatchHandler()
