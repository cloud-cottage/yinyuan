/**
 * API 调用计量（印源「用量地基」，2026-10-19）。
 *
 * ★ 计量面（写死，改即改账单口径）：
 *   只计**经 API key 通道**（`Authorization: ApiKey …` 或 `X-API-Key: …`）鉴权通过的
 *   `GET /api/v1/**` 请求 —— **含实例缓存命中**；`Session` 通道（控制台页面自身）**不计**。
 *   计数点由 `handler.js` 钉在「鉴权通过 → 限流 → **实例缓存分支之前**」：
 *   `401` / `404` / `405` / 预检 `OPTIONS` / `503`（未配置、限流 429）一律不计数。
 *
 * ★ 两个写面（**本模块是唯一作者**，只碰这两个集合 + env 主体不落 users）：
 *   ① 明细 `yinyuan_usage_records` —— 一行一次调用，字段名**逐字取** `src/data/contract.js`
 *      的 `UsageRecord`（camelCase，见 `buildRecordRow`），外加两个非契约诊断位：
 *      `cacheHit`（是否实例缓存命中）、`seeded`（是否示例数据，**不得静默冒充真实调用**）。
 *   ② 日聚合 `yinyuan_usage_daily` —— 键 `(userId, cstDate, endpoint)`，`_id` 由该三元组
 *      派生（`ud-<sha256 前 24 位>`）⇒ 天然一对一；**聚合可由明细完整重算**（明细是账本，
 *      聚合是派生视图）。字段：`callCount` / `billableCallCount` / `failureCallCount` /
 *      `latencyMsSum` / `seededCallCount` / `firstSeenAt` / `updatedAt` / `seeded`。
 *
 * ★ 幂等：
 *   - 明细 `_id = ur-<sha256(traceId) 前 24 位>` ⇒ 同一 `trace_id` 重试**写不进第二行**
 *     （`create` 撞 `_id` ⇒ 判重复 ⇒ 直接返回 deduped）；
 *   - 日聚合**只在明细行确实新建成功后**才 `+n` ⇒ 重试/重跑都不会重复累加；
 *   - 明细写失败 ⇒ 不动聚合（宁可少计，绝不虚构）。
 *   `trace_id` 优先取请求头 `x-request-id` / `x-vercel-id` / `x-correlation-id`（平台每次
 *   调用唯一），都没有则进程内随机 UUID；**不把 key 或任何凭据写进 trace**。
 *
 * ★ 降级（硬要求）：`recordApiCall` / `startMetering().finish()` **永不抛出、永不改响应**；
 *   整条写链有 `METERING_TIMEOUT_MS` 预算（默认 1500ms，云库单请求另有 8000ms），
 *   失败/超时只留**一行** `METERING_FAILED` 结构化日志，不伪造、不补写计数。
 *
 * ★ 主体（口径 6）：env 机构钥匙 ⇒ `userId='u_org_env'`、`kid='env:default'`（逐字），
 *   否则机构调用永远进不了账。客户钥匙 ⇒ 用鉴权结果里的 `userId` / `keyId`。
 *
 * ★ 注入式数据层：所有写函数首参或选项可传 `db`（CloudBase database 句柄），
 *   单测用内存假 DB 实现同一面（`.collection().doc().create()/update()` + `command.inc`）。
 */
import { createHash, randomUUID } from 'node:crypto'

/** 明细集合（一行一次调用）。 */
export const RECORDS_COLLECTION = 'yinyuan_usage_records'

/** 日聚合集合（(userId, cstDate, endpoint) 一行）。 */
export const DAILY_COLLECTION = 'yinyuan_usage_daily'

/** env 机构钥匙的计量主体（**逐字**，待入规范）。 */
export const ORG_USER_ID = 'u_org_env'
export const ORG_KID = 'env:default'

/** 整条计量写链的时间预算（ms）：到点即放弃并记 `METERING_FAILED`，不回写响应。 */
export const METERING_TIMEOUT_MS = 1500

