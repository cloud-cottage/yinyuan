/**
 * 每日限额（印源对外只读 API v1）—— 规范 v1.43 §7.13-2 ＋ §7.14-1（AC-130 ／ AC-131 ／ AC-132）。
 *
 * 口径（逐条对应规范，不得自行调整）：
 *   - 上限 ＝ **1000 次 / 鉴权通过的 API key / 自然日**；窗口 ＝ `Asia/Shanghai` `00:00:00` 重置；
 *     **不设 QPS 上限**（本条不引入任何按秒限流）。
 *   - 计数键 ＝ 一次「鉴权通过」的 key（`Authorization` 优先、`X-API-Key` 备选；同一把 key 两种头
 *     形态**同计一份** —— 键只由 key 明文派生，与头形态无关）。
 *   - 计数点由调用方（`handler.js`）钉在「方法门 → 鉴权 → 数据源已配置」之后 ⇒
 *     `401` ／ `404` ／ `405` ／ `503` ／ 预检 `OPTIONS` **一律不计数**；`200` ／ `400` ／ `500` 计入。
 *   - 超限 ⇒ `429` ＋ `{ok:false,reason:"RATE_LIMITED",message:"今日调用次数已达上限，请明日再试。"}`
 *     （文案在 `respond.js` 单一来源；本模块只落码）。
 *   - **降级硬约束（§7.14-1 ③ (a)）**：计数存储不可达 ／ 超时 ／ 返回异常 ⇒ **放行且不 5xx**，
 *     只在服务端日志留一行 `degraded` 痕迹。
 *   - **保密（§7.14-1 ③ (e)）**：key 明文与存储令牌**不进日志 ／ 响应 ／ 429 文案**；
 *     日志只带「是否计数、动作、额度、原因标签」，指纹亦不落日志。
 *
 * 存储（§7.14-1 ①）：Vercel Marketplace 的 Redis/KV（Upstash 集成）**REST 接口**，
 * 用 Node 18+ 全局 `fetch` 直调，**不新增任何 npm 依赖**；连接参数一律由平台注入环境变量，
 * 代码里不写死任何地址 ／ 令牌 ／ 库名。
 *
 * 命令数：**每次请求 1 个 HTTP 请求、2 条命令（REST pipeline：`INCR` ＋ `EXPIRE … NX`）**。
 *   - `EXPIRE … NX` 只在「键尚无 TTL」时设置 ⇒ 不会把 TTL 反复推后，也不会跨日累积。
 *   - TTL ＝ 距下一次 CST `00:00:00` 的秒数 ＋ 300s 余量 ⇒ 覆盖整个窗口且不提前过期
 *     （§7.14-1 ③ (d)）。
 *   - 键形：`<前缀>:<CST 日期 YYYY-MM-DD>:<sha256(key) 前 16 位>` ⇒ 日期在键内，跨日自然换键，
 *     即使旧键因余量未到期也不会被新窗口读到。
 *
 * 可测性：环境变量覆盖 `RATE_LIMIT_MAX_PER_DAY`（缺省 1000、下限钳 1），**仅供测试**，
 *   不改变默认语义、不进对外文档；`evaluateRateLimit` 另有 `now / env / fetchImpl` 注入面。
 */
import { createHash } from 'node:crypto'
import { fail, failWith } from './respond.js'

/** 每日上限缺省值（规范值 1000 次 / 键 / 自然日）。 */
export const RATE_LIMIT_MAX_PER_DAY_DEFAULT = 1000

/** 窗口时区（规范口径；**不得按 UTC**）。 */
export const WINDOW_TIMEZONE = 'Asia/Shanghai'

/** 存储请求超时（ms）：短超时优先保业务可用性（§7.14-1 ③ (a)）。 */
export const STORE_TIMEOUT_MS = 800

/** 计数键前缀（§7.14-1 ④ 明写：前缀 ／ 命名空间不判负）。 */
export const KEY_PREFIX = 'yinyuan:rl'

/** TTL 余量（秒）：覆盖到窗口结束后仍保留一小段，避免边界秒提前过期。 */
export const TTL_SLACK_SECONDS = 300

/** CST 与 UTC 的固定偏移（Asia/Shanghai 自 1991 年起无夏令时，恒 +08:00）。 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/** CST 墙钟的年 / 月 / 日（用 Intl 取，不依赖本机时区设置）。 */
function cstDateParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WINDOW_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(nowMs))
  const pick = (type) => {
    const hit = parts.find((part) => part.type === type)
    return hit ? Number(hit.value) : NaN
  }
  return { year: pick('year'), month: pick('month'), day: pick('day') }
}

