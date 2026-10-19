/**
 * ============================================================================
 * 用量读面适配层（A10–A14）—— `/api/v1/usage/*` 的前端唯一实现
 *
 * 端点（B2，服务端已实现待部署；响应信封一律 `{ok:true,data:{...}}`）：
 *   A10 `GET /usage/summary?range=|from=&to=&kid=&endpoint=&seeded=`
 *   A11 `GET /usage/breakdown?dim=endpoint|day|key&…同上`
 *   A12 `GET /usage/trend?bucket=day|month&…同上`
 *   A13 `GET /usage/records?limit=&offset=&…同上`
 *   A14 `GET /usage/export?…同上`
 *
 * ★ 本文件最重要的职责：**把页面已用的筛选形状映射成端点支持的参数**（页面契约零改动）。
 *
 *   页面（Overview / Usage）实际会传：
 *     · `{ range: '30d' | '12m' }`                     （Overview 图表 / 导出）
 *     · `{ range: 'month' }`                           （Overview 的本月图片流量 KPI）
 *     · `{ from, to, range, keys[], endpoints[], env }`（Usage 页）
 *     · `{ range: '12m' }`                             （Usage 页的接口选项来源）
 *
 *   服务端只认：`range=1d|7d|30d|90d|all`、或 `from`/`to`（ISO8601，`YYYY-MM-DD` 按 CST 自然日）、
 *   `kid` / `endpoint`（可重复或逗号分隔）、`seeded=all|only|exclude`。
 *
 *   映射规则（**丢什么、为什么**）：
 *     `today`            → `range=1d`（CST 自然日含当日，与服务端口径一致）
 *     `7d/30d/90d/1d/all`→ 同名直传
 *     `month`            → `from=<本月 1 日>`、`to=now`（端点无「本月」预设；按 CST 自然月换算）
 *     `12m`              → `from=<11 个月前的 1 日>`、`to=now`（端点无「近 12 月」预设）
 *     已有 `from`/`to`   → **只发 from/to**，丢掉 `range`（服务端见到 from/to 即按 custom 解释）
 *     `keys[]`           → `kid=a,b`（多值逗号分隔，服务端 `listParam` 支持）
 *     `endpoints[]`      → `endpoint=a,b`
 *     `env`              → **丢弃**：服务端无环境维度（mock 专有筛选），透传会得到 400 或静默无效
 *     未知 `range`        → 丢弃（服务端回落到它自己的缺省 30d，不猜业务窗口）
 *
 * ★ `seeded`：服务端在汇总给 `seededCalls` / `realCalls`、分桶给 `seededCalls`、明细行给
 *   `seeded`。本层**逐字保留**这些字段（页面据此把示例数据标出来），并把可选筛选
 *   `seeded=only|exclude` 透传（页面当前未使用，能力保留）。
 *
 * ★ 不做任何聚合 / 补数：数值一律取服务端；缺 ⇒ 0（计数类字段的「无数据」就是 0），
 *   但不改写任何服务端给出的非 0 值。
 * ============================================================================
 */
import { request } from './auth.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const USAGE_PATHS = Object.freeze({
  summary: '/usage/summary',
  breakdown: '/usage/breakdown',
  trend: '/usage/trend',
  records: '/usage/records',
  export: '/usage/export',
})

/** 服务端预设区间（CST 自然日，含当日）。 */
export const SERVER_RANGES = Object.freeze(['1d', '7d', '30d', '90d', 'all'])

/** 服务端缺省区间（端点文档：缺省 30d）。 */
export const DEFAULT_SERVER_RANGE = '30d'

/** 页面区间字面 → 服务端预设区间（不在表内的一律走 from/to 或丢弃）。 */
const PRESET_BY_PAGE_RANGE = Object.freeze({
  today: '1d',
  '1d': '1d',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'all',
})

/** 服务端聚合维度 / 趋势粒度白名单。 */
const DIMS = Object.freeze(['endpoint', 'day', 'key'])
const BUCKETS = Object.freeze(['day', 'month'])