export const RECORD_ID_PREFIX = 'ur-'
export const DAILY_ID_PREFIX = 'ud-'

/** 派生 id 取 sha256 前多少位十六进制（24 hex = 96 bit，冲突面可忽略）。 */
export const ID_HEX_LENGTH = 24

/** 单一端点名长度上限（避免异常 URL 撑爆字段）。 */
export const ENDPOINT_MAX_LENGTH = 160

/** trace 头（按序取第一个非空；都是平台/网关注入的每次调用唯一值）。 */
const TRACE_HEADERS = ['x-request-id', 'x-vercel-id', 'x-correlation-id']

/** CST（UTC+8）固定偏移：中国无夏令时，**不用** Intl 以免运行时缺时区数据。 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000

/* ── 纯函数（单测直接打这些） ───────────────────────────────────── */

function toMs(at) {
  if (at instanceof Date) {
    const ms = at.getTime()
    return Number.isFinite(ms) ? ms : Date.now()
  }
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (typeof at === 'string' && at !== '') {
    const ms = Date.parse(at)
    if (Number.isFinite(ms)) return ms
  }
  return Date.now()
}

/** CST 自然日 / 自然月（`YYYY-MM-DD` / `YYYY-MM`）。 */
export function cstParts(at) {
  const iso = new Date(toMs(at) + CST_OFFSET_MS).toISOString()
  return { cstDate: iso.slice(0, 10), cstMonth: iso.slice(0, 7) }
}

/** 计费判据（口径 3）：**响应 2xx 才计包量**；失败调用仍留明细但不计费。 */
export function isBillableStatus(statusCode) {
  const n = Number(statusCode)
  return Number.isFinite(n) && n >= 200 && n < 300
}

/** 端点名：只留路径、去掉查询串（不带凭据、不带随机探测参数），限长。 */
export function normalizeEndpoint(raw) {
  const value = typeof raw === 'string' ? raw : ''
  const path = value.split('?')[0] || ''
  return (path === '' ? '/' : path).slice(0, ENDPOINT_MAX_LENGTH)
}

/** 从请求取端点路径（`req.url` 是函数级路径，不含 query 之外的秘密）。 */
export function endpointOf(req) {
  return normalizeEndpoint(req && typeof req.url === 'string' ? req.url : '')
}

/** 取请求级 trace_id（公开头，绝不含 key）。 */
export function traceIdOf(req, fallback) {
  const headers = (req && req.headers) || {}
  for (const name of TRACE_HEADERS) {
    const raw = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200)
  }
  return typeof fallback === 'string' && fallback !== '' ? fallback : randomUUID()
}

/** 明细行 `_id`（**幂等键**：同一 trace 只可能有一行）。 */
export function recordIdOf(traceId) {
  const hex = createHash('sha256').update(`record|${String(traceId)}`, 'utf8').digest('hex')
  return `${RECORD_ID_PREFIX}${hex.slice(0, ID_HEX_LENGTH)}`
}

/** 日聚合行 `_id`（`(userId, cstDate, endpoint)` 的确定性派生）。 */
export function dailyIdOf({ userId, cstDate, endpoint }) {
  const key = `daily|${String(userId)}|${String(cstDate)}|${normalizeEndpoint(endpoint)}`
  const hex = createHash('sha256').update(key, 'utf8').digest('hex')
  return `${DAILY_ID_PREFIX}${hex.slice(0, ID_HEX_LENGTH)}`
}

/**
 * 鉴权结果 ⇒ 计量主体。
 * - `via:'env'` ⇒ 机构主体（`u_org_env` / `env:default`）
 * - `via:'key'` ⇒ 该 key 的 `userId` / `keyId`（缺一即**不计量**，绝不匿名记账）
 * - 其它（含 `Session` 通道 / 未鉴权）⇒ `null`（**不计入用量**）
 * @returns {{userId:string, kid:string}|null}
 */
