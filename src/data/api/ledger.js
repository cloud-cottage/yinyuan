/**
 * ============================================================================
 * 账单流水适配层（A24）—— `GET /api/v1/ledger` 的前端唯一实现
 *
 * 端点（B2，服务端已实现待部署）：
 *   GET /api/v1/ledger?limit=&offset=   200 `{ ok:true, data:{ items:[LedgerEntry], total, limit,
 *        offset, limitTruncated, hasMore, page, pageSize, totalPages,
 *        summary:{count,inboundCents,outboundCents,netCents}, collectionReady } }`
 *   400 INVALID_PARAM / 401 UNAUTHORIZED / 405 / 503 NOT_CONFIGURED
 *
 * ★ 流水集合**尚未就绪**（本单红线：不建集合、不写流水）⇒ 服务端 200 + `items: []` +
 *   全 0 汇总 + `collectionReady:false`。本层原样透出 `collectionReady`，
 *   页面据此显示「账单流水暂未开通 / 暂无流水」，**不是错误态、也不是 404**。
 *
 * ★ 分页参数映射（页面契约不变）：页面传 `{page,pageSize}` ⇒ 本层换算 `limit/offset`；
 *   服务端 `limit` 上限 200（超出截断不报错）⇒ 以**响应里的** `limit/offset/page/pageSize/
 *   totalPages` 为准回给页面（页面契约里本就有这些字段，mock 同形）。
 *
 * ★ 页面筛选（`{range, types}`）：服务端本端点**只接受分页参数**，没有时间窗口 / 类型的查询能力。
 *   本层**丢弃**这两个字段（按「形状不支持就丢弃、不透传」的纪律），不做客户端半量过滤
 *   （只对当页做过过滤会给出错误的总数）。待服务端支持同义参数后，在此层补映射即可（页面零改动）。
 * ============================================================================
 */
import { request } from './auth.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const LEDGER_PATH = '/ledger'

/** 服务端分页上限（超限由服务端截断，本层以响应为准）。 */
export const LEDGER_PAGE_SIZE_MAX = 200

/** 页面缺省每页条数（与 mock 实现同值，避免两条渲染路径的分页手感不同）。 */
export const LEDGER_PAGE_SIZE_DEFAULT = 20

function intOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 页面分页参数 → 端点 `limit` / `offset`。
 * 页面既可能给 `{page,pageSize}`（Overview / Billing），也可能直接给 `{limit,offset}`。
 */
export function pagingOf(page = {}) {
  const src = page && typeof page === 'object' ? page : {}
  const limitGiven = Number(src.limit)
  const offsetGiven = Number(src.offset)
  const pageSizeGiven = Number(src.pageSize)
  const pageGiven = Number(src.page)
  const pageSize = Number.isFinite(pageSizeGiven) && pageSizeGiven > 0
    ? Math.floor(pageSizeGiven)
    : (Number.isFinite(limitGiven) && limitGiven > 0 ? Math.floor(limitGiven) : LEDGER_PAGE_SIZE_DEFAULT)
  const offset = Number.isFinite(offsetGiven) && offsetGiven >= 0
    ? Math.floor(offsetGiven)
    : Math.max(0, (Number.isFinite(pageGiven) && pageGiven > 0 ? Math.floor(pageGiven) : 1) - 1) * pageSize
  return { limit: pageSize, offset }
}

/** 单条流水投影（字段逐一显式化；服务端没有的字段不造，缺 ⇒ null / 0）。 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    entryId: stringOrNull(raw.entryId),
    userId: stringOrNull(raw.userId),
    type: stringOrNull(raw.type),
    direction: stringOrNull(raw.direction),
    amountCents: intOrZero(raw.amountCents),
    callCount: intOrZero(raw.callCount),
    originalImageCount: intOrZero(raw.originalImageCount),
    balanceAfterCents: intOrZero(raw.balanceAfterCents),
    quotaUsedAfter: intOrZero(raw.quotaUsedAfter),
    relatedOrderId: stringOrNull(raw.relatedOrderId),
    relatedKid: stringOrNull(raw.relatedKid),
    occurredAt: stringOrNull(raw.occurredAt),
    cstDate: stringOrNull(raw.cstDate),
    cstMonth: stringOrNull(raw.cstMonth),
    remark: stringOrNull(raw.remark),
    operatorType: stringOrNull(raw.operatorType),
  }
}

/**
 * A24 —— 列出流水（分页）。
 * @param {{range?:string, types?:string[]}} [_filter] 服务端无对应查询参数 ⇒ **丢弃**（见文件头）
 * @param {{page?:number, pageSize?:number, limit?:number, offset?:number}} [page]
 * @param {{fetchImpl?:Function}} [options]
 * @returns {Promise<{items:Array<object>, total:number, limit:number, offset:number,
 *                    hasMore:boolean, page:number, pageSize:number, totalPages:number,
 *                    summary:object|null, collectionReady:boolean}>}
 */
export async function listLedgerEntries(_filter = {}, page = {}, options = {}) {
  const { limit, offset } = pagingOf(page)
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const { payload } = await request(`${LEDGER_PATH}?${query.toString()}`, {
    method: 'GET', authed: true, ...options,
  })
  const data = (payload && payload.data) || {}
  const items = Array.isArray(data.items) ? data.items.map(normalizeEntry).filter(Boolean) : []
  const servedLimit = intOrZero(data.limit) || limit
  const servedOffset = Number.isFinite(Number(data.offset)) ? intOrZero(data.offset) : offset
  return {
    items,
    total: intOrZero(data.total),
    limit: servedLimit,
    offset: servedOffset,
    /** 服务端 `limit` 触顶被截断（页面可据此提示「每页最多 N 条」）。 */
    limitTruncated: data.limitTruncated === true,
    hasMore: data.hasMore === true,
    page: intOrZero(data.page) || Math.floor(servedOffset / servedLimit) + 1,
    pageSize: intOrZero(data.pageSize) || servedLimit,
    totalPages: intOrZero(data.totalPages) || 1,
    summary: data.summary && typeof data.summary === 'object' ? { ...data.summary } : null,
    /** `false` ⇒ 账本集合未就绪（空列表是**如实空**，不是筛选无命中）。 */
    collectionReady: data.collectionReady === true,
  }
}
