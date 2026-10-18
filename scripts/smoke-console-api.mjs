/**
 * ============================================================================
 * B3 适配层契约冒烟 —— **全程假 fetch，零网络、零写入**
 *
 * 覆盖：`auth.js` 的 4 个方法 + `keys.js` 的 5 个方法（共 9 个），逐条断言
 *   ① 请求形状（URL / 方法 / 头 / 体 —— 含 `Authorization: Session <token>` 与会话体不 trim 口令）；
 *   ② 响应映射（snake_case → 适配层形状；`plain → plaintextOnce`；状态枚举 active/revoked → ACTIVE/DISABLED）；
 *   ③ 失败面映射（401 / 404 / 409 / 413 / 429 / 503 / 网络 / 响应不可解析）；
 *   ④ 会话存储（sessionStorage 单键；成功写、401 与过期清；**明文绝不入存储**）。
 *
 * 红线：**不真注册、不真建 key**（会写生产数据）—— 本文件不打任何真实主机，
 * `globalThis.fetch` 在 import 之后被整体替换，所有响应都是自造对象。
 *
 * 跑法（仓内 esbuild 套路）：`node scripts/build-smoke-console-api.mjs`
 * ============================================================================
 */
import {
  SESSION_STORAGE_KEY,
  clearSession,
  expiryMsOf,
  isAlreadyExists,
  isAuthFailure,
  isRateLimited,
  isServiceUnavailable,
  login,
  logout,
  me,
  onSessionExpired,
  readSession,
  register,
  writeSession,
} from '../src/data/api/auth.js'
import { create, list, remove, rotate, setStatus } from '../src/data/api/keys.js'

/* ---------------------------------------------------------------------------
 * 环境替身：sessionStorage（node 无此全局）
 * ------------------------------------------------------------------------- */
class MemoryStorage {
  constructor() {
    this.map = new Map()
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }

  setItem(key, value) {
    this.map.set(key, String(value))
  }

  removeItem(key) {
    this.map.delete(key)
  }

  get size() {
    return this.map.size
  }
}

globalThis.sessionStorage = new MemoryStorage()

/* ---------------------------------------------------------------------------
 * 环境替身：fetch（把每次调用的 URL 与方法/头/体记下来，返回自造响应）
 * ------------------------------------------------------------------------- */
let calls = []
let responder = null

globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  if (typeof responder !== 'function') throw new Error('测试未预置响应：responder 为空')
  return responder(url, init)
}

function respondWith(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

function respondBroken(status) {
  return {
    status,
    ok: false,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    },
  }
}

function reset(nextResponder) {
  calls = []
  responder = nextResponder
}

function lastCall() {
  return calls[calls.length - 1]
}

function bodyOf(call) {
  if (!call || call.init.body === undefined || call.init.body === null) return null
  return JSON.parse(call.init.body)
}

function headerOf(call, name) {
  const headers = (call && call.init && call.init.headers) || {}
  return headers[name]
}

const HOUR_MS = 60 * 60 * 1000
const FUTURE = new Date(Date.now() + 6 * HOUR_MS).toISOString()
const PAST = new Date(Date.now() - 1 * HOUR_MS).toISOString()

function seedSession(token = 'tk_seed') {
  writeSession({ token, expires_at: FUTURE, user: { userId: 'u_1' } })
}

/* ---------------------------------------------------------------------------
 * 断言器
 * ------------------------------------------------------------------------- */
const rows = []
let failed = 0

function check(id, label, condition, reading) {
  const pass = Boolean(condition)
  if (!pass) failed += 1
  rows.push({ id, label, pass, reading })
}

function show(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function report() {
  for (const row of rows) {
    const mark = row.pass ? '✓' : '✗'
    console.log(`${mark} ${row.id} ${row.label}   ⇒ ${row.reading}`)
  }
  const total = rows.length
  const passed = total - failed
  console.log(`\n${failed === 0 ? '✓' : '✗'} 契约冒烟：${passed}/${total} 通过${failed ? `，${failed} 失败` : ''}`)
  if (failed) process.exitCode = 1
}

async function capture(fn) {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error }
  }
}

