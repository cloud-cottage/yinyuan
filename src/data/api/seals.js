/**
 * ============================================================================
 * 玺印适配层（A25 / A26）—— `GET /api/v1/seals` 的前端唯一实现
 *
 * ★ 公开只读面（服务端已上线，2026-10-19 函数合并后经 `api/console/index.js` `?op=seals`
 *   分派，对外 URL 逐字不变）：`GET /api/v1/seals`（含 `/seals/{id}`）无会话即 200
 *   （营销首页样例区是未登录页面）⇒ 本层一律 `authed: false`（标成 `true` 会在本地直接
 *   401、请求根本不发，未登录访客只看到「读取失败」）。
 *
 * 端点（`/seals/{id}` 由 vercel.json rewrite 折成 `?id=`，URL 形态对外可用）：
 *   GET /api/v1/seals?limit=&offset=   200 `{ ok:true, data:{ items:[Seal], total, limit, offset } }`
 *   GET /api/v1/seals/{id}             200 `{ ok:true, data:{…Seal} }`
 *   400 INVALID_PARAM / 404 NOT_FOUND「玺印条目不存在。」/ 405 / 503 NOT_CONFIGURED
 *
 * ★ 分页参数映射（页面契约不变）：页面传 `{page,pageSize}` ⇒ 本层换算
 *   `offset=(page-1)*pageSize`、`limit=pageSize`；服务端 `limit` 缺省 50、上限 200
 *   （超出**截断不报错**）⇒ 以**响应里的** `limit/offset/total` 为准回给页面。
 *   服务端不回 `page/pageSize/totalPages`，由本层按响应读数回算（与 mock 分页信封同形，
 *   D2 护栏：`{items,total,page,pageSize,totalPages}`，不得为裸数组）。
 *
 * ★ 页面筛选（`{keyword,dynasty,material,sealType}`）：服务端本端点**只接受分页参数**
 *   （`parsePaging`），没有关键词 / 朝代 / 材质 / 类型的查询能力 ⇒ 本层**丢弃**
 *   （「形状不支持就丢弃、不透传」纪律，与 `ledger.js` 同口径），不做客户端半量过滤
 *   （只对当页过滤会给出错误的总数）。待服务端支持同义参数后在此层补映射（页面零改动）。
 *
 * ★ 字段面：服务端已按契约名投影（`sealId` / `sealName` / … / `assets[].assetId`），空值
 *   如实（`""` / `null`，库内 `seal_name` / `transcription` 各仅 2/79 非空）；本层逐字段
 *   白名单化透传，**不造字段、不补默认值**。`id` 与 `sealId` 同值（服务端口径，保留）。
 * ============================================================================
 */
import { request } from './auth.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const SEALS_PATH = '/seals'

/** 页面缺省每页条数（与 mock `listSeals` 缺省值同值，避免两条渲染路径的分页手感不同）。 */
export const SEAL_PAGE_SIZE_DEFAULT = 12

/** 服务端分页上限（超限由服务端截断，本层以响应为准）。 */
export const SEAL_PAGE_SIZE_MAX = 200

function intOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 数值或 null（服务端「命中才采用、命不中 ⇒ null」的尺寸读数如实透传）。 */
function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null
}

/**
 * 页面分页参数 → 端点 `limit` / `offset`。
 * 页面传 `{page,pageSize}`（首页样例区）；也兼容直接给 `{limit,offset}`。
 * 缺省每页 `SEAL_PAGE_SIZE_DEFAULT` 条（= mock 缺省 12）、页码从 1 起。
 */
export function pagingOf(page = {}) {
  const src = page && typeof page === 'object' ? page : {}
  const pageSizeGiven = Number(src.pageSize)
  const limitGiven = Number(src.limit)
  const pageGiven = Number(src.page)
  const offsetGiven = Number(src.offset)
  const pageSize = Number.isFinite(pageSizeGiven) && pageSizeGiven > 0
    ? Math.floor(pageSizeGiven)
    : (Number.isFinite(limitGiven) && limitGiven > 0 ? Math.floor(limitGiven) : SEAL_PAGE_SIZE_DEFAULT)
  const offset = Number.isFinite(offsetGiven) && offsetGiven >= 0
    ? Math.floor(offsetGiven)
    : Math.max(0, (Number.isFinite(pageGiven) && pageGiven > 0 ? Math.floor(pageGiven) : 1) - 1) * pageSize
  return { limit: pageSize, offset }
}

/**
 * 单个影像资源白名单（服务端投影：`{assetId,kind,seq,width,height}`；尺寸命不中 ⇒ null）。
 * 缺 `assetId` ⇒ null（调用方过滤；**不造 ID**）。
 */
