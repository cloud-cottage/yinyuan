/**
 * `api/_lib/metering.js` 的假 DB 单测（不连云库、不联网）。
 *
 * 跑法：`node tests/metering.test.mjs`
 *
 * 假 DB 只实现 metering 用到的那一面（与 `@cloudbase/node-sdk` v3 实签名对齐）：
 *   db.collection(name).doc(id).create(row) -> {id} | throw/err-code（已存在）
 *   db.collection(name).doc(id).update(patch) -> {updated}
 *   db.collection(name).doc(id).get() -> {data:[row]}
 *   db.command.inc(n) -> 自增标记
 */
import assert from 'node:assert/strict'
import {
  DAILY_COLLECTION,
  METERING_TIMEOUT_MS,
  ORG_KID,
  ORG_USER_ID,
  RECORDS_COLLECTION,
  buildRecordRow,
  cstParts,
  dailyIdOf,
  isBillableStatus,
  recordApiCall,
  recordIdOf,
  seedUsage,
  startMetering,
  subjectOf,
  traceIdOf
} from '../api/_lib/metering.js'

/* ── 假 DB ─────────────────────────────────────────────────────── */

const INC = Symbol('inc')

function makeDb(options = {}) {
  const store = new Map() // `${collection}|${id}` -> row
  let writes = 0
  const command = { inc: (n) => ({ [INC]: n }) }
  const db = {
    command,
    store,
    get writes() {
      return writes
    },
    collection(name) {
      return {
        doc(id) {
          const key = `${name}|${id}`
          return {
            async create(row) {
              if (options.failOn === name) throw new Error('connect timeout')
              if (options.hangOn === name) await new Promise(() => {})
              if (store.has(key)) {
                const error = new Error('document already exists')
                error.code = 'DUPLICATE'
                throw error
              }
              writes += 1
              store.set(key, { _id: id, ...row })
              return { id }
            },
            async update(patch) {
              if (options.failOn === name) throw new Error('connect timeout')
              if (options.hangOnUpdate === name) await new Promise(() => {})
              const row = store.get(key)
              if (!row) return { updated: 0 }
              writes += 1
              for (const [field, value] of Object.entries(patch)) {
                if (value && typeof value === 'object' && INC in value) {
                  row[field] = (Number(row[field]) || 0) + value[INC]
                } else {
                  row[field] = value
                }
              }
              return { updated: 1 }
            },
            async get() {
              const row = store.get(key)
              return { data: row ? [row] : [] }
            }
          }
        }
      }
    }
  }
  return db
}

const rowsOf = (db, collection) =>
  [...db.store.entries()].filter(([key]) => key.startsWith(`${collection}|`)).map(([, row]) => row)

/* ── 断言脚手架 ─────────────────────────────────────────────────── */

