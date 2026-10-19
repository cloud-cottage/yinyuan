/**
 * 用量读面（A10/A11/A12/A13/A14）—— `GET /api/v1/usage/*` 的**唯一实现**。
 *
 * ★ 口径（写死，可判负）：
 *   ① 只读本用户：所有查询首条子句恒为 `{ userId }`（session 的 user id）。
 *      机构主体 `u_org_env` 是**独立主体**，其行永远不会被算进客户账号。
 *   ② 无数据 ⇒ **全 0 / 空数组**（不 404、不 500、不造示例行）。
 *   ③ `seeded:true` 的行必须在响应里**可区分**：汇总给 `seededCalls`、明细行透出 `seeded`、
 *      分桶给 `seededCalls`。示例数据不得静默冒充真实调用。
 *   ④ 时间：库里存 UTC ISO8601；`cstDate` / `cstMonth` 一律按 Asia/Shanghai（固定 +08:00，
 *      中国无夏令时）派生；趋势缺日补 0。
 *   ⑤ 金额：整数分（本文件不产生金额，图片字节为整数字节）。
 *   ⑥ 聚合**必须显式 `.limit(N)`**：CloudBase `aggregate().end()` 默认只回 20 桶且**不报错**
 *      （本仓已踩过）⇒ 分桶上限写死 `BREAKDOWN_BUCKET_LIMIT`；触顶只记服务端日志并透出
 *      `truncatedBuckets:true`，不改写数值。
 *   ⑦ 导出必须**游标分批**：按 `_id` 升序 keyset 翻页（每批 `SCAN_BATCH_SIZE`），
 *      并受 `exportBudgetMs`（默认 20s < 函数 30s）与 `EXPORT_MAX_ROWS` 双重约束；
 *      到点/到量即停，如实回 `truncated:true`（**不假装导全了**）。
 *
 * ★ 展示通道流量：本轮后端**没有**展示切片通道的计量落库 ⇒ `displayChannelBytes` 恒 0
 *   （`DISPLAY_CHANNEL_BYTES`），并在注记里写明。宁可如实 0，也不从别处搬数。
 */
import { listByUser } from './apiKeys.js'
import { RECORDS_COLLECTION, cstParts } from './metering.js'
import { getSearchParams } from './pagination.js'
import { InvalidParamError } from './respond.js'
import { withTransientRetry } from './resilience.js'

export { RECORDS_COLLECTION }

/** 展示通道（切片）流量：后端尚无该通道计量 ⇒ 如实 0。 */
export const DISPLAY_CHANNEL_BYTES = 0

/** 汇总口径注记（与 CSV 汇总区注记行**逐字相同**）。 */
export const SUMMARY_CALIBER_NOTE =
  '图片流量分两口径：明细行合计不含展示通道（切片）流量；展示通道流量只计图片流量、不计调用次数。两口径之和等于汇总图片流量。'

/** 允许的区间预设（CST 自然日，含当日）。 */
export const RANGE_DAYS = Object.freeze({ '1d': 1, '7d': 7, '30d': 30, '90d': 90 })

/** 缺省区间。 */
export const DEFAULT_RANGE = '30d'

/** 分桶上限（显式 `.limit`；见文件头 ⑥）。 */
export const BREAKDOWN_BUCKET_LIMIT = 500

/** 趋势桶上限（防「区间拉满一年 + 按日」把响应撑爆）。 */
export const TREND_MAX_BUCKETS = 400

/** 扫描批大小（keyset 游标一页）。 */
export const SCAN_BATCH_SIZE = 500

/** 汇总/趋势单次扫描行数上限（超出即如实截断）。 */
export const SUMMARY_MAX_ROWS = 20000

/** 导出单次行数上限。 */
export const EXPORT_MAX_ROWS = 5000

/** 单次函数预算（ms）：导出留 10s 余量给平台层 30s 上限。 */
export const SUMMARY_BUDGET_MS = 12000
export const EXPORT_BUDGET_MS = 20000

const CST_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 86400000

/* ── CST 时间工具 ─────────────────────────────────────────────── */

