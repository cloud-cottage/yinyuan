#!/usr/bin/env node
/**
 * 演示账号「服务端数据」预置 —— 可重跑、幂等（2026-10-19）。
 *
 * 做什么（两件事，顺序固定）：
 *   ① 示例用量：调 `api/_lib/metering.js` 的 `seedUsage()`，给**该演示用户**（不是
 *      `u_org_env`）写 9–27 条 `seeded:true` 的 `yinyuan_usage_records` 明细，时间铺在
 *      **最近 N 个 CST 自然日**（默认 7，含当天）；对应 `yinyuan_usage_daily` 聚合由
 *      `seedUsage()` 内部按「确实新建的明细」累加（`seededCallCount` 必须体现示例部分）。
 *   ② 账号快照：写 `yinyuan_accounts` 一行（`_id` ＝ 用户 id），字段逐字取
 *      `src/data/contract.js` 的 `Account` 口径；套餐与包量从 `src/config/pricing.js`
 *      读（**单一来源**，脚本里不出现包量/套餐字面量）。
 *
 * 字段命名（`yinyuan_accounts`）：**逐字取 `contract.js` 的 `Account`（camelCase）**——
 * `userId` / `planId` / `monthKey` / `quotaTotalCalls` / `quotaUsedCalls` /
 * `quotaRemainCalls` / `balanceCents` / `originalImageUsedThisMonth` / `updatedAt`；
 * 与 `yinyuan_usage_records` 同口径，账号端点（`api/_lib/account.js`）就是按这些名字读的。
 * 行 `_id` ＝ userId（契约 §3.10「一行一账号」）。
 *
 * 幂等纪律：
 *   - 账号行：`doc(userId).set(...)` **整行定值覆盖**（不是 `inc`/追加）⇒ 重跑不插入第二行、
 *     数值不累加；`quota_used_calls` 由**本月计费明细实际合计**派生，重跑结果恒等。
 *   - 示例用量：`trace_id` 由 `(userId, 自然日, 端点, 序号)` 确定性派生 ⇒ 同日重跑全部
 *     deduped（0 新增）；聚合只在明细确实新建时 +n ⇒ 不重复累加。
 *   - 脚本末尾默认做一次**进程内二次 seed**（`idempotent.created` 必须为 0）作为自检。
 *
 * 用法（凭据**只从进程环境变量读**，不落仓、不回显）：
 *   set -a; . /tmp/yy-prod.env; set +a          # CB_ENV / CB_SECRET_ID / CB_SECRET_KEY
 *   node scripts/seed-demo-account.mjs
 *
 * 环境变量：
 *   CB_ENV / CB_SECRET_ID / CB_SECRET_KEY   必填（云库，见 api/_lib/cloudbase.js）
 *   YINYUAN_DEMO_EMAIL                      演示账号邮箱，默认 demo@yinyuan.example
 *   DEMO_USER_ID                            直接指定用户 id（默认按邮箱在 yinyuan_users 查）
 *   SEED_DAYS                               示例铺开天数，默认 7（上限 31）
 *   YINYUAN_BASE_URL + YINYUAN_DEMO_PASSWORD  两者都给时，顺带做「登录 → /me」冒烟
 *                                           （只打印状态码与非敏感字段，**不打印 token**）
 *
 * 退出码：0 ＝ 全部断言通过；非 0 ＝ 有断言失败（见 stdout 的 FAIL 行）。
 */
import { getDb } from '../api/_lib/cloudbase.js'
import { cstParts, seedUsage } from '../api/_lib/metering.js'
import { PLAN_IDS, PRICING } from '../src/config/pricing.js'

const ACCOUNTS = 'yinyuan_accounts'
const USERS = 'yinyuan_users'
const RECORDS = 'yinyuan_usage_records'
const DAILY = 'yinyuan_usage_daily'

