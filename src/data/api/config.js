/**
 * ============================================================================
 * 站点配置适配层（A1）—— `GET /api/v1/config` 的前端唯一实现
 *
 * 端点（B2，服务端已实现待部署）：
 *   GET /api/v1/config   200 `{ ok:true, data:{ featureFlags, site, demo, apiKeyLimit,
 *                            orderPendingTimeoutMinutes, demoEnvQuota, notConnectedNotice,
 *                            dataSource, configSource } }`
 *   401 UNAUTHORIZED / 405 / 503 NOT_CONFIGURED
 *
 * 职责（只三件）：
 *   ① 解 **服务端信封** `{ok,data}` —— 页面拿到的仍是 A1 契约的扁平对象（与 mock 同形）；
 *   ② 数值字段**逐字取值**：缺就是缺（`null`），不补默认值 —— 补了就会在界面上冒充「配置已给」；
 *   ③ `demo` 段**只透传服务端给到的字段**：服务端按白名单投影（口令 / 验证码占位值永不外发），
 *      本层不拼装、不猜测、不回落本地 `src/config/app-config.js` 的 `demo.password`。
 *
 * 纪律：本文件**零演示数据**、**零凭证字面量**、失败即结构化失败（不回落到本地 mock）。
 * ============================================================================
 */
import { request } from './auth.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const CONFIG_PATH = '/config'

/** 有限数（缺 / 非数 ⇒ null，不补 0）。 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 数据源字面量白名单（非法值 ⇒ null，页面据此回落构建期开关）。 */
function dataSourceOf(value) {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'api' || raw === 'mock' ? raw : null
}

/**
 * 服务端配置投影 → A1 契约形状（与 mock `getAppConfig()` 同形）。
 * @param {object|null} raw `payload.data`
 * @returns {object|null}
 */
export function normalizeAppConfig(raw) {
  if (!raw || typeof raw !== 'object') return null
  const demo = raw.demo && typeof raw.demo === 'object' ? { ...raw.demo } : null
  return {
    featureFlags: raw.featureFlags && typeof raw.featureFlags === 'object' ? { ...raw.featureFlags } : {},
    site: raw.site && typeof raw.site === 'object' ? { ...raw.site } : {},
    demo,
    apiKeyLimit: numberOrNull(raw.apiKeyLimit),
    orderPendingTimeoutMinutes: numberOrNull(raw.orderPendingTimeoutMinutes),
    demoEnvQuota: raw.demoEnvQuota && typeof raw.demoEnvQuota === 'object' ? { ...raw.demoEnvQuota } : null,
    notConnectedNotice: typeof raw.notConnectedNotice === 'string' ? raw.notConnectedNotice : null,
    /** `api` | `mock` | null（未知值不猜，页面回落到 `RESOLVED_DATA_SOURCE`）。 */
    dataSource: dataSourceOf(raw.dataSource),
    configSource: typeof raw.configSource === 'string' ? raw.configSource : null,
  }
}

/**
 * A1 —— 取站点配置。
 *
 * ★ **公开端点**（实测：不带 `Authorization` 直接 `GET /api/v1/config` ⇒ 200 全量投影）。
 *   因此这里 `authed: false`：若标成 `authed: true`，无会话时请求层会在**本地**先拒绝
 *   （不发请求、直接 401 + 派发会话失效），登录页就永远拿不到 `demo.signInEnabled`，
 *   「一键登录演示账号」在 api 模式被本地逻辑挡掉（服务端其实是公开下发的）。
 *   服务端若对某些部署改成需鉴权并回 401，本层照常抛结构化失败，页面按失败态处理（不伪造配置）。
 *
 * @param {{fetchImpl?:Function}} [options] 仅供自检注入 fetch
 * @returns {Promise<object>} A1 契约对象（含 `dataSource`）
 */
export async function getAppConfig(options = {}) {
  const { payload } = await request(CONFIG_PATH, { method: 'GET', authed: false, ...options })
  return normalizeAppConfig(payload && payload.data)
}