/* ---------------------------------------------------------------------------
 * 1. register —— 201 成功：URL / 方法 / 头 / 体（不 trim 口令、丢弃后端不接收的字段）
 * ------------------------------------------------------------------------- */
clearSession()
reset(() => respondWith(201, {
  ok: true,
  session: { token: 'tk_reg', token_type: 'Session', expires_in: 604800, expires_at: FUTURE },
  user: {
    id: 'u_1',
    phone: '13800138000',
    email: null,
    role: 'user',
    status: 'active',
    createdAt: '2026-10-18T01:02:03.000Z',
    lastLoginAt: null,
  },
}))

const regResult = await register({
  orgName: '（测试）某博物馆',
  contactName: '张示例',
  phone: '13800138000',
  email: '',
  password: ' Pass w0rd ',
})
const regCall = lastCall()
const regBody = bodyOf(regCall)

check('01', 'register 请求行', same([regCall.init.method, regCall.url], ['POST', '/api/v1/auth/register']),
  `${regCall.init.method} ${regCall.url}`)
check('02', 'register 体只含 password/phone（orgName/contactName/空 email 一律不送）',
  same(Object.keys(regBody).sort(), ['password', 'phone']), show(regBody))
check('03', 'register 口令逐字不 trim', regBody.password === ' Pass w0rd ', show(regBody.password))
check('04', 'register 无会话头 / 有 JSON 头',
  headerOf(regCall, 'Authorization') === undefined && headerOf(regCall, 'Content-Type') === 'application/json',
  `Authorization=${show(headerOf(regCall, 'Authorization'))} Content-Type=${show(headerOf(regCall, 'Content-Type'))}`)

const regSession = readSession()
check('05', 'register 写会话 {token,expires_at,user} 且落在 sessionStorage 单键',
  Boolean(regSession) && regSession.token === 'tk_reg' && regSession.expires_at === FUTURE
    && regSession.user && regSession.user.userId === 'u_1'
    && Object.keys(regSession).sort().join(',') === 'expires_at,token,user',
  `${SESSION_STORAGE_KEY} = ${show(regSession)}`)
check('06', 'register 返回值与 user 归一（orgName/planId 不造值）',
  regResult.user.userId === 'u_1' && regResult.user.orgName === null && regResult.user.planId === null
    && regResult.sessionToken === 'tk_reg',
  show({ userId: regResult.user.userId, orgName: regResult.user.orgName, planId: regResult.user.planId, sessionToken: regResult.sessionToken }))

/* ---------------------------------------------------------------------------
 * 2. login —— 401 统一失败面（账号标识拆成 email；口令原值）
 * ------------------------------------------------------------------------- */
clearSession()
reset(() => respondWith(401, { ok: false, reason: 'UNAUTHORIZED', message: '手机号/邮箱或口令不正确。' }))
const loginFail = await capture(() => login('ops@example.com', 'wrong-pass'))
const loginCall = lastCall()
const loginBody = bodyOf(loginCall)

check('07', 'login 请求行与体（含 @ ⇒ email，不送 phone）',
  loginCall.init.method === 'POST' && loginCall.url === '/api/v1/auth/login'
    && same(Object.keys(loginBody).sort(), ['email', 'password'])
    && loginBody.email === 'ops@example.com' && loginBody.password === 'wrong-pass',
  `${loginCall.init.method} ${loginCall.url} body=${show(loginBody)}`)
check('08', 'login 401 → ok:false / reason 逐字 UNAUTHORIZED / httpStatus 401',
  loginFail.ok === false && loginFail.error.ok === false && loginFail.error.reason === 'UNAUTHORIZED'
    && loginFail.error.httpStatus === 401 && loginFail.error.code === 'UNAUTHORIZED',
  show({ ok: loginFail.error.ok, reason: loginFail.error.reason, code: loginFail.error.code, status: loginFail.error.httpStatus }))
