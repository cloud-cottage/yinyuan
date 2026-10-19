/**
 * `GET /api/v1/config`（A1）—— 站点级配置投影（**纯静态，不查库**）。
 *
 * 响应：200 `{ ok:true, data:{ featureFlags, site, demo, apiKeyLimit,
 *            orderPendingTimeoutMinutes, demoEnvQuota, notConnectedNotice, dataSource } }`
 *   401 UNAUTHORIZED   —— 缺/坏会话令牌（本端点也要求会话：配置里含运营开关）
 *   405 METHOD_NOT_ALLOWED（`Allow: GET`）
 *   503 NOT_CONFIGURED —— 账号表不可用 / 缺会话密钥（鉴权失败面，与其它端点同口径）
 *
 * ★ 数值全部来自 `src/config/app-config.js`（`api/_lib/appConfig.js` 只做白名单投影）。
 * ★ `demo.password` / `demo.captcha` **永不返回**（口令红线）。
 */
import { projectAppConfig } from '../_lib/appConfig.js'
import { createRouteHandler } from '../_lib/routeHandler.js'
import { sessionAuthenticator } from '../_lib/sessionRoute.js'

export function createConfigHandler(options = {}) {
  return createRouteHandler('v1/config', {
    methods: ['GET'],
    db: options.db || null,
    authenticate: sessionAuthenticator(options),
    run: async () => ({ status: 200, body: { ok: true, data: projectAppConfig() } })
  })
}

export default createConfigHandler()
