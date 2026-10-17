/**
 * 印源账号 / 密钥端点自检（B2）—— **真 HTTP ＋ 真 handler ＋ 内存假 DB ＋ 假计数存储**。
 *
 * 不连云库、不读生产数据、不发真实网络请求（`fetchImpl` 被假 Upstash pipeline 替身接管）。
 *
 * 覆盖：
 *   1) 闭环：register → login → 建 key → **用该 key 调数据端点 `dynasties`（假上游/假 DB）⇒ 200**
 *   2) 契约：9 个端点的状态码 / 字段面（201/200/400/401/404/405/409/413/429）
 *   3) 安全：会话回表复核（停用即 401）／停用账号其 key 失效／越权只能操作自己（别人 kid ⇒ 404）／
 *      登录注册限流／口令不 trim／失败面不泄露内部状态
 *   4) 回归：`createGetHandler` 与改前（`git show HEAD:api/_lib/handler.js`）**逐场景 A/B 同形**，
 *      且四个真实数据端点在 env 机构钥匙下的失败面（405/401/503）形状不变
 *
 * 跑法：node scripts/verify-yinyuan-auth-endpoints.mjs   （退出码 0 ＝ 全绿）
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { signSession } from '../api/_lib/session.js'
import * as users from '../api/_lib/users.js'
import { countByField } from '../api/_lib/dataset.js'
import { DYNASTY_CONTRACT } from '../api/_lib/dynasty-contract.js'
import { createGetHandler } from '../api/_lib/handler.js'
import { resetCache } from '../api/_lib/instance-cache.js'
import { createLoginHandler } from '../api/v1/auth/login.js'
import { createLogoutHandler } from '../api/v1/auth/logout.js'
import { createRegisterHandler } from '../api/v1/auth/register.js'
// ★ 路由形态修复（2026-10-18）：三个密钥端点收进 `api/v1/keys/index.js` 单入口分派。
//   旧路径 `api/v1/keys/[kid].js`、`api/v1/keys/[kid]/rotate.js`（动态段）与
//   `api/v1/keys/[...path].js`（方括号组）在线上**都没被注册成路由**（实测均落 /api/v1/bogus 同形 404）
//   ⇒ 动态路径改由 `vercel.json` rewrite 折成 `?kid=` / `?kid=&action=rotate`（对外 URL 不变）。
import { createKeysCatchAllHandler } from '../api/v1/keys/index.js'
import { createMeHandler } from '../api/v1/me.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

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
  const extra = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`
  console.log(`✗ ${name}${extra}`)
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), { actual, expected })
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

/* ── 内存假 DB（实现本单用到的 CloudBase v3 面：where/doc/aggregate/command） ── */

function createFakeDb() {
  const collections = new Map()
  const state = { failing: false, touched: new Set() }

  function guard() {
    if (state.failing) {
      const error = new Error('simulated cloudbase failure')
      error.code = 'ETIMEDOUT'
      throw error
    }
  }

  function docsOf(name) {
    state.touched.add(name)
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }

  function matches(row, where) {
    return Object.entries(where).every(([key, value]) => row[key] === value)
  }

  const db = {
    command: {
      inc: (value) => ({ __op: 'inc', value }),
      aggregate: { sum: (value) => ({ __op: 'sum', value }) }
    },
    collection(name) {
      const docs = docsOf(name)
      return {
        where(condition) {
          let max = Number.POSITIVE_INFINITY
          const query = {
            limit(n) {
              max = n
              return query
            },
            orderBy() {
              return query
            },
            async get() {
              guard()
              const rows = []
              for (const row of docs.values()) {
                if (!matches(row, condition)) continue
                rows.push(structuredClone(row))
                if (rows.length >= max) break
              }
              return { data: rows }
            }
          }
          return query
        },
        async count() {
          guard()
          return { total: docs.size }
        },
        aggregate() {
          let groupSpec = null
          const pipeline = {
            group(spec) {
              groupSpec = spec
              return pipeline
            },
            limit() {
              return pipeline
            },
            async match() {
              return pipeline
            },
            async end() {
              guard()
              const field = String(groupSpec && groupSpec._id).replace(/^\$/, '')
              const buckets = new Map()
              for (const row of docs.values()) {
                const raw = row[field]
                const key = raw === undefined || raw === null || String(raw).trim() === '' ? null : String(raw)
                buckets.set(key, (buckets.get(key) || 0) + 1)
              }
              return { data: [...buckets.entries()].map(([id, n]) => ({ _id: id, n })) }
            }
          }
          return pipeline
        },
        doc(id) {
          return {
            async get() {
              guard()
              const row = docs.get(id)
              return { data: row ? [structuredClone(row)] : [] }
            },
            async create(row) {
              guard()
              if (docs.has(id)) throw new Error('document already exists')
              docs.set(id, { _id: id, ...structuredClone(row) })
              return { id }
            },
            async update(patch) {
              guard()
              const row = docs.get(id)
              if (!row) return { updated: 0 }
              for (const [key, value] of Object.entries(patch)) {
                if (value && typeof value === 'object' && value.__op === 'inc') {
                  row[key] = Number(row[key] || 0) + value.value
                } else {
                  row[key] = structuredClone(value)
                }
              }
              return { updated: 1 }
            }
          }
        }
      }
    }
  }

  return {
    db,
    state,
    seed(collection, rows) {
      const docs = docsOf(collection)
      for (const row of rows) docs.set(row._id, structuredClone(row))
    },
    patch(collection, id, patch) {
      const docs = docsOf(collection)
      const row = docs.get(id)
      if (!row) throw new Error(`no row ${collection}/${id}`)
      Object.assign(row, structuredClone(patch))
    },
    has(collection, id) {
      return collections.has(collection) && collections.get(collection).has(id)
    },
    row(collection, id) {
      const docs = collections.get(collection)
      return docs && docs.get(id) ? structuredClone(docs.get(id)) : null
    }
  }
}