const CST_OFFSET_MS = 8 * 60 * 60 * 1000

function intOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function numOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 多值筛选入参：`['a','b']` / `'a,b'` / `'a'` 都能收；去空去重保序。 */
function listOf(value) {
  const out = []
  const push = (raw) => {
    const piece = String(raw === null || raw === undefined ? '' : raw).trim()
    if (piece !== '' && !out.includes(piece)) out.push(piece)
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (value !== null && value !== undefined && value !== '') String(value).split(',').forEach(push)
  return out
}

/** CST 自然日 `YYYY-MM-DD`（`nowMs` 仅为自检注入时钟）。 */
export function cstToday(nowMs = Date.now()) {
  return new Date(Number(nowMs) + CST_OFFSET_MS).toISOString().slice(0, 10)
}

/** CST 自然月回退 `monthsBack` 个月的**月首日**（`YYYY-MM-01`；服务端按 CST 自然日解释）。 */
export function cstMonthStart(monthsBack = 0, nowMs = Date.now()) {
  const [y, m] = cstToday(nowMs).split('-').map(Number)
  const total = y * 12 + (m - 1) - Math.trunc(Number(monthsBack) || 0)
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** 取 ISO 时间串（空 / 非串 ⇒ ''）。`YYYY-MM-DD` 与完整 ISO 都原样保留（服务端自行解释）。 */
function instantOf(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  return text
}

/**
 * 页面筛选对象 → 端点查询串（**唯一映射点**；所有 A10–A14 共用，保证五面同区间）。
 * @param {object} [filter] 页面传来的筛选（形状见文件头）
 * @param {{nowMs?:number}} [options] `nowMs` 仅供自检注入时钟
 * @returns {URLSearchParams}
 */
export function buildUsageQuery(filter, options = {}) {
  const src = filter && typeof filter === 'object' ? filter : {}
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  const params = new URLSearchParams()

  const from = instantOf(src.from)
  const to = instantOf(src.to)

  if (from !== '' || to !== '') {
    // 显式窗口优先：服务端见到 from/to 即按 custom 解释，多给 range 只会造成两套口径。
    if (from !== '') params.set('from', from)
    if (to !== '') params.set('to', to)
  } else {
    const rangeRaw = String(src.range === null || src.range === undefined ? '' : src.range).trim().toLowerCase()
    if (rangeRaw === 'month' || rangeRaw === '12m') {
      params.set('from', cstMonthStart(rangeRaw === 'month' ? 0 : 11, nowMs))
      params.set('to', new Date(nowMs).toISOString())
    } else if (PRESET_BY_PAGE_RANGE[rangeRaw]) {
      params.set('range', PRESET_BY_PAGE_RANGE[rangeRaw])
    } else {
      params.set('range', DEFAULT_SERVER_RANGE)
    }
  }

  const kids = listOf(src.keys !== undefined ? src.keys : (src.kids !== undefined ? src.kids : src.kid))
  const endpoints = listOf(src.endpoints !== undefined ? src.endpoints : src.endpoint)
  if (kids.length) params.set('kid', kids.join(','))
  if (endpoints.length) params.set('endpoint', endpoints.join(','))

  const seeded = String(src.seeded || '').trim().toLowerCase()
  if (seeded === 'only' || seeded === 'exclude') params.set('seeded', seeded)

  // `env`（测试 / 线上）与其它 mock 专有字段**在此丢弃**：端点无该维度，透传只会打错。
  return params
}

/** 拼完整路径（`/usage/xxx?…`，末尾无 `?` 时不留尾巴）。 */
function pathWithQuery(path, filter, options) {
  const query = buildUsageQuery(filter, options).toString()
  return query === '' ? path : `${path}?${query}`
}

/** 服务端 `range` 投影 → 页面可读窗口（`{range,from,to}`）。 */
function normalizeRange(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    range: typeof raw.range === 'string' ? raw.range : null,
    from: typeof raw.from === 'string' ? raw.from : null,
    to: typeof raw.to === 'string' ? raw.to : null,
  }
}

/* ---------------------------------------------------------------------------
 * A10 汇总（双口径 + 示例/真实分列）
 * ------------------------------------------------------------------------- */

/**
 * 服务端汇总投影 → A10 契约形状。
 * `realCalls` 缺失时按 `calls - seededCalls` 派生（仅此一处派生，且不改变任何原始字段）。
 */
export function normalizeSummary(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const calls = intOrZero(data.calls)
  const seededCalls = intOrZero(data.seededCalls)
  const realCalls = data.realCalls === undefined || data.realCalls === null
    ? Math.max(0, calls - seededCalls)
    : intOrZero(data.realCalls)
  return {
    calls,
    billableCalls: intOrZero(data.billableCalls),
    failedCalls: intOrZero(data.failedCalls),
    originalImages: intOrZero(data.originalImages),
    imageCount: intOrZero(data.imageCount),
    detailImageBytes: intOrZero(data.detailImageBytes),
    displayChannelBytes: intOrZero(data.displayChannelBytes),
    imageBytes: intOrZero(data.imageBytes),
    avgLatencyMs: numOrZero(data.avgLatencyMs),
    /** 示例数据口径（服务端如实下发；UI 必须据此标注，不得把示例量当真实调用量报）。 */
    seededCalls,
    realCalls,
    quotaTotalCalls: intOrZero(data.quotaTotalCalls),
    quotaUsedCalls: intOrZero(data.quotaUsedCalls),
    quotaRemainCalls: intOrZero(data.quotaRemainCalls),
    range: normalizeRange(data.range),
    scannedCalls: intOrZero(data.scannedCalls),
    truncated: data.truncated === true,
  }
}

/** A10 —— 用量汇总。 */
export async function getUsageSummary(filter, options = {}) {
  const { payload } = await request(pathWithQuery(USAGE_PATHS.summary, filter, options), {
    method: 'GET', authed: true,
  })
  return normalizeSummary(payload && payload.data)
}

/* ---------------------------------------------------------------------------
 * A11 三维聚合
 * ------------------------------------------------------------------------- */

/** 维度归一（非法 ⇒ `endpoint`，与服务端缺省同值；不静默改成别的业务维度）。 */
export function dimOf(dim) {
  const raw = String(dim === null || dim === undefined ? '' : dim).trim().toLowerCase()
  return DIMS.includes(raw) ? raw : 'endpoint'
}

export function normalizeBreakdownRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const dimValue = typeof raw.dimValue === 'string' ? raw.dimValue : ''
  return {
    dimValue,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : dimValue,
    calls: intOrZero(raw.calls),
    billableCalls: intOrZero(raw.billableCalls),
    failedCalls: intOrZero(raw.failedCalls),
    /** 该分组里示例数据的调用次数（0 表示该组全为真实调用）。 */
    seededCalls: intOrZero(raw.seededCalls),
    originalImages: intOrZero(raw.originalImages),
    imageCount: intOrZero(raw.imageCount),
    imageBytes: intOrZero(raw.imageBytes),
    avgLatencyMs: numOrZero(raw.avgLatencyMs),
    share: numOrZero(raw.share),
  }
}