export function subjectOf(authResult) {
  if (!authResult || authResult.ok !== true) return null
  if (authResult.session === true) return null
  if (authResult.via === 'env') return { userId: ORG_USER_ID, kid: ORG_KID }
  if (authResult.via === 'key') {
    const userId = typeof authResult.userId === 'string' ? authResult.userId.trim() : ''
    const kid = typeof authResult.keyId === 'string' ? authResult.keyId.trim() : ''
    if (userId === '' || kid === '') return null
    return { userId, kid }
  }
  return null
}

/**
 * 造明细行（**字段名逐字取 contract.js 的 `UsageRecord`**）。
 * `callCount` 恒为 1（一请求一行）；图片类字段本轮恒 0（本端点面不产图）；
 * `planIdAtTime` 为空串 ＝ **未判定**（不编造套餐，待账号面接入后回填）。
 */
export function buildRecordRow(input = {}) {
  const atMs = toMs(input.requestedAt)
  const { cstDate, cstMonth } = cstParts(atMs)
  const traceId = typeof input.traceId === 'string' && input.traceId !== '' ? input.traceId : randomUUID()
  const statusCode = Number.isFinite(Number(input.statusCode)) ? Math.trunc(Number(input.statusCode)) : 0
  const latencyMs = Number.isFinite(Number(input.latencyMs)) ? Math.max(0, Math.trunc(Number(input.latencyMs))) : 0
  return {
    recordId: recordIdOf(traceId),
    userId: String(input.userId || ''),
    kid: String(input.kid || ''),
    endpoint: normalizeEndpoint(input.endpoint),
    method: String(input.method || 'GET').toUpperCase().slice(0, 16),
    statusCode,
    isBillable: isBillableStatus(statusCode),
    callCount: 1,
    requestedAt: new Date(atMs).toISOString(),
    cstDate,
    cstMonth,
    latencyMs,
    imageCount: 0,
    imageBytes: 0,
    originalImageCount: 0,
    traceId,
    planIdAtTime: typeof input.planIdAtTime === 'string' ? input.planIdAtTime : '',
    cacheHit: input.cacheHit === true,
    seeded: input.seeded === true
  }
}

/* ── 存储写面（永不抛出） ────────────────────────────────────────── */

function isFailedResult(result) {
  return !result || (typeof result.code === 'string' && result.code !== '')
}

function describeError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error || '')
  const code = error && (error.code || error.errCode)
  return `${code ? String(code) + ' ' : ''}${raw}`.replace(/[\r\n\t]+/g, ' ').slice(0, 160)
}

function isDuplicate(message, code) {
  return /exist|duplicate|重复|已存在/i.test(String(message || '')) || /DUPLICATE/i.test(String(code || ''))
}

/** 一行 `METERING_FAILED`（结构化、无凭据、无堆栈）。 */
function logFailure(step, reason) {
  console.error(`[api] METERING_FAILED step=${step} reason=${String(reason).slice(0, 160)}`)
}

/** `create` 一行；`{ok:true, duplicate:true}` ＝ 幂等命中（已存在，未写）。 */
async function createDoc(db, collection, id, row) {
  try {
    const result = await db.collection(collection).doc(id).create(row)
    if (isFailedResult(result)) {
      if (isDuplicate(result.message, result.code)) return { ok: true, duplicate: true }
      return { ok: false, reason: `CREATE ${describeError(result)}` }
    }
    return { ok: true, duplicate: false }
  } catch (error) {
    if (isDuplicate(describeError(error), error && error.code)) return { ok: true, duplicate: true }
    return { ok: false, reason: `CREATE ${describeError(error)}` }
  }
}

/**
 * 日聚合 `+delta`（**幂等由调用方保证**：只对确实新建成功的明细行调用）。
 * 首次 ⇒ `create` 初值；已存在 ⇒ `command.inc` 自增（单文档原子）。
 * @param {object} delta {userId, cstDate, endpoint, count, billableCallCount, latencyMsSum, seededCount, at}
 */