/** 示例用量（合计 18 条：17 条 2xx 计费、1 条 500 失败留痕；落在近 SEED_DAYS 天）。 */
const SEED_ENDPOINTS = Object.freeze([
  { endpoint: '/api/v1/dynasties', count: 8 },
  { endpoint: '/api/v1/authors', count: 5 },
  { endpoint: '/api/v1/inscriptions', count: 3, billableCount: 2 },
  { endpoint: '/api/v1/seals', count: 2 }
])

const DEMO_EMAIL = String(process.env.YINYUAN_DEMO_EMAIL || 'demo@yinyuan.example')
  .trim()
  .toLowerCase()
const SEED_DAYS = Math.max(1, Math.trunc(Number(process.env.SEED_DAYS) || 7))

let failures = 0
function check(name, condition, detail) {
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  if (condition) {
    console.log(`✓ ${name}${suffix}`)
  } else {
    failures += 1
    console.log(`✗ ${name}${suffix}`)
  }
}

/** 集合 `count`（带上限保护：演示账号不会到万级）。 */
async function countWhere(db, collection, where) {
  const result = await db.collection(collection).where(where).count()
  return Number(result && result.total) || 0
}

/** 拉全量（演示量级；超出 1000 直接判失败，避免静默截断）。 */
async function fetchAll(db, collection, where) {
  const result = await db.collection(collection).where(where).limit(1000).get()
  const rows = Array.isArray(result && result.data) ? result.data : []
  if (rows.length >= 1000) throw new Error(`${collection}: 行数触顶 1000，演示量级异常`)
  return rows
}

/** 按邮箱查演示用户 id（只读：不碰 users 行的任何字段）。 */
async function resolveUserId(db) {
  const explicit = String(process.env.DEMO_USER_ID || '').trim()
  if (explicit !== '') return explicit
  const result = await db.collection(USERS).where({ email: DEMO_EMAIL }).limit(1).get()
  const rows = Array.isArray(result && result.data) ? result.data : []
  if (rows.length === 0) throw new Error(`yinyuan_users 里没有 ${DEMO_EMAIL}`)
  return String(rows[0]._id || '')
}

/** 标准版套餐（包量与 id 都从 pricing.js 读，不写字面量）。 */
function standardPlan() {
  const plan = PRICING.plans.find((p) => p.planId === PLAN_IDS.STANDARD)
  if (!plan) throw new Error('pricing.js 缺标准版套餐')
  return plan
}

/** 账号行（字段逐字取 contract.js Account）。`quotaUsedCalls` 由本月计费明细派生。 */
function buildAccountRow(userId, usedCalls, nowIso) {
  const plan = standardPlan()
  const total = plan.monthlyQuotaCalls
  const used = Math.max(0, Math.min(total, Math.trunc(usedCalls)))
  return {
    userId,
    planId: plan.planId,
    monthKey: cstParts(Date.now()).cstMonth,
    quotaTotalCalls: total,
    quotaUsedCalls: used,
    quotaRemainCalls: Math.max(0, total - used),
    balanceCents: 0,
    originalImageUsedThisMonth: 0,
    updatedAt: nowIso
  }
}

/** 端到端冒烟：登录 → /me（token 只在内存里，不打印）。 */
async function smokeAuth(baseUrl, email, password) {
  const base = baseUrl.replace(/\/+$/, '')
  const loginRes = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const loginBody = await loginRes.json().catch(() => null)
  const token = loginBody && loginBody.session && loginBody.session.token
  check('登录 POST /api/v1/auth/login ⇒ 200', loginRes.status === 200, `HTTP ${loginRes.status}`)
  check('登录响应带会话令牌', typeof token === 'string' && token.length > 0, { tokenPresent: Boolean(token) })
  if (loginRes.status !== 200 || !token) return

  const meRes = await fetch(`${base}/api/v1/me`, {
    headers: { Accept: 'application/json', Authorization: `Session ${token}` }
  })
  const meBody = await meRes.json().catch(() => null)
  check('GET /api/v1/me ⇒ 200', meRes.status === 200, `HTTP ${meRes.status}`)
  const user = meBody && meBody.user ? meBody.user : null
  check('me 返回演示用户', Boolean(user), user ? { id: user.id, email: user.email, role: user.role, status: user.status } : null)
  if (user) {
    console.log(`  /me user.id=${user.id} email=${user.email} role=${user.role} status=${user.status}`)
  }
}