/**
 * A11 —— 三维聚合。
 * @param {object} filter 页面筛选（见文件头）
 * @param {'endpoint'|'day'|'key'} dim
 */
export async function getUsageBreakdown(filter, dim, options = {}) {
  const boundDim = dimOf(dim)
  const query = buildUsageQuery(filter, options)
  query.set('dim', boundDim)
  const { payload } = await request(`${USAGE_PATHS.breakdown}?${query.toString()}`, {
    method: 'GET', authed: true,
  })
  const data = (payload && payload.data) || {}
  return {
    dim: dimOf(data.dim),
    rows: Array.isArray(data.rows) ? data.rows.map(normalizeBreakdownRow).filter(Boolean) : [],
    total: intOrZero(data.total),
    /** 触顶（服务端显式 limit 500）⇒ 如实透出，页面可提示「分组未列全」。 */
    truncatedBuckets: data.truncatedBuckets === true,
  }
}

/* ---------------------------------------------------------------------------
 * A12 趋势
 * ------------------------------------------------------------------------- */

function normalizeTrendPoint(raw) {
  if (!raw || typeof raw !== 'object') return null
  const bucket = typeof raw.bucket === 'string' ? raw.bucket : ''
  if (bucket === '') return null
  return {
    bucket,
    calls: intOrZero(raw.calls),
    billableCalls: intOrZero(raw.billableCalls),
    failedCalls: intOrZero(raw.failedCalls),
    seededCalls: intOrZero(raw.seededCalls),
    originalImages: intOrZero(raw.originalImages),
    imageBytes: intOrZero(raw.imageBytes),
  }
}