let passed = 0
const failures = []
function test(name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      return out.then(
        () => {
          passed += 1
          console.log(`PASS ${name}`)
        },
        (error) => {
          failures.push({ name, error })
          console.log(`FAIL ${name} :: ${error.message}`)
        }
      )
    }
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name} :: ${error.message}`)
  }
  return Promise.resolve()
}

const quietError = async (fn) => {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const value = await fn()
    return { value, lines }
  } finally {
    console.error = original
  }
}

/* ── 用例 ─────────────────────────────────────────────────────── */

await test('CST 自然日跨 UTC 边界（16:30Z ⇒ 次日）', () => {
  const parts = cstParts('2026-10-18T16:30:00.000Z')
  assert.equal(parts.cstDate, '2026-10-19')
  assert.equal(parts.cstMonth, '2026-10')
  const before = cstParts('2026-10-18T15:59:59.000Z')
  assert.equal(before.cstDate, '2026-10-18')
})

await test('计费判据只认 2xx', () => {
  assert.equal(isBillableStatus(200), true)
  assert.equal(isBillableStatus(204), true)
  assert.equal(isBillableStatus(302), false)
  assert.equal(isBillableStatus(400), false)
  assert.equal(isBillableStatus(500), false)
  assert.equal(isBillableStatus(undefined), false)
})

await test('明细行字段名逐字命中 contract.js UsageRecord', () => {
  const row = buildRecordRow({
    userId: 'u-abc',
    kid: 'k-1',
    endpoint: '/api/v1/authors?probe=1',
    method: 'get',
    statusCode: 200,
    latencyMs: 42,
    traceId: 'trace-1'
  })
  const expected = [
    'recordId', 'userId', 'kid', 'endpoint', 'method', 'statusCode', 'isBillable', 'callCount',
    'requestedAt', 'cstDate', 'cstMonth', 'latencyMs', 'imageCount', 'imageBytes',
    'originalImageCount', 'traceId', 'planIdAtTime'
  ]
  for (const field of expected) assert.ok(field in row, `missing ${field}`)
  assert.equal(row.endpoint, '/api/v1/authors', '查询串必须被剥掉')
  assert.equal(row.method, 'GET')
  assert.equal(row.isBillable, true)
  assert.equal(row.callCount, 1)
  assert.equal(row.planIdAtTime, '', '未判定套餐 ⇒ 空串（不编造）')
  assert.equal(row.recordId, recordIdOf('trace-1'))
})

await test('幂等键确定性：同 trace 同 id、不同 trace 不同 id、不同端点不同日聚合 id', () => {
  assert.equal(recordIdOf('t1'), recordIdOf('t1'))
  assert.notEqual(recordIdOf('t1'), recordIdOf('t2'))
  const a = dailyIdOf({ userId: 'u', cstDate: '2026-10-19', endpoint: '/api/v1/authors' })
  const b = dailyIdOf({ userId: 'u', cstDate: '2026-10-19', endpoint: '/api/v1/inscriptions' })
  const c = dailyIdOf({ userId: 'u2', cstDate: '2026-10-19', endpoint: '/api/v1/authors' })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.ok(a.startsWith('ud-'))
})

await test('主体映射：env ⇒ u_org_env/env:default；key ⇒ 账号+kid；Session/未鉴权 ⇒ null', () => {
  assert.deepEqual(subjectOf({ ok: true, via: 'env' }), { userId: ORG_USER_ID, kid: ORG_KID })
  assert.deepEqual(subjectOf({ ok: true, via: 'key', userId: 'u-1', keyId: 'k-1' }), { userId: 'u-1', kid: 'k-1' })
  assert.equal(subjectOf({ ok: true, via: 'key', userId: 'u-1' }), null, '缺 kid ⇒ 不记账')
  assert.equal(subjectOf({ ok: true, via: 'session', userId: 'u-1', session: true }), null)
  assert.equal(subjectOf({ ok: false, status: 401 }), null)
  assert.equal(subjectOf(null), null)
})

await test('trace 头优先、缺失则回退（不含凭据）', () => {
  assert.equal(traceIdOf({ headers: { 'x-vercel-id': 'abc:123' } }), 'abc:123')
  assert.equal(traceIdOf({ headers: { 'x-request-id': 'rq-1' } }), 'rq-1')
  assert.equal(traceIdOf({ headers: {} }, 'fallback-1'), 'fallback-1')
  const generated = traceIdOf({ headers: {} })
  assert.ok(typeof generated === 'string' && generated.length >= 16)
})

await test('一条调用 ⇒ 1 行明细 + 日聚合 +1（2xx 计费）', async () => {
  const db = makeDb()
  const result = await recordApiCall(
    {
      userId: 'u-1',
      kid: 'k-1',
      endpoint: '/api/v1/authors',
      method: 'GET',
      statusCode: 200,
      latencyMs: 33,
      traceId: 'trace-a'
    },
    { db }
  )
  assert.equal(result.ok, true)
  const records = rowsOf(db, RECORDS_COLLECTION)
  assert.equal(records.length, 1)
  assert.equal(records[0].isBillable, true)
  assert.equal(records[0].cstDate, cstParts(Date.now()).cstDate)
  const daily = rowsOf(db, DAILY_COLLECTION)
  assert.equal(daily.length, 1)
  assert.equal(daily[0].callCount, 1)
  assert.equal(daily[0].billableCallCount, 1)
  assert.equal(daily[0].failureCallCount, 0)
  assert.equal(daily[0].latencyMsSum, 33)
  assert.equal(daily[0].seeded, false)
})

await test('同 trace 重试 ⇒ 明细不重复、日聚合不重复累加', async () => {
  const db = makeDb()
  const input = {
    userId: 'u-1',
    kid: 'k-1',
    endpoint: '/api/v1/authors',
    statusCode: 200,
    latencyMs: 10,
    traceId: 'trace-retry'
  }
  const first = await recordApiCall(input, { db })
  const second = await recordApiCall(input, { db })
  assert.equal(first.ok, true)
  assert.equal(first.deduped, false)
  assert.equal(second.ok, true)
  assert.equal(second.deduped, true)
  assert.equal(rowsOf(db, RECORDS_COLLECTION).length, 1)
  assert.equal(rowsOf(db, DAILY_COLLECTION)[0].callCount, 1)
})

await test('5xx ⇒ 仍留明细但 isBillable=false，只进 failureCallCount', async () => {
  const db = makeDb()
  await recordApiCall(
    { userId: 'u-1', kid: 'k-1', endpoint: '/api/v1/inscriptions', statusCode: 500, latencyMs: 900, traceId: 'trace-500' },
    { db }
  )
  const record = rowsOf(db, RECORDS_COLLECTION)[0]
  assert.equal(record.isBillable, false)
  assert.equal(record.statusCode, 500)
  const daily = rowsOf(db, DAILY_COLLECTION)[0]
  assert.equal(daily.callCount, 1)
  assert.equal(daily.billableCallCount, 0)
  assert.equal(daily.failureCallCount, 1)
})

await test('不同端点各自一行日聚合；同日同端点累加', async () => {
  const db = makeDb()
  for (const [endpoint, trace] of [
    ['/api/v1/authors', 't-1'],
    ['/api/v1/authors', 't-2'],
    ['/api/v1/dynasties', 't-3']
  ]) {
    await recordApiCall({ userId: 'u-1', kid: 'k-1', endpoint, statusCode: 200, latencyMs: 5, traceId: trace }, { db })
  }
  const daily = rowsOf(db, DAILY_COLLECTION)
  assert.equal(daily.length, 2)
  const authors = daily.find((row) => row.endpoint === '/api/v1/authors')
  assert.equal(authors.callCount, 2)
  assert.equal(authors.latencyMsSum, 10)
})

await test('写失败（云库抛错）⇒ 不抛出、返回 ok:false、只留一行 METERING_FAILED', async () => {
  const db = makeDb({ failOn: RECORDS_COLLECTION })
  const { value, lines } = await quietError(() =>
    recordApiCall({ userId: 'u-1', kid: 'k-1', endpoint: '/api/v1/authors', statusCode: 200, traceId: 't-fail' }, { db })
  )
  assert.equal(value.ok, false)
  assert.equal(lines.filter((line) => line.includes('METERING_FAILED')).length, 1)
  assert.ok(lines[0].includes('step=record'))
  assert.equal(rowsOf(db, DAILY_COLLECTION).length, 0, '明细失败 ⇒ 不动聚合（绝不虚构）')
})

await test('日聚合写失败 ⇒ 明细已在（少计而非错计）、不抛出', async () => {
  const db = makeDb({ failOn: DAILY_COLLECTION })
  const { value, lines } = await quietError(() =>
    recordApiCall({ userId: 'u-1', kid: 'k-1', endpoint: '/api/v1/authors', statusCode: 200, traceId: 't-fail-daily' }, { db })
  )
  assert.equal(value.ok, false)
  assert.equal(rowsOf(db, RECORDS_COLLECTION).length, 1)
  assert.ok(lines[0].includes('step=daily'))
})

await test('写超时 ⇒ 预算内返回 TIMEOUT，不悬挂', async () => {
  const db = makeDb({ hangOn: RECORDS_COLLECTION })
  const startedAt = Date.now()
  const { value, lines } = await quietError(() =>
    recordApiCall(
      { userId: 'u-1', kid: 'k-1', endpoint: '/api/v1/authors', statusCode: 200, traceId: 't-hang' },
      { db, budgetMs: 120 }
    )
  )
  const elapsed = Date.now() - startedAt
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'TIMEOUT')
  assert.ok(elapsed < 1000, `elapsed=${elapsed}ms`)
  assert.ok(lines[0].includes('METERING_FAILED'))
  assert.ok(METERING_TIMEOUT_MS >= 500)
})

await test('startMetering：env 通道 ⇒ 机构主体入账；重复 finish 只写一次', async () => {
  const db = makeDb()
  const metering = startMetering({
    req: { method: 'GET', url: '/api/v1/dynasties?probe=x', headers: { 'x-vercel-id': 'vid-1' } },
    authResult: { ok: true, via: 'env' },
    startedAt: Date.now() - 12,
    db
  })
  const first = await metering.finish({ statusCode: 200, cacheHit: true })
  const second = await metering.finish({ statusCode: 200 })
  assert.equal(first.ok, true)
  assert.equal(second.skipped, 'ALREADY_RECORDED')
  const record = rowsOf(db, RECORDS_COLLECTION)[0]
  assert.equal(record.userId, ORG_USER_ID)
  assert.equal(record.kid, ORG_KID)
  assert.equal(record.endpoint, '/api/v1/dynasties')
  assert.equal(record.cacheHit, true, '缓存命中照计且可辨识')
  assert.equal(rowsOf(db, RECORDS_COLLECTION).length, 1)
})

await test('startMetering：Session 通道不计数', async () => {
  const db = makeDb()
  const metering = startMetering({
    req: { method: 'GET', url: '/api/v1/authors', headers: {} },
    authResult: { ok: true, via: 'session', session: true, userId: 'u-1' },
    db
  })
  const result = await metering.finish({ statusCode: 200 })
  assert.equal(result.skipped, 'NOT_API_KEY_CHANNEL')
  assert.equal(db.store.size, 0)
})

await test('seedUsage：seeded:true、重跑不重复、日聚合只在新建时累加', async () => {
  const db = makeDb()
  const now = Date.parse('2026-10-19T02:00:00.000Z')
  const spec = {
    userId: 'u-demo',
    kid: 'demo:seed',
    now,
    endpoints: [
      { endpoint: '/api/v1/authors', count: 6, billableCount: 5 },
      { endpoint: '/api/v1/dynasties', count: 3 }
    ]
  }
  const first = await seedUsage(db, spec)
  assert.equal(first.ok, true)
  assert.equal(first.created, 9)
  assert.equal(first.skipped, 0)
  const records = rowsOf(db, RECORDS_COLLECTION)
  assert.equal(records.length, 9)
  assert.ok(records.every((row) => row.seeded === true))
  const daily = rowsOf(db, DAILY_COLLECTION)
  assert.equal(daily.length, 2)
  const authors = daily.find((row) => row.endpoint === '/api/v1/authors')
  assert.equal(authors.callCount, 6)
  assert.equal(authors.billableCallCount, 5)
  assert.equal(authors.failureCallCount, 1)
  assert.equal(authors.seededCallCount, 6)
  assert.equal(authors.seeded, true)

  const second = await seedUsage(db, spec)
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 9)
  assert.equal(rowsOf(db, RECORDS_COLLECTION).length, 9)
  assert.equal(rowsOf(db, DAILY_COLLECTION).find((row) => row.endpoint === '/api/v1/authors').callCount, 6)
})

/* ── 汇总 ─────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.log(`\n[${name}]\n${error.stack}`)
  process.exitCode = 1
}
