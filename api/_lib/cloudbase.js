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
 * 取 database 句柄（模块级缓存；同进程复用同一 app 实例）。
 * 未配置凭据 ⇒ 抛 NotConfiguredError。
 */
export function getDb() {
  const cfg = cbConfig()
  if (!cfg.configured) throw new NotConfiguredError('cloudbase credentials missing')
  const cacheKey = `${cfg.env}|${cfg.secretId}|${cfg.secretKey}`
  if (cached && cached.cacheKey === cacheKey) return cached.db
  const app = tcb.init({ env: cfg.env, secretId: cfg.secretId, secretKey: cfg.secretKey })
  const db = app.database()
  cached = { cacheKey, db }
  return db
}