export async function applyDailyDelta(db, delta = {}) {
  const userId = String(delta.userId || '')
  const cstDate = String(delta.cstDate || '')
  const endpoint = normalizeEndpoint(delta.endpoint)
  const count = Math.max(0, Math.trunc(Number(delta.count) || 0))
  if (userId === '' || cstDate === '' || count === 0) return { ok: true, skipped: true }
  const billable = Math.min(count, Math.max(0, Math.trunc(Number(delta.billableCallCount) || 0)))
  const seeded = Math.min(count, Math.max(0, Math.trunc(Number(delta.seededCount) || 0)))
  const latencySum = Math.max(0, Math.trunc(Number(delta.latencyMsSum) || 0))
  const stamp = new Date(toMs(delta.at)).toISOString()
  const id = dailyIdOf({ userId, cstDate, endpoint })

  const created = await createDoc(db, DAILY_COLLECTION, id, {
    userId,
    cstDate,
    endpoint,
    callCount: count,
    billableCallCount: billable,
    failureCallCount: count - billable,
    latencyMsSum: latencySum,
    seededCallCount: seeded,
    seeded: seeded > 0,
    firstSeenAt: stamp,
    updatedAt: stamp
  })
  if (!created.ok) return { ok: false, reason: created.reason }
  if (!created.duplicate) return { ok: true, created: true }

  const command = db && db.command
  if (!command || typeof command.inc !== 'function') {
    return { ok: false, reason: 'INC_UNAVAILABLE' }
  }
  try {
    const result = await db
      .collection(DAILY_COLLECTION)
      .doc(id)
      .update({
        callCount: command.inc(count),
        billableCallCount: command.inc(billable),
        failureCallCount: command.inc(count - billable),
        latencyMsSum: command.inc(latencySum),
        seededCallCount: command.inc(seeded),
        updatedAt: stamp
      })
    if (isFailedResult(result)) return { ok: false, reason: `UPDATE ${describeError(result)}` }
    return { ok: true, created: false }
  } catch (error) {
    return { ok: false, reason: `UPDATE ${describeError(error)}` }
  }
}

/**
 * 写一条明细 + 对应日聚合（**永不抛出**）。
 * 顺序纪律：**先明细、后聚合**；明细已存在（重试）⇒ 直接 deduped，不再累加聚合。
 * @returns {Promise<{ok:boolean, deduped?:boolean, reason?:string}>}
 */
export async function persistRecord(db, row) {
  const created = await createDoc(db, RECORDS_COLLECTION, row.recordId, row)
  if (!created.ok) {
    logFailure('record', created.reason)
    return { ok: false, reason: created.reason }
  }
  if (created.duplicate) return { ok: true, deduped: true }

  const daily = await applyDailyDelta(db, {
    userId: row.userId,
    cstDate: row.cstDate,
    endpoint: row.endpoint,
    count: 1,
    billableCallCount: row.isBillable ? 1 : 0,
    latencyMsSum: row.latencyMs,
    seededCount: row.seeded ? 1 : 0,
    at: row.requestedAt
  })
  if (!daily.ok) {
    logFailure('daily', daily.reason)
    return { ok: false, reason: daily.reason }
  }
  return { ok: true, deduped: false }
}

/** 惰性取云库句柄（动态 import：不连云库的环境/单测不加载 SDK）。 */
async function defaultDb() {
  const { getDb } = await import('./cloudbase.js')
  return getDb()
}

/** 时间预算包装：**永不 reject**，到点返回 `{timedOut:true}`（底层继续跑但结果被丢弃）。 */
function withBudget(promise, budgetMs) {
  const ms = Math.max(50, Math.trunc(Number(budgetMs) || METERING_TIMEOUT_MS))
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ value })
      },
      (error) => {
        clearTimeout(timer)
        resolve({ error })
      }
    )
  })
}