export function normalizeAsset(raw) {
  if (!raw || typeof raw !== 'object') return null
  const assetId = stringOrNull(raw.assetId)
  if (assetId === null) return null
  return {
    assetId,
    kind: stringOrNull(raw.kind),
    seq: raw.seq === null || raw.seq === undefined ? null : intOrZero(raw.seq),
    width: numberOrNull(raw.width),
    height: numberOrNull(raw.height),
  }
}

/**
 * 玺印条目白名单投影（字段逐一显式化；服务端没有的字段不造，缺 ⇒ null / []，如实）。
 * 结构不符（非对象）⇒ null，由调用方决定空态 / 失败面。
 */
export function normalizeSeal(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    id: stringOrNull(raw.id),
    sealId: stringOrNull(raw.sealId),
    sealCode: stringOrNull(raw.sealCode),
    sealName: stringOrNull(raw.sealName),
    transcription: stringOrNull(raw.transcription),
    dynasty: stringOrNull(raw.dynasty),
    author: stringOrNull(raw.author),
    material: stringOrNull(raw.material),
    shape: stringOrNull(raw.shape),
    sealType: stringOrNull(raw.sealType),
    sealStyle: stringOrNull(raw.sealStyle),
    sizeMm: raw.sizeMm && typeof raw.sizeMm === 'object' ? { ...raw.sizeMm } : null,
    bbox: raw.bbox && typeof raw.bbox === 'object' ? { ...raw.bbox } : null,
    rightsStatus: stringOrNull(raw.rightsStatus),
    reviewStatus: stringOrNull(raw.reviewStatus),
    createdAt: stringOrNull(raw.createdAt),
    updatedAt: stringOrNull(raw.updatedAt),
    assets: Array.isArray(raw.assets) ? raw.assets.map(normalizeAsset).filter(Boolean) : [],
  }
}

/**
 * A25 —— 玺印检索（分页列表）。
 * @param {{keyword?:string, dynasty?:string, material?:string, sealType?:string}} [_filter]
 *        服务端无对应查询参数 ⇒ **丢弃**（见文件头）
 * @param {{page?:number, pageSize?:number, limit?:number, offset?:number}} [page]
 * @param {{fetchImpl?:Function}} [options]
 * @returns {Promise<{items:Array<object>, total:number, limit:number, offset:number,
 *                    page:number, pageSize:number, totalPages:number, isPlaceholder:boolean}>}
 */
export async function listSeals(_filter = {}, page = {}, options = {}) {
  const { limit, offset } = pagingOf(page)
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const { payload } = await request(`${SEALS_PATH}?${query.toString()}`, {
    method: 'GET', authed: false, ...options,
  })
  const data = (payload && payload.data) || {}
  const items = Array.isArray(data.items) ? data.items.map(normalizeSeal).filter(Boolean) : []
  const servedLimit = intOrZero(data.limit) || limit
  const servedOffset = Number.isFinite(Number(data.offset)) ? intOrZero(data.offset) : offset
  const total = intOrZero(data.total)
  return {
    items,
    total,
    limit: servedLimit,
    offset: servedOffset,
    /** 服务端不回页码，按响应读数回算（offset 越界 ⇒ items 空、页号仍如实）。 */
    page: Math.floor(servedOffset / servedLimit) + 1,
    pageSize: servedLimit,
    totalPages: Math.max(1, Math.ceil(total / servedLimit)),
    /** api 数据为真实值；mock 同形信封里的占位标记在 api 模式恒为 false。 */
    isPlaceholder: false,
  }
}

/**
 * A26 —— 玺印详情（单条）。
 * 空入参**本地即拒**（不发请求）：服务端把空 `?id=` 判成列表形态，本地拒才能与 mock
 * 同码（`NOT_FOUND`「玺印条目不存在」）；`id` 逐字 `encodeURIComponent`（不改写）。
 * 404 由 `request()` 按服务端信封抛 `NOT_FOUND`（与 mock 同码）。
 */
export async function getSeal(sealId, options = {}) {
  const id = typeof sealId === 'string' ? sealId.trim() : String(sealId ?? '').trim()
  if (!id) {
    const error = new Error('玺印条目不存在')
    error.code = 'NOT_FOUND'
    throw error
  }
  const { payload } = await request(`${SEALS_PATH}/${encodeURIComponent(id)}`, {
    method: 'GET', authed: false, ...options,
  })
  const seal = normalizeSeal(payload && payload.data)
  if (!seal) {
    const error = new Error('玺印条目不存在')
    error.code = 'NOT_FOUND'
    throw error
  }
  return seal
}