/** 窗口日期键：CST `YYYY-MM-DD`。 */
export function windowDayKey(nowMs = Date.now()) {
  const { year, month, day } = cstDateParts(nowMs)
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
}

/** 下一次 CST `00:00:00` 的 Unix 秒（`X-RateLimit-Reset` 语义，§7.13-2 ⑤）。 */
export function windowResetEpochSeconds(nowMs = Date.now()) {
  const { year, month, day } = cstDateParts(nowMs)
  // 次日 00:00:00 CST ＝ 当日 16:00:00 UTC（`Date.UTC` 自动处理月末 ／ 年末进位）
  return Math.floor((Date.UTC(year, month - 1, day + 1) - CST_OFFSET_MS) / 1000)
}

/** 上限：缺省 1000；`RATE_LIMIT_MAX_PER_DAY` 仅供测试覆盖，下限钳 1（空串视为未设）。 */
export function limitPerDay(env = process.env) {
  const raw = env && typeof env.RATE_LIMIT_MAX_PER_DAY === 'string' ? env.RATE_LIMIT_MAX_PER_DAY.trim() : ''
  if (raw === '') return RATE_LIMIT_MAX_PER_DAY_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n)) return RATE_LIMIT_MAX_PER_DAY_DEFAULT
  return Math.max(1, Math.floor(n))
}

/**
 * key 指纹：`sha256(key)` 前 16 位十六进制。
 * 与 `instance-cache.js` 的 `authFingerprint` 同构（同算法、同长度），但**只用于计数键**，
 * 不进日志、不进响应、不可逆。
 */
export function keyFingerprint(apiKey) {
  return createHash('sha256').update(String(apiKey == null ? '' : apiKey), 'utf8').digest('hex').slice(0, 16)
}

/** 计数键（导出的纯函数，便于 harness 断言键形）。 */
export function counterKeyOf(dayKey, fingerprint) {
  return `${KEY_PREFIX}:${dayKey}:${fingerprint}`
}

/** 计数存储异常（只带原因标签，**不带**地址 ／ 令牌 ／ 响应体）。 */
export class RateLimitStoreError extends Error {
  constructor(reason) {
    super(String(reason))
    this.name = 'RateLimitStoreError'
    this.reason = String(reason)
  }
}

/** 连接参数（地址类 ＋ 认证令牌类；**只读环境变量，不落盘、不回显**）。 */
function storeConfig(env) {
  const source = env || {}
  const url = String(source.KV_REST_API_URL || source.UPSTASH_REDIS_REST_URL || '')
    .trim()
    .replace(/\/+$/, '')
  const token = String(source.KV_REST_API_TOKEN || source.UPSTASH_REDIS_REST_TOKEN || '').trim()
  return { url, token }
}

/**
 * 计数 +1（REST pipeline：`INCR` ＋ `EXPIRE … NX`，1 次 HTTP / 2 条命令）。
 * 成功返回**当次累计值**（含本次）；任何异常一律抛 `RateLimitStoreError`（由调用方降级）。
 */