/** 粒度归一（非法 ⇒ `day`，与服务端缺省同值）。 */
export function bucketOf(bucket) {
  const raw = String(bucket === null || bucket === undefined ? '' : bucket).trim().toLowerCase()
  return BUCKETS.includes(raw) ? raw : 'day'
}

/** A12 —— 趋势序列（服务端已按窗口缺桶补 0）。 */
export async function getUsageTrend(filter, bucket, options = {}) {
  const boundBucket = bucketOf(bucket)
  const query = buildUsageQuery(filter, options)
  query.set('bucket', boundBucket)
  const { payload } = await request(`${USAGE_PATHS.trend}?${query.toString()}`, {
    method: 'GET', authed: true,
  })
  const data = (payload && payload.data) || {}
  return {
    bucket: bucketOf(data.bucket),
    series: Array.isArray(data.series) ? data.series.map(normalizeTrendPoint).filter(Boolean) : [],
    truncatedBuckets: data.truncatedBuckets === true,
    range: normalizeRange(data.range),
  }
}

/* ---------------------------------------------------------------------------
 * A13 明细（分页）
 * ------------------------------------------------------------------------- */

/** 单条明细投影：服务端字段逐一显式化，`seeded` 显式成布尔（页面据此打「示例」标记）。 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    recordId: typeof raw.recordId === 'string' ? raw.recordId : null,
    userId: typeof raw.userId === 'string' ? raw.userId : null,
    kid: typeof raw.kid === 'string' ? raw.kid : '',
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    method: typeof raw.method === 'string' ? raw.method : '',
    statusCode: intOrZero(raw.statusCode),
    isBillable: raw.isBillable === true,
    callCount: intOrZero(raw.callCount),
    requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : null,
    cstDate: typeof raw.cstDate === 'string' ? raw.cstDate : null,
    cstMonth: typeof raw.cstMonth === 'string' ? raw.cstMonth : null,
    latencyMs: intOrZero(raw.latencyMs),
    imageCount: intOrZero(raw.imageCount),
    imageBytes: intOrZero(raw.imageBytes),
    originalImageCount: intOrZero(raw.originalImageCount),
    traceId: typeof raw.traceId === 'string' ? raw.traceId : null,
    planIdAtTime: typeof raw.planIdAtTime === 'string' ? raw.planIdAtTime : null,
    /** ★ 示例数据标记（服务端透出；`true` ⇒ 该行是演示预置的示例记录，不是真实调用）。 */
    seeded: raw.seeded === true,
  }
}

/** 页面分页 `{page,pageSize}` → 端点 `limit` / `offset`（也接受直接给 limit/offset）。 */
export function recordsPaging(page = {}) {
  const src = page && typeof page === 'object' ? page : {}
  const pageSizeGiven = Number(src.pageSize)
  const limitGiven = Number(src.limit)
  const pageSize = Number.isFinite(pageSizeGiven) && pageSizeGiven > 0
    ? Math.floor(pageSizeGiven)
    : (Number.isFinite(limitGiven) && limitGiven > 0 ? Math.floor(limitGiven) : 20)
  const offsetGiven = Number(src.offset)
  const offset = Number.isFinite(offsetGiven) && offsetGiven >= 0
    ? Math.floor(offsetGiven)
    : Math.max(0, (Number.isFinite(Number(src.page)) && Number(src.page) > 0 ? Math.floor(Number(src.page)) : 1) - 1) * pageSize
  return { limit: pageSize, offset }
}

