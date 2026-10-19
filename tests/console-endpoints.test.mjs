/**
 * 控制台只读端点契约冒烟（A1 / A10–A17 / A24）——**真 HTTP ＋ 真 handler ＋ 内存假 DB**。
 *
 * 不连云库、不打生产、不写任何数据：假 DB 只实现本组端点用到的那一面
 * （`doc().get()` / `where().orderBy().skip().limit().get()/count()` /
 *  `aggregate().match().group().sort().limit().end()` / `command.*`）。
 *
 * 覆盖：
 *   1) 9 条端点逐条 200 形状 + 关键值（config / plans / account / usage×5 / ledger）
 *      —— config / plans 为**公开面**（无会话 200），其余 7 条仍会话必填
 *   2) 无数据路径：全 0 / 空数组 / 200（**不 404、不 500**）
 *   3) 越权与隔离：只读本用户；`u_org_env` 与他人行**不得**被算进客户账号
 *   4) seeded 可区分：汇总 `seededCalls`、明细 `seeded` 透出
 *   5) 聚合显式 limit（500）；导出**游标分批**（>1 批）＋ BOM ＋ 双口径汇总行
 *   6) 失败面：401（缺/坏会话，仅 7 条会话端点）、405 + Allow、400（limit=abc / dim 非法）、404 JSON 信封
 *
 * 跑法：`node tests/console-endpoints.test.mjs`（退出码 0 ＝ 全绿）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { buildRecordRow } from '../api/_lib/metering.js'
import { signSession } from '../api/_lib/session.js'
import { SUMMARY_CALIBER_NOTE } from '../api/_lib/usage.js'
import notFoundHandler from '../api/index.js'
import { createConfigHandler } from '../api/_lib/ops/console-config.js'
import { createPlansHandler } from '../api/_lib/ops/console-plans.js'
import { createAccountHandler } from '../api/_lib/ops/console-account.js'
import { createUsageSummaryHandler } from '../api/_lib/ops/usage-summary.js'
import { createUsageBreakdownHandler } from '../api/_lib/ops/usage-breakdown.js'
import { createUsageTrendHandler } from '../api/_lib/ops/usage-trend.js'
import { createUsageRecordsHandler } from '../api/_lib/ops/usage-records.js'
import { createUsageExportHandler } from '../api/_lib/ops/usage-export.js'
import { createLedgerHandler } from '../api/_lib/ops/console-ledger.js'
import { PRICING, getPlanById } from '../src/config/pricing.js'

/* ── 断言小工具 ─────────────────────────────────────────────────── */