check('09', 'login 401 判为凭据失败（isAuthFailure=true、非限流）、且不写会话',
  isAuthFailure(loginFail.error) === true && isRateLimited(loginFail.error) === false && readSession() === null,
  `isAuthFailure=${isAuthFailure(loginFail.error)} isRateLimited=${isRateLimited(loginFail.error)} session=${show(readSession())}`)
check('10', '失败信封保留服务端文案与请求读数',
  loginFail.error.message === '手机号/邮箱或口令不正确。' && loginFail.error.endpoint === '/api/v1/auth/login'
    && loginFail.error.method === 'POST',
  `message=${loginFail.error.message} endpoint=${loginFail.error.endpoint} method=${loginFail.error.method}`)

/* ---------------------------------------------------------------------------
 * 3. register 409 —— 已注册
 * ------------------------------------------------------------------------- */
reset(() => respondWith(409, { ok: false, reason: 'ALREADY_EXISTS', message: '该手机号或邮箱已注册。' }))
const regDup = await capture(() => register({ phone: '13800138000', password: 'Passw0rd1' }))
check('11', 'register 409 → ALREADY_EXISTS（isAlreadyExists=true；不写会话）',
  regDup.ok === false && regDup.error.reason === 'ALREADY_EXISTS' && isAlreadyExists(regDup.error) === true
    && regDup.error.httpStatus === 409 && readSession() === null,
  show({ reason: regDup.error.reason, status: regDup.error.httpStatus, session: readSession() }))

/* ---------------------------------------------------------------------------
 * 4. logout —— Session 头、无体、清会话
 * ------------------------------------------------------------------------- */
seedSession('tk_live')
reset(() => respondWith(200, { ok: true }))
const logoutValue = await logout()
const logoutCall = lastCall()
check('12', 'logout 请求行（Session 头 + 无体）',
  logoutCall.init.method === 'POST' && logoutCall.url === '/api/v1/auth/logout'
    && headerOf(logoutCall, 'Authorization') === 'Session tk_live'
    && logoutCall.init.body === undefined,
  `${logoutCall.init.method} ${logoutCall.url} Authorization=${headerOf(logoutCall, 'Authorization')} body=${show(logoutCall.init.body)}`)
check('13', 'logout 200 → 清会话并返回 true',
  logoutValue === true && readSession() === null, `return=${show(logoutValue)} session=${show(readSession())}`)

