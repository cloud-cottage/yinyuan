/**
 * A1 `GET /api/v1/config` 的**纯静态投影**。
 *
 * ★ 单一数据源：直接 import 前端配置模块 `src/config/app-config.js`（不另写副本）。
 *   改配置只改那一处，端点与页面自动一致。
 * ★ 口令红线：`demo.password`（演示口令）与 `demo.captcha`（验证码占位值）**永不外发**。
 *   本模块用**白名单**投影 `demo` 段（只列字段名），而不是「删掉 password」——
 *   这样日后配置里新增任何凭据类字段都不会被顺手带出去。
 * ★ `dataSource: 'api'` 与 mock 实现的同名字段对齐（页面据此显示数据源）。
 */
import { APP_CONFIG } from '../../src/config/app-config.js'

/** 配置来源（写进响应，便于对拍「改动需双改」的替代方案是否被误用）。 */
export const CONFIG_SOURCE = 'src/config/app-config.js'

/** `demo` 段允许外发的字段（**白名单**；口令/验证码一律不在表内）。 */
export const DEMO_PUBLIC_FIELDS = Object.freeze([
  'showDemoAccount',
  'account',
  'label',
  'buttonLabel',
  'signInEnabled'
])

/**
 * api 模式的 `demo.label` 覆写：共享配置里的原文「演示账号（演示环境：登录不校验真实凭证）」
 * 只对 **mock** 成立；api 模式的演示登录由服务端代签会话（`POST /auth/demo-login`），
 * 沿用原说法即与实现相反 ⇒ 对外投影改写为与 api 模式不矛盾的表述（口令/验证码仍不外发）。
 */
const DEMO_LABEL_API = '演示账号（预置账号，由服务端校验并代签会话）'

/** 浅拷贝并只保留白名单字段；缺失字段不补默认值（缺就是缺）。 */
function projectDemo(demo) {
  const out = {}
  for (const name of DEMO_PUBLIC_FIELDS) {
    if (demo && demo[name] !== undefined) out[name] = demo[name]
  }
  if (out.label !== undefined) out.label = DEMO_LABEL_API
  return out
}

/**
 * 对外投影（全部字段来自 `APP_CONFIG`；本函数**不产生任何新数值**）。
 * @returns {object} `{ featureFlags, site, demo, apiKeyLimit, orderPendingTimeoutMinutes,
 *                      demoEnvQuota, notConnectedNotice, dataSource }`
 */
export function projectAppConfig() {
  return {
    featureFlags: { ...APP_CONFIG.featureFlags },
    site: { ...APP_CONFIG.site },
    demo: projectDemo(APP_CONFIG.demo),
    apiKeyLimit: APP_CONFIG.apiKeyLimit,
    orderPendingTimeoutMinutes: APP_CONFIG.orderPendingTimeoutMinutes,
    demoEnvQuota: { ...APP_CONFIG.demoEnvQuota },
    notConnectedNotice: APP_CONFIG.notConnectedNotice,
    dataSource: 'api',
    configSource: CONFIG_SOURCE
  }
}
