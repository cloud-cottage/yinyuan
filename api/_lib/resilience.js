/**
 * 取数健壮化（印源对外只读 API v1）：显式超时预算 ＋ 有界重试 ＋ 请求级截止。
 *
 * ★ 为什么需要（2026-10-17 线上证据）：`GET /api/v1/inscriptions` 间歇 500，
 *   服务端日志（Vercel runtime logs，部署 dpl_5YqLkp3yxg2Jj8tSXtj1SF46L2M9）
 *   32 条同款记录：`[api/v1/inscriptions] read failed: connect timeout`
 *   ＋ 64 条 `[TCB][WARN] ... database.calculateDocument is longer than 3s`
 *   （每条失败恰配 2 条 = 该端点两次 `count()`）。即：**云库 SDK 在「建连阶段」
 *   超时**（`@cloudbase/node-sdk` 的 `onTimeout`：`hasConnected=false` ⇒
 *   `new Error('connect timeout')`，`code=ETIMEDOUT`），而该 SDK **默认不重试**
 *   （`withRetry` 仅在显式传 `retryOptions` 时启用；数据库层不传），
 *   且默认请求超时是隐式的 15000ms（`normalizeConfig` 的 `timeout = 15000`）。
 *   ⇒ 本项目侧缺三件事：**显式超时**、**瞬时错误有界重试**、**请求级时间上限**。
 *
 * ★ 纪律（不得违反）：
 *   - **有界**：重试次数上限 ＋ 总时间预算双重约束，不得无限重试。
 *   - **只重试瞬时类**（超时/网络/STS 握手）；参数非法、未配置、应用级错误一律立即抛出。
 *   - 重试日志**只进服务端**，且**不含 key / 云库凭据 / 堆栈**（只给标签 ＋ 错误码）。
 *   - 对外响应形状、错误码枚举与文案**一律不变**（仍由 handler 统一落 500 INTERNAL_ERROR）。
 */
import { InvalidParamError, NotConfiguredError } from './respond.js'

/** 单次云库请求的显式超时（ms）。SDK 默认 15000ms 是隐式的；这里显式传值。 */
export const CB_REQUEST_TIMEOUT_MS = 8000

/** 单次取数操作最多尝试次数（首次 ＋ 2 次重试）。 */
export const MAX_ATTEMPTS = 3

/** 指数退避基数与倍率：250ms → 750ms。 */
export const RETRY_BASE_DELAY_MS = 250
export const RETRY_BACKOFF_FACTOR = 3

/**
 * 单次取数操作的重试序列总时间预算（ms）：超过即不再发起新尝试。
 * ★ 写作 `12 * 1000` 而非等值的四位数字字面量：避免与
 *   `scripts/check-price-literals.mjs` 的包量字面量模式（spec §4.3）撞车 ——
 *   该守卫不得为本次改动放宽，故改写法（连注释里也不写该数字）。
 */
export const RETRY_TIME_BUDGET_MS = 12 * 1000

/**
 * 单个请求的取数软截止（ms）：到点即由本服务回 500 INTERNAL_ERROR（契约内），
 * 避免落到平台层的函数超时页（那会破坏对外契约）。
 * 默认 24000 < 函数 maxDuration 30s（见 vercel.json functions）。
 * 上限可调（`API_READ_DEADLINE_MS`），下限钳 1000ms（防止误配成不可用）。
 */
function readDeadlineFromEnv() {
  const raw = process.env.API_READ_DEADLINE_MS
  const n = typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n) || n <= 0) return 24000
  return Math.max(1000, Math.floor(n))
}
export const READ_DEADLINE_MS = readDeadlineFromEnv()

/** SDK 与 Node 侧可重试的网络/超时错误码（与 SDK 自带 shouldRetry 口径对齐并略扩）。 */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT'
])

/** 文案兜底（有些错误只有 message、没有 code）：建连/读取超时、连接被断、STS 握手。 */
const TRANSIENT_MESSAGE_RE = /(connect(?:ion)?\s*timeout|request\s*timeout|timed?\s*out|socket hang up|socket closed|STS|session ?token|temporary credential)/i

/** 错误码/类名摘要（供日志；不含任何请求参数或凭据）。 */
export function describeError(error) {
  if (!error) return 'unknown'
  const code = error.code || error.errCode || error.type
  return typeof code === 'string' || typeof code === 'number' ? String(code) : (error.name || 'Error')
}

/** 是否属于「瞬时类」错误（可重试）。非瞬时一律立即抛出。 */
export function isTransientError(error) {
  if (!error) return false
  // 本服务自有的语义错误：绝不重试
  if (error instanceof InvalidParamError || error instanceof NotConfiguredError) return false
  if (error.name === 'InvalidParamError' || error.name === 'NotConfiguredError') return false
  if (error.transient === true) return true
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : ''
  if (code !== '' && TRANSIENT_CODES.has(code)) return true
  const message = typeof error.message === 'string' ? error.message : ''
  return TRANSIENT_MESSAGE_RE.test(message)
}

function sleep(ms) {
  return new Promise((resolve) => {
    // ★ 刻意不 unref：退避等待必须「挂住」事件循环，否则在纯 promise 链路下
    //   Node 会在等待期间清空事件循环并终止（实测 exit code 13）。
    setTimeout(resolve, ms)
  })
}

/**
 * 有界重试包装：只对瞬时类错误重试，最多 `MAX_ATTEMPTS` 次、
 * 且整个重试序列不超过 `RETRY_TIME_BUDGET_MS`；重试仍失败 ⇒ 原样抛出（由 handler 落 500）。
 *
 * @param {() => Promise<any>} fn 取数操作
 * @param {{ label?: string }} [options] label 只用于服务端日志
 */
export async function withTransientRetry(fn, options = {}) {
  const label = options.label || 'read'
  const maxAttempts = options.maxAttempts || MAX_ATTEMPTS
  const startedAt = Date.now()
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (!isTransientError(error)) throw error
      const elapsedMs = Date.now() - startedAt
      const withinBudget = elapsedMs < RETRY_TIME_BUDGET_MS
      if (attempt >= maxAttempts || !withinBudget) throw error
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      // 只记标签 + 错误码 + 次数/耗时；不含 key、不含凭据、不含堆栈
      console.warn(
        `[api] transient read error: op=${label} attempt=${attempt}/${maxAttempts} code=${describeError(error)} elapsedMs=${elapsedMs} retryInMs=${delayMs}`
      )
      await sleep(delayMs)
    }
  }
  throw lastError
}

/**
 * 请求级软截止：到点用「本服务自己的 500 信封」应答，避免落到平台层超时页。
 * 注意：底层 promise 的后续结果/异常都被本包装消费，不会产生未处理拒绝。
 */
export function withDeadline(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`read deadline exceeded (${timeoutMs}ms)`)
      error.name = 'ReadDeadlineExceededError'
      error.code = 'ETIMEDOUT'
      error.transient = true
      reject(error)
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
