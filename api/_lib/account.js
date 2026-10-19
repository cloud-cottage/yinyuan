/**
 * A15 `GET /api/v1/account` —— 额度账户投影（只读 `yinyuan_accounts` 当前用户行）。
 *
 * ★ 只读本用户：查询一律带 `userId`（session 里的 user id）；机构主体 `u_org_env`
 *   是**独立主体**，绝不会被算进任何客户账号。
 * ★ 行缺失 / 集合为空 ⇒ **如实零值投影**（`accountExists:false`，各项 0、`planId:null`），
 *   不 404、不 500，也不替用户「默认挂标准版」——没有行就是没有开通。
 * ★ 套餐字段（`quotaTotalCalls`）来自 `src/config/pricing.js`（金额/包量单一真源）；
 *   用量计数来自账号行。**包量不跨月结转**：账号行的 `monthKey` 不是当前 CST 月时，
 *   本月已用量按 0 计（与 `pricing.js` 的 `quotaCarryOver:false` 一致）。
 * ★ `monthKey` 一律按 Asia/Shanghai 派生（CST 固定 +08:00，中国无夏令时）。
 */
import { findPlan } from './plans.js'

/** 集合名（本模块**唯一**读的集合）。 */
export const COLLECTION = 'yinyuan_accounts'

const CST_OFFSET_MS = 8 * 60 * 60 * 1000

/** 毫秒时刻 ⇒ CST 自然月 `YYYY-MM`。 */
export function cstMonthOf(atMs) {
  const ms = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  return new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 7)
}

function toInt(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.trunc(n)
}

function isFailedResult(result) {
  return !result || (typeof result.code === 'string' && result.code !== '')
}

/**
 * 读当前用户的账号行。
 * @returns {Promise<{ok:true, row:object|null}|{ok:false, reason:string}>}
 *   `row:null` ＝ 确实没有这一行（如实空，不是故障）
 */
export async function readAccountRow(db, userId) {
  const id = typeof userId === 'string' ? userId.trim() : ''
  if (id === '') return { ok: true, row: null }
  try {
    // 账号行 `_id` 即 userId（契约 §3.10：一行一账号）；用 doc 直取，避免 where 全表扫。
    const result = await db.collection(COLLECTION).doc(id).get()
    if (isFailedResult(result) && !/not exist|not found|DOCUMENT_NOT_FOUND/i.test(String(result.message || result.code || ''))) {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE' }
    }
    const rows = Array.isArray(result && result.data)
      ? result.data
      : result && result.data
        ? [result.data]
        : []
    const row = rows.find((item) => item && (item.userId === id || item._id === id)) || rows[0] || null
    return { ok: true, row }
  } catch (error) {
    // 「文档不存在」在 doc().get() 上可能抛也可能回空；只有明确的「不存在」才当空行，
    // 其它（超时/网络/未配置）一律向上抛，由路由层落 500/503，绝不把故障说成「零额度」。
    const message = `${(error && error.code) || ''} ${(error && error.message) || ''}`
    if (/DOCUMENT_NOT_FOUND|not exist|not found/i.test(message)) return { ok: true, row: null }
    throw error
  }
}

/**
 * 账号零值投影（行不存在时）。
 * 全部数值为 0、`planId:null`、`accountExists:false` —— 不编造套餐、不编造余额。
 */
export function emptyAccount(userId, nowMs = Date.now()) {
  return {
    userId: String(userId || ''),
    planId: null,
    planName: null,
    monthKey: cstMonthOf(nowMs),
    quotaTotalCalls: 0,
    quotaUsedCalls: 0,
    quotaRemainCalls: 0,
    balanceCents: 0,
    originalImageUsedThisMonth: 0,
    annualFeePaidUntil: null,
    updatedAt: null,
    accountExists: false
  }
}

/**
 * 账号行 ⇒ 对外投影。
 * @param {object|null} row
 * @param {{userId:string, nowMs?:number}} context
 */
export function projectAccountRow(row, context = {}) {
  const userId = String(context.userId || '')
  const nowMs = Number.isFinite(Number(context.nowMs)) ? Number(context.nowMs) : Date.now()
  if (!row || typeof row !== 'object') return emptyAccount(userId, nowMs)

  const monthKey = cstMonthOf(nowMs)
  const plan = findPlan(row.planId)
  const sameMonth = String(row.monthKey || '') === monthKey
  const quotaTotalCalls = plan ? plan.monthlyQuotaCalls : 0
  // 包量按月重置：行里的用量只在本月有效
  const quotaUsedCalls = sameMonth ? Math.max(0, toInt(row.quotaUsedCalls, 0)) : 0
  const originalImageUsedThisMonth = sameMonth
    ? Math.max(0, toInt(row.originalImageUsedThisMonth, 0))
    : 0

  return {
    userId: String(row.userId || userId),
    planId: typeof row.planId === 'string' && row.planId !== '' ? row.planId : null,
    planName: plan ? plan.name : null,
    monthKey,
    quotaTotalCalls,
    quotaUsedCalls,
    quotaRemainCalls: Math.max(0, quotaTotalCalls - quotaUsedCalls),
    balanceCents: toInt(row.balanceCents, 0),
    originalImageUsedThisMonth,
    annualFeePaidUntil: row.annualFeePaidUntil || null,
    updatedAt: row.updatedAt || null,
    accountExists: true
  }
}

/**
 * 读 + 投影（端点唯一入口）。
 * @param {object} db
 * @param {string} userId session 里的 user id
 * @param {{nowMs?:number}} [options]
 * @returns {Promise<object>} 投影（永不 404；存储故障向上抛）
 */
export async function getAccountProjection(db, userId, options = {}) {
  const found = await readAccountRow(db, userId)
  if (!found.ok) {
    const error = new Error('account storage unavailable')
    error.name = 'AccountStorageUnavailableError'
    throw error
  }
  return projectAccountRow(found.row, { userId, nowMs: options.nowMs })
}
