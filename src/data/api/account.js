/**
 * ============================================================================
 * 额度账户适配层（A15）—— `GET /api/v1/account` 的前端唯一实现
 *
 * 端点（B2，服务端已实现待部署）：
 *   GET /api/v1/account   200 `{ ok:true, data:{ userId, planId, planName, monthKey,
 *                            quotaTotalCalls, quotaUsedCalls, quotaRemainCalls, balanceCents,
 *                            originalImageUsedThisMonth, annualFeePaidUntil, updatedAt,
 *                            accountExists } }`
 *   401 UNAUTHORIZED / 405 / 503 NOT_CONFIGURED（存储故障 ⇒ 500，**绝不把故障说成零额度**）
 *
 * ★ 行缺失（新账号尚未开户）**不是错误**：服务端回 `accountExists:false` + 各项 0。
 *   本层原样透出 `accountExists`，页面据此显示「空账号如实 0」，不得渲染成失败态。
 *
 * ★ `consistency`（Σ流水 = 余额 自检）：**本层不提供**（`null`）。
 *   理由：自检需要读流水（A24），而服务端流水集合尚未就绪（`collectionReady:false`）；
 *   本层既不能拿 0 条流水去「证明」余额一致，也不能自己拼一条账 —— 因此如实给 `null`，
 *   由页面显示「暂无法自检」。（mock 实现仍返回完整 `consistency`，不受影响。）
 * ============================================================================
 */
import { request } from './auth.js'

/** 端点路径（相对 `API_BASE_URL`）。 */
export const ACCOUNT_PATH = '/account'

/** 整数（缺 / 非数 ⇒ 0；账户数值一律非负计数或分）。 */
function intOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 可空字符串（空串 ⇒ null，页面按「—」展示）。 */
function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 服务端账户投影 → A15 契约形状（与 mock 同形，数值字段齐备）。
 * @param {object|null} raw `payload.data`
 * @returns {object}
 */
export function normalizeAccount(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  return {
    userId: stringOrNull(data.userId),
    planId: stringOrNull(data.planId),
    planName: stringOrNull(data.planName),
    monthKey: stringOrNull(data.monthKey),
    quotaTotalCalls: intOrZero(data.quotaTotalCalls),
    quotaUsedCalls: intOrZero(data.quotaUsedCalls),
    /** 剩余包量以服务端为准（服务端已按「不跨月结转」口径算好，本层不重算）。 */
    quotaRemainCalls: intOrZero(data.quotaRemainCalls),
    balanceCents: intOrZero(data.balanceCents),
    originalImageUsedThisMonth: intOrZero(data.originalImageUsedThisMonth),
    annualFeePaidUntil: stringOrNull(data.annualFeePaidUntil),
    updatedAt: stringOrNull(data.updatedAt),
    /** `false` ⇒ 该账号尚无额度账户行（各项如实 0，不是读取失败）。 */
    accountExists: data.accountExists === true,
    /** 见文件头：自检需要流水集合，未就绪 ⇒ 如实 null（页面显示「暂无法自检」）。 */
    consistency: null,
  }
}

/**
 * A15 —— 取当前账号额度账户。
 * @param {{silent?:boolean, fetchImpl?:Function}} [options] `silent` 与 mock 签名兼容（真实端点无人工延迟，忽略）
 * @returns {Promise<object>}
 */
export async function getAccount(options = {}) {
  const { silent, ...rest } = options || {}
  void silent
  const { payload } = await request(ACCOUNT_PATH, { method: 'GET', authed: true, ...rest })
  return normalizeAccount(payload && payload.data)
}