/**
 * 写一次调用计量（明细 + 日聚合）。**永不抛出、永不改响应**。
 * @param {{userId:string, kid:string, endpoint:string, method?:string, statusCode:number,
 *          latencyMs?:number, isBillable?:boolean, traceId?:string, requestedAt?:*,
 *          planIdAtTime?:string, cacheHit?:boolean, seeded?:boolean}} input
 * @param {{db?:object, budgetMs?:number}} [options]
 * @returns {Promise<{ok:boolean, deduped?:boolean, skipped?:string, reason?:string}>}
 */
export async function recordApiCall(input = {}, options = {}) {
  try {
    const subject = input.userId && input.kid
      ? { userId: String(input.userId), kid: String(input.kid) }
      : subjectOf(input.authResult)
    if (!subject) return { ok: true, skipped: 'NO_SUBJECT' }

    const row = buildRecordRow({
      ...input,
      userId: subject.userId,
      kid: subject.kid
    })
    const db = options.db || (await defaultDb())
    const result = await withBudget(persistRecord(db, row), options.budgetMs)
    if (result.timedOut) {
      logFailure('record', 'TIMEOUT')
      return { ok: false, reason: 'TIMEOUT' }
    }
    if (result.error) {
      logFailure('record', describeError(result.error))
      return { ok: false, reason: 'THROWN' }
    }
    return result.value
  } catch (error) {
    logFailure('record', describeError(error))
    return { ok: false, reason: 'THROWN' }
  }
}

/**
 * 计量上下文（供 `handler.js` 埋点）：**在实例缓存分支之前**建，响应落盘后 `finish()`。
 * 同一个上下文重复 `finish()` 只写一次（进程内幂等）。
 *
 * @param {{req:object, authResult:object, routeName?:string, startedAt?:number,
 *          endpoint?:string, traceId?:string, db?:object, budgetMs?:number}} input
 * @returns {{finish:function({statusCode:number, cacheHit?:boolean, latencyMs?:number}):Promise<object>,
 *            traceId:string, subject:object|null, endpoint:string}}
 */
export function startMetering(input = {}) {
  const subject = subjectOf(input.authResult)
  const traceId = traceIdOf(input.req, input.traceId)
  const endpoint = input.endpoint
    ? normalizeEndpoint(input.endpoint)
    : endpointOf(input.req) || (input.routeName ? `/api/${input.routeName}` : '/api')
  const method = String((input.req && input.req.method) || 'GET').toUpperCase()
  const startedAt = Number.isFinite(Number(input.startedAt)) ? Number(input.startedAt) : Date.now()
  let fired = false

  return {
    traceId,
    subject,
    endpoint,
    finish(result = {}) {
      if (fired) return Promise.resolve({ ok: true, skipped: 'ALREADY_RECORDED' })
      fired = true
      if (!subject) return Promise.resolve({ ok: true, skipped: 'NOT_API_KEY_CHANNEL' })
      const statusCode = Number.isFinite(Number(result.statusCode)) ? Number(result.statusCode) : 0
      const latencyMs = Number.isFinite(Number(result.latencyMs))
        ? Number(result.latencyMs)
        : Math.max(0, Date.now() - startedAt)
      return recordApiCall(
        {
          userId: subject.userId,
          kid: subject.kid,
          endpoint,
          method,
          statusCode,
          latencyMs,
          traceId,
          cacheHit: result.cacheHit === true
        },
        { db: input.db, budgetMs: input.budgetMs }
      )
    }
  }
}

/* ── 演示账号的「示例用量」预置（只给运维脚本用；不冒充真实调用） ────── */

/** 单端点示例条数上限（防止误把演示数据写成巨额）。 */
export const SEED_MAX_PER_ENDPOINT = 200

/** 示例数据最多铺开的天数（含当天；上限 31 天＝一个自然月）。 */
export const SEED_MAX_DAYS = 31

