/**
 * A24 `GET /api/v1/ledger` —— 流水读面（`yinyuan_ledger_entries`，**当前集合尚不存在**）。
 *
 * ★ 本单红线：**不为它建集合、不写入任何流水**。集合不存在 ⇒ 如实返回空列表 + 空汇总
 *   （`collectionReady:false`），不 404、不 500、不造假行。
 * ★ 只读本用户：`{ userId }` 恒为首条筛选子句；机构主体 `u_org_env` 永远不会被读进客户账。
 * ★ 金额整数分；`Σ流入 − Σ流出 = netCents`（页面可据此与余额勾稽）。
 * ★ 汇总走聚合且**显式 `.limit(SUM_BUCKET_LIMIT)`**（CloudBase 聚合默认只回 20 桶且不报错）。
 */
import { getSearchParams, parsePaging } from './pagination.js'
import { withTransientRetry } from './resilience.js'

/** 集合名（**只读**；本模块不含任何写面）。 */
export const COLLECTION = 'yinyuan_ledger_entries'

/** 方向取值（与 `src/data/contract.js` 的 `LEDGER_DIRECTION` 同字面）。 */
export const DIRECTIONS = Object.freeze({ IN: 'IN', OUT: 'OUT' })

/** 汇总聚合的输出上限（方向只有两个值，10 已足够；显式写出以免默认 20 桶截断）。 */
export const SUM_BUCKET_LIMIT = 10

/** 「集合不存在」判别：CloudBase doc/get 与 count 都会抛 `DATABASE_COLLECTION_NOT_EXIST`。 */
export function isMissingCollection(error) {
  const code = String((error && (error.code || error.errCode)) || '')
  const message = String((error && error.message) || error || '')
  return (
    /DATABASE_COLLECTION_NOT_EXIST|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(code) ||
    /(db|table|collection).{0,20}not exist/i.test(message)
  )
}

function readOp(label, fn) {
  return withTransientRetry(fn, { label })
}

function toInt(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** 白名单投影（契约字段；不额外回 `_id`）。 */
export function projectEntry(row) {
  const source = row || {}
  return {
    entryId: source.entryId || source._id || null,
    userId: source.userId || null,
    type: source.type || null,
    direction: source.direction === DIRECTIONS.OUT ? DIRECTIONS.OUT : DIRECTIONS.IN,
    amountCents: toInt(source.amountCents, 0),
    callCount: Math.max(0, toInt(source.callCount, 0)),
    originalImageCount: Math.max(0, toInt(source.originalImageCount, 0)),
    balanceAfterCents: toInt(source.balanceAfterCents, 0),
    quotaUsedAfter: Math.max(0, toInt(source.quotaUsedAfter, 0)),
    relatedOrderId: source.relatedOrderId || null,
    relatedKid: source.relatedKid || null,
    occurredAt: source.occurredAt || null,
    cstDate: source.cstDate || null,
    cstMonth: source.cstMonth || null,
    remark: source.remark || '',
    operatorType: source.operatorType || 'SYSTEM'
  }
}

function emptySummary() {
  return { count: 0, inboundCents: 0, outboundCents: 0, netCents: 0 }
}

function whereOf(db, userId, types) {
  const _ = db.command
  const clauses = [{ userId: String(userId) }]
  if (types.length === 1) clauses.push({ type: types[0] })
  else if (types.length > 1) clauses.push({ type: _.in(types) })
  return clauses.length === 1 ? clauses[0] : _.and(clauses)
}

function typesOf(req) {
  const params = getSearchParams(req)
  const out = []
  for (const name of ['type', 'types']) {
    for (const raw of params.getAll(name)) {
      for (const piece of String(raw).split(',')) {
        const value = piece.trim()
        if (value !== '' && !out.includes(value)) out.push(value.slice(0, 32))
      }
    }
  }
  return out
}

/**
 * 汇总（全量匹配行，不是当前页）：先 `count()` 判集合存在，再按方向分组求和。
 *
 * ★ 为什么先 count：**集合不存在时 `aggregate().end()` 会静默回空数组而不抛错**
 *   （本机实测），若拿聚合当存在性判据会把「集合还没建」误报成 `collectionReady:true`。
 *   `count()` 在集合缺失时抛 `DATABASE_COLLECTION_NOT_EXIST`，是可靠判据。
 * @returns {Promise<{summary:object, total:number, collectionReady:boolean}>}
 */
export async function readLedgerSummary(db, userId, types = []) {
  const $ = db.command.aggregate
  let total = 0
  try {
    const counted = await readOp('ledger:count', () =>
      db.collection(COLLECTION).where(whereOf(db, userId, types)).count()
    )
    total = Math.max(0, toInt(counted && counted.total, 0))
  } catch (error) {
    if (isMissingCollection(error)) return { summary: emptySummary(), total: 0, collectionReady: false }
    throw error
  }
  if (total === 0) return { summary: emptySummary(), total: 0, collectionReady: true }

  const result = await readOp('ledger:summary', () =>
    db
      .collection(COLLECTION)
      .aggregate()
      .match(whereOf(db, userId, types))
      .group({ _id: '$direction', n: $.sum(1), amount: $.sum('$amountCents') })
      .limit(SUM_BUCKET_LIMIT)
      .end()
  )
  const rows = Array.isArray(result && result.data) ? result.data : []
  const summary = emptySummary()
  for (const row of rows) {
    const n = Math.max(0, toInt(row && row.n, 0))
    const amount = Math.max(0, toInt(row && row.amount, 0))
    summary.count += n
    if (String(row && row._id) === DIRECTIONS.OUT) summary.outboundCents += amount
    else summary.inboundCents += amount
  }
  summary.netCents = summary.inboundCents - summary.outboundCents
  return { summary, total, collectionReady: true }
}

/**
 * A24 读面：分页 + 全量汇总。
 * @param {object} db
 * @param {string} userId
 * @param {object} req 用于 `limit/offset/type`
 */
export async function listLedgerEntries(db, userId, req) {
  const paging = parsePaging(req)
  const types = typesOf(req)
  const { summary, total, collectionReady } = await readLedgerSummary(db, userId, types)

  let items = []
  if (collectionReady && total > 0 && paging.limit > 0 && paging.offset < total) {
    const rows = await readOp('ledger:page', async () => {
      const out = await db
        .collection(COLLECTION)
        .where(whereOf(db, userId, types))
        .orderBy('occurredAt', 'desc')
        .skip(paging.offset)
        .limit(paging.limit)
        .get()
      return Array.isArray(out && out.data) ? out.data : []
    })
    items = rows.map(projectEntry)
  }

  return {
    items,
    total,
    limit: paging.limit,
    offset: paging.offset,
    limitTruncated: paging.limitTruncated === true,
    hasMore: paging.offset + items.length < total,
    page: paging.limit > 0 ? Math.floor(paging.offset / paging.limit) + 1 : 1,
    pageSize: paging.limit,
    totalPages: paging.limit > 0 ? Math.max(1, Math.ceil(total / paging.limit)) : 1,
    summary,
    collectionReady
  }
}