/* ── 假 Upstash 计数存储（只实现 /pipeline 的 INCR + EXPIRE NX） ── */

function createFakeStore() {
  const counters = new Map()
  const state = { hits: 0 }
  const env = { KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'test-token' }
  async function fetchImpl(url, init) {
    state.hits += 1
    if (!String(url).endsWith('/pipeline')) throw new Error('unexpected store url')
    let commands = []
    try {
      commands = JSON.parse(init && init.body ? init.body : '[]')
    } catch (error) {
      throw new Error('bad pipeline body')
    }
    const results = []
    for (const command of commands) {
      const [verb, key] = command
      if (verb === 'INCR') {
        const next = (counters.get(key) || 0) + 1
        counters.set(key, next)
        results.push({ result: next })
      } else if (verb === 'EXPIRE') {
        results.push({ result: 1 })
      } else {
        results.push({ error: 'unknown command' })
      }
    }
    return { ok: true, status: 200, async json() { return results } }
  }
  return { fetchImpl, counters, state, env, reset: () => counters.clear() }
}

/* ── 环境变量存档（跑完必须原样还原） ─────────────────────────────── */

const ENV_KEYS = [
  'YINYUAN_API_KEY',
  'YINYUAN_SESSION_SECRET',
  'CB_ENV',
  'CB_SECRET_ID',
  'CB_SECRET_KEY',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN'
]
const ENV_BACKUP = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ENV_BACKUP[key] === undefined) delete process.env[key]
    else process.env[key] = ENV_BACKUP[key]
  }
}

/* ── 真 HTTP 客户端 ─────────────────────────────────────────────── */

function request(origin, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  const url = new URL(target, origin)
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  const finalHeaders = { ...headers }
  if (payload) {
    finalHeaders['content-length'] = String(payload.length)
    if (!finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json'
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: finalHeaders,
        agent: false
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text === '' ? null : JSON.parse(text)
          } catch (error) {
            json = null
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/* ── 起服务（真 http.createServer + 真 handler 工厂 + 注入假 DB / 假计数存储） ── */

function buildServer({ fakeDb, store, now }) {
  const common = {
    db: fakeDb.db,
    throttleOptions: { fetchImpl: store.fetchImpl, env: store.env, now }
  }
  const routes = new Map()
  routes.set('/api/v1/auth/register', createRegisterHandler(common))
  routes.set('/api/v1/auth/login', createLoginHandler(common))
  routes.set('/api/v1/auth/logout', createLogoutHandler(common))
  routes.set('/api/v1/me', createMeHandler(common))
  // ★ 三个密钥端点由**同一个 catch-all 分派器**接（与线上入口同形：路径段在 handler 内自判，
  //   不再依赖路由表的正则替身）⇒ 自检打的是真分派逻辑。
  const keysAll = createKeysCatchAllHandler(common)

  // 数据端点（假上游：真 countByField + 假 DB；鉴权走真实 handler 工厂 + 注入 db）
  const dynasties = createGetHandler(
    'v1/dynasties',
    async () => {
      const [faces, seals] = await Promise.all([
        countByField(fakeDb.db, 'xiai_faces', 'dynasty'),
        countByField(fakeDb.db, 'xiai_seals', 'dynasty')
      ])
      return {
        total: DYNASTY_CONTRACT.length,
        items: DYNASTY_CONTRACT.map((value, index) => ({ seq: index + 1, value })),
        counts: { faces: faces.counts, seals: seals.counts },
        unrecorded: { faces: faces.unrecorded, seals: seals.unrecorded }
      }
    },
    { db: fakeDb.db }
  )
  routes.set('/api/v1/dynasties', dynasties)

  const server = http.createServer((req, res) => {
    // ★ 复刻 Vercel 的 `req.query`：生产上 `vercel.json` rewrite 折出的 `?kid=` / `?action=rotate`
    //   正是落到这里（裸 node 的 IncomingMessage 没有 `.query`，不补就测不到 rewrite 通道）。
    req.query = Object.fromEntries(new URL(String(req.url || '/'), 'http://harness.local').searchParams)
    const pathname = String(req.url || '/').split('?')[0]
    let handler = routes.get(pathname)
    // 密钥前缀下的全部形态交给 catch-all 分派器（0 段／1 段／{kid}/rotate／其它 ⇒ 分派器自判）
    if (!handler && (pathname === '/api/v1/keys' || pathname.startsWith('/api/v1/keys/'))) handler = keysAll
    if (!handler) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, reason: 'NOT_FOUND' }))
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      try {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, reason: 'HARNESS_ERROR', message: String(error && error.message) }))
      } catch (ignored) {}
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
  })
}

/* ── 改前 handler 的 A/B 基线（从 git HEAD 取源码，改写相对导入为绝对路径） ── */

