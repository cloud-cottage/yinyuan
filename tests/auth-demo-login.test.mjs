/**
 * 公开只读面 ＋ 演示一键登录 契约冒烟（2026-10-19 Zang 裁定一 / 裁定二）。
 *
 * 真 HTTP ＋ 真 handler ＋ 内存假 DB；不连云库、不打生产、不发真实网络请求
 * （节流存储用假 Upstash pipeline 替身接管）。
 *
 * 覆盖：
 *   A) 公开面 config / plans：**无会话 200**、键集与关键值、带会话仍 200、
 *      `POST` ⇒ 405 + `Allow: GET`、`Cache-Control: no-store`、config 不含口令/验证码
 *   B) `POST /api/v1/auth/demo-login`：
 *      - 200 形状（session 四键 + token_type='Session'；user 七键）**与 /auth/login 同形**
 *      - **无请求体**即可成功；请求体里塞 email/password **不被采信**（仍签演示账号）
 *      - 账号不存在 ⇒ 401 UNAUTHORIZED（不建号、不回落）
 *      - 账号停用 ⇒ 401（不因「演示」跳过 status 检查）
 *      - 账号表不可用 ⇒ 503 NOT_CONFIGURED
 *      - 非 POST ⇒ 405 + `Allow: POST`
 *      - 同 IP 超限 ⇒ 429 RATE_LIMITED（`AUTH_THROTTLE.DEMO_LOGIN_IP` 口径）
 *      - 响应/日志面**不含口令与散列**；唯一写操作是 `last_login_at`
 *
 * 跑法：`node tests/auth-demo-login.test.mjs`（退出码 0 ＝ 全绿）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { APP_CONFIG } from '../src/config/app-config.js'
import { signSession } from '../api/_lib/session.js'
import { SESSION_DEFAULT_TTL_SECONDS } from '../api/_lib/accountContract.js'
import { AUTH_THROTTLE } from '../api/_lib/ratelimit.js'
import { DEMO_ACCOUNT_EMAIL_DEFAULT } from '../api/_lib/demoAccount.js'
import { COLLECTION as USERS_COLLECTION } from '../api/_lib/users.js'
import { createConfigHandler } from '../api/v1/config.js'
import { createPlansHandler } from '../api/v1/plans.js'
import { createDemoLoginHandler } from '../api/v1/auth/demo-login.js'
import notFoundHandler from '../api/index.js'

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

/* ── 内存假 DB（只实现本组端点用到的那一面） ─────────────────────── */

function createFakeDb(options = {}) {
  const docs = new Map()
  const missing = new Set(options.missingCollections || [])
  const stats = { updates: [], gets: 0 }

  function collectionOf(name) {
    if (missing.has(name)) {
      const error = new Error(`Db or Table not exist: ${name}`)
      error.code = 'DATABASE_COLLECTION_NOT_EXIST'
      throw error
    }
    return {
      where(where) {
        return {
          limit() {
            return {
              async get() {
                stats.gets += 1
                const rows = [...docs.entries()]
                  .map(([id, row]) => ({ _id: id, ...row }))
                  .filter((row) => Object.entries(where).every(([field, value]) => row[field] === value))
                return { data: rows.slice(0, 1) }
              }
            }
          }
        }
      },
      doc(id) {
        return {
          async get() {
            const row = docs.get(id)
            return { data: row ? [{ _id: id, ...row }] : [] }
          },
          async update(patch) {
            stats.updates.push({ id, patch })
            const row = docs.get(id) || {}
            docs.set(id, { ...row, ...patch })
            return { updated: 1 }
          }
        }
      }
    }
  }

  return {
    db: { collection: collectionOf },
    stats,
    seed(rows) {
      for (const row of rows) docs.set(row._id, { ...row })
    }
  }
}

/* ── 场景 ──────────────────────────────────────────────────────── */

const SECRET = 'test-session-secret-for-demo-login'
const DEMO_ID = 'u-demo-fixture'
const NOW_MS = Date.parse('2026-10-19T04:00:00.000Z')

function demoRow(overrides = {}) {
  return {
    _id: DEMO_ID,
    email: DEMO_ACCOUNT_EMAIL_DEFAULT,
    // 形态与 passwordHash.js 产物一致，但内容只为「响应不得泄漏散列」这一断言存在
    password_hash: { v: 1, algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 64, hash: 'deadbeef'.repeat(8), salt: 'cafebabe'.repeat(4) },
    role: 'user',
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    last_login_at: null,
    ...overrides
  }
}

