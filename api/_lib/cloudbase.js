/**
 * CloudBase（腾讯云开发）只读数据源（印源对外只读 API v1）。
 *
 * ★ 只读纪律：本模块只暴露 `count / orderBy+skip+limit+get / aggregate` 读面；
 *   不提供任何写面（add / update / set / remove / 写面云函数调用）。
 * ★ 凭据只从进程环境变量读：`CB_ENV` / `CB_SECRET_ID` / `CB_SECRET_KEY`；
 *   三者任一缺失 ⇒ 抛 NotConfiguredError（**绝不回落假数据 / 静态快照 / 演示数据**）。
 * ★ 不用 `@cloudbase/js-sdk`（那是浏览器端、走匿名/用户态权限，不适用服务端只读）。
 */
import tcb from '@cloudbase/node-sdk'
import { NotConfiguredError } from './respond.js'
import { CB_REQUEST_TIMEOUT_MS } from './resilience.js'

let cached = null

/** 读取并规整云端凭据（不回显值）。 */
export function cbConfig() {
  const read = (name) => (typeof process.env[name] === 'string' ? process.env[name].trim() : '')
  const env = read('CB_ENV')
  const secretId = read('CB_SECRET_ID')
  const secretKey = read('CB_SECRET_KEY')
  return { env, secretId, secretKey, configured: env !== '' && secretId !== '' && secretKey !== '' }
}

/** 数据源是否已配置（供 handler 在取数前判 503）。 */
export function isCloudBaseConfigured() {
  return cbConfig().configured
}

/**
 * 取 database 句柄（**模块作用域缓存**：暖实例复用同一 app 与同一 db 句柄，不重建）。
 * 未配置凭据 ⇒ 抛 NotConfiguredError。
 *
 * ★ 显式超时（2026-10-17 修复）：`tcb.init` 的 `timeout` **默认是 15000ms 的隐式默认值**
 *   （`normalizeConfig` 里 `timeout = 15000`），且 SDK 在**建连阶段**超时会抛
 *   `connect timeout`（`code=ETIMEDOUT`）。本仓显式传 `CB_REQUEST_TIMEOUT_MS`，
 *   使「单次云库请求」的时间上限成为**代码内可读、可评审、可调**的常量，
 *   并与 `resilience.js` 的有界重试 ＋ 请求级截止共同构成显式时间预算。
 */
export function getDb() {
  const cfg = cbConfig()
  if (!cfg.configured) throw new NotConfiguredError('cloudbase credentials missing')
  const cacheKey = `${cfg.env}|${cfg.secretId}|${cfg.secretKey}`
  if (cached && cached.cacheKey === cacheKey) return cached.db
  const app = tcb.init({
    env: cfg.env,
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    timeout: CB_REQUEST_TIMEOUT_MS
  })
  const db = app.database()
  cached = { cacheKey, db }
  return db
}