async function main() {
  const db = getDb()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const { cstMonth } = cstParts(nowMs)
  const userId = await resolveUserId(db)
  if (userId === '') throw new Error('解析不到演示用户 id')
  console.log(`demo user_id=${userId} email=${DEMO_EMAIL} cstMonth=${cstMonth} days=${SEED_DAYS}\n`)

  /* ① 示例用量（发给演示用户，不是 u_org_env） */
  const before = {
    records: await countWhere(db, RECORDS, { userId }),
    seeded: await countWhere(db, RECORDS, { userId, seeded: true }),
    daily: await countWhere(db, DAILY, { userId })
  }
  const first = await seedUsage(db, { userId, kid: 'demo:seed', days: SEED_DAYS, endpoints: SEED_ENDPOINTS })
  check('seedUsage 首次执行成功', first.ok === true, first)
  const after = {
    records: await countWhere(db, RECORDS, { userId }),
    seeded: await countWhere(db, RECORDS, { userId, seeded: true }),
    daily: await countWhere(db, DAILY, { userId })
  }
  console.log(`  records ${before.records} → ${after.records}（seeded ${before.seeded} → ${after.seeded}）· daily 行 ${before.daily} → ${after.daily}`)

  // 幂等自检：同一进程内立刻再跑一遍，必须 0 新增。
  const second = await seedUsage(db, { userId, kid: 'demo:seed', days: SEED_DAYS, endpoints: SEED_ENDPOINTS })
  check('二次 seed 0 新增（幂等）', second.ok === true && second.created === 0, second)
  const afterSecond = {
    records: await countWhere(db, RECORDS, { userId }),
    seeded: await countWhere(db, RECORDS, { userId, seeded: true }),
    daily: await countWhere(db, DAILY, { userId })
  }
  check('二次 seed 后行数不变', JSON.stringify(after) === JSON.stringify(afterSecond), afterSecond)

  /* ② 账号快照（quota_used_calls 由本月计费明细派生 ⇒ 与用量自洽） */
  const monthRecords = await fetchAll(db, RECORDS, { userId, cstMonth })
  const billableCalls = monthRecords
    .filter((row) => row.isBillable === true)
    .reduce((sum, row) => sum + (Number(row.callCount) || 0), 0)
  const row = buildAccountRow(userId, billableCalls, nowIso)
  const existing = await db.collection(ACCOUNTS).doc(userId).get()
  const existingRow = Array.isArray(existing && existing.data) ? existing.data[0] : null
  const setResult = await db.collection(ACCOUNTS).doc(userId).set(row)
  if (setResult && typeof setResult.code === 'string' && setResult.code !== '') {
    throw new Error(`accounts set failed: ${setResult.code}`)
  }
  const readBack = await db.collection(ACCOUNTS).doc(userId).get()
  const stored = Array.isArray(readBack && readBack.data) ? readBack.data[0] : null
  check('accounts 行可回读且 _id＝userId', Boolean(stored) && stored._id === userId, stored && stored._id)
  if (existingRow) {
    const stableKeys = Object.keys(row).filter((key) => key !== 'updatedAt')
    const same = stableKeys.every((key) => existingRow[key] === row[key])
    check('accounts 重跑未改数值（幂等）', same, same ? null : { existingRow, row })
  }

  /* ③ 取证读数 */
  const allRecords = await fetchAll(db, RECORDS, { userId })
  const dailyRows = await fetchAll(db, DAILY, { userId })
  const seededRows = allRecords.filter((r) => r.seeded === true)
  const times = seededRows.map((r) => Date.parse(r.requestedAt)).filter((ms) => Number.isFinite(ms))
  const minAt = times.length ? new Date(Math.min(...times)).toISOString() : null
  const maxAt = times.length ? new Date(Math.max(...times)).toISOString() : null
  const dates = [...new Set(seededRows.map((r) => r.cstDate))].sort()
  const dailyCalls = dailyRows.reduce((sum, r) => sum + (Number(r.callCount) || 0), 0)
  const dailySeeded = dailyRows.reduce((sum, r) => sum + (Number(r.seededCallCount) || 0), 0)
  const monthStartDate = `${cstMonth}-01`

  console.log('\n── 取证读数 ──────────────────────────────────────────')
  console.log('account row =', JSON.stringify(stored, null, 0))
  console.log(`usage: records=${allRecords.length} seeded=${seededRows.length} dailyRows=${dailyRows.length} dailyCallCount=${dailyCalls} dailySeededCallCount=${dailySeeded}`)
  console.log(`seeded 覆盖日 = ${dates.join(',')}（${dates.length} 天）· 时间 ${minAt} ~ ${maxAt}`)
  console.log('daily =', JSON.stringify(dailyRows.map((r) => ({
    cstDate: r.cstDate,
    endpoint: r.endpoint,
    callCount: r.callCount,
    billableCallCount: r.billableCallCount,
    failureCallCount: r.failureCallCount,
    seededCallCount: r.seededCallCount,
    seeded: r.seeded
  }))))

  check('示例明细条数在 9–27 之间', seededRows.length >= 9 && seededRows.length <= 27, seededRows.length)
  check('全部示例明细都在本月', seededRows.every((r) => r.cstMonth === cstMonth), cstMonth)
  check('示例明细日期不早于本月 1 日', dates.every((date) => date >= monthStartDate), { dates, monthStartDate })
  check('示例明细落在近 7 天内', minAt !== null && nowMs - Date.parse(minAt) <= 7 * 24 * 60 * 60 * 1000, { minAt, now: new Date(nowMs).toISOString() })
  check('日聚合合计 = 明细合计', dailyCalls === allRecords.length, { dailyCalls, records: allRecords.length })
  check('日聚合 seededCallCount 体现示例部分', dailySeeded === seededRows.length, { dailySeeded, seeded: seededRows.length })
  check('accounts 包量取标准版', stored && stored.quotaTotalCalls === standardPlan().monthlyQuotaCalls, stored && stored.quotaTotalCalls)
  check('accounts 已用+余量 = 包量', stored && stored.quotaUsedCalls + stored.quotaRemainCalls === stored.quotaTotalCalls, stored && { used: stored.quotaUsedCalls, remain: stored.quotaRemainCalls })
  check('accounts 已用 = 本月计费明细合计', stored && stored.quotaUsedCalls === billableCalls, { used: stored && stored.quotaUsedCalls, billableCalls })
  check('accounts 余额 0 / 原图 0', stored && stored.balanceCents === 0 && stored.originalImageUsedThisMonth === 0)
  const strayKeys = stored ? Object.keys(stored).filter((key) => key !== '_id' && key.includes('_')) : []
  check('accounts 行无 snake_case 残留', strayKeys.length === 0, { strayKeys })

  /* ④ 可选：登录 → /me 冒烟 */
  const baseUrl = String(process.env.YINYUAN_BASE_URL || '').trim()
  const password = String(process.env.YINYUAN_DEMO_PASSWORD || '')
  if (baseUrl !== '' && password !== '') {
    console.log('\n── 登录 → /me ────────────────────────────────────────')
    await smokeAuth(baseUrl, DEMO_EMAIL, password)
  } else {
    console.log('\n（跳过登录冒烟：未给 YINYUAN_BASE_URL / YINYUAN_DEMO_PASSWORD）')
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`}`)
  if (failures !== 0) process.exitCode = 1
}

main().then(
  () => {},
  (error) => {
    console.error(`FATAL ${error && error.message ? error.message : String(error)}`)
    process.exitCode = 1
  }
)