let passCount = 0
let failCount = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passCount += 1
    console.log(`✓ ${name}`)
    return
  }
  failCount += 1
  failures.push(name)
  console.log(`✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), { actual, expected })
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
}

/* ── 内存假 DB（CloudBase v3 读面 + 聚合子集） ───────────────────── */

const CMP = Symbol('cmp')
const AGG = Symbol('agg')
const LOGIC = Symbol('logic')

function matches(row, where) {
  if (!where || typeof where !== 'object') return true
  if (where[LOGIC] === 'and') return where.list.every((item) => matches(row, item))
  if (where[LOGIC] === 'or') return where.list.some((item) => matches(row, item))
  return Object.entries(where).every(([field, expected]) => {
    const actual = row[field]
    if (expected && typeof expected === 'object' && expected[CMP]) {
      switch (expected[CMP]) {
        case 'gt':
          return actual > expected.value
        case 'gte':
          return actual >= expected.value
        case 'lte':
          return actual <= expected.value
        case 'neq':
          return actual !== expected.value
        case 'in':
          return Array.isArray(expected.value) && expected.value.includes(actual)
        default:
          return false
      }
    }
    return actual === expected
  })
}

function groupKeyOf(row, spec) {
  if (spec === null || spec === undefined) return null
  const field = String(spec).replace(/^\$/, '')
  return row[field] === undefined ? null : row[field]
}

function sumOf(rows, spec) {
  if (!spec || typeof spec !== 'object') return 0
  if (spec[AGG] === 'cond') {
    const { if: test, then: thenValue, else: elseValue } = spec.value
    return rows.reduce((acc, row) => {
      let hit = false
      if (typeof test === 'string') hit = Boolean(row[test.replace(/^\$/, '')])
      else if (test && test[AGG] === 'gte') {
        const [field, bound] = test.value
        hit = Number(row[String(field).replace(/^\$/, '')]) >= Number(bound)
      }
      return acc + (hit ? Number(thenValue) || 0 : Number(elseValue) || 0)
    }, 0)
  }
  if (spec[AGG] === 'sum') {
    const inner = spec.value
    if (inner && typeof inner === 'object' && inner[AGG]) return sumOf(rows, inner)
    if (typeof inner === 'string' && inner.startsWith('$')) {
      const field = inner.slice(1)
      return rows.reduce((acc, row) => acc + (Number(row[field]) || 0), 0)
    }
    return (Number(inner) || 0) * rows.length
  }
  return 0
}

function createFakeDb(options = {}) {
  const collections = new Map()
  const missing = new Set(options.missingCollections || [])
  const stats = { gets: 0, reads: 0, aggregateLimits: [], limits: [], counts: 0 }

  function docsOf(name, mustExist = false) {
    if (missing.has(name)) {
      if (mustExist) {
        const error = new Error(`Db or Table not exist: ${name}`)
        error.code = 'DATABASE_COLLECTION_NOT_EXIST'
        throw error
      }
    }
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }

  function queryOf(name, where, order, skip, limit) {
    if (missing.has(name)) {
      const error = new Error(`Db or Table not exist: ${name}`)
      error.code = 'DATABASE_COLLECTION_NOT_EXIST'
      throw error
    }
    const docs = docsOf(name)
    let rows = [...docs.values()].filter((row) => matches(row, where))
    if (order) {
      const { field, direction } = order
      rows = rows.slice().sort((a, b) => {
        const left = a[field]
        const right = b[field]
        if (left === right) return 0
        const cmp = left < right ? -1 : 1
        return direction === 'desc' ? -cmp : cmp
      })
    }
    return rows.slice(skip, skip + limit)
  }

  const db = {
    command: {
      and: (list) => ({ [LOGIC]: 'and', list }),
      or: (list) => ({ [LOGIC]: 'or', list }),
      gt: (value) => ({ [CMP]: 'gt', value }),
      gte: (value) => ({ [CMP]: 'gte', value }),
      lte: (value) => ({ [CMP]: 'lte', value }),
      neq: (value) => ({ [CMP]: 'neq', value }),
      in: (value) => ({ [CMP]: 'in', value }),
      aggregate: {
        sum: (value) => ({ [AGG]: 'sum', value }),
        cond: (value) => ({ [AGG]: 'cond', value }),
        gte: (value) => ({ [AGG]: 'gte', value })
      }
    },
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              stats.gets += 1
              const docs = docsOf(name, true)
              const row = docs.get(id)
              return { data: row ? [structuredClone(row)] : [] }
            }
          }
        },
        where(where) {
          const state = { order: null, skip: 0, limit: Number.POSITIVE_INFINITY }
          const api = {
            orderBy(field, direction = 'asc') {
              state.order = { field, direction }
              return api
            },
            skip(n) {
              stats.gets += 1
              state.skip = Number(n) || 0
              return api
            },
            limit(n) {
              stats.limits.push(n)
              state.limit = Number(n)
              return api
            },
            async get() {
              stats.reads += 1
              return { data: queryOf(name, where, state.order, state.skip, state.limit) }
            },
            async count() {
              stats.counts += 1
              docsOf(name, true)
              const rows = [...docsOf(name).values()].filter((row) => matches(row, where))
              return { total: rows.length }
            }
          }
          return api
        },
        aggregate() {
          const state = { where: null, group: null, sort: null, limit: Number.POSITIVE_INFINITY }
          const api = {
            match(where) {
              state.where = where
              return api
            },
            group(spec) {
              state.group = spec
              return api
            },
            sort(spec) {
              state.sort = spec
              return api
            },
            limit(n) {
              stats.aggregateLimits.push(n)
              state.limit = Number(n)
              return api
            },
            async end() {
              docsOf(name, true)
              const rows = [...docsOf(name).values()].filter((row) => matches(row, state.where))
              const buckets = new Map()
              for (const row of rows) {
                const key = groupKeyOf(row, state.group._id)
                if (!buckets.has(key)) buckets.set(key, [])
                buckets.get(key).push(row)
              }
              let out = [...buckets.entries()].map(([key, groupRows]) => {
                const item = { _id: key }
                for (const [field, spec] of Object.entries(state.group)) {
                  if (field === '_id') continue
                  item[field] = sumOf(groupRows, spec)
                }
                return item
              })
              if (state.sort) {
                const [field, direction] = Object.entries(state.sort)[0]
                out = out.sort((a, b) => (a[field] === b[field] ? 0 : a[field] < b[field] ? -1 : 1) * (direction < 0 ? -1 : 1))
              }
              return { data: out.slice(0, state.limit) }
            }
          }
          return api
        }
      }
    }
  }

  return {
    db,
    stats,
    seed(name, rows) {
      const docs = docsOf(name)
      for (const row of rows) {
        const id = row._id || row.recordId || row.userId || Math.random().toString(36)
        docs.set(id, { _id: id, ...row })
      }
    }
  }
}

/* ── 场景数据 ───────────────────────────────────────────────────── */

const SECRET = 'test-session-secret-for-console-endpoints'
const USER_A = 'u-test-a'
const USER_B = 'u-test-b'
const ORG = 'u_org_env'
const NOW_MS = Date.parse('2026-10-19T04:00:00.000Z') // CST 2026-10-19 12:00
// 包量与充值档位一律从单一配置源派生（spec §4.3：夹具也不写死金额/包量）。
const PRO_MONTHLY_QUOTA_CALLS = getPlanById('plan_pro').monthlyQuotaCalls
const RECHARGE_PRESET_CENTS = PRICING.recharge.presetsCents[0]

function record(userId, at, extra = {}) {
  const row = buildRecordRow({
    userId,
    kid: extra.kid || 'k-test',
    endpoint: extra.endpoint || '/api/v1/dynasties',
    method: 'GET',
    statusCode: extra.statusCode === undefined ? 200 : extra.statusCode,
    requestedAt: at,
    latencyMs: extra.latencyMs === undefined ? 100 : extra.latencyMs,
    imageCount: extra.imageCount || 0,
    imageBytes: extra.imageBytes || 0,
    originalImageCount: extra.originalImageCount || 0,
    traceId: extra.traceId,
    seeded: extra.seeded === true
  })
  // `buildRecordRow` 本轮的图片类字段恒 0（端点为文字检索）；自检另行注入，用以验证双口径求和。
  return {
    ...row,
    imageCount: Math.trunc(Number(extra.imageCount) || 0),
    imageBytes: Math.trunc(Number(extra.imageBytes) || 0),
    originalImageCount: Math.trunc(Number(extra.originalImageCount) || 0)
  }
}

function buildFixture() {
  const fake = createFakeDb({ missingCollections: ['yinyuan_ledger_entries'] })
  fake.seed('yinyuan_users', [
    { _id: USER_A, status: 'active', role: 'user', email: 'a@example.com' },
    { _id: USER_B, status: 'active', role: 'user', email: 'b@example.com' }
  ])
  fake.seed('yinyuan_accounts', [
    {
      _id: USER_A,
      userId: USER_A,
      planId: 'plan_pro',
      monthKey: '2026-10',
      quotaTotalCalls: PRO_MONTHLY_QUOTA_CALLS,
      quotaUsedCalls: 42,
      balanceCents: 12345,
      originalImageUsedThisMonth: 3,
      annualFeePaidUntil: '2027-01-01T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z'
    },
    // 上月行：包量不跨月 ⇒ 本月已用量应按 0
    { _id: USER_B, userId: USER_B, planId: 'plan_standard', monthKey: '2026-09', quotaUsedCalls: 99, balanceCents: 500 }
  ])
  fake.seed('yinyuan_api_keys', [{ _id: 'k-test', user_id: USER_A, label: '演示密钥', status: 'active', prefix: 'yk_abc' }])

  const rows = [
    record(USER_A, '2026-10-18T01:00:00.000Z', { endpoint: '/api/v1/dynasties', imageBytes: 1024 }),
    record(USER_A, '2026-10-18T02:00:00.000Z', { endpoint: '/api/v1/authors', statusCode: 500 }),
    record(USER_A, '2026-10-19T01:00:00.000Z', { endpoint: '/api/v1/authors', imageBytes: 2048, seeded: true }),
    record(USER_B, '2026-10-19T01:30:00.000Z', { endpoint: '/api/v1/inscriptions' }),
    record(ORG, '2026-10-19T01:45:00.000Z', { endpoint: '/api/v1/inscriptions', kid: 'env:default' })
  ]
  fake.seed('yinyuan_usage_records', rows)
  return fake
}

function tokenFor(uid) {
  const signed = signSession({ uid, role: 'user', ttlSeconds: 3600, secret: SECRET })
  assert.equal(signed.ok, true)
  return signed.token
}

function makeServer(fake) {
  const options = { db: fake.db, secret: SECRET, nowMs: NOW_MS }
  const routes = {
    '/api/v1/config': createConfigHandler(options),
    '/api/v1/plans': createPlansHandler(options),
    '/api/v1/account': createAccountHandler(options),
    '/api/v1/usage/summary': createUsageSummaryHandler(options),
    '/api/v1/usage/breakdown': createUsageBreakdownHandler(options),
    '/api/v1/usage/trend': createUsageTrendHandler(options),
    '/api/v1/usage/records': createUsageRecordsHandler(options),
    '/api/v1/usage/export': createUsageExportHandler(options),
    '/api/v1/ledger': createLedgerHandler(options)
  }
  const server = http.createServer((req, res) => {
    const path = String(req.url || '').split('?')[0]
    const handler = routes[path] || notFoundHandler
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function request(port, path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.token) headers.Authorization = `Session ${options.token}`
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method || 'GET',
    headers
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch (error) {
    body = null
  }
  return { status: response.status, headers: response.headers, body, text }
}

/* ── 用例 ───────────────────────────────────────────────────────── */

async function main() {
  const fake = buildFixture()
  const { server, port } = await makeServer(fake)
  const tokenA = tokenFor(USER_A)
  const tokenB = tokenFor(USER_B)

  try {
    section('鉴权面（7 条控制台端点统一；config/plans 已公开）')
    for (const path of [
      '/api/v1/account',
      '/api/v1/usage/summary',
      '/api/v1/usage/breakdown',
      '/api/v1/usage/trend',
      '/api/v1/usage/records',
      '/api/v1/usage/export',
      '/api/v1/ledger'
    ]) {
      const noToken = await request(port, path)
      ok(`${path} 无会话 ⇒ 401`, noToken.status === 401, noToken.status)
      ok(`${path} 401 信封`, noToken.body && noToken.body.ok === false && noToken.body.reason === 'UNAUTHORIZED', noToken.body)
      const badToken = await request(port, path, { token: 'not-a-real-token' })
      ok(`${path} 坏会话 ⇒ 401`, badToken.status === 401, badToken.status)
    }

    section('公开只读面（config / plans 无会话）')
    const pubConfig = await request(port, '/api/v1/config')
    ok('config 无会话 ⇒ 200（公开面）', pubConfig.status === 200, pubConfig.status)
    ok('config 无会话 data.ok', Boolean(pubConfig.body && pubConfig.body.ok === true && pubConfig.body.data), pubConfig.body)
    const pubPlans = await request(port, '/api/v1/plans')
    ok('plans 无会话 ⇒ 200（公开面）', pubPlans.status === 200, pubPlans.status)
    eq('plans 无会话三档', pubPlans.body && pubPlans.body.data.plans.length, 3)
    const secConfig = await request(port, '/api/v1/config', { token: tokenA })
    ok('config 带会话仍 200', secConfig.status === 200, secConfig.status)
    const secPlans = await request(port, '/api/v1/plans', { token: tokenA })
    ok('plans 带会话仍 200', secPlans.status === 200, secPlans.status)

    const postConfig = await request(port, '/api/v1/config', { method: 'POST', token: tokenA })
    ok('POST /config ⇒ 405', postConfig.status === 405, postConfig.status)
    eq('405 带 Allow: GET', postConfig.headers.get('allow'), 'GET')
    ok('405 信封 reason', postConfig.body && postConfig.body.reason === 'METHOD_NOT_ALLOWED', postConfig.body)

    const unknown = await request(port, '/api/v1/bogus-console', { token: tokenA })
    ok('未知路径 ⇒ 404 JSON 信封', unknown.status === 404 && unknown.body && unknown.body.reason === 'NOT_FOUND', unknown.body)
    ok('未知路径 Content-Type 为 JSON', String(unknown.headers.get('content-type') || '').includes('application/json'))

    section('A1 GET /api/v1/config')
    const config = await request(port, '/api/v1/config', { token: tokenA })
    eq('config 200', config.status, 200)
    ok('config data 键集', config.body && config.body.ok === true && config.body.data, config.body)
    const cfg = config.body.data
    ok(
      'config 关键键齐备',
      ['featureFlags', 'site', 'demo', 'apiKeyLimit', 'orderPendingTimeoutMinutes', 'demoEnvQuota', 'notConnectedNotice', 'dataSource']
        .every((key) => key in cfg),
      Object.keys(cfg)
    )
    eq('config dataSource=api', cfg.dataSource, 'api')
    eq('config registerOpen 来自配置', cfg.featureFlags.registerOpen, true)
    eq('config apiKeyLimit 来自配置', cfg.apiKeyLimit, 5)
    eq('config site.name', cfg.site.name, '印源')
    ok('config **不含**演示口令/验证码', !config.text.includes('yinyuan2026') && !config.text.includes('DEMO'), Object.keys(cfg.demo))
    ok('config demo 段只含白名单字段', !('password' in cfg.demo) && !('captcha' in cfg.demo), Object.keys(cfg.demo))

    section('A16/A17 GET /api/v1/plans')
    const plans = await request(port, '/api/v1/plans', { token: tokenA })
    eq('plans 200', plans.status, 200)
    eq('plans 三档', plans.body.data.plans.length, 3)
    eq('plans pricingTable.rows 三档', plans.body.data.pricingTable.rows.length, 3)
    ok(
      'plans 金额全为整数分',
      plans.body.data.plans.every((plan) => Number.isInteger(plan.annualFeeCents) && Number.isInteger(plan.overageUnitPriceCents)),
      plans.body.data.plans.map((p) => p.annualFeeCents)
    )
    ok(
      'plans 与配置单源一致（原图单价折叠进每档）',
      plans.body.data.plans.every((plan) => plan.originalImageUnitPriceCents === plans.body.data.pricingTable.originalImageUnitPriceCents)
    )
    eq('plans currency', plans.body.data.currency, 'CNY')

    section('A15 GET /api/v1/account')
    const account = await request(port, '/api/v1/account', { token: tokenA })
    eq('account 200', account.status, 200)
    eq('account accountExists', account.body.data.accountExists, true)
    eq('account planId', account.body.data.planId, 'plan_pro')
    eq('account quotaTotalCalls 来自套餐', account.body.data.quotaTotalCalls, PRO_MONTHLY_QUOTA_CALLS)
    eq('account quotaUsedCalls 来自账号行', account.body.data.quotaUsedCalls, 42)
    eq('account quotaRemainCalls', account.body.data.quotaRemainCalls, PRO_MONTHLY_QUOTA_CALLS - 42)
    eq('account balanceCents', account.body.data.balanceCents, 12345)
    eq('account monthKey（CST）', account.body.data.monthKey, '2026-10')

    const accountB = await request(port, '/api/v1/account', { token: tokenB })
    eq('account 跨月行：本月已用量归零', accountB.body.data.quotaUsedCalls, 0)
    eq('account 跨月行：余额照读', accountB.body.data.balanceCents, 500)

    const tokenMissing = tokenFor('u-no-account-row')
    fake.seed('yinyuan_users', [{ _id: 'u-no-account-row', status: 'active', role: 'user' }])
    const accountEmpty = await request(port, '/api/v1/account', { token: tokenMissing })
    eq('account 无行 ⇒ 200（不 404）', accountEmpty.status, 200)
    eq('account 无行 ⇒ accountExists:false', accountEmpty.body.data.accountExists, false)
    eq('account 无行 ⇒ 全 0 余额', accountEmpty.body.data.balanceCents, 0)
    eq('account 无行 ⇒ 套餐 0', accountEmpty.body.data.quotaTotalCalls, 0)
    eq('account 无行 ⇒ planId null', accountEmpty.body.data.planId, null)

    section('A10 GET /api/v1/usage/summary')
    const summary = await request(port, '/api/v1/usage/summary?range=30d', { token: tokenA })
    eq('summary 200', summary.status, 200)
    const s = summary.body.data
    eq('summary calls 只算本用户（3）', s.calls, 3)
    eq('summary billableCalls', s.billableCalls, 2)
    eq('summary failedCalls', s.failedCalls, 1)
    eq('summary seededCalls 可区分', s.seededCalls, 1)
    eq('summary realCalls', s.realCalls, 2)
    eq('summary detailImageBytes', s.detailImageBytes, 3072)
    eq('summary displayChannelBytes 如实 0', s.displayChannelBytes, 0)
    eq('summary imageBytes = 明细 + 展示', s.imageBytes, 3072)
    eq('summary quotaRemainCalls 拼账号', s.quotaRemainCalls, 9958)
    ok(
      'summary 不含他人/机构行',
      s.calls === 3 && !summary.text.includes('u_org_env') && !summary.text.includes(USER_B),
      s.calls
    )

    const summaryEmpty = await request(port, '/api/v1/usage/summary?range=1d', { token: tokenMissing })
    eq('summary 无数据 ⇒ 200', summaryEmpty.status, 200)
    eq('summary 无数据 ⇒ 全 0', summaryEmpty.body.data.calls, 0)
    eq('summary 无数据 ⇒ 图片流量 0', summaryEmpty.body.data.imageBytes, 0)
    eq('summary 无数据 ⇒ 不 404', summaryEmpty.body.ok, true)

    const summaryBad = await request(port, '/api/v1/usage/summary?range=42d', { token: tokenA })
    eq('summary 非法 range ⇒ 400', summaryBad.status, 400)
    eq('summary 非法 range reason', summaryBad.body.reason, 'INVALID_PARAM')

    section('A11 GET /api/v1/usage/breakdown')
    const byEndpoint = await request(port, '/api/v1/usage/breakdown?dim=endpoint', { token: tokenA })
    eq('breakdown 200', byEndpoint.status, 200)
    eq('breakdown 两桶（dynasties/authors）', byEndpoint.body.data.rows.length, 2)
    eq('breakdown total', byEndpoint.body.data.total, 3)
    const authors = byEndpoint.body.data.rows.find((row) => row.dimValue === '/api/v1/authors')
    eq('breakdown authors calls', authors.calls, 2)
    eq('breakdown authors failedCalls', authors.failedCalls, 1)
    eq('breakdown authors seededCalls', authors.seededCalls, 1)
    ok('breakdown share 合计 ≈ 1', Math.abs(byEndpoint.body.data.rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9)
    ok('breakdown 聚合显式 limit=500', fake.stats.aggregateLimits.includes(500), fake.stats.aggregateLimits)

    const byDay = await request(port, '/api/v1/usage/breakdown?dim=day', { token: tokenA })
    eq('breakdown day 两桶', byDay.body.data.rows.length, 2)
    ok(
      'breakdown day 按 CST 归属日',
      byDay.body.data.rows.every((row) => /^2026-10-(18|19)$/.test(row.dimValue)),
      byDay.body.data.rows.map((r) => r.dimValue)
    )

    const byKey = await request(port, '/api/v1/usage/breakdown?dim=key', { token: tokenA })
    eq('breakdown key label 取自密钥表', byKey.body.data.rows[0].label, '演示密钥')

    const breakdownEmpty = await request(port, '/api/v1/usage/breakdown?dim=endpoint', { token: tokenMissing })
    eq('breakdown 无数据 ⇒ 200 空数组', breakdownEmpty.status, 200)
    eq('breakdown 无数据 rows=[]', breakdownEmpty.body.data.rows.length, 0)

    const breakdownBad = await request(port, '/api/v1/usage/breakdown?dim=seal', { token: tokenA })
    eq('breakdown 非法 dim ⇒ 400', breakdownBad.status, 400)

    section('A12 GET /api/v1/usage/trend')
    const trend = await request(port, '/api/v1/usage/trend?range=7d&bucket=day', { token: tokenA })
    eq('trend 200', trend.status, 200)
    eq('trend 7 日补零（7 桶）', trend.body.data.series.length, 7)
    ok(
      'trend 首尾桶为 CST 自然日',
      trend.body.data.series[0].bucket === '2026-10-13' && trend.body.data.series[6].bucket === '2026-10-19',
      [trend.body.data.series[0].bucket, trend.body.data.series[6].bucket]
    )
    const day19 = trend.body.data.series.find((slot) => slot.bucket === '2026-10-19')
    eq('trend 10-19 calls', day19.calls, 1)
    eq('trend 空日 calls=0', trend.body.data.series[0].calls, 0)
    eq('trend 空日 seededCalls=0', trend.body.data.series[0].seededCalls, 0)
    eq('trend seeded 桶可区分', day19.seededCalls, 1)

    const trendMonth = await request(port, '/api/v1/usage/trend?range=90d&bucket=month', { token: tokenA })
    ok('trend 月桶', trendMonth.body.data.bucket === 'month' && trendMonth.body.data.series.length >= 1, trendMonth.body.data.series)
    ok(
      'trend 月桶 key 形如 YYYY-MM',
      trendMonth.body.data.series.every((slot) => /^\d{4}-\d{2}$/.test(slot.bucket))
    )

    const trendEmpty = await request(port, '/api/v1/usage/trend?range=7d', { token: tokenMissing })
    eq('trend 无数据 ⇒ 7 个 0 桶', trendEmpty.body.data.series.filter((slot) => slot.calls === 0).length, 7)

    const trendBad = await request(port, '/api/v1/usage/trend?bucket=week', { token: tokenA })
    eq('trend 非法 bucket ⇒ 400', trendBad.status, 400)

    section('A13 GET /api/v1/usage/records')
    const records = await request(port, '/api/v1/usage/records', { token: tokenA })
    eq('records 200', records.status, 200)
    eq('records total', records.body.data.total, 3)
    eq('records 缺省 limit=50', records.body.data.limit, 50)
    ok(
      'records 按 requestedAt 倒序',
      records.body.data.items[0].requestedAt >= records.body.data.items[1].requestedAt,
      records.body.data.items.map((r) => r.requestedAt)
    )
    eq('records 行透出 seeded', records.body.data.items[0].seeded, true)
    ok('records 行不含 _id', !('_id' in records.body.data.items[0]))
    ok(
      'records 行字段为契约面',
      ['recordId', 'userId', 'kid', 'endpoint', 'method', 'statusCode', 'isBillable', 'callCount', 'requestedAt', 'cstDate', 'cstMonth', 'latencyMs', 'imageCount', 'imageBytes', 'originalImageCount', 'traceId', 'planIdAtTime', 'seeded']
        .every((key) => key in records.body.data.items[0]),
      Object.keys(records.body.data.items[0])
    )

    const recordsPage = await request(port, '/api/v1/usage/records?limit=1&offset=1', { token: tokenA })
    eq('records 分页 limit=1', recordsPage.body.data.items.length, 1)
    eq('records hasMore', recordsPage.body.data.hasMore, true)
    eq('records totalPages', recordsPage.body.data.totalPages, 3)

    const recordsOverLimit = await request(port, '/api/v1/usage/records?limit=999', { token: tokenA })
    eq('records limit 超上限 ⇒ 200 截断', recordsOverLimit.status, 200)
    eq('records limit 截断为 200', recordsOverLimit.body.data.limit, 200)
    eq('records limitTruncated', recordsOverLimit.body.data.limitTruncated, true)

    const recordsBadLimit = await request(port, '/api/v1/usage/records?limit=abc', { token: tokenA })
    eq('records limit=abc ⇒ 400', recordsBadLimit.status, 400)
    const recordsBadOffset = await request(port, '/api/v1/usage/records?offset=-1', { token: tokenA })
    eq('records offset=-1 ⇒ 400', recordsBadOffset.status, 400)

    const recordsOffset = await request(port, '/api/v1/usage/records?offset=9999', { token: tokenA })
    eq('records offset 越界 ⇒ 空数组', recordsOffset.body.data.items.length, 0)
    eq('records offset 越界仍回 total', recordsOffset.body.data.total, 3)

    const recordsEmpty = await request(port, '/api/v1/usage/records', { token: tokenMissing })
    ok(
      'records 无数据 ⇒ 200 空',
      recordsEmpty.status === 200 && recordsEmpty.body.data.items.length === 0 && recordsEmpty.body.data.total === 0,
      recordsEmpty.body
    )

    const recordsFiltered = await request(port, '/api/v1/usage/records?endpoint=%2Fapi%2Fv1%2Fauthors&seeded=only', { token: tokenA })
    eq('records endpoint+seeded 过滤', recordsFiltered.body.data.total, 1)
    eq('records 过滤命中示例行', recordsFiltered.body.data.items[0].seeded, true)

    section('A14 GET /api/v1/usage/export')
    const exported = await request(port, '/api/v1/usage/export?range=30d', { token: tokenA })
    eq('export 200', exported.status, 200)
    const csv = exported.body.data
    eq('export rowCount = 本用户 3 行', csv.rowCount, 3)
    ok('export BOM 前缀', csv.content.charCodeAt(0) === 0xfeff)
    ok('export CRLF 行分隔', csv.content.includes('\r\n'))
    ok('export 表头含 seeded 列', csv.content.split('\r\n')[0].includes('seeded'))
    ok('export 表尾含双口径汇总行', csv.content.includes('图片流量（明细行合计）,3072 字节') && csv.content.includes('展示通道流量（不计调用）,0 字节'), csv.content.slice(-400))
    eq('export summary.note 与汇总行同文', csv.summary.note, SUMMARY_CALIBER_NOTE)
    eq('export summary.imageBytes', csv.summary.imageBytes, 3072)
    eq('export summary.detailImageBytes', csv.summary.detailImageBytes, 3072)
    eq('export summary.seededCalls', csv.summary.seededCalls, 1)
    ok('export 含密钥 label（来自密钥表）', csv.content.includes('演示密钥'))

    const exportEmpty = await request(port, '/api/v1/usage/export?range=7d', { token: tokenMissing })
    eq('export 无数据 ⇒ 200', exportEmpty.status, 200)
    eq('export 无数据 rowCount=0', exportEmpty.body.data.rowCount, 0)
    ok('export 无数据仍为合法 CSV（表头+BOM）', exportEmpty.body.data.content.startsWith('\ufeffrequestedAt(CST)'))

    const exportBudget = await request(port, '/api/v1/usage/export?range=30d', { token: tokenA })
    ok('export 未截断（3 行 < 上限）', exportBudget.body.data.truncated === false)

    section('A24 GET /api/v1/ledger（集合不存在）')
    const ledger = await request(port, '/api/v1/ledger', { token: tokenA })
    eq('ledger 集合不存在 ⇒ 200', ledger.status, 200)
    eq('ledger items=[]', ledger.body.data.items.length, 0)
    eq('ledger total=0', ledger.body.data.total, 0)
    eq('ledger collectionReady:false', ledger.body.data.collectionReady, false)
    ok(
      'ledger 空汇总全 0',
      ledger.body.data.summary.count === 0 && ledger.body.data.summary.inboundCents === 0 && ledger.body.data.summary.outboundCents === 0 && ledger.body.data.summary.netCents === 0,
      ledger.body.data.summary
    )

    section('ledger 集合存在时（另建假 DB）')
    const ledgerFake = createFakeDb()
    ledgerFake.seed('yinyuan_users', [
      { _id: USER_A, status: 'active', role: 'user' },
      { _id: 'u-other', status: 'active', role: 'user' }
    ])
    ledgerFake.seed('yinyuan_ledger_entries', [
      { _id: 'le-1', entryId: 'le-1', userId: USER_A, type: 'RECHARGE', direction: 'IN', amountCents: RECHARGE_PRESET_CENTS, balanceAfterCents: RECHARGE_PRESET_CENTS, occurredAt: '2026-10-01T00:00:00.000Z' },
      { _id: 'le-2', entryId: 'le-2', userId: USER_A, type: 'DEDUCT_BALANCE', direction: 'OUT', amountCents: 2500, balanceAfterCents: 97500, occurredAt: '2026-10-02T00:00:00.000Z' },
      { _id: 'le-3', entryId: 'le-3', userId: USER_B, type: 'RECHARGE', direction: 'IN', amountCents: 999, balanceAfterCents: 999, occurredAt: '2026-10-02T00:00:00.000Z' }
    ])
    const ledgerServer = await makeServer(ledgerFake)
    try {
      const listed = await request(ledgerServer.port, '/api/v1/ledger', { token: tokenA })
      eq('ledger 有集合 200', listed.status, 200)
      eq('ledger 只回本用户 2 行', listed.body.data.total, 2)
      eq('ledger 倒序（10-02 在前）', listed.body.data.items[0].entryId, 'le-2')
      eq('ledger 汇总流入', listed.body.data.summary.inboundCents, RECHARGE_PRESET_CENTS)
      eq('ledger 汇总流出', listed.body.data.summary.outboundCents, 2500)
      eq('ledger 汇总净额', listed.body.data.summary.netCents, 97500)
      eq('ledger collectionReady:true', listed.body.data.collectionReady, true)
      ok('ledger 不含他人行', !listed.text.includes('le-3'))
      const emptyUser = await request(ledgerServer.port, '/api/v1/ledger', { token: tokenFor('u-other') })
      ok('ledger 无行用户仍 200/0', emptyUser.status === 200 && emptyUser.body.data.total === 0, emptyUser.body)
    } finally {
      ledgerServer.server.close()
    }

    section('导出分批（1200 行，游标 >1 批）')
    const bulkFake = createFakeDb()
    bulkFake.seed('yinyuan_users', [{ _id: USER_A, status: 'active', role: 'user' }])
    const bulk = []
    for (let i = 0; i < 1200; i += 1) {
      const at = new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60000).toISOString()
      bulk.push(record(USER_A, at, { traceId: `bulk-${i}`, endpoint: '/api/v1/authors' }))
    }
    bulkFake.seed('yinyuan_usage_records', bulk)
    const beforeReads = bulkFake.stats.reads
    const bulkServer = await makeServer(bulkFake)
    try {
      const big = await request(bulkServer.port, '/api/v1/usage/export?range=all', { token: tokenA })
      eq('批量导出 200', big.status, 200)
      eq('批量导出导全 1200 行', big.body.data.rowCount, 1200)
      ok('批量导出走多批游标（读次数 ≥ 3）', bulkFake.stats.reads - beforeReads >= 3, bulkFake.stats.reads - beforeReads)
      ok('批量导出 summary.calls', big.body.data.summary.calls === 1200)
    } finally {
      bulkServer.server.close()
    }

  } finally {
    server.close()
  }

  console.log(`\n${passCount} passed, ${failCount} failed`)
  if (failCount > 0) {
    console.log(`失败项：${failures.join(' / ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
