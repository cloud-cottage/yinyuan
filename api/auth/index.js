/**
 * `/api/auth` —— 会话五端点的**单入口 `?op=` 分派**（B2 对外契约一字不改）。
 *
 * ★ 2026-10-19 函数合并（21→8，过 Vercel Hobby「12 个 Serverless Functions」上限）：
 *   原 5 个函数文件（`api/v1/auth/{login,register,logout,demo-login}.js`、`api/v1/me.js`）
 *   迁入 `api/_lib/ops/`（下划线目录**不注册为函数**），由本入口按 `?op=` 分派：
 *     op=login | register | demo-login | logout | me
 *   对外 URL **逐字不变** —— `vercel.json` 把旧路径 rewrite 折成 `?op=`（新增条目位于
 *   keys/seals 既有 rewrite 之后、末条 `/api/(.*)` 兜底之前，既有条目逐字未动）：
 *     POST /api/v1/auth/login        ⇒ /api/auth?op=login
 *     POST /api/v1/auth/register     ⇒ /api/auth?op=register
 *     POST /api/v1/auth/demo-login   ⇒ /api/auth?op=demo-login
 *     POST /api/v1/auth/logout       ⇒ /api/auth?op=logout
 *     GET  /api/v1/me                ⇒ /api/auth?op=me
 *   每个 op 的 handler 仍由**原工厂**构造（`createRouteHandler` 调用链、方法门 / Allow 头 /
 *   统一信封 / 限流 scope 逐字同构，只是入口从「文件」变「分派」）。分派判据只读 `?op=`
 *   （`req.url` 查询串优先、兼容 `req.query` —— 与 `pagination.getSearchParams` 同口径，
 *   生产 rewrite 与本地直调两条通道都覆盖）。
 *   未识别 op（含裸 `/api/auth` 直调）⇒ 与全站兜底同信封 404 `NOT_FOUND`（预检仍 204）。
 */
import { handlePreflight } from '../_lib/cors.js'
import { getSearchParams } from '../_lib/pagination.js'
import { createDemoLoginHandler } from '../_lib/ops/auth-demo-login.js'
import { createLoginHandler } from '../_lib/ops/auth-login.js'
import { createLogoutHandler } from '../_lib/ops/auth-logout.js'
import { createMeHandler } from '../_lib/ops/auth-me.js'
import { createRegisterHandler } from '../_lib/ops/auth-register.js'
import { failWith } from '../_lib/respond.js'

/** op 表（键即对外 `?op=` 值；值即原单文件工厂，构造参数原样透传）。 */
const OP_FACTORIES = {
  login: createLoginHandler,
  register: createRegisterHandler,
  'demo-login': createDemoLoginHandler,
  logout: createLogoutHandler,
  me: createMeHandler
}

/** 请求的 op（`?op=`，trim 后精确匹配 —— 与 URL 契约逐字对应，不做大小写归一）。 */
export function authOpOf(req) {
  const raw = getSearchParams(req).get('op')
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 单入口分派器：按 `?op=` 交给对应 handler。
 * 各 op 的方法门 / Allow / 鉴权 / 限流仍由各自 `createRouteHandler` 负责 ⇒ 与逐文件时代逐字一致。
 */
export function createAuthDispatchHandler(options = {}) {
  const handlers = {}
  for (const [op, create] of Object.entries(OP_FACTORIES)) handlers[op] = create(options)

  return async function handler(req, res) {
    const chosen = handlers[authOpOf(req)]
    if (chosen) return chosen(req, res)
    // 未识别 op：与全站兜底同信封（预检仍 204）
    if (handlePreflight(req, res)) return undefined
    failWith(res, 404, 'NOT_FOUND')
    return undefined
  }
}

export default createAuthDispatchHandler()
