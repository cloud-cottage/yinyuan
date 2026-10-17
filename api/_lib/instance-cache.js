/**
 * 实例级内存缓存（印源对外只读 API v1）。
 *
 * ★ 为什么需要（2026-10-17 并发修复，线上证据见 `api/_lib/resilience.js` 顶部注释）：
 *   并发 5 路时冷实例的**建连阶段**超时（`connect timeout` / `code=ETIMEDOUT`）会整层放大成 500；
 *   同一实例在 60s 内重复请求同一 URL 时，**根本不需要再打云库** —— 少一次建连就少一次失败面。
 *
 * ★ 纪律（不得违反）：
 *   - **只缓存 200 的数据**：`write` 只在本服务成功取数后调用 ⇒ 401 / 404 / 405 / 500 / 503
 *     永不入缓存（错误面由 handler 的失败分支直接落响应，不经过本模块）。
 *   - **缓存键必须含鉴权结果**：键 = 路由名 + 路径 + 规范化查询串 + **鉴权指纹**
 *     （`sha256(调用方 key)` 前 16 位；只驻内存、**不入日志、不入响应、不入磁盘**）。
 *     ∴ 换用别的 key（错 key）要么命中不了（指纹不同）、要么根本走不到这里（401 不入缓存）
 *     —— 金钥错配**不可能**取到别人的 200 缓存体。
 *   - 有界：TTL 60s ＋ 条目数上限 128（超限按插入序 FIFO 淘汰），不无界增长。
 *   - 进程级单例（随 serverless 实例生命周期存在；实例回收即失效，属正常且安全）。
 */
import { createHash } from 'node:crypto'

/** 实例级缓存 TTL（ms）。 */
export const INSTANCE_CACHE_TTL_MS = 60 * 1000

/** 条目数上限（FIFO 淘汰）。 */
export const INSTANCE_CACHE_MAX_ENTRIES = 128

const store = new Map()

/**
 * 鉴权指纹：`sha256(key)` 前 16 位十六进制。
 * 只用作**缓存键的一部分**（证明「同一缓存体只服务同一把 key」），不可逆、不可回显。
 */
export function authFingerprint(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 缓存键：`<route>|<path>|<规范化查询串>|<鉴权指纹>`。
 * 查询串按**参数名排序**规范化（同一组参数的书写顺序不同 ⇒ 同一缓存体）。
 */
export function cacheKeyOf(routeName, req, fingerprint) {
  const raw = req && typeof req.url === 'string' ? req.url : ''
  const qIndex = raw.indexOf('?')
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw
  const pairs = [...new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : '').entries()]
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const query = new URLSearchParams(pairs).toString()
  return `${routeName}|${path}|${query}|${fingerprint}`
}

/** 读缓存：命中且未过期 ⇒ 返回数据；否则 null（顺手清掉过期项）。 */
export function readCache(key) {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > INSTANCE_CACHE_TTL_MS) {
    store.delete(key)
    return null
  }
  return entry.data
}

/** 写缓存（只允许写**成功**数据；调用点见 handler）。 */
export function writeCache(key, data) {
  if (store.size >= INSTANCE_CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(key, { at: Date.now(), data })
}

/** 当前条目数与命中/未命中计数（诊断用；只进日志）。 */
let hitCount = 0
let missCount = 0
export function markHit() {
  hitCount += 1
}
export function markMiss() {
  missCount += 1
}
export function cacheStats() {
  return { size: store.size, hitCount, missCount }
}

/** 清空（仅本地 harness 使用）。 */
export function resetCache() {
  store.clear()
  hitCount = 0
  missCount = 0
}