export async function incrCounter(options = {}) {
  const {
    dayKey,
    fingerprint,
    ttlSeconds,
    env = process.env,
    fetchImpl,
    timeoutMs = STORE_TIMEOUT_MS
  } = options
  const { url, token } = storeConfig(env)
  if (url === '' || token === '') throw new RateLimitStoreError('not_configured')

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') throw new RateLimitStoreError('no_fetch')

  const key = counterKeyOf(dayKey, fingerprint)
  // 只发 2 条命令：INCR（计数）＋ EXPIRE NX（首次设 TTL，后续不推后）
  const body = JSON.stringify([
    ['INCR', key],
    ['EXPIRE', key, Math.max(1, Math.floor(ttlSeconds)), 'NX']
  ])

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  // ★ 刻意**不** unref：该定时器必须在等待窗口内真实触发（超时即降级）。
  //   unref 后若事件循环无其他任务，Node 会提前退出（实测 exit code 13）。

  try {
    const response = await doFetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body,
      signal: controller ? controller.signal : undefined
    })
    if (!response || response.ok !== true) {
      throw new RateLimitStoreError(`http_${(response && response.status) || 'none'}`)
    }
    const payload = await response.json()
    const first = Array.isArray(payload) ? payload[0] : null
    if (!first || first.error) throw new RateLimitStoreError('command_error')
    const used = Number(first.result)
    if (!Number.isFinite(used)) throw new RateLimitStoreError('bad_result')
    return Math.floor(used)
  } catch (error) {
    if (error instanceof RateLimitStoreError) throw error
    const name = (error && error.name) || ''
    throw new RateLimitStoreError(name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 判定（纯决策，不写响应）：返回
 *   - `{ counted:true, allowed, limit, used, remaining, reset }`
 *   - `{ counted:false, allowed:true, limit, degraded:true, reason }`（存储不可用 ⇒ 放行）
 */
export async function evaluateRateLimit(options = {}) {
  const { apiKey, env = process.env, now = Date.now(), fetchImpl, timeoutMs } = options
  const limit = limitPerDay(env)
  const dayKey = windowDayKey(now)
  const reset = windowResetEpochSeconds(now)
  const ttlSeconds = Math.max(60, reset - Math.floor(now / 1000) + TTL_SLACK_SECONDS)

  try {
    const used = await incrCounter({
      dayKey,
      fingerprint: keyFingerprint(apiKey),
      ttlSeconds,
      env,
      fetchImpl,
      timeoutMs
    })
    return {
      counted: true,
      allowed: used <= limit,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      reset
    }
  } catch (error) {
    // ★ 降级：存储不可达 / 超时 / 报错 ⇒ 放行（绝不因限流回 5xx）
    return {
      counted: false,
      allowed: true,
      limit,
      degraded: true,
      reason: (error && error.reason) || 'unknown'
    }
  }
}

/**
 * handler 内的限额门：写 `X-RateLimit-*`（可选头，语义须正确）、必要时直接落 `429`。
 * 返回 `true` ⇒ 放行；`false` ⇒ 已回 429（调用方立即 return）。
 */
export async function enforceRateLimit(req, res, apiKey, options = {}) {
  const verdict = await evaluateRateLimit({ apiKey, ...options })
  if (typeof res.setHeader === 'function') {
    res.setHeader('X-RateLimit-Limit', String(verdict.limit))
  }

  if (!verdict.counted) {
    // 存储不可用 ⇒ 放行；余量与重置未知，故**不写** `Remaining` ／ `Reset`（头可选，写错才判负）
    console.warn(`[api/ratelimit] degraded counted=0 action=allow limit=${verdict.limit} reason=${verdict.reason}`)
    return true
  }

  if (typeof res.setHeader === 'function') {
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining))
    res.setHeader('X-RateLimit-Reset', String(verdict.reset))
  }

  if (verdict.allowed) return true

  // 429 属错误面：`respond.failWith` ⇒ `Cache-Control: no-store`、无边缘缓存指令（全仓已一律不下发）、
  // 带 `Access-Control-Allow-Origin: *`（§7.13-2 ⑥ ／ §7.13-3 ⑧）。
  // 日志只给读数，不含 key ／ 指纹 ／ 令牌。
  console.warn(
    `[api/ratelimit] limited counted=1 action=reject used=${verdict.used} limit=${verdict.limit} reset=${verdict.reset}`
  )
  failWith(res, 429, 'RATE_LIMITED')
  return false
}

/* ── 固定窗口节流（B2：登录 / 注册防爆破） ───────────────────────── */

/**
 * 会话端点节流口径（写死；改口径＝改本节并同轮升规范）。
 *
 * 与上面的「每日 1000 次/键」是**两件事**：
 *   - 那是**业务配额**（按 key 计、自然日窗口、超限文案「今日调用次数已达上限」）；
 *   - 这是**防爆破节流**（按「作用域 + 调用方指纹」计、固定短窗口、超限文案「尝试次数过多」）。
 * 存储复用同一 Redis 命名空间与同一 `incrCounter`（**不新增任何依赖 / 不新增环境变量**），
 * 键形 `yinyuan:rl:<scope>:<窗口序号>:<sha256(标识) 前 16 位>` —— 标识（IP / 手机号 / 邮箱）
 * **只以摘要形态出现**，Redis 里与日志里都没有原文。
 *
 * 取值理由：登录**两道** —— 同一 IP 30 次 / 10 分钟（挡「一个来源撞多账号」），
 * 同一标识 10 次 / 10 分钟（挡「多来源撞同一账号」）；注册 5 次 / 1 小时（同一 IP）。
 * —— 正常用户远够用；窗口过期自动恢复（无人工解锁）。
 */