/** 一天毫秒数（CST 自然日换算用）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 预置**标记为示例**的用量：一行一行写明细（`seeded:true`），再按确实新建的条数累加日聚合。
 * `trace_id` 为确定性派生 ⇒ **重跑不重复**（第二次全部 deduped）。
 *
 * `days`（默认 1）：把该端点的示例铺到**最近 N 个 CST 自然日**（含当天），供控制台趋势图有形状。
 * 每行时间由 `(i, days)` 确定性派生 ⇒ 同一天重跑得到同一批 `trace_id`；跨天重跑会落在新的
 * 自然日上（示例数据本就按"当前窗口"造，不做历史回填）。
 *
 * @param {object} db
 * @param {{userId:string, kid?:string, now?:*, days?:number,
 *          endpoints:Array<{endpoint:string, count:number, billableCount?:number}>}} input
 * @returns {Promise<{ok:boolean, created:number, skipped:number, reason?:string}>}
 */
export async function seedUsage(db, input = {}) {
  const userId = String(input.userId || '')
  if (userId === '') return { ok: false, created: 0, skipped: 0, reason: 'INVALID_INPUT' }
  const kid = String(input.kid || 'demo:seed')
  const nowMs = toMs(input.now)
  const days = Math.min(SEED_MAX_DAYS, Math.max(1, Math.trunc(Number(input.days) || 1)))
  const specs = Array.isArray(input.endpoints) ? input.endpoints : []
  let created = 0
  let skipped = 0

  for (const spec of specs) {
    const endpoint = normalizeEndpoint(spec && spec.endpoint)
    const total = Math.min(SEED_MAX_PER_ENDPOINT, Math.max(0, Math.trunc(Number(spec && spec.count) || 0)))
    if (total === 0) continue
    const billable = Math.min(
      total,
      Math.max(0, Math.trunc(Number(spec && spec.billableCount !== undefined ? spec.billableCount : total)))
    )
    /** 该端点每天确实新建的条数（按行的 cstDate 分组，聚合必须与明细同日）。 */
    const perDay = new Map()
    for (let i = 1; i <= total; i += 1) {
      // 时间：最近 days 个自然日；i 越大越靠近现在（i === total ⇒ 今天）。
      const dayOffset = days > 1 ? (total - i) % days : 0
      const minutesBack = days > 1 ? dayOffset * 24 * 60 + ((i * 97) % 600) : total - i
      const atMs = nowMs - minutesBack * 60 * 1000
      const rowDate = cstParts(atMs).cstDate
      const traceId = `seed:${userId}:${rowDate}:${endpoint}:${i}`
      const row = buildRecordRow({
        userId,
        kid,
        endpoint,
        method: 'GET',
        statusCode: i <= billable ? 200 : 500,
        traceId,
        // 示例时间：确定性铺开（只作展示，不参与计费判定）
        requestedAt: atMs,
        latencyMs: 80 + ((i * 13) % 60),
        seeded: true
      })
      const written = await createDoc(db, RECORDS_COLLECTION, row.recordId, row)
      if (!written.ok) return { ok: false, created, skipped, reason: written.reason }
      if (written.duplicate) {
        skipped += 1
        continue
      }
      created += 1
      const bucket = perDay.get(row.cstDate) || { count: 0, billable: 0, latencySum: 0 }
      bucket.count += 1
      bucket.latencySum += row.latencyMs
      if (row.isBillable) bucket.billable += 1
      perDay.set(row.cstDate, bucket)
    }
    for (const [date, bucket] of perDay) {
      const daily = await applyDailyDelta(db, {
        userId,
        cstDate: date,
        endpoint,
        count: bucket.count,
        billableCallCount: bucket.billable,
        latencyMsSum: bucket.latencySum,
        seededCount: bucket.count,
        at: nowMs
      })
      if (!daily.ok) return { ok: false, created, skipped, reason: daily.reason }
    }
  }
  return { ok: true, created, skipped }
}
