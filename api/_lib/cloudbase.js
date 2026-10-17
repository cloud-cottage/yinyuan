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

/**
 * 本实例内**首个** database 句柄的创建时刻（ms）。诊断用：配合 dataset.js 的操作计时，
 * 可读出「实例从拿到句柄到首个云库读完成」的耗时（≈ 建连 + 首查），供区域/线路前后对比。
 * 未创建过句柄 ⇒ 返回 -1。
 */
let handleCreatedAt = 0
export function cbHandleAgeMs() {
  return handleCreatedAt === 0 ? -1 : Date.now() - handleCreatedAt
}

/**
 * ★ 句柄寿命上限（2026-10-17 暖实例死句柄修复）。
 *
 * 现象（线上读数）：同一暖实例内 `handleAgeMs` 一路涨到 ≈1,092,000ms（≈18 分钟），
 * 期间 `authors` 的每次取数都在**建连阶段** ETIMEDOUT（attempts=3 全失败），
 * 而同刻 `dynasties` 因命中实例缓存（日志 `cache=hit ms=0`）看起来正常。
 * 即：**长期复用的 SDK 句柄里的 keepalive 连接被网关/NAT 静默收掉后不会自愈**，
 * 且「拿同一个死连接重试三次」必然三次都失败。
 *
 * ⇒ 预防项：句柄超过本上限即**主动重建**（新 app ⇒ 新连接池），默认 120s，
 *   可用环境变量 `CB_HANDLE_MAX_AGE_MS` 覆盖（下限钳 1000ms，避免误配成每请求重建）。
 */
function handleMaxAgeMs() {
  const raw = process.env.CB_HANDLE_MAX_AGE_MS
  const n = typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n) || n <= 0) return 120 * 1000
  return Math.max(1000, Math.floor(n))
}

/** 重建/作废句柄的服务端日志（**不含**凭据、key、URL、堆栈）。 */
function logRebuild(reason, ageMs) {
  console.warn(
    `[api] cb handle handleRebuilt=1 rebuiltReason=${reason} handleAgeMs=${ageMs}`
  )
}

/**
 * ★ 作废旧句柄（失败后丢弃；2026-10-17 死句柄修复）。
 *
 * 由 `dataset.js` 在任一取数遇**瞬时错**（ETIMEDOUT 等）时调用：
 * 死连接必须当场丢掉，下一次尝试/下一个请求才可能拿到活连接。
 * 只作废「调用方实际在用的那一个」句柄（`staleDb` 比对）—— 并发分支里
 * 已有人先重建时，后来者不会把新句柄又打掉。
 *
 * @returns {boolean} 是否真的作废了（false ＝ 已有别的分支先重建）
 */
export function invalidateDb(reason = 'transient', staleDb = null) {
  if (!cached) return false
  if (staleDb && cached.db !== staleDb) return false
  const ageMs = cbHandleAgeMs()
  cached = null
  handleCreatedAt = 0
  logRebuild(reason, ageMs)
  return true
}

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
  if (cached) {
    const ageMs = cbHandleAgeMs()
    const sameConfig = cached.cacheKey === cacheKey
    if (sameConfig && ageMs >= 0 && ageMs < handleMaxAgeMs()) return cached.db
    // 超过寿命上限（或凭据变更）⇒ 主动重建，不等它坏掉
    cached = null
    handleCreatedAt = 0
    logRebuild(sameConfig ? 'age' : 'config', ageMs)
  }
  const app = tcb.init({
    env: cfg.env,
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    timeout: CB_REQUEST_TIMEOUT_MS
  })
  const db = app.database()
  const createdAt = Date.now()
  cached = { cacheKey, db, createdAt }
  handleCreatedAt = createdAt
  return db
}