export const AUTH_THROTTLE = Object.freeze({
  LOGIN_IP: Object.freeze({ scope: 'auth:login:ip', limit: 30, windowSeconds: 600 }),
  LOGIN_ACCOUNT: Object.freeze({ scope: 'auth:login:acct', limit: 10, windowSeconds: 600 }),
  REGISTER: Object.freeze({ scope: 'auth:register', limit: 5, windowSeconds: 60 * 60 }),
  // 演示一键登录（2026-10-19）：只按 IP 计（请求方不指定账号 ⇒ 无「按账号」维度）。
  // 与 LOGIN_IP **同量级同窗口**，但独立 scope ⇒ 演示按钮的点击不消耗真实登录的额度。
  DEMO_LOGIN_IP: Object.freeze({ scope: 'auth:demo-login:ip', limit: 30, windowSeconds: 600 })
})

/** 固定窗口序号（`floor(now / 窗口)`）—— 序号一变即新键，天然无需「删键解锁」。 */
export function throttleBucket(nowMs, windowSeconds) {
  const width = Math.max(1, Math.floor(Number(windowSeconds) || 1)) * 1000
  return Math.floor(Number(nowMs) / width)
}

/** 窗口结束时刻（Unix 秒；`X-RateLimit-Reset` 语义）。 */
export function throttleResetEpochSeconds(nowMs, windowSeconds) {
  const width = Math.max(1, Math.floor(Number(windowSeconds) || 1))
  return (throttleBucket(nowMs, width) + 1) * width
}

/**
 * 节流判定（纯决策，不写响应；存储不可用 ⇒ 放行，与 `evaluateRateLimit` 同一降级纪律）。
 * @returns {Promise<{counted:boolean, allowed:boolean, limit:number, used?:number,
 *                    remaining?:number, reset?:number, degraded?:boolean, reason?:string}>}
 */
export async function evaluateThrottle(options = {}) {
  const {
    scope = 'auth',
    identifier = '',
    limit = 10,
    windowSeconds = 600,
    now = Date.now(),
    env = process.env,
    fetchImpl,
    timeoutMs
  } = options
  const max = Math.max(1, Math.floor(Number(limit) || 1))
  const width = Math.max(1, Math.floor(Number(windowSeconds) || 1))
  const bucket = throttleBucket(now, width)
  const reset = throttleResetEpochSeconds(now, width)
  const ttlSeconds = width + TTL_SLACK_SECONDS

  try {
    const used = await incrCounter({
      dayKey: `${scope}:${bucket}`,
      fingerprint: keyFingerprint(identifier),
      ttlSeconds,
      env,
      fetchImpl,
      timeoutMs
    })
    return {
      counted: true,
      allowed: used <= max,
      limit: max,
      used,
      remaining: Math.max(0, max - used),
      reset
    }
  } catch (error) {
    return {
      counted: false,
      allowed: true,
      limit: max,
      degraded: true,
      reason: (error && error.reason) || 'unknown'
    }
  }
}

/**
 * 路由内节流门：写 `X-RateLimit-*`，超限直接落 `429`。
 * 返回 `true` ⇒ 放行；`false` ⇒ 已回 429（调用方立即 return）。
 * 文案与「每日配额」区分（本门的 message 是「尝试次数过多，请稍后再试。」）。
 */
export async function enforceThrottle(res, throttle) {
  const verdict = await evaluateThrottle(throttle)
  if (typeof res.setHeader === 'function') {
    res.setHeader('X-RateLimit-Limit', String(verdict.limit))
  }
  if (!verdict.counted) {
    console.warn(
      `[api/throttle] degraded counted=0 action=allow scope=${throttle.scope || 'auth'} limit=${verdict.limit} reason=${verdict.reason}`
    )
    return true
  }
  if (typeof res.setHeader === 'function') {
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining))
    res.setHeader('X-RateLimit-Reset', String(verdict.reset))
  }
  if (verdict.allowed) return true
  console.warn(
    `[api/throttle] limited counted=1 action=reject scope=${throttle.scope || 'auth'} used=${verdict.used} limit=${verdict.limit} reset=${verdict.reset}`
  )
  fail(res, 429, 'RATE_LIMITED', '尝试次数过多，请稍后再试。')
  return false
}