/**
 * A13 —— 调用明细。
 * 回包补齐页面契约里的 `page` / `pageSize` / `totalPages`（服务端已算好，逐字采用）。
 */
export async function listUsageRecords(filter, page = {}, options = {}) {
  const { limit, offset } = recordsPaging(page)
  const query = buildUsageQuery(filter, options)
  query.set('limit', String(limit))
  query.set('offset', String(offset))
  const { payload } = await request(`${USAGE_PATHS.records}?${query.toString()}`, {
    method: 'GET', authed: true,
  })
  const data = (payload && payload.data) || {}
  const servedLimit = intOrZero(data.limit) || limit
  const servedOffset = Number.isFinite(Number(data.offset)) ? intOrZero(data.offset) : offset
  return {
    items: Array.isArray(data.items) ? data.items.map(normalizeRecord).filter(Boolean) : [],
    total: intOrZero(data.total),
    limit: servedLimit,
    offset: servedOffset,
    limitTruncated: data.limitTruncated === true,
    hasMore: data.hasMore === true,
    page: intOrZero(data.page) || Math.floor(servedOffset / servedLimit) + 1,
    pageSize: intOrZero(data.pageSize) || servedLimit,
    totalPages: intOrZero(data.totalPages) || 1,
    range: normalizeRange(data.range),
  }
}

/* ---------------------------------------------------------------------------
 * A14 导出（**返回 JSON 信封，CSV 文本在 `content` 里**）
 * ------------------------------------------------------------------------- */

/**
 * 服务端导出信封 → A14 契约形状。
 *
 * ★ 端点回的是 **JSON**（`{fileName,mimeType,content,rowCount,truncated,summary}`），
 *   `content` 才是 CSV 文本（UTF-8 BOM）。**下载必须由浏览器侧 Blob 触发**（页面已实现），
 *   不得把本函数的返回值当 URL 去请求（服务端没有 `/usage/export/<file>` 这种地址）。
 */
export function normalizeExport(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const content = typeof data.content === 'string' ? data.content : ''
  return {
    fileName: typeof data.fileName === 'string' && data.fileName !== '' ? data.fileName : 'yinyuan-usage.csv',
    mimeType: typeof data.mimeType === 'string' && data.mimeType !== '' ? data.mimeType : 'text/csv;charset=utf-8',
    content,
    rowCount: intOrZero(data.rowCount),
    /** 到量 / 到时间预算即停 ⇒ 如实 `true`（不假装导全）。 */
    truncated: data.truncated === true,
    summary: data.summary && typeof data.summary === 'object'
      ? {
        calls: intOrZero(data.summary.calls),
        billableCalls: intOrZero(data.summary.billableCalls),
        failedCalls: intOrZero(data.summary.failedCalls),
        originalImages: intOrZero(data.summary.originalImages),
        detailImageBytes: intOrZero(data.summary.detailImageBytes),
        displayChannelBytes: intOrZero(data.summary.displayChannelBytes),
        imageBytes: intOrZero(data.summary.imageBytes),
        seededCalls: intOrZero(data.summary.seededCalls),
        rowCount: intOrZero(data.summary.rowCount),
        note: typeof data.summary.note === 'string' ? data.summary.note : '',
      }
      : null,
  }
}

/** A14 —— 导出当前筛选结果（CSV 文本在 `content`；下载由页面 Blob 完成）。 */
export async function exportUsage(filter, options = {}) {
  const { payload } = await request(pathWithQuery(USAGE_PATHS.export, filter, options), {
    method: 'GET', authed: true,
  })
  return normalizeExport(payload && payload.data)
}