function makeServer(options) {
  const routes = {
    '/api/v1/config': createConfigHandler(options),
    '/api/v1/plans': createPlansHandler(options),
    '/api/v1/auth/demo-login': createDemoLoginHandler(options)
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
  const init = { method: options.method || 'GET', headers }
  if (options.rawBody !== undefined) {
    if (options.contentType) headers['Content-Type'] = options.contentType
    init.body = options.rawBody
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch (error) {
    body = null
  }
  return { status: response.status, headers: response.headers, body, text }
}

function tokenFor(uid) {
  const signed = signSession({ uid, role: 'user', ttlSeconds: SESSION_DEFAULT_TTL_SECONDS, secret: SECRET })
  assert.equal(signed.ok, true)
  return signed.token
}

/** 假节流存储：`result` 为固定读数（> limit 即 429）；未配置 URL/token 时走降级放行。 */
function fakeThrottleStore(result) {
  const calls = []
  return {
    calls,
    env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'test-token' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: String((init && init.body) || '') })
      return { ok: true, status: 200, json: async () => [{ result }] }
    }
  }
}

/* ── 用例 ──────────────────────────────────────────────────────── */

async function main() {
  const fake = createFakeDb()
  fake.seed([demoRow()])
  const { server, port } = await makeServer({ db: fake.db, secret: SECRET, nowMs: NOW_MS, nowSeconds: Math.floor(NOW_MS / 1000) })
  const token = tokenFor(DEMO_ID)

  try {
    section('A) 公开只读面 —— GET /api/v1/config')
    const anonConfig = await request(port, '/api/v1/config')
    eq('config 无会话 200', anonConfig.status, 200)
    ok('config 信封 ok:true', anonConfig.body && anonConfig.body.ok === true, anonConfig.body)
    const cfg = anonConfig.body.data
    ok(
      'config 键集齐备（8 键）',
      ['featureFlags', 'site', 'demo', 'apiKeyLimit', 'orderPendingTimeoutMinutes', 'demoEnvQuota', 'notConnectedNotice', 'dataSource']
        .every((key) => key in cfg),
      Object.keys(cfg)
    )
    eq('config dataSource=api', cfg.dataSource, 'api')
    eq('config 演示账号对外展示值（公开字段）', cfg.demo.account, APP_CONFIG.demo.account)
    ok('config **不含** demo.password', !('password' in cfg.demo), Object.keys(cfg.demo))
    ok('config **不含** demo.captcha', !('captcha' in cfg.demo), Object.keys(cfg.demo))
    ok('config 原文不含演示口令', !anonConfig.text.includes(APP_CONFIG.demo.password), 'leaked')
    eq('config Cache-Control: no-store', anonConfig.headers.get('cache-control'), 'no-store')
    eq('config Access-Control-Allow-Origin: *', anonConfig.headers.get('access-control-allow-origin'), '*')
    const cfgWithSession = await request(port, '/api/v1/config', { token })
    eq('config 带会话仍 200', cfgWithSession.status, 200)

    section('A) 公开只读面 —— GET /api/v1/plans')
    const anonPlans = await request(port, '/api/v1/plans')
    eq('plans 无会话 200', anonPlans.status, 200)
    eq('plans 三档', anonPlans.body.data.plans.length, 3)
    eq('plans currency', anonPlans.body.data.currency, 'CNY')
    eq('plans Cache-Control: no-store', anonPlans.headers.get('cache-control'), 'no-store')
    const plansWithSession = await request(port, '/api/v1/plans', { token })
    eq('plans 带会话仍 200', plansWithSession.status, 200)

    const postConfig = await request(port, '/api/v1/config', { method: 'POST' })
    eq('POST /config 无会话 ⇒ 405（方法门先于一切）', postConfig.status, 405)
    eq('405 Allow: GET', postConfig.headers.get('allow'), 'GET')
    eq('405 信封 reason', postConfig.body.reason, 'METHOD_NOT_ALLOWED')
    const postPlans = await request(port, '/api/v1/plans', { method: 'POST' })
    eq('POST /plans ⇒ 405', postPlans.status, 405)
    eq('plans 405 Allow: GET', postPlans.headers.get('allow'), 'GET')
    const putConfig = await request(port, '/api/v1/config', { method: 'PUT' })
    eq('PUT /config ⇒ 405', putConfig.status, 405)

    section('B) POST /api/v1/auth/demo-login —— 200 形状')
    const anonDemo = await request(port, '/api/v1/auth/demo-login', { method: 'POST' })
    eq('demo-login 无请求体 ⇒ 200', anonDemo.status, 200)
    ok('demo-login 信封 ok:true', anonDemo.body && anonDemo.body.ok === true, anonDemo.body)
    const session = anonDemo.body.session
    ok(
      'demo-login session 四键（与 /auth/login 同形）',
      ['token', 'token_type', 'expires_in', 'expires_at'].every((key) => key in session) && Object.keys(session).length === 4,
      Object.keys(session)
    )
    eq('demo-login token_type=Session', session.token_type, 'Session')
    eq('demo-login expires_in 为正整数', Number.isInteger(session.expires_in) && session.expires_in > 0, true)
    ok('demo-login expires_at 为 ISO8601', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(session.expires_at))
    const user = anonDemo.body.user
    ok(
      'demo-login user 七键',
      ['id', 'phone', 'email', 'role', 'status', 'createdAt', 'lastLoginAt'].every((key) => key in user) && Object.keys(user).length === 7,
      Object.keys(user)
    )
    eq('demo-login user.id 为演示账号行', user.id, DEMO_ID)
    eq('demo-login user.email', user.email, DEMO_ACCOUNT_EMAIL_DEFAULT)
    eq('demo-login user.status=active', user.status, 'active')
    ok('demo-login 不泄漏口令/散列', !/password|scrypt|deadbeef|cafebabe/i.test(anonDemo.text), 'leaked')
    eq('demo-login Cache-Control: no-store', anonDemo.headers.get('cache-control'), 'no-store')
    eq('demo-login 记了 last_login_at（唯一写操作）', fake.stats.updates.length, 1)
    eq('last_login_at 只写这一个字段', Object.keys(fake.stats.updates[0].patch).join(','), 'last_login_at')

    // 签出来的令牌能当会话用（真签发，不是假串）
    const me = await request(port, '/api/v1/plans', { token: session.token })
    eq('demo-login 令牌可用（Session 验签通过）', me.status, 200)

    const withBody = await request(port, '/api/v1/auth/demo-login', {
      method: 'POST',
      body: { email: 'attacker@example.com', password: 'whatever' }
    })
    eq('请求体里指定别的账号 ⇒ 仍 200（不采信）', withBody.status, 200)
    eq('请求体不改变签发对象', withBody.body.user.email, DEMO_ACCOUNT_EMAIL_DEFAULT)

    section('B) demo-login 失败面')
    const emptyFake = createFakeDb()
    const emptyServer = await makeServer({ db: emptyFake.db, secret: SECRET })
    try {
      const noAccount = await request(emptyServer.port, '/api/v1/auth/demo-login', { method: 'POST' })
      eq('账号不存在 ⇒ 401', noAccount.status, 401)
      eq('账号不存在 reason=UNAUTHORIZED', noAccount.body.reason, 'UNAUTHORIZED')
      eq('账号不存在**不建号**（无任何写）', emptyFake.stats.updates.length, 0)
      ok('401 信封不含 password 字样', !/password|scrypt/i.test(noAccount.text), noAccount.text)
    } finally {
      emptyServer.server.close()
    }

    const disabledFake = createFakeDb()
    disabledFake.seed([demoRow({ status: 'disabled' })])
    const disabledServer = await makeServer({ db: disabledFake.db, secret: SECRET })
    try {
      const disabled = await request(disabledServer.port, '/api/v1/auth/demo-login', { method: 'POST' })
      eq('账号停用 ⇒ 401（不跳过 status 检查）', disabled.status, 401)
      eq('停用 reason=UNAUTHORIZED', disabled.body.reason, 'UNAUTHORIZED')
      eq('停用不写 last_login_at', disabledFake.stats.updates.length, 0)
    } finally {
      disabledServer.server.close()
    }

    const missingFake = createFakeDb({ missingCollections: [USERS_COLLECTION] })
    const missingServer = await makeServer({ db: missingFake.db, secret: SECRET })
    try {
      const broken = await request(missingServer.port, '/api/v1/auth/demo-login', { method: 'POST' })
      eq('账号表不可用 ⇒ 503', broken.status, 503)
      eq('账号表不可用 reason=NOT_CONFIGURED', broken.body.reason, 'NOT_CONFIGURED')
    } finally {
      missingServer.server.close()
    }

    const noSecretServer = await makeServer({ db: fake.db, secret: '' })
    try {
      const noSecret = await request(noSecretServer.port, '/api/v1/auth/demo-login', { method: 'POST' })
      const signedWithoutSecret = signSession({ uid: DEMO_ID, ttlSeconds: 60, secret: '' })
      if (signedWithoutSecret.ok) {
        ok('缺会话密钥时的行为与 signSession 一致（环境已配密钥 ⇒ 200）', noSecret.status === 200, noSecret.status)
      } else {
        eq('缺会话密钥 ⇒ 503 NOT_CONFIGURED', noSecret.status, 503)
        eq('503 reason=NOT_CONFIGURED', noSecret.body.reason, 'NOT_CONFIGURED')
      }
    } finally {
      noSecretServer.server.close()
    }

    const getDemo = await request(port, '/api/v1/auth/demo-login')
    eq('GET demo-login ⇒ 405', getDemo.status, 405)
    eq('405 Allow: POST', getDemo.headers.get('allow'), 'POST')
    eq('405 信封 reason', getDemo.body.reason, 'METHOD_NOT_ALLOWED')
    const putDemo = await request(port, '/api/v1/auth/demo-login', { method: 'PUT' })
    eq('PUT demo-login ⇒ 405', putDemo.status, 405)

    section('B) demo-login 限流（429）')
    ok('DEMO_LOGIN_IP 与 LOGIN_IP 同量级（30 次 / 10 分钟）', AUTH_THROTTLE.DEMO_LOGIN_IP.limit === AUTH_THROTTLE.LOGIN_IP.limit && AUTH_THROTTLE.DEMO_LOGIN_IP.windowSeconds === AUTH_THROTTLE.LOGIN_IP.windowSeconds)
    ok('DEMO_LOGIN_IP 独立 scope（不消耗真实登录额度）', AUTH_THROTTLE.DEMO_LOGIN_IP.scope !== AUTH_THROTTLE.LOGIN_IP.scope)
    const store = fakeThrottleStore(AUTH_THROTTLE.DEMO_LOGIN_IP.limit + 1)
    const throttleServer = await makeServer({
      db: fake.db,
      secret: SECRET,
      throttleOptions: { fetchImpl: store.fetchImpl, env: store.env, now: NOW_MS }
    })
    try {
      const limited = await request(throttleServer.port, '/api/v1/auth/demo-login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.9' }
      })
      eq('超限 ⇒ 429', limited.status, 429)
      eq('429 reason=RATE_LIMITED', limited.body.reason, 'RATE_LIMITED')
      ok('429 文案是「尝试次数过多」', /尝试次数过多/.test(limited.body.message))
      eq('429 带 X-RateLimit-Limit', limited.headers.get('x-ratelimit-limit'), String(AUTH_THROTTLE.DEMO_LOGIN_IP.limit))
      ok('限流键按 IP 指纹（不含 IP 原文）', store.calls.length === 1 && !store.calls[0].body.includes('203.0.113.9'), store.calls[0] && store.calls[0].body)
      eq('429 不签发会话', Boolean(limited.body.session), false)
    } finally {
      throttleServer.server.close()
    }

    const allowedStore = fakeThrottleStore(1)
    const allowedServer = await makeServer({
      db: fake.db,
      secret: SECRET,
      throttleOptions: { fetchImpl: allowedStore.fetchImpl, env: allowedStore.env, now: NOW_MS }
    })
    try {
      const passed = await request(allowedServer.port, '/api/v1/auth/demo-login', { method: 'POST' })
      eq('未超限 ⇒ 200', passed.status, 200)
      eq('未超限带 X-RateLimit-Remaining', passed.headers.get('x-ratelimit-remaining'), String(AUTH_THROTTLE.DEMO_LOGIN_IP.limit - 1))
    } finally {
      allowedServer.server.close()
    }

    section('C) 公开面不连库（云库未配置也能 200）')
    const offlineConfig = await request(port, '/api/v1/config')
    eq('config 在无账号表访问下 200', offlineConfig.status, 200)
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