seedSession('tk_dead')
reset(() => respondWith(401, { ok: false, reason: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录。' }))
const logoutDead = await capture(() => logout())
check('14', 'logout 401（令牌已失效）仍视为成功并清会话',
  logoutDead.ok === true && logoutDead.value === true && readSession() === null,
  `resolved=${logoutDead.ok} value=${show(logoutDead.value)} session=${show(readSession())}`)

/* ---------------------------------------------------------------------------
 * 5. me —— 200 归一 / 本地过期不发请求
 * ------------------------------------------------------------------------- */
seedSession('tk_me')
reset(() => respondWith(200, {
  ok: true,
  user: { id: 'u_9', phone: null, email: 'a@b.co', role: 'user', status: 'active', createdAt: '2026-10-18T00:00:00.000Z', lastLoginAt: null },
}))
const meUser = await me()
const meCall = lastCall()
check('15', 'me 请求行（GET + Session 头）',
  meCall.init.method === 'GET' && meCall.url === '/api/v1/me' && headerOf(meCall, 'Authorization') === 'Session tk_me'
    && meCall.init.body === undefined,
  `${meCall.init.method} ${meCall.url} Authorization=${headerOf(meCall, 'Authorization')}`)
check('16', 'me 200 → user 归一（userId 来自 id）',
  Boolean(meUser) && meUser.userId === 'u_9' && meUser.email === 'a@b.co' && meUser.orgName === null,
  show(meUser))

writeSession({ token: 'tk_expired', expires_at: PAST, user: { userId: 'u_1' } })
reset(() => respondWith(200, { ok: true, user: { id: 'u_1' } }))
const meExpired = await me()
check('17', 'me 本地已过期 → 返回 null、清会话、**不发请求**',
  meExpired === null && readSession() === null && calls.length === 0,
  `value=${show(meExpired)} session=${show(readSession())} fetchCalls=${calls.length}`)
check('18', 'expiryMsOf 认 UTC ISO8601 与秒级数字',
  Math.abs(expiryMsOf(FUTURE) - Date.parse(FUTURE)) < 1 && expiryMsOf(1700000000) === 1700000000000,
  `iso→${expiryMsOf(FUTURE)} seconds→${expiryMsOf(1700000000)}`)

/* ---------------------------------------------------------------------------
 * 6. keys.list —— 列表映射
 * ------------------------------------------------------------------------- */
seedSession('tk_keys')
reset(() => respondWith(200, {
  ok: true,
  items: [
    { id: 'k_1', prefix: 'yy_ab', label: '展陈联调', status: 'active', created_at: '2026-10-18T02:00:00.000Z', last_used_at: '2026-10-18T03:00:00.000Z', call_count: 7 },
    { id: 'k_0', prefix: 'yy_zz', label: '旧密钥', status: 'revoked', created_at: '2026-10-17T02:00:00.000Z', last_used_at: null, call_count: 0 },
  ],
}))
const keyList = await list()
const listCall = lastCall()
check('19', 'keys.list 请求行（GET /keys + Session 头）',
  listCall.init.method === 'GET' && listCall.url === '/api/v1/keys'
    && headerOf(listCall, 'Authorization') === 'Session tk_keys',
  `${listCall.init.method} ${listCall.url} Authorization=${headerOf(listCall, 'Authorization')}`)
check('20', 'keys.list 映射 snake_case→适配层形状、active/revoked→ACTIVE/DISABLED',
  keyList.length === 2 && keyList[0].kid === 'k_1' && keyList[0].label === '展陈联调'
    && keyList[0].prefix === 'yy_ab' && keyList[0].status === 'ACTIVE' && keyList[0].callCount === 7
    && keyList[0].createdAt === '2026-10-18T02:00:00.000Z' && keyList[0].lastUsedAt === '2026-10-18T03:00:00.000Z'
    && keyList[1].status === 'DISABLED' && keyList[1].lastUsedAt === null,
  show(keyList))

/* ---------------------------------------------------------------------------
 * 7. keys.create —— 201：体只有 label；plain 只经 plaintextOnce 出现且不入存储
 * ------------------------------------------------------------------------- */
reset(() => respondWith(201, { ok: true, key: { id: 'k_2', prefix: 'yy_cd', label: '新建密钥', plain: 'yy_plain_secret_once' } }))
const created = await create({ label: '  新建密钥  ' })
const createCall = lastCall()
check('21', 'keys.create 请求行（POST /keys + 体 {"label"}）',
  createCall.init.method === 'POST' && createCall.url === '/api/v1/keys'
    && same(bodyOf(createCall), { label: '新建密钥' }),
  `${createCall.init.method} ${createCall.url} body=${show(bodyOf(createCall))}`)
check('22', 'keys.create 201 → {key, plaintextOnce}（plain 改名，不明文外泄到别处）',
  created.key.kid === 'k_2' && created.key.prefix === 'yy_cd' && created.plaintextOnce === 'yy_plain_secret_once',
  show({ kid: created.key.kid, prefix: created.key.prefix, plaintextOnce: created.plaintextOnce }))
const storedRaw = globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY) || ''
check('23', '明文不落 sessionStorage',
  storedRaw.includes('yy_plain_secret_once') === false,
  `sessionStorage(${SESSION_STORAGE_KEY})=${show(storedRaw)}`)

reset(() => respondWith(409, { ok: false, reason: 'KEY_LIMIT', message: '每个账号最多保留 10 把有效密钥。' }))
const createLimit = await capture(() => create({ label: '第 N 把' }))
check('24', 'keys.create 409 KEY_LIMIT → reason 与文案逐字透传',
  createLimit.ok === false && createLimit.error.reason === 'KEY_LIMIT' && createLimit.error.httpStatus === 409
    && createLimit.error.message === '每个账号最多保留 10 把有效密钥。',
  show({ reason: createLimit.error.reason, status: createLimit.error.httpStatus, message: createLimit.error.message }))

/* ---------------------------------------------------------------------------
 * 8. keys.rotate —— 201：路径段编码 + 无体
 * ------------------------------------------------------------------------- */
reset(() => respondWith(201, { ok: true, key: { id: 'k_3', prefix: 'yy_ef', label: '轮换后', plain: 'yy_rotated_once' } }))
const rotated = await rotate('k/2')
const rotateCall = lastCall()
check('25', 'keys.rotate 请求行（kid 逐段编码 + POST + 无体）',
  rotateCall.init.method === 'POST' && rotateCall.url === '/api/v1/keys/k%2F2/rotate'
    && rotateCall.init.body === undefined && headerOf(rotateCall, 'Authorization') === 'Session tk_keys',
  `${rotateCall.init.method} ${rotateCall.url} body=${show(rotateCall.init.body)}`)
check('26', 'keys.rotate 201 → 新 key + 新明文（kid 为新 id）',
  rotated.key.kid === 'k_3' && rotated.plaintextOnce === 'yy_rotated_once', show(rotated))

reset(() => respondWith(404, { ok: false, reason: 'NOT_FOUND', message: '密钥不存在。' }))
const rotateMiss = await capture(() => rotate('k_missing'))
check('27', 'keys.rotate 404 → NOT_FOUND（越权与不存在同形，前端不区分）',
  rotateMiss.ok === false && rotateMiss.error.reason === 'NOT_FOUND' && rotateMiss.error.httpStatus === 404,
  show({ reason: rotateMiss.error.reason, status: rotateMiss.error.httpStatus }))

/* ---------------------------------------------------------------------------
 * 9. keys.setStatus —— PATCH 体 {status}：DISABLED→revoked、ACTIVE→active
 * ------------------------------------------------------------------------- */
reset(() => respondWith(200, {
  ok: true,
  key: { id: 'k_1', prefix: 'yy_ab', label: '展陈联调', status: 'revoked', created_at: '2026-10-18T02:00:00.000Z', last_used_at: null, call_count: 7 },
}))
const disabled = await setStatus('k_1', 'DISABLED')
const patchCall = lastCall()
check('28', 'keys.setStatus(DISABLED) → PATCH /keys/k_1 body {status:"revoked"}',
  patchCall.init.method === 'PATCH' && patchCall.url === '/api/v1/keys/k_1'
    && same(bodyOf(patchCall), { status: 'revoked' })
    && disabled.status === 'DISABLED' && disabled.kid === 'k_1',
  `${patchCall.init.method} ${patchCall.url} body=${show(bodyOf(patchCall))} → status=${disabled.status}`)

reset(() => respondWith(200, {
  ok: true,
  key: { id: 'k_1', prefix: 'yy_ab', label: '展陈联调', status: 'active', created_at: null, last_used_at: null, call_count: 0 },
}))
const enabled = await setStatus('k_1', 'ACTIVE')
check('29', 'keys.setStatus(ACTIVE) → body {status:"active"} → status=ACTIVE',
  same(bodyOf(lastCall()), { status: 'active' }) && enabled.status === 'ACTIVE',
  `body=${show(bodyOf(lastCall()))} → status=${enabled.status}`)

/* ---------------------------------------------------------------------------
 * 10. keys.remove —— DELETE 200 {ok:true}
 * ------------------------------------------------------------------------- */
reset(() => respondWith(200, { ok: true }))
const removed = await remove('k_1')
const delCall = lastCall()
check('30', 'keys.remove 请求行（DELETE /keys/k_1，无体）→ 返回 undefined',
  delCall.init.method === 'DELETE' && delCall.url === '/api/v1/keys/k_1'
    && delCall.init.body === undefined && removed === undefined,
  `${delCall.init.method} ${delCall.url} return=${show(removed)}`)

/* ---------------------------------------------------------------------------
 * 11. 失败面：429 / 503（两种 reason 字面）/ 网络 / 响应不可解析 / 401 会话失效
 * ------------------------------------------------------------------------- */
reset(() => respondWith(429, { ok: false, reason: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' }))
const limited = await capture(() => list())
check('31', '429 → RATE_LIMITED（isRateLimited=true）',
  limited.ok === false && limited.error.reason === 'RATE_LIMITED' && isRateLimited(limited.error) === true,
  show({ reason: limited.error.reason, isRateLimited: isRateLimited(limited.error) }))

reset(() => respondWith(503, { ok: false, reason: 'NOT_CONFIGURED', message: '密钥服务暂时不可用，请稍后重试。' }))
const downA = await capture(() => list())
check('32', '503 NOT_CONFIGURED → isServiceUnavailable=true（派单口径 CONFIG_MISSING 同判）',
  downA.ok === false && downA.error.reason === 'NOT_CONFIGURED' && isServiceUnavailable(downA.error) === true,
  show({ reason: downA.error.reason, status: downA.error.httpStatus, isServiceUnavailable: isServiceUnavailable(downA.error) }))

reset(() => respondWith(503, { ok: false, reason: 'CONFIG_MISSING', message: '服务未配置。' }))
const downB = await capture(() => list())
check('33', '503 CONFIG_MISSING（派单字面）→ 同判 isServiceUnavailable=true',
  downB.ok === false && downB.error.reason === 'CONFIG_MISSING' && isServiceUnavailable(downB.error) === true,
  show({ reason: downB.error.reason, isServiceUnavailable: isServiceUnavailable(downB.error) }))

reset(() => { throw new TypeError('fetch failed') })
const offline = await capture(() => list())
check('34', '网络层抛错 → NETWORK_ERROR / httpStatus 0 / 不重试不回落',
  offline.ok === false && offline.error.reason === 'NETWORK_ERROR' && offline.error.httpStatus === 0,
  show({ reason: offline.error.reason, status: offline.error.httpStatus, message: offline.error.message }))

reset(() => respondBroken(500))
const broken = await capture(() => list())
check('35', '响应不可解析 → INVALID_RESPONSE（不把 HTML 兜底页当成功）',
  broken.ok === false && broken.error.reason === 'INVALID_RESPONSE' && broken.error.httpStatus === 500,
  show({ reason: broken.error.reason, status: broken.error.httpStatus }))

const events = []
const unsubscribe = onSessionExpired((detail) => events.push(detail))
seedSession('tk_stale')
reset(() => respondWith(401, { ok: false, reason: 'SESSION_INVALID', message: '登录状态已失效，请重新登录。' }))
const stale = await capture(() => list())
unsubscribe()
check('36', 'keys 401 → 清会话 + 派发 session-expired（守卫据此跳 /console/login）',
  stale.ok === false && stale.error.sessionInvalid === true && readSession() === null
    && events.length === 1 && events[0].reason === 'SESSION_INVALID'
    && events[0].endpoint === '/api/v1/keys' && events[0].method === 'GET',
  show({ sessionInvalid: stale.error.sessionInvalid, session: readSession(), events }))

/* ---------------------------------------------------------------------------
 * 12. 无会话时不得发请求（authed 调用直接被判失效）
 * ------------------------------------------------------------------------- */
clearSession()
reset(() => respondWith(200, { ok: true, items: [] }))
const noSession = await capture(() => list())
check('37', '无会话调用受保护端点 → 本地即 401 SESSION_INVALID、**零请求**',
  noSession.ok === false && noSession.error.reason === 'SESSION_INVALID' && noSession.error.httpStatus === 401
    && calls.length === 0,
  show({ reason: noSession.error.reason, status: noSession.error.httpStatus, fetchCalls: calls.length }))

report()
