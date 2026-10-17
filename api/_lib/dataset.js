/**
 * 只读取数工具（印源对外只读 API v1）。
 *
 * 只做三件事：集合计数、按 `_id` 升序取页、按某字段聚合计数。
 * 全部为读面；**不写云库、不调写面接口**。
 *
 * ★ 健壮化（2026-10-17）：每个读操作都经 `withTransientRetry` 包一层**有界重试**
 *   （只对瞬时类错误：建连/读取超时、网络类、STS 握手；上限 3 次尝试 ＋ 12s 预算，
 *   指数退避 250ms → 750ms）。理由：线上 500 的真因是云库 SDK 的 `connect timeout`
 *   （建连阶段 ETIMEDOUT）而该 SDK 默认不重试 —— 这类抖动重试一次通常即成功；
 *   非瞬时错误（参数非法/未配置/应用级）**立即抛出**，不重试。
 */
import { cbHandleAgeMs } from './cloudbase.js'
import { describeError, withTransientRetry } from './resilience.js'

/**
 * ★ 云库读操作的**诊断计时**（2026-10-17 并发修复；只进服务端日志）。
 *
 * 为什么：并发 500 的真因是**建连阶段**超时（`connect timeout` / `ETIMEDOUT`），
 * 要判「是不是函数执行区离云库太远的线路问题」必须有**逐操作毫秒数**的前后对比读数。
 * 每次读操作记一行：操作标签 + 毫秒 + 尝试次数 + 是否本实例首个操作 + 句柄年龄。
 * 纪律：**不含**凭据、请求参数、URL、堆栈；标签只含集合名（集合名在 §7.10-2 内属可入服务端日志的面）。
 */
let opSeq = 0
function logOp({ label, ms, attempts, ok, code }) {
  opSeq += 1
  console.log(
    `[api] cb op=${label} ms=${ms} attempts=${attempts} opSeq=${opSeq} first=${opSeq === 1 ? 1 : 0}` +
      ` handleAgeMs=${cbHandleAgeMs()} ok=${ok ? 1 : 0}${code ? ` code=${code}` : ''}`
  )
}

/**
 * 包一层：有界重试 + 逐操作计时。失败时先记一行带错误码的诊断，再把原错误抛出
 * （对外仍由 handler 统一落 500）。
 */
async function runRead(label, fn) {
  let attempts = 0
  const started = Date.now()
  try {
    const value = await withTransientRetry(async () => {
      attempts += 1
      return await fn()
    }, { label })
    logOp({ label, ms: Date.now() - started, attempts, ok: true })
    return value
  } catch (error) {
    logOp({ label, ms: Date.now() - started, attempts, ok: false, code: describeError(error) })
    throw error
  }
}

/** 集合总条数。 */
export async function countDocs(db, collection) {
  return runRead(`count:${collection}`, async () => {
    const res = await db.collection(collection).count()
    return typeof res.total === 'number' ? res.total : 0
  })
}

/**
 * 按 `_id` 升序取一页（稳定顺序＝`_id` 升序；避免依赖库内默认（插入序未定义））。
 * 越界 ⇒ 空数组（不报错）。
 */
export async function fetchPage(db, collection, offset, limit) {
  if (limit <= 0) return []
  return runRead(`page:${collection}`, async () => {
    const res = await db
      .collection(collection)
      .orderBy('_id', 'asc')
      .skip(offset)
      .limit(limit)
      .get()
    return Array.isArray(res.data) ? res.data : []
  })
}

/**
 * 聚合输出上限（★ 实测踩过的坑）：CloudBase `aggregate().end()` **默认只返回 20 行**，
 * 且**不报错、不提示**。本端点的 counts 是「按朝代值分桶」，桶数一旦超过 20
 * （15 类契约 + 库内旧值 + 未来新增值）就会**静默丢桶** ⇒ 必须显式 `.limit()` 抬高上限。
 * 1000 远大于值域实际基数（当前 1 个非空值 + 1 个空值桶）。
 */
const AGG_BUCKET_LIMIT = 1000

/**
 * 按字段聚合计数：返回 { counts: {值:条数}, unrecorded:空值条数 }。
 * 空值（null / undefined / 空串）计入 unrecorded，不进 counts；
 * 非空值**原样读出**（含库内旧值，R-21 口径：不归一、不改写）。
 * 输入侧不限量（实测：1742 行集合的单桶聚合 sum 恒等于 count()，聚合全量参与）。
 */
export async function countByField(db, collection, field) {
  const $ = db.command.aggregate
  const res = await runRead(`aggregate:${collection}.${field}`, async () => {
    return await db
      .collection(collection)
      .aggregate()
      .group({ _id: `$${field}`, n: $.sum(1) })
      .limit(AGG_BUCKET_LIMIT)
      .end()
  })
  const rows = Array.isArray(res.data) ? res.data : []
  if (rows.length >= AGG_BUCKET_LIMIT) {
    // 触到上限即可能截断：只记服务端日志，不改写对外数据（宁可如实少、也不编造）
    console.warn(`[api] aggregate bucket limit reached on ${collection}.${field} (${rows.length})`)
  }
  const counts = {}
  let unrecorded = 0
  for (const row of rows) {
    const value = row ? row._id : null
    const n = Number(row && row.n) || 0
    if (value === null || value === undefined || String(value).trim() === '') {
      unrecorded += n
      continue
    }
    const key = String(value)
    counts[key] = (counts[key] || 0) + n
  }
  return { counts, unrecorded }
}

/**
 * 跨多个集合按「集合顺序 + 各集合内 `_id` 升序」拼一页。
 * sources: [{ collection, key, map, total }]（total 由调用方一次 count 后传入）
 *
 * ★ 2026-10-17：`inscriptions` 已改为「首集合取页 + 两集合计数并行」的单轮往返路径
 *   （见 `api/v1/inscriptions.js`），本函数**暂无调用点**；保留它是为把「合并页语义」
 *   留成一处可读的参考实现（改分页口径时两头对照用），不是死代码里的隐藏依赖。
 */
export async function fetchMergedPage(db, sources, offset, limit) {
  const items = []
  let skip = offset
  for (const source of sources) {
    if (items.length >= limit) break
    if (skip >= source.total) {
      skip -= source.total
      continue
    }
    const need = limit - items.length
    const rows = await fetchPage(db, source.collection, skip, need)
    skip = 0
    for (const row of rows) items.push(source.map(row))
  }
  return items
}

/* ── 字段取值：如实读出，空值不编造 ───────────────────────────────── */

/** 字符串字段：undefined/null ⇒ null；其余**原样**（含空串）返回。 */
export function readString(value) {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : String(value)
}

/** 数值字段：undefined/null/''/非数值 ⇒ null；数值字符串转 Number。 */
export function readNumber(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 字符串数组字段：非数组（含 undefined/null）⇒ []；元素一律转字符串并丢掉空值。 */
export function readStringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
    .map((v) => String(v))
}

/** 记录主键：优先业务 `id`，回落 `_id`。 */
export function readId(doc) {
  const id = readString(doc && doc.id)
  if (id !== null && id !== '') return id
  return readString(doc && doc._id)
}
