/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/config.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/console/index.js（op=config）` 按 `?op=` 分派。
 * `GET /api/v1/config`（A1）—— 站点级配置投影（**纯静态，不查库**）。
 *
 * ★ **公开只读面**（Zang 2026-10-19 裁定一）：**不要求会话**。
 *   理由：`/`（首页）与 `/pricing` 是**未登录**的营销页面，价格表与站点配置必须在
 *   无会话时也能读到；此前要求 `Session` ⇒ 营销页必然走满 401 错误态。
 *   公开后仍保留：方法门（非 `GET` ⇒ 405 + `Allow: GET`）、统一信封、
 *   `Cache-Control: no-store`、边缘缓存禁令（见 `respond.js`）——一律不变。
 *   **其余 7 条控制台端点（account / usage×5 / ledger）维持会话必填**，不得顺手公开。
 *
 * 响应：200 `{ ok:true, data:{ featureFlags, site, demo, apiKeyLimit,
 *            orderPendingTimeoutMinutes, demoEnvQuota, notConnectedNotice, dataSource } }`
 *   405 METHOD_NOT_ALLOWED（`Allow: GET`）
 *
 * ★ 数值全部来自 `src/config/app-config.js`（`api/_lib/appConfig.js` 只做白名单投影）。
 * ★ `demo.password` / `demo.captcha` **永不返回**（口令红线；公开后更须守住）。
 *   口令不公开 ⇒ 演示一键登录必须由服务端代签，见 `POST /api/v1/auth/demo-login`。
 * ★ 不碰账号表：`dbAccess: false` 让路由工厂**跳过云库句柄解析**——
 *   公开配置面在「云库未配置」的环境（本地 / 预览）也必须能回 200，而不是 503。
 */
import { projectAppConfig } from '../appConfig.js'
import { createRouteHandler } from '../routeHandler.js'

export function createConfigHandler(options = {}) {
  return createRouteHandler('v1/config', {
    methods: ['GET'],
    db: options.db || null,
    dbAccess: false,
    run: async () => ({ status: 200, body: { ok: true, data: projectAppConfig() } })
  })
}

export default createConfigHandler()