function loadBaselineHandler() {
  const source = execFileSync('git', ['show', 'HEAD:api/_lib/handler.js'], { cwd: REPO, encoding: 'utf8' })
  if (!source.includes('checkApiKey(req)')) throw new Error('baseline 不含同步 checkApiKey —— 基线取错')
  const rewritten = source.replace(/from '\.\/([^']+)'/g, (match, file) =>
    `from '${pathToFileURL(path.join(REPO, 'api/_lib', file)).href}'`
  )
  const scratchRoot = process.env.TMPDIR && process.env.TMPDIR.trim() !== '' ? process.env.TMPDIR : tmpdir()
  const dir = mkdtempSync(path.join(scratchRoot, 'yinyuan-baseline-'))
  const file = path.join(dir, 'handler-baseline.mjs')
  writeFileSync(file, rewritten, 'utf8')
  return { dir, file }
}

/* ── 假 req / res（探针用） ───────────────────────────────────────── */

function fakeRes() {
  const headers = {}
  const res = {
    statusCode: 0,
    body: '',
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value)
    },
    end(chunk) {
      res.body = chunk === undefined ? '' : String(chunk)
    }
  }
  return res
}

async function callHandler(handler, { method = 'GET', headerKey, url = '/api/v1/dynasties' }) {
  const headers = {}
  if (headerKey) headers.authorization = `ApiKey ${headerKey}`
  const req = { method, url, headers, query: {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await handler(req, res)
  let json = null
  try {
    json = res.body === '' ? null : JSON.parse(res.body)
  } catch (error) {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, body: res.body, json }
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

const PASSWORD = 'correct horse battery staple'
const SESSION_SECRET = randomBytes(32).toString('base64url')
const FIXED_NOW = Date.parse('2026-10-18T02:00:00.000Z')
const ONE_HOUR_SECONDS = 60 * 60
const bodiesSeen = []

async function main() {
  process.env.YINYUAN_SESSION_SECRET = SESSION_SECRET
  delete process.env.YINYUAN_API_KEY
  // 数据端点：只要「配置了云库凭据」这一判据；run() 用的是注入的假 DB，不会真的连库
  process.env.CB_ENV = 'fake-env'
  process.env.CB_SECRET_ID = 'fake-id'
  process.env.CB_SECRET_KEY = 'fake-key'

  const fakeDb = createFakeDb()
  fakeDb.seed('xiai_faces', [
    { _id: 'f1', dynasty: '唐' },
    { _id: 'f2', dynasty: '宋' },
    { _id: 'f3', dynasty: null }
  ])
  fakeDb.seed('xiai_seals', [{ _id: 's1', dynasty: '唐' }])

  const store = createFakeStore()
  const { server, origin } = await buildServer({ fakeDb, store, now: undefined })
  const api = (options) => request(origin, options)

  try {
    /* ══ 1. 闭环 ══════════════════════════════════════════════════ */
    section('1. 闭环：register → login → 建 key → 用 key 调 dynasties')

    const ipOf = (n) => ({ 'x-forwarded-for': `198.51.100.${n}` })
    const registered = await api({
      method: 'POST',
      path: '/api/v1/auth/register',
      headers: ipOf(1),
      body: { phone: '138-0013-8000', password: PASSWORD }
    })
    bodiesSeen.push(registered.text)
    eq('register ⇒ 201', registered.status, 201)
    eq('register 信封 ok=true', registered.json && registered.json.ok, true)
    ok('register 回 session.token', typeof (registered.json.session || {}).token === 'string')
    eq('session.token_type = Session', registered.json.session.token_type, 'Session')
    eq('session.expires_in = 604800（7 天）', registered.json.session.expires_in, 604800)
    ok('session.expires_at 是 ISO8601', /^\d{4}-\d{2}-\d{2}T/.test(registered.json.session.expires_at))
    eq('user.phone 已归一化', registered.json.user.phone, '13800138000')
    eq('user.status = active', registered.json.user.status, 'active')
    ok('register 响应不含 password_hash', !registered.text.includes('password_hash'))
    ok('register 响应不含口令明文', !registered.text.includes(PASSWORD))

    const login = await api({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { phone: '13800138000', password: PASSWORD }
    })
    bodiesSeen.push(login.text)
    eq('login ⇒ 200', login.status, 200)
    const token = login.json.session.token
    ok('login 回了新的 session.token', typeof token === 'string' && token.length > 40)
    const sessionHeader = { authorization: `Session ${token}` }

    const me = await api({ path: '/api/v1/me', headers: sessionHeader })
    eq('GET /me ⇒ 200', me.status, 200)
    eq('/me 的 user 就是注册账号', me.json.user.id, registered.json.user.id)

    const created = await api({
      method: 'POST',
      path: '/api/v1/keys',
      headers: sessionHeader,
      body: { label: '生产密钥' }
    })
    bodiesSeen.push(created.text)
    eq('POST /keys ⇒ 201', created.status, 201)
    const plain = created.json.key.plain
    ok('明文以 yy_ 开头且 46 字符', typeof plain === 'string' && plain.startsWith('yy_') && plain.length === 46)
    eq('key.label 回显', created.json.key.label, '生产密钥')
    ok('201 体只含 id/prefix/label/plain 四字段', Object.keys(created.json.key).sort().join(',') === 'id,label,plain,prefix')

    // ★ 闭环关键一步：客户 key 调数据端点
    const data = await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${plain}` } })
    bodiesSeen.push(data.text)
    eq('用该 key 调 dynasties ⇒ 200', data.status, 200)
    eq('dynasties 信封 ok=true', data.json && data.json.ok, true)
    eq('dynasties.data.total = 15（朝代契约）', data.json.data.total, 15)
    eq('dynasties.data.counts.faces 聚合正确', JSON.stringify(data.json.data.counts.faces), JSON.stringify({ 唐: 1, 宋: 1 }))
    eq('dynasties.data.unrecorded.faces = 1', data.json.data.unrecorded.faces, 1)

    // 缓存命中仍 200（第二次同一 URL）
    const dataAgain = await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${plain}` } })
    eq('同 key 再调 ⇒ 200（实例缓存路径）', dataAgain.status, 200)

    /* ══ 2. 契约与失败面 ══════════════════════════════════════════ */
    section('2. 契约：状态码与字段面')

    const dup = await api({ method: 'POST', path: '/api/v1/auth/register', headers: ipOf(2), body: { phone: '13800138000', password: PASSWORD } })
    eq('重复注册 ⇒ 409', dup.status, 409)
    eq('重复注册 reason=ALREADY_EXISTS', dup.json.reason, 'ALREADY_EXISTS')

    const weak = await api({ method: 'POST', path: '/api/v1/auth/register', headers: ipOf(3), body: { phone: '13900139001', password: 'short' } })
    eq('弱口令 ⇒ 400', weak.status, 400)
    eq('弱口令 reason=INVALID_INPUT', weak.json.reason, 'INVALID_INPUT')

    const noIdent = await api({ method: 'POST', path: '/api/v1/auth/register', headers: ipOf(4), body: { password: PASSWORD } })
    eq('无标识 ⇒ 400', noIdent.status, 400)

    const badPhone = await api({ method: 'POST', path: '/api/v1/auth/register', headers: ipOf(5), body: { phone: 'abc', password: PASSWORD } })
    eq('非法手机号 ⇒ 400', badPhone.status, 400)

    const wrongPw = await api({ method: 'POST', path: '/api/v1/auth/login', body: { phone: '13800138000', password: `${PASSWORD}!` } })
    const unknown = await api({ method: 'POST', path: '/api/v1/auth/login', body: { phone: '13700137000', password: PASSWORD } })
    bodiesSeen.push(wrongPw.text, unknown.text)
    eq('口令错 ⇒ 401', wrongPw.status, 401)
    eq('账号不存在 ⇒ 401', unknown.status, 401)
    eq('两种失败**逐字同形**（不区分账号存在性）', wrongPw.text, unknown.text)
    eq('401 reason=UNAUTHORIZED', wrongPw.json.reason, 'UNAUTHORIZED')

    eq('无会话调 /me ⇒ 401', (await api({ path: '/api/v1/me' })).status, 401)
    eq('坏令牌调 /me ⇒ 401', (await api({ path: '/api/v1/me', headers: { authorization: 'Session v1.bogus.bogus' } })).status, 401)
    eq(
      'ApiKey scheme 当会话用 ⇒ 401（scheme 严格区分）',
      (await api({ path: '/api/v1/me', headers: { authorization: `ApiKey ${plain}` } })).status,
      401
    )
    const expired = signSession({
      uid: registered.json.user.id,
      role: 'user',
      ttlSeconds: 604800,
      nowSeconds: Math.floor(FIXED_NOW / 1000) - 9 * 24 * 60 * 60
    })
    eq(
      '过期会话 ⇒ 401',
      (await api({ path: '/api/v1/me', headers: { authorization: `Session ${expired.token}` } })).status,
      401
    )

    const listed = await api({ path: '/api/v1/keys', headers: sessionHeader })
    bodiesSeen.push(listed.text)
    eq('GET /keys ⇒ 200', listed.status, 200)
    ok('items 是数组', Array.isArray(listed.json.items))
    ok(
      '列表字段面逐字（7 字段）',
      listed.json.items.every((item) => Object.keys(item).sort().join(',') === 'call_count,created_at,id,label,last_used_at,prefix,status')
    )
    ok('列表**永不**回明文', !listed.text.includes(plain))
    ok('列表**永不**回 hash', !listed.text.includes('key_hash'))
    eq('列表只 1 条（自己刚建的那把）', listed.json.items.length, 1)

    const logout = await api({ method: 'POST', path: '/api/v1/auth/logout', headers: sessionHeader })
    eq('logout（带会话）⇒ 200', logout.status, 200)
    eq('logout 体 ok=true', logout.json.ok, true)
    eq('logout（无会话）⇒ 401', (await api({ method: 'POST', path: '/api/v1/auth/logout' })).status, 401)
    eq('登出后令牌按口径仍可用（无黑名单，HTTP 层不校验）', (await api({ path: '/api/v1/me', headers: sessionHeader })).status, 200)

    /* ══ 3. 方法门 / CORS / 体长 ══════════════════════════════════ */
    section('3. 方法白名单 / 预检 / 体长')

    const putRegister = await api({ method: 'PUT', path: '/api/v1/auth/register', body: {} })
    eq('PUT /auth/register ⇒ 405', putRegister.status, 405)
    eq('405 带 Allow: POST', putRegister.headers.allow, 'POST')

    const getRegister = await api({ path: '/api/v1/auth/register' })
    eq('GET /auth/register ⇒ 405', getRegister.status, 405)

    const deleteMe = await api({ method: 'DELETE', path: '/api/v1/me' })
    eq('DELETE /me ⇒ 405', deleteMe.status, 405)
    eq('405 带 Allow: GET', deleteMe.headers.allow, 'GET')

    const preflight = await api({
      method: 'OPTIONS',
      path: '/api/v1/keys',
      headers: { origin: 'https://yinyuan.example', 'access-control-request-method': 'POST' }
    })
    eq('预检 ⇒ 204', preflight.status, 204)
    eq('预检 Allow-Methods 含 POST/PATCH/DELETE', preflight.headers['access-control-allow-methods'], 'GET, POST, PATCH, DELETE, OPTIONS')
    eq('预检 Allow-Origin = *', preflight.headers['access-control-allow-origin'], '*')

    /* ── 分派形状门（catch-all 入口把三种形态收在一个文件里，未识别形态必须落 JSON 404） ── */
    const getItem = await api({ path: '/api/v1/keys/k-0000000000000000', headers: sessionHeader })
    eq('GET /keys/{kid} ⇒ 405（方法门先于认证）', getItem.status, 405)
    eq('GET /keys/{kid} 的 Allow 仍是 PATCH, DELETE', getItem.headers.allow, 'PATCH, DELETE')
    const bogusTail = await api({ path: '/api/v1/keys/k-0000000000000000/bogus', headers: sessionHeader })
    eq('/keys/{kid}/bogus ⇒ 404（未识别形态）', bogusTail.status, 404)
    eq('/keys/{kid}/bogus reason=NOT_FOUND', bogusTail.json && bogusTail.json.reason, 'NOT_FOUND')
    eq('/keys/{kid}/bogus 文案与全站兜底逐字一致', bogusTail.json && bogusTail.json.message, '接口不存在。')
    const deepPath = await api({ path: '/api/v1/keys/a/b/c' })
    eq('/keys/a/b/c ⇒ 404（多段未识别，不泄露端点面）', deepPath.status, 404)
    eq('/keys/a/b/c reason=NOT_FOUND', deepPath.json && deepPath.json.reason, 'NOT_FOUND')
    eq('未识别形态仍带 CORS 头', deepPath.headers['access-control-allow-origin'], '*')
    eq('未识别形态仍带 Cache-Control: no-store', deepPath.headers['cache-control'], 'no-store')

    const tooBig = await api({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: JSON.stringify({ phone: '13800138000', password: PASSWORD, pad: 'x'.repeat(9000) })
    })
    eq('体超 8 KiB ⇒ 413', tooBig.status, 413)
    eq('413 reason=BODY_TOO_LARGE', tooBig.json.reason, 'BODY_TOO_LARGE')

    const badJson = await api({ method: 'POST', path: '/api/v1/auth/login', body: '{not json' })
    eq('非法 JSON ⇒ 400', badJson.status, 400)

    /* ══ 4. 密钥全生命周期 ════════════════════════════════════════ */
    section('4. 密钥：轮换 / 状态变更 / 逻辑撤销 / 上限')

    const rotated = await api({ method: 'POST', path: `/api/v1/keys/${created.json.key.id}/rotate`, headers: sessionHeader })
    bodiesSeen.push(rotated.text)
    eq('rotate ⇒ 201', rotated.status, 201)
    ok('rotate 回新明文（与旧不同）', typeof rotated.json.key.plain === 'string' && rotated.json.key.plain !== plain)
    eq('rotate 后新 key 可调数据端点', (await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${rotated.json.key.plain}` } })).status, 200)
    resetCache()
    eq('rotate 后**旧 key 立即失效**（401）', (await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${plain}` } })).status, 401)
    const afterRotate = await api({ path: '/api/v1/keys', headers: sessionHeader })
    const oldRow = afterRotate.json.items.find((item) => item.id === created.json.key.id)
    eq('旧行未被删除（逻辑撤销，still in list）', Boolean(oldRow), true)
    eq('旧行 status=revoked', oldRow && oldRow.status, 'revoked')
    ok(
      '库里两行都在（不物理删）',
      fakeDb.has('yinyuan_api_keys', created.json.key.id) && fakeDb.has('yinyuan_api_keys', rotated.json.key.id)
    )

    const patched = await api({
      method: 'PATCH',
      path: `/api/v1/keys/${rotated.json.key.id}`,
      headers: sessionHeader,
      body: { status: 'revoked' }
    })
    eq('PATCH status=revoked ⇒ 200', patched.status, 200)
    eq('PATCH 回 key.status=revoked', patched.json.key.status, 'revoked')
    resetCache()
    eq('PATCH 撤销后该 key ⇒ 401', (await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${rotated.json.key.plain}` } })).status, 401)

    const badStatus = await api({
      method: 'PATCH',
      path: `/api/v1/keys/${rotated.json.key.id}`,
      headers: sessionHeader,
      body: { status: 'bogus' }
    })
    eq('PATCH 非法 status ⇒ 400', badStatus.status, 400)

    const deleted = await api({ method: 'DELETE', path: `/api/v1/keys/${rotated.json.key.id}`, headers: sessionHeader })
    eq('DELETE ⇒ 200', deleted.status, 200)
    ok('DELETE 是逻辑撤销（行仍在）', fakeDb.has('yinyuan_api_keys', rotated.json.key.id))
    eq('DELETE 后库里 status=revoked', fakeDb.row('yinyuan_api_keys', rotated.json.key.id).status, 'revoked')
    eq(
      'DELETE 不存在的 kid ⇒ 404',
      (await api({ method: 'DELETE', path: '/api/v1/keys/k-0000000000000000', headers: sessionHeader })).status,
      404
    )

    /* ★ rewrite 通道（生产实际入口）：`vercel.json` 把 `/keys/:kid` 折成 `?kid=`，
       `/{kid}/rotate` 折成 `?kid=&action=rotate`。此处全程走 query 通道，验四件事：
       形态判定进对了 handler、Allow 头不变、轮换 201 且旧 key 失效、撤销 200。 */
    const viaQueryCreated = await api({
      method: 'POST',
      path: '/api/v1/keys',
      headers: sessionHeader,
      body: { label: 'query 通道' }
    })
    eq('query 通道：先建一把 ⇒ 201', viaQueryCreated.status, 201)
    const queryKid = viaQueryCreated.json.key.id
    const queryPlain = viaQueryCreated.json.key.plain
    const queryGet = await api({ path: `/api/v1/keys?kid=${queryKid}`, headers: sessionHeader })
    eq('query 通道 GET /keys?kid= ⇒ 405（形态进 item handler）', queryGet.status, 405)
    eq('query 通道 GET 的 Allow 仍是 PATCH, DELETE', queryGet.headers.allow, 'PATCH, DELETE')
    const queryRotated = await api({
      method: 'POST',
      path: `/api/v1/keys?kid=${queryKid}&action=rotate`,
      headers: sessionHeader
    })
    eq('query 通道 rotate ⇒ 201', queryRotated.status, 201)
    ok('query 通道 rotate 回新明文', typeof (queryRotated.json.key || {}).plain === 'string')
    resetCache()
    eq('query 通道 rotate 后旧行 status=revoked（先铸新后撤旧）', fakeDb.row('yinyuan_api_keys', queryKid).status, 'revoked')
    ok('query 通道 rotate 后新旧两行都在（不物理删）', fakeDb.has('yinyuan_api_keys', queryKid) && fakeDb.has('yinyuan_api_keys', queryRotated.json.key.id))
    const queryDeleted = await api({
      method: 'DELETE',
      path: `/api/v1/keys?kid=${queryRotated.json.key.id}`,
      headers: sessionHeader
    })
    eq('query 通道 DELETE ⇒ 200', queryDeleted.status, 200)
    const noSessionQuery = await api({ method: 'PATCH', path: '/api/v1/keys?kid=k-0000000000000000', body: { status: 'revoked' } })
    eq('query 通道无会话 ⇒ 401（不是 404）', noSessionQuery.status, 401)
    const noSessionRotate = await api({ method: 'POST', path: '/api/v1/keys?kid=k-0000000000000000&action=rotate' })
    eq('query 通道 rotate 无会话 ⇒ 401（不是 404）', noSessionRotate.status, 401)

    // 上限：把 active 数填到 10（上限以内每次都必须成功），再建一把必须 409
    for (let i = 0; i < 10; i += 1) {
      const made = await api({ method: 'POST', path: '/api/v1/keys', headers: sessionHeader, body: { label: `批量-${i}` } })
      if (made.status !== 201) ok(`批量建第 ${i + 1} 把 ⇒ 201`, false, { status: made.status, body: made.json })
    }
    const overLimit = await api({ method: 'POST', path: '/api/v1/keys', headers: sessionHeader, body: { label: '第 11 把' } })
    eq('active 已达 10 把后再建 ⇒ 409', overLimit.status, 409)
    eq('超限 reason=KEY_LIMIT', overLimit.json.reason, 'KEY_LIMIT')

    const ttlKey = await api({ method: 'POST', path: '/api/v1/keys', headers: sessionHeader, body: { label: '带 TTL', ttl: ONE_HOUR_SECONDS } })
    eq('带 ttl 建 key（仍受 10 把上限约束）⇒ 409', ttlKey.status, 409)

    /* ══ 5. 越权隔离 ══════════════════════════════════════════════ */
    section('5. 越权隔离（别人的 kid ⇒ 404，绝不 403）')

    store.reset()
    const otherReg = await api({
      method: 'POST',
      path: '/api/v1/auth/register',
      headers: ipOf(6),
      body: { email: 'other@example.com', password: PASSWORD }
    })
    eq('另一个账号注册 ⇒ 201', otherReg.status, 201)
    const otherHeader = { authorization: `Session ${otherReg.json.session.token}` }
    const otherKeys = await api({ path: '/api/v1/keys', headers: otherHeader })
    eq('B 的 GET /keys ⇒ 200 但**只回自己的**（空列表）', otherKeys.json.items.length, 0)

    const freshList = await api({ path: '/api/v1/keys', headers: sessionHeader })
    const victimKid = freshList.json.items.find((item) => item.status === 'active').id
    ok('拿到 A 的一把 active key 作为越权目标', typeof victimKid === 'string' && victimKid.startsWith('k-'))
    const crossRotate = await api({ method: 'POST', path: `/api/v1/keys/${victimKid}/rotate`, headers: otherHeader })
    const crossPatch = await api({ method: 'PATCH', path: `/api/v1/keys/${victimKid}`, headers: otherHeader, body: { status: 'revoked' } })
    const crossDelete = await api({ method: 'DELETE', path: `/api/v1/keys/${victimKid}`, headers: otherHeader })
    eq('B 轮换 A 的 key ⇒ 404', crossRotate.status, 404)
    eq('B 改 A 的 key 状态 ⇒ 404', crossPatch.status, 404)
    eq('B 删 A 的 key ⇒ 404', crossDelete.status, 404)
    eq('越权 reason=NOT_FOUND（不泄露存在性）', crossRotate.json.reason, 'NOT_FOUND')
    eq('A 的 key 仍 active（未被越权改动）', fakeDb.row('yinyuan_api_keys', victimKid).status, 'active')

    /* ══ 6. 停用账号：会话与 key 立即失效 ══════════════════════════ */
    section('6. 停用账号 ⇒ 旧会话 401、其 key 立即失效')

    const activeKeyPlain = (
      await api({ method: 'POST', path: '/api/v1/keys', headers: otherHeader, body: { label: '停用前建的' } })
    )
    eq('为 B 建一把 key ⇒ 201', activeKeyPlain.status, 201)
    const bKeyPlain = activeKeyPlain.json.key.plain

    const ttlCreated = await api({ method: 'POST', path: '/api/v1/keys', headers: otherHeader, body: { label: '带 ttl', ttl: ONE_HOUR_SECONDS } })
    eq('POST /keys 带 ttl（1 小时）⇒ 201', ttlCreated.status, 201)
    const ttlRow = fakeDb.row('yinyuan_api_keys', ttlCreated.json.key.id)
    ok('ttl 落到行内 expires_at（UTC ISO8601）', Boolean(ttlRow && /^\d{4}-\d{2}-\d{2}T/.test(String(ttlRow.expires_at))))
    const badTtl = await api({ method: 'POST', path: '/api/v1/keys', headers: otherHeader, body: { ttl: 5 } })
    eq('ttl 过小（<60s）⇒ 400', badTtl.status, 400)

    const massAssign = await api({
      method: 'POST',
      path: '/api/v1/keys',
      headers: otherHeader,
      body: { label: '越权尝试', userId: 'u-0000000000000000' }
    })
    eq('体里塞 userId 不影响归属（无质量赋值面）', fakeDb.row('yinyuan_api_keys', massAssign.json.key.id).user_id, otherReg.json.user.id)
    resetCache()
    eq('停用前：B 的 key 可调数据端点 ⇒ 200', (await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${bKeyPlain}` } })).status, 200)

    await users.setStatus(fakeDb.db, otherReg.json.user.id, 'disabled', new Date(FIXED_NOW))
    resetCache()
    eq('停用后：B 的旧会话调 /me ⇒ 401', (await api({ path: '/api/v1/me', headers: otherHeader })).status, 401)
    eq(
      '停用后：B 的旧会话建 key ⇒ 401',
      (await api({ method: 'POST', path: '/api/v1/keys', headers: otherHeader, body: {} })).status,
      401
    )
    eq(
      '停用后：B 的 key 调数据端点 ⇒ 401',
      (await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${bKeyPlain}` } })).status,
      401
    )
    eq('停用账号登录 ⇒ 401（不说明「已停用」）', (await api({ method: 'POST', path: '/api/v1/auth/login', body: { email: 'other@example.com', password: PASSWORD } })).status, 401)

    await users.setStatus(fakeDb.db, otherReg.json.user.id, 'active', new Date(FIXED_NOW))
    resetCache()
    eq('恢复 active 后：旧会话又可用（令牌无状态）', (await api({ path: '/api/v1/me', headers: otherHeader })).status, 200)
    eq('恢复 active 后：其 key 又可调数据端点', (await api({ path: '/api/v1/dynasties', headers: { authorization: `ApiKey ${bKeyPlain}` } })).status, 200)

    /* ══ 7. 限流 ══════════════════════════════════════════════════ */
    section('7. 登录/注册限流（假计数存储，真 ratelimit.js）')

    store.reset()
    let lastStatus = 0
    let limitedBody = null
    for (let i = 0; i < 11; i += 1) {
      const attempt = await api({
        method: 'POST',
        path: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.7' },
        body: { phone: '13600136000', password: `${PASSWORD}-wrong` }
      })
      lastStatus = attempt.status
      if (attempt.status === 429) limitedBody = attempt.json
    }
    eq('同账号第 11 次失败登录 ⇒ 429', lastStatus, 429)
    eq('429 reason=RATE_LIMITED', limitedBody && limitedBody.reason, 'RATE_LIMITED')
    ok('429 文案是「尝试次数过多」（不是每日配额文案）', Boolean(limitedBody && /尝试次数过多/.test(limitedBody.message)))
    ok('限流计数键里没有账号/手机号原文', [...store.counters.keys()].every((key) => !key.includes('13600136000')))
    ok('限流计数键形 yinyuan:rl:<scope>:<窗口>:<指纹>', [...store.counters.keys()].every((key) => key.startsWith('yinyuan:rl:auth:login:')))

    store.reset()
    let registerStatuses = []
    for (let i = 0; i < 6; i += 1) {
      const attempt = await api({
        method: 'POST',
        path: '/api/v1/auth/register',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        body: { phone: `1390013900${i}`, password: PASSWORD }
      })
      registerStatuses.push(attempt.status)
    }
    eq('同 IP 第 6 次注册 ⇒ 429', registerStatuses[5], 429)

    /* ══ 8. 回归 A/B：改前 handler vs 改后 handler ══════════════ */
    section('8. 回归：与改前 handler 逐场景同形 + 四个真实端点失败面')

    const baseline = loadBaselineHandler()
    baselineDir = baseline.dir
    let baselineFactory = null
    try {
      const mod = await import(pathToFileURL(baseline.file).href)
      baselineFactory = mod.createGetHandler
    } catch (error) {
      ok('基线 handler 可加载', false, { error: String(error && error.message) })
    }

    if (baselineFactory) {
      const ENV_KEY = `env-${randomBytes(12).toString('base64url')}`
      const stubRun = async () => ({ probe: 'parity', count: 3 })
      const scenarios = [
        { name: 'POST（方法门）', method: 'POST', key: null, env: true, cb: false, expect: 405 },
        { name: 'GET 无 key', method: 'GET', key: null, env: true, cb: false, expect: 401 },
        { name: 'GET 错 key', method: 'GET', key: 'wrong-key', env: true, cb: false, expect: 401 },
        { name: 'GET 有效 env key（CB 未配置）', method: 'GET', key: ENV_KEY, env: true, cb: false, expect: 503 },
        { name: 'GET 有效 env key（CB 已配置 ⇒ 200）', method: 'GET', key: ENV_KEY, env: true, cb: true, expect: 200 },
        { name: 'GET env 未配置（带任意 key）', method: 'GET', key: 'any-key', env: false, cb: false, expect: 503 }
      ]

      for (const scenario of scenarios) {
        const currentHandler = createGetHandler('parity/probe', stubRun)
        const baselineHandler = baselineFactory('parity/probe', stubRun)
        const applyEnv = () => {
          if (scenario.env) process.env.YINYUAN_API_KEY = ENV_KEY
          else delete process.env.YINYUAN_API_KEY
          if (scenario.cb) {
            process.env.CB_ENV = 'fake-env'
            process.env.CB_SECRET_ID = 'fake-id'
            process.env.CB_SECRET_KEY = 'fake-key'
          } else {
            delete process.env.CB_ENV
            delete process.env.CB_SECRET_ID
            delete process.env.CB_SECRET_KEY
          }
          resetCache()
        }
        applyEnv()
        const after = await callHandler(currentHandler, { method: scenario.method, headerKey: scenario.key })
        applyEnv()
        const before = await callHandler(baselineHandler, { method: scenario.method, headerKey: scenario.key })
        eq(`A/B [${scenario.name}] 状态码 ${scenario.expect}`, after.status, scenario.expect)
        eq(`A/B [${scenario.name}] 改前改后状态码相同`, after.status, before.status)
        eq(`A/B [${scenario.name}] 响应体逐字相同`, after.body, before.body)
        eq(`A/B [${scenario.name}] Allow 头相同`, after.headers.allow || '', before.headers.allow || '')
        eq(`A/B [${scenario.name}] Cache-Control 相同`, after.headers['cache-control'] || '', before.headers['cache-control'] || '')
        eq(`A/B [${scenario.name}] CORS 头相同`, after.headers['access-control-allow-origin'] || '', before.headers['access-control-allow-origin'] || '')
      }

      // 四个真实数据端点：env 机构钥匙下的失败面形状不变（真模块、真工厂）
      process.env.YINYUAN_API_KEY = ENV_KEY
      delete process.env.CB_ENV
      delete process.env.CB_SECRET_ID
      delete process.env.CB_SECRET_KEY
      const realModules = {
        dynasties: (await import('../api/v1/dynasties.js')).default,
        authors: (await import('../api/v1/authors.js')).default,
        inscriptions: (await import('../api/v1/inscriptions.js')).default
      }
      for (const [name, handler] of Object.entries(realModules)) {
        resetCache()
        eq(`真端点 ${name}：无 key ⇒ 401`, (await callHandler(handler, { url: `/api/v1/${name}` })).status, 401)
        eq(`真端点 ${name}：错 key ⇒ 401`, (await callHandler(handler, { headerKey: 'nope', url: `/api/v1/${name}` })).status, 401)
        eq(`真端点 ${name}：合法 env key + CB 未配置 ⇒ 503`, (await callHandler(handler, { headerKey: ENV_KEY, url: `/api/v1/${name}` })).status, 503)
        const postRes = await callHandler(handler, { method: 'POST', headerKey: ENV_KEY, url: `/api/v1/${name}` })
        eq(`真端点 ${name}：POST ⇒ 405`, postRes.status, 405)
        eq(`真端点 ${name}：405 带 Allow: GET`, postRes.headers.allow, 'GET')
        eq(`真端点 ${name}：405 信封 reason`, postRes.json && postRes.json.reason, 'METHOD_NOT_ALLOWED')
      }
    }

    /* ══ 9. 静态门 ════════════════════════════════════════════════ */
    section('9. 静态门：集合隔离 / 无敏感回显')

    const touched = [...fakeDb.state.touched]
    ok(`只触达 yinyuan_* 与只读数据集合（实测：${touched.join(', ')}）`, touched.every((name) => name.startsWith('yinyuan_') || name.startsWith('xiai_')))
    ok('账号表与密钥表均被用到', touched.includes('yinyuan_users') && touched.includes('yinyuan_api_keys'))
    const allBodies = bodiesSeen.join('\n')
    ok('所有响应体不含 key_hash', !allBodies.includes('key_hash'))
    ok('所有响应体不含 password_hash', !allBodies.includes('password_hash'))
    ok('所有响应体不含 STORAGE_UNAVAILABLE 理由', !allBodies.includes('STORAGE_UNAVAILABLE'))
    ok('所有响应体不含 SESSION_SECRET 值', !allBodies.includes(SESSION_SECRET))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

let baselineDir = null
try {
  await main()
} catch (error) {
  failCount += 1
  failures.push('未捕获异常')
  console.error('\n未捕获异常：', error && error.stack ? error.stack : error)
} finally {
  restoreEnv()
  if (baselineDir) {
    try {
      rmSync(baselineDir, { recursive: true, force: true })
    } catch (ignored) {}
  }
}

console.log(`\n══ 自检结果：${passCount} 通过 / ${failCount} 失败 ══`)
if (failCount > 0) {
  console.log('失败项：')
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('全部通过。')