/** 毫秒 ⇒ CST 自然日 `YYYY-MM-DD`。 */
export function cstDateOf(atMs) {
  const ms = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  return new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 毫秒 ⇒ CST 自然月 `YYYY-MM`。 */
export function cstMonthOf(atMs) {
  return cstDateOf(atMs).slice(0, 7)
}

/** CST 自然日 00:00:00 的绝对毫秒。 */
export function cstDayStartMs(cstDate) {
  return Date.parse(`${cstDate}T00:00:00+08:00`)
}

/** UTC ISO ⇒ 展示串 `YYYY-MM-DD HH:mm CST`（与前端 `toCstDateTime` 同形）。 */
export function cstLabelOf(iso) {
  const ms = Date.parse(String(iso || ''))
  if (!Number.isFinite(ms)) return ''
  const shifted = new Date(ms + CST_OFFSET_MS).toISOString()
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} CST`
}

/** `YYYY-MM-DD` 加减天数。 */
function shiftDate(cstDate, deltaDays) {
  return cstDateOf(cstDayStartMs(cstDate) + deltaDays * DAY_MS)
}

/* ── 查询解析 ─────────────────────────────────────────────────── */

function firstParam(params, names) {
  for (const name of names) {
    const value = params.get(name)
    if (value !== null && String(value).trim() !== '') return String(value).trim()
  }
  return ''
}

/** 多值参数：同名字段可重复，也支持逗号分隔。 */
function listParam(params, names) {
  const out = []
  for (const name of names) {
    for (const raw of params.getAll(name)) {
      for (const piece of String(raw).split(',')) {
        const value = piece.trim()
        if (value !== '' && !out.includes(value)) out.push(value.slice(0, 160))
      }
    }
  }
  return out
}

function parseInstant(raw, name, edge) {
  const value = String(raw || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = cstDayStartMs(value)
    if (!Number.isFinite(start)) throw new InvalidParamError(`参数 ${name} 不是有效日期。`)
    return edge === 'to' ? start + DAY_MS - 1 : start
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new InvalidParamError(`参数 ${name} 必须是 ISO8601 时间。`)
  return ms
}

/**
 * 解析区间 / 筛选参数。
 * @param {object} req
 * @param {{nowMs?:number}} [options] `nowMs` 仅供自检注入时钟
 * @returns {{range:string, from:string|null, to:string, fromMs:number|null, toMs:number,
 *            kids:string[], endpoints:string[], seeded:'all'|'only'|'exclude'}}
 */
export function parseUsageQuery(req, options = {}) {
  const params = getSearchParams(req)
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  const range = (firstParam(params, ['range']) || DEFAULT_RANGE).toLowerCase()

  const rawFrom = firstParam(params, ['from'])
  const rawTo = firstParam(params, ['to'])
  let fromMs = null
  let toMs = nowMs
  let label = range

  if (rawFrom !== '' || rawTo !== '') {
    fromMs = rawFrom === '' ? null : parseInstant(rawFrom, 'from', 'from')
    toMs = rawTo === '' ? nowMs : parseInstant(rawTo, 'to', 'to')
    label = 'custom'
  } else if (range === 'all') {
    fromMs = null
  } else {
    const days = RANGE_DAYS[range]
    if (!days) {
      throw new InvalidParamError(`参数 range 只支持 ${[...Object.keys(RANGE_DAYS), 'all'].join(' / ')}。`)
    }
    const today = cstDateOf(nowMs)
    fromMs = cstDayStartMs(shiftDate(today, -(days - 1)))
  }

  if (fromMs !== null && toMs < fromMs) {
    throw new InvalidParamError('参数 from 必须早于 to。')
  }

  const seededRaw = (firstParam(params, ['seeded']) || 'all').toLowerCase()
  const seeded = ['all', 'only', 'exclude'].includes(seededRaw) ? seededRaw : 'all'
  if (!['all', 'only', 'exclude'].includes(seededRaw)) {
    throw new InvalidParamError('参数 seeded 只支持 all / only / exclude。')
  }

  return {
    range: label,
    from: fromMs === null ? null : new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    kids: listParam(params, ['kid', 'key', 'keys']),
    endpoints: listParam(params, ['endpoint', 'endpoints']),
    seeded
  }
}

/** 分桶维度（缺省 endpoint；`key` 无归属标签时 label 回 kid 本身）。 */
export function parseDim(req) {
  const raw = (firstParam(getSearchParams(req), ['dim']) || 'endpoint').toLowerCase()
  if (!['endpoint', 'day', 'key'].includes(raw)) {
    throw new InvalidParamError('参数 dim 只支持 endpoint / day / key。')
  }
  return raw
}

/** 趋势粒度（缺省 day）。 */
export function parseBucket(req) {
  const raw = (firstParam(getSearchParams(req), ['bucket']) || 'day').toLowerCase()
  if (!['day', 'month'].includes(raw)) {
    throw new InvalidParamError('参数 bucket 只支持 day / month。')
  }
  return raw
}

/* ── 查询构造 ─────────────────────────────────────────────────── */

function filterClauses(db, userId, query) {
  const _ = db.command
  const clauses = [{ userId: String(userId) }]
  if (query.from) clauses.push({ requestedAt: _.gte(query.from) })
  if (query.to) clauses.push({ requestedAt: _.lte(query.to) })
  if (query.kids.length === 1) clauses.push({ kid: query.kids[0] })
  else if (query.kids.length > 1) clauses.push({ kid: _.in(query.kids) })
  if (query.endpoints.length === 1) clauses.push({ endpoint: query.endpoints[0] })
  else if (query.endpoints.length > 1) clauses.push({ endpoint: _.in(query.endpoints) })
  if (query.seeded === 'only') clauses.push({ seeded: true })
  else if (query.seeded === 'exclude') clauses.push({ seeded: _.neq(true) })
  return clauses
}

function whereOf(db, userId, query) {
  const clauses = filterClauses(db, userId, query)
  if (clauses.length === 1) return clauses[0]
  return db.command.and(clauses)
}

function readOp(label, fn) {
  return withTransientRetry(fn, { label })
}

/**
 * 取本用户密钥的 `kid → label` 映射（只用于**给明细/分桶加可读标签**）。
 * 读失败 ⇒ 空映射（标签缺省回落 kid），绝不让标签查询把主数据打挂。
 */
export async function loadKeyLabels(db, userId) {
  try {
    const found = await listByUser(db, userId)
    if (!found || found.ok !== true) return {}
    const labels = {}
    for (const key of found.keys || []) {
      if (key && typeof key.id === 'string' && key.id !== '') labels[key.id] = key.label || ''
    }
    return labels
  } catch (error) {
    console.warn('[api/usage] key label lookup failed; falling back to kid')
    return {}
  }
}

/* ── 扫描（游标分批） ─────────────────────────────────────────── */

/**
 * 按 `_id` 升序 keyset 翻页读取本用户的用量明细。
 * @param {object} db
 * @param {string} userId
 * @param {object} query `parseUsageQuery` 结果
 * @param {{batchSize?:number, maxRows?:number, budgetMs?:number, startedAt?:number}} [options]
 * @returns {Promise<{rows:object[], truncated:boolean, batches:number}>}
 */
export async function scanUsageRows(db, userId, query, options = {}) {
  const _ = db.command
  const batchSize = Math.max(1, Math.trunc(Number(options.batchSize) || SCAN_BATCH_SIZE))
  const maxRows = Math.max(1, Math.trunc(Number(options.maxRows) || SUMMARY_MAX_ROWS))
  const budgetMs = Math.max(500, Math.trunc(Number(options.budgetMs) || SUMMARY_BUDGET_MS))
  const deadline = (Number(options.startedAt) || Date.now()) + budgetMs

  const base = filterClauses(db, userId, query)
  const rows = []
  let cursor = ''
  let batches = 0
  let truncated = false

  for (;;) {
    if (rows.length >= maxRows) {
      truncated = true
      break
    }
    if (Date.now() > deadline) {
      truncated = true
      console.warn(`[api/usage] scan budget reached after ${batches} batches / ${rows.length} rows`)
      break
    }
    const clauses = cursor === '' ? base : [...base, { _id: _.gt(cursor) }]
    const take = Math.min(batchSize, maxRows - rows.length)
    const res = await readOp('usage:scan', async () => {
      const out = await db
        .collection(RECORDS_COLLECTION)
        .where(clauses.length === 1 ? clauses[0] : _.and(clauses))
        .orderBy('_id', 'asc')
        .limit(take)
        .get()
      return Array.isArray(out && out.data) ? out.data : []
    })
    batches += 1
    if (res.length === 0) break
    for (const row of res) rows.push(row)
    if (res.length < take) break
    const last = res[res.length - 1]
    const lastId = last && last._id
    if (typeof lastId !== 'string' || lastId === '') break
    cursor = lastId
  }

  return { rows: rows.slice(0, maxRows), truncated, batches }
}

/** 本用户匹配行的总条数（分页用；与扫描同一 `where`）。 */
export async function countUsageRows(db, userId, query) {
  const out = await readOp('usage:count', () => db.collection(RECORDS_COLLECTION).where(whereOf(db, userId, query)).count())
  return Number(out && out.total) || 0
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

/**
 * 明细行合计（**双口径**：`detailImageBytes` 为明细合计，`displayChannelBytes` 恒 0，
 * `imageBytes` ＝ 两者之和）。
 */
export function summarizeRows(rows) {
  const acc = {
    calls: 0,
    billableCalls: 0,
    failedCalls: 0,
    originalImages: 0,
    imageCount: 0,
    detailImageBytes: 0,
    displayChannelBytes: DISPLAY_CHANNEL_BYTES,
    imageBytes: 0,
    avgLatencyMs: 0,
    seededCalls: 0,
    realCalls: 0
  }
  let latencySum = 0
  for (const row of rows || []) {
    const callCount = Math.max(1, Math.trunc(Number(row && row.callCount) || 1))
    acc.calls += callCount
    if (row && row.isBillable === true) acc.billableCalls += callCount
    if (Number(row && row.statusCode) >= 400) acc.failedCalls += callCount
    acc.originalImages += Math.trunc(Number(row && row.originalImageCount) || 0)
    acc.imageCount += Math.trunc(Number(row && row.imageCount) || 0)
    acc.detailImageBytes += Math.trunc(Number(row && row.imageBytes) || 0)
    latencySum += Math.max(0, Math.trunc(Number(row && row.latencyMs) || 0))
    if (row && row.seeded === true) acc.seededCalls += callCount
  }
  acc.imageBytes = acc.detailImageBytes + acc.displayChannelBytes
  acc.avgLatencyMs = acc.calls > 0 ? Math.round(latencySum / acc.calls) : 0
  acc.realCalls = Math.max(0, acc.calls - acc.seededCalls)
  return acc
}

/** 对外明细行投影（白名单：契约字段 + `seeded` 可见性位；不含 `_id`）。 */
export function projectRecord(row) {
  const source = row || {}
  const at = typeof source.requestedAt === 'string' ? source.requestedAt : ''
  const parts = at === '' ? { cstDate: '', cstMonth: '' } : cstParts(at)
  return {
    recordId: source.recordId || null,
    userId: source.userId || null,
    kid: source.kid || null,
    endpoint: source.endpoint || null,
    method: source.method || 'GET',
    statusCode: Number(source.statusCode) || 0,
    isBillable: source.isBillable === true,
    callCount: Number(source.callCount) || 1,
    requestedAt: at || null,
    cstDate: source.cstDate || parts.cstDate,
    cstMonth: source.cstMonth || parts.cstMonth,
    latencyMs: Math.max(0, Math.trunc(Number(source.latencyMs) || 0)),
    imageCount: Math.trunc(Number(source.imageCount) || 0),
    imageBytes: Math.trunc(Number(source.imageBytes) || 0),
    originalImageCount: Math.trunc(Number(source.originalImageCount) || 0),
    traceId: source.traceId || null,
    planIdAtTime: source.planIdAtTime || '',
    seeded: source.seeded === true
  }
}

/**
 * A10 汇总（含额度三件套，供控制台首屏一次取全）。
 * @param {object} db
 * @param {string} userId
 * @param {object} query `parseUsageQuery` 结果
 * @param {{nowMs?:number, budgetMs?:number, maxRows?:number}} [options]
 * @param {(userId:string)=>Promise<object>} [accountLoader] 注入账号投影（避免本模块反依赖 account.js）
 */
export async function getUsageSummary(db, userId, query, options = {}, accountLoader = null) {
  const scan = await scanUsageRows(db, userId, query, {
    maxRows: options.maxRows || SUMMARY_MAX_ROWS,
    budgetMs: options.budgetMs || SUMMARY_BUDGET_MS
  })
  const totals = summarizeRows(scan.rows)
  const account = typeof accountLoader === 'function' ? await accountLoader(userId) : null
  return {
    ...totals,
    quotaTotalCalls: account ? account.quotaTotalCalls : 0,
    quotaUsedCalls: account ? account.quotaUsedCalls : 0,
    quotaRemainCalls: account ? account.quotaRemainCalls : 0,
    range: { range: query.range, from: query.from, to: query.to },
    scannedCalls: totals.calls,
    truncated: scan.truncated
  }
}

/* ── A11 分桶 ─────────────────────────────────────────────────── */

const DIM_FIELD = Object.freeze({ endpoint: '$endpoint', day: '$cstDate', key: '$kid' })

/**
 * A11 三维聚合。**聚合输出显式 `.limit(BREAKDOWN_BUCKET_LIMIT)`**（CloudBase 默认只回 20 桶）。
 * @returns {Promise<{dim:string, rows:object[], total:number, truncatedBuckets:boolean}>}
 */
export async function getUsageBreakdown(db, userId, query, dim, options = {}) {
  const _ = db.command
  const $ = db.command.aggregate
  const field = DIM_FIELD[dim] || DIM_FIELD.endpoint
  const matchClauses = filterClauses(db, userId, query)

  const result = await readOp('usage:breakdown', () =>
    db
      .collection(RECORDS_COLLECTION)
      .aggregate()
      .match(_.and(matchClauses))
      .group({
        _id: field,
        calls: $.sum(1),
        billableCalls: $.sum($.cond({ if: '$isBillable', then: 1, else: 0 })),
        failedCalls: $.sum($.cond({ if: $.gte(['$statusCode', 400]), then: 1, else: 0 })),
        seededCalls: $.sum($.cond({ if: '$seeded', then: 1, else: 0 })),
        originalImages: $.sum('$originalImageCount'),
        imageCount: $.sum('$imageCount'),
        imageBytes: $.sum('$imageBytes'),
        latencyMsSum: $.sum('$latencyMs')
      })
      .sort({ calls: -1 })
      .limit(BREAKDOWN_BUCKET_LIMIT)
      .end()
  )

  const raw = Array.isArray(result && result.data) ? result.data : []
  const truncatedBuckets = raw.length >= BREAKDOWN_BUCKET_LIMIT
  if (truncatedBuckets) {
    console.warn(`[api/usage] breakdown bucket limit reached (${raw.length}) dim=${dim}`)
  }
  const total = raw.reduce((sum, row) => sum + (Number(row && row.calls) || 0), 0)
  const keyLabels = options.keyLabels || {}
  const rows = raw.map((row) => {
    const dimValue = row && row._id !== undefined && row._id !== null ? String(row._id) : ''
    const calls = Number(row && row.calls) || 0
    return {
      dimValue: dimValue === '' ? '(unknown)' : dimValue,
      label: dim === 'key' ? keyLabels[dimValue] || dimValue || '(unknown)' : dimValue || '(unknown)',
      calls,
      billableCalls: Number(row && row.billableCalls) || 0,
      failedCalls: Number(row && row.failedCalls) || 0,
      seededCalls: Number(row && row.seededCalls) || 0,
      originalImages: Number(row && row.originalImages) || 0,
      imageCount: Number(row && row.imageCount) || 0,
      imageBytes: Number(row && row.imageBytes) || 0,
      avgLatencyMs: calls > 0 ? Math.round((Number(row && row.latencyMsSum) || 0) / calls) : 0,
      share: total > 0 ? calls / total : 0
    }
  })

  return { dim, rows, total, truncatedBuckets }
}

/* ── A12 趋势 ─────────────────────────────────────────────────── */

/**
 * 按 CST 日 / 月序列（**缺桶补 0**）。
 * @returns {Promise<{bucket:'day'|'month', series:object[], truncatedBuckets:boolean, range:object}>}
 */
export async function getUsageTrend(db, userId, query, bucket, options = {}) {
  const scan = await scanUsageRows(db, userId, query, {
    maxRows: options.maxRows || SUMMARY_MAX_ROWS,
    budgetMs: options.budgetMs || SUMMARY_BUDGET_MS
  })

  const buckets = []
  if (bucket === 'month') {
    const fromMs = query.fromMs === null ? minRequestedMs(scan.rows, query.toMs) : query.fromMs
    let [year, month] = cstMonthOf(fromMs).split('-').map(Number)
    const last = cstMonthOf(query.toMs)
    for (;;) {
      const key = `${year}-${String(month).padStart(2, '0')}`
      buckets.push(key)
      if (key >= last) break
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
      if (buckets.length > TREND_MAX_BUCKETS + 24) break
    }
  } else {
    const fromMs = query.fromMs === null ? minRequestedMs(scan.rows, query.toMs) : query.fromMs
    const lastDate = cstDateOf(query.toMs)
    let date = cstDateOf(fromMs)
    for (;;) {
      buckets.push(date)
      if (date >= lastDate) break
      date = shiftDate(date, 1)
      if (buckets.length > TREND_MAX_BUCKETS + 31) break
    }
  }

  const truncatedBuckets = buckets.length > TREND_MAX_BUCKETS
  const kept = truncatedBuckets ? buckets.slice(buckets.length - TREND_MAX_BUCKETS) : buckets
  const index = new Map(kept.map((key, i) => [key, i]))
  const series = kept.map((key) => ({
    bucket: key,
    calls: 0,
    billableCalls: 0,
    failedCalls: 0,
    seededCalls: 0,
    originalImages: 0,
    imageBytes: 0
  }))

  for (const row of scan.rows) {
    const at = Date.parse(String((row && row.requestedAt) || ''))
    if (!Number.isFinite(at)) continue
    const key = bucket === 'month' ? cstMonthOf(at) : cstDateOf(at)
    const i = index.get(key)
    if (i === undefined) continue
    const slot = series[i]
    const callCount = Math.max(1, Math.trunc(Number(row.callCount) || 1))
    slot.calls += callCount
    if (row.isBillable === true) slot.billableCalls += callCount
    if (Number(row.statusCode) >= 400) slot.failedCalls += callCount
    if (row.seeded === true) slot.seededCalls += callCount
    slot.originalImages += Math.trunc(Number(row.originalImageCount) || 0)
    slot.imageBytes += Math.trunc(Number(row.imageBytes) || 0)
  }

  return {
    bucket,
    series,
    truncatedBuckets,
    range: { range: query.range, from: query.from, to: query.to }
  }
}

function minRequestedMs(rows, fallbackMs) {
  let min = Number.POSITIVE_INFINITY
  for (const row of rows || []) {
    const at = Date.parse(String((row && row.requestedAt) || ''))
    if (Number.isFinite(at) && at < min) min = at
  }
  if (!Number.isFinite(min)) return fallbackMs
  return min
}

/* ── A13 明细分页 ─────────────────────────────────────────────── */

/**
 * 按 `requestedAt` 倒序分页（`limit` 缺省 50 / 上限 200，超出截断不报错；`offset ≥ 0`）。
 * @param {{limit:number, offset:number, limitTruncated:boolean}} paging `parsePaging` 结果
 */
export async function listUsageRecords(db, userId, query, paging, options = {}) {
  const limit = Math.max(0, Math.trunc(Number(paging.limit) || 0))
  const offset = Math.max(0, Math.trunc(Number(paging.offset) || 0))
  const total = await countUsageRows(db, userId, query)
  let items = []
  if (limit > 0 && offset < total) {
    items = await readOp('usage:records', async () => {
      const out = await db
        .collection(RECORDS_COLLECTION)
        .where(whereOf(db, userId, query))
        .orderBy('requestedAt', 'desc')
        .skip(offset)
        .limit(limit)
        .get()
      return Array.isArray(out && out.data) ? out.data : []
    })
  }
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1
  return {
    items: items.map(projectRecord),
    total,
    limit,
    offset,
    limitTruncated: paging.limitTruncated === true,
    hasMore: offset + items.length < total,
    page: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
    pageSize: limit,
    totalPages,
    range: { range: query.range, from: query.from, to: query.to }
  }
}

/* ── A14 导出 ─────────────────────────────────────────────────── */

const CSV_HEADER = Object.freeze([
  'requestedAt(CST)',
  'kid',
  'label',
  'endpoint',
  'method',
  'statusCode',
  'latencyMs',
  'isBillable',
  'callCount',
  'imageCount',
  'imageBytes',
  'originalImageCount',
  'seeded',
  'traceId'
])

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvRow(cells) {
  return cells.map(csvCell).join(',')
}

/**
 * A14 导出（CSV + UTF-8 BOM；表尾双口径汇总行 ×2 + 口径注记行）。
 * @param {{keyLabels?:object, budgetMs?:number, maxRows?:number, startedAt?:number, nowMs?:number}} [options]
 */
export async function exportUsageCsv(db, userId, query, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  const scan = await scanUsageRows(db, userId, query, {
    maxRows: options.maxRows || EXPORT_MAX_ROWS,
    budgetMs: options.budgetMs || EXPORT_BUDGET_MS,
    startedAt: options.startedAt
  })
  const rows = scan.rows
    .slice()
    .sort((a, b) => {
      const left = String((a && a.requestedAt) || '')
      const right = String((b && b.requestedAt) || '')
      if (left !== right) return left < right ? -1 : 1
      return String(a._id || '') < String(b._id || '') ? -1 : 1
    })

  const labels = options.keyLabels || {}
  const lines = [csvRow(CSV_HEADER)]
  for (const row of rows) {
    const record = projectRecord(row)
    lines.push(
      csvRow([
        cstLabelOf(record.requestedAt),
        record.kid || '',
        labels[record.kid] || '',
        record.endpoint || '',
        record.method,
        record.statusCode,
        record.latencyMs,
        record.isBillable ? '1' : '0',
        record.callCount,
        record.imageCount,
        record.imageBytes,
        record.originalImageCount,
        record.seeded ? '1' : '0',
        record.traceId || ''
      ])
    )
  }

  const totals = summarizeRows(rows)
  const rowCount = rows.length
  lines.push('')
  lines.push(
    csvRow([
      '汇总',
      `区间 ${cstLabelOf(query.from || '')} ~ ${cstLabelOf(query.to)}`,
      `接口 ${query.endpoints.length ? query.endpoints.join('|') : '全部'}`,
      `调用 ${totals.calls}`,
      `计费调用 ${totals.billableCalls}`,
      `原图 ${totals.originalImages} 张`,
      `失败 ${totals.failedCalls}`,
      `示例 ${totals.seededCalls}`
    ])
  )
  lines.push(csvRow(['图片流量（明细行合计）', `${totals.detailImageBytes} 字节`]))
  lines.push(csvRow(['展示通道流量（不计调用）', `${totals.displayChannelBytes} 字节`]))
  lines.push(csvRow(['汇总口径注记', SUMMARY_CALIBER_NOTE]))

  const stamp = new Date(nowMs + CST_OFFSET_MS).toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const fromToken = (query.from || 'all').slice(0, 10).replace(/-/g, '')
  const toToken = query.to.slice(0, 10).replace(/-/g, '')
  return {
    fileName: `yinyuan-usage-${userId}-${stamp}-${fromToken}_${toToken}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    content: `\ufeff${lines.join('\r\n')}`,
    rowCount,
    truncated: scan.truncated,
    summary: {
      calls: totals.calls,
      billableCalls: totals.billableCalls,
      failedCalls: totals.failedCalls,
      originalImages: totals.originalImages,
      detailImageBytes: totals.detailImageBytes,
      displayChannelBytes: totals.displayChannelBytes,
      imageBytes: totals.imageBytes,
      seededCalls: totals.seededCalls,
      rowCount,
      note: SUMMARY_CALIBER_NOTE
    }
  }
}
