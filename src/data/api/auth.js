/**
 * ============================================================================
 * 账号 / 会话适配层（B3）—— `/api/v1/auth/*` 与 `/api/v1/me` 的前端唯一实现
 *
 * 纪律（与 `src/data/api/image.js` 同构）：
 *   ① **页面不得直接 import 本文件**（spec §8.3-3）——页面只经 `@/data` 的
 *      A2 `register` / A3 `login` / A4 `logout` / `getSession` 取用；
 *   ② 本层**不含**任何演示数据、不在失败时回落到本地数据：服务端说什么就是什么，
 *      连不上就结构化失败（`ok:false` + `reason` + 请求读数）；
 *   ③ **口令不得 trim / 归一化**（服务端口径：`' pass '` 与 `'pass'` 是两个口令）——
 *      本层把调用方给的字符串逐字放进 JSON 体；
 *   ④ 会话只落 **sessionStorage**（`yinyuan.session.v1`，spec §8.1 禁 localStorage）；
 *      401 / 过期 ⇒ 清会话并发 `yinyuan:session-expired` 事件（由路由守卫跳登录）。
 *
 * 对外错误形状（与仓内既有结构化失败同源）：
 *   `Error` 上挂 `{ ok:false, reason, code, httpStatus, authed, sessionInvalid,
 *                  endpoint, method, body }`；`message` 为可读中文。
 *   `reason` 一律**逐字**取服务端 `body.reason`（如 `UNAUTHORIZED` / `ALREADY_EXISTS` /
 *   `KEY_LIMIT` / `RATE_LIMITED` / `NOT_CONFIGURED`），服务端未给才按状态码派生。
 *   ⚠ 契约字面与实际实现的差异（本层双向兼容，不猜）：
 *       派单口径 401 `SESSION_INVALID` ↔ 实测 401 `UNAUTHORIZED`；
 *       派单口径 503 `CONFIG_MISSING`  ↔ 实测 503 `NOT_CONFIGURED`。
 *     因此判定一律走本文件导出的谓词（`isAuthFailure` 等），页面**不写字面量比较**。
 * ============================================================================
 */
import { API_BASE_URL } from '@/config/env.js'

/** 会话存储键（sessionStorage；与 mock 的 `yinsuo.mock.v1` 分开，互不覆写）。 */
export const SESSION_STORAGE_KEY = 'yinyuan.session.v1'

/** 会话失效事件名（401 / 本地过期）。载荷：`{ reason, serverReason, endpoint, method }`。 */
export const SESSION_EXPIRED_EVENT = 'yinyuan:session-expired'

/** 会话头前缀（服务端契约：`Authorization: Session <token>`）。 */
export const SESSION_HEADER_SCHEME = 'Session'

/** 服务端 `session.token_type` 的期望值（仅作自检标注，不参与判定）。 */
export const SESSION_TOKEN_TYPE = 'Session'

/** 服务端 reason → 本层语义（双向别名；用于**判定**，不改写 `reason` 原文）。 */
const REASON_ALIASES = Object.freeze({
  UNAUTHORIZED: 'SESSION_INVALID',
  SESSION_INVALID: 'SESSION_INVALID',
  NOT_CONFIGURED: 'CONFIG_MISSING',
  CONFIG_MISSING: 'CONFIG_MISSING',
})

/** 状态码 → 兜底 reason（服务端未给 `reason` 时使用；取自 B2 端点文档的失败面）。 */
const REASON_BY_STATUS = Object.freeze({
  400: 'INVALID_INPUT',
  401: 'SESSION_INVALID',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'BODY_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'CONFIG_MISSING',
})

/** 网络层失败 / 响应不可解析的**本地** reason（非服务端枚举，页面按需展示）。 */
export const LOCAL_REASON = Object.freeze({
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
})

/* ---------------------------------------------------------------------------
 * 存储（sessionStorage；不可用时静默退化，不抛）
 * ------------------------------------------------------------------------- */

function storage() {
  try {
    return globalThis.sessionStorage || null
  } catch (error) {
    void error
    return null
  }
}

/**
 * 读会话快照 `{token, expires_at, user}`。
 * 结构不全（缺 token）视为无会话并**顺手清掉**，避免半截记录反复误导守卫。
 */
export function readSession() {
  const store = storage()
  if (!store) return null
  let raw = null
  try {
    raw = store.getItem(SESSION_STORAGE_KEY)
  } catch (error) {
    void error
    return null
  }
  if (!raw) return null
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    void error
    clearSession()
    return null
  }
  if (!parsed || typeof parsed.token !== 'string' || parsed.token === '') {
    clearSession()
    return null
  }
  return parsed
}

/**
 * 写会话（**只写这三个字段**：`token` / `expires_at` / `user`）。
 * 明文密钥（`plain`）永不入本存储 —— 调用方也不得把明文塞进 `user`。
 */
export function writeSession(session) {
  const store = storage()
  if (!store) return null
  const record = {
    token: String(session && session.token ? session.token : ''),
    expires_at: (session && session.expires_at) || null,
    user: (session && session.user) || null,
  }
  try {
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(record))
  } catch (error) {
    void error
    return null
  }
  return record
}

/** 清会话（幂等；存储不可用也算已清）。 */
export function clearSession() {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(SESSION_STORAGE_KEY)
  } catch (error) {
    void error
  }
}

/** `expires_at` → 毫秒时间戳；支持 UTC ISO8601（服务端实际形态）与秒级数字。 */
export function expiryMsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级与毫秒级都认：小于 1e12 视为秒（2026 年的秒级时间戳约 1.7e9）。
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value !== '') {
    const at = Date.parse(value)
    return Number.isFinite(at) ? at : NaN
  }
  return NaN
}

/**
 * 会话是否已过期。**缺 / 坏 `expires_at` 一律判过期**（fail-closed：
 * 宁可让用户重登，也不拿一个过期时刻不明的令牌去打真接口）。
 */
export function isSessionExpired(session, nowMs = Date.now()) {
  const at = expiryMsOf(session && session.expires_at)
  return !Number.isFinite(at) || at <= nowMs
}

/** 当前可用令牌（无会话 / 已过期 ⇒ 空串，并清掉过期记录）。 */
export function sessionToken() {
  const session = readSession()
  if (!session) return ''
  if (isSessionExpired(session)) {
    clearSession()
    return ''
  }
  return session.token
}

/** 会话头（无可用令牌 ⇒ 空对象，由请求层拒绝发送）。 */
export function authHeaders() {
  const token = sessionToken()
  return token ? { Authorization: `${SESSION_HEADER_SCHEME} ${token}` } : {}
}

/* ---------------------------------------------------------------------------
 * 会话失效订阅（适配层不 import 路由，避免环；由路由守卫注册）
 * ------------------------------------------------------------------------- */

const listeners = new Set()

/** 订阅会话失效；返回取消函数。事件在**适配层判定 401 / 本地过期时**同步派发。 */
export function onSessionExpired(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitSessionExpired(detail) {
  if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    try {
      globalThis.dispatchEvent(new globalThis.CustomEvent(SESSION_EXPIRED_EVENT, { detail }))
    } catch (error) {
      void error
    }
  }
  for (const listener of [...listeners]) {
    try {
      listener(detail)
    } catch (error) {
      void error
    }
  }
}

/* ---------------------------------------------------------------------------
 * 请求核心
 * ------------------------------------------------------------------------- */

/** 拼接 API 地址（基址来自 env 的唯一读取点 `src/config/env.js`）。 */
export function apiUrl(path) {
  const base = String(API_BASE_URL || '').replace(/\/+$/, '')
  const tail = String(path || '').replace(/^\/+/, '')
  return `${base}/${tail}`
}

function reasonOf(status, payload) {
  if (payload && typeof payload.reason === 'string' && payload.reason !== '') return payload.reason
  return REASON_BY_STATUS[status] || 'HTTP_ERROR'
}

function messageOf(status, payload, reason) {
  if (payload && typeof payload.message === 'string' && payload.message !== '') return payload.message
  if (reason === LOCAL_REASON.NETWORK_ERROR) return '网络不可用：无法连接到服务端，请检查网络后重试。'
  if (reason === LOCAL_REASON.INVALID_RESPONSE) return `服务端响应不可解析（HTTP ${status}）。`
  return `请求失败（HTTP ${status}）。`
}

/**
 * 造结构化失败。`ok:false` 是**契约字段**（与服务端失败信封同形），
 * 其余为请求读数（页面可据此渲染可读失败态，也可直接复述服务端文案）。
 */
export function createApiError(options = {}) {
  const {
    status = 0, reason, payload = null, endpoint = '', method = 'GET', authed = false, cause = null,
  } = options
  const finalReason = reason || reasonOf(status, payload)
  const error = new Error(messageOf(status, payload, finalReason))
  error.name = 'ApiError'
  error.ok = false
  error.reason = finalReason
  error.code = finalReason
  error.httpStatus = status
  error.authed = Boolean(authed)
  error.sessionInvalid = Boolean(authed) && status === 401
  error.endpoint = endpoint
  error.method = method
  error.body = payload
  if (cause) error.cause = cause
  return error
}

/**
 * 发一个请求。
 *
 * @param {string} path 相对路径（如 `/auth/login`，拼接 `API_BASE_URL`）
 * @param {{method?:string, body?:object, authed?:boolean, fetchImpl?:Function}} [options]
 * @returns {Promise<{status:number, payload:object|null}>}
 */
export async function request(path, options = {}) {
  const {
    method = 'GET', body, authed = false, fetchImpl,
  } = options
  const url = apiUrl(path)
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (authed) {
    const token = sessionToken()
    if (!token) {
      const expired = new Error('登录状态已失效，请重新登录。')
      const error = createApiError({ status: 401, reason: 'SESSION_INVALID', endpoint: url, method, authed: true })
      error.message = expired.message
      error.localExpiry = true
      emitSessionExpired({ reason: 'SESSION_INVALID', serverReason: null, endpoint: url, method })
      throw error
    }
    headers.Authorization = `${SESSION_HEADER_SCHEME} ${token}`
  }

  const init = {
    method,
    headers,
    // 会话走 Authorization 头，不带 Cookie（跨域也不外发凭据）。
    credentials: 'omit',
    cache: 'no-store',
  }
  if (body !== undefined) init.body = JSON.stringify(body)

  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw createApiError({ status: 0, reason: LOCAL_REASON.NETWORK_ERROR, endpoint: url, method, authed })
  }

  let response = null
  try {
    response = await doFetch(url, init)
  } catch (cause) {
    throw createApiError({
      status: 0, reason: LOCAL_REASON.NETWORK_ERROR, endpoint: url, method, authed, cause,
    })
  }

  let payload = null
  let parseError = null
  try {
    payload = await response.json()
  } catch (cause) {
    parseError = cause
  }

  if (parseError || payload === null || typeof payload !== 'object') {
    if (response.status >= 200 && response.status < 300 && response.status === 204) {
      return { status: response.status, payload: { ok: true } }
    }
    throw createApiError({
      status: response.status, reason: LOCAL_REASON.INVALID_RESPONSE, endpoint: url, method, authed, cause: parseError,
    })
  }

  if (response.status >= 400 || payload.ok === false) {
    const error = createApiError({
      status: response.status, payload, endpoint: url, method, authed,
    })
    if (authed && response.status === 401) {
      clearSession()
      emitSessionExpired({
        reason: 'SESSION_INVALID', serverReason: error.reason, endpoint: url, method,
      })
    }
    throw error
  }

  return { status: response.status, payload }
}

/* ---------------------------------------------------------------------------
 * 账号投影归一（A2/A3/A4 共用）
 * ------------------------------------------------------------------------- */

/**
 * 服务端 user 投影 → 适配层 `User` 形状。
 *
 * 服务端字段面（B2 冻结）：`{ id, phone, email, role, status, createdAt, lastLoginAt }`。
 * 本层只做**改名**（`id` → `userId`）与**缺省显式化**：
 * 机构名 / 套餐档位等后端**没有**的字段一律 `null`（不造值 —— 造了就会在界面显示假机构名）。
 */
export function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') return null
  const userId = raw.id || raw.userId || null
  return {
    userId,
    id: userId,
    phone: raw.phone || null,
    email: raw.email || null,
    role: raw.role || 'user',
    status: raw.status || null,
    createdAt: raw.createdAt || null,
    lastLoginAt: raw.lastLoginAt || null,
    /** 后端账号体系无机构 / 套餐字段（B2 契约）：保持 null，页面按「—」展示。 */
    orgName: null,
    planId: null,
  }
}

/** 账号标识拆分：含 `@` ⇒ 邮箱，否则 ⇒ 手机号（服务端二选一，**手机号优先**）。 */
export function identifierOf(account) {
  const value = typeof account === 'string' ? account.trim() : ''
  if (!value) return {}
  if (value.includes('@')) return { email: value }
  return { phone: value }
}

/**
 * 注册（A2）。
 * @param {{phone?:string,email?:string,password:string}} input
 *   页面表单里的机构名 / 联系人等**后端不接收**的字段在此显式丢弃（不静默改语义：见 README 口径）。
 * @returns {Promise<{ok:true,user:object,session:object,sessionToken:string,expiresAt:string}>}
 */
export async function register(input = {}) {
  const password = input.password
  if (typeof password !== 'string' || password === '') {
    throw createApiError({
      status: 400, reason: 'INVALID_INPUT', endpoint: apiUrl('/auth/register'), method: 'POST',
      payload: { ok: false, reason: 'INVALID_INPUT', message: '口令不能为空。' },
    })
  }
  const body = { password }
  // 标识逐字透传（服务端自行归一化）；本层不 trim 口令，也不伪造缺失字段。
  if (typeof input.phone === 'string' && input.phone.trim() !== '') body.phone = input.phone
  if (typeof input.email === 'string' && input.email.trim() !== '') body.email = input.email
  if (body.phone === undefined && body.email === undefined) {
    throw createApiError({
      status: 400, reason: 'INVALID_INPUT', endpoint: apiUrl('/auth/register'), method: 'POST',
      payload: { ok: false, reason: 'INVALID_INPUT', message: '手机号与邮箱至少给一个。' },
    })
  }

  const { payload } = await request('/auth/register', { method: 'POST', body })
  const user = normalizeUser(payload.user)
  const session = payload.session || null
  if (session && session.token) {
    writeSession({ token: session.token, expires_at: session.expires_at, user })
  }
  return {
    ok: true,
    user,
    session,
    sessionToken: session ? session.token : '',
    expiresAt: session ? session.expires_at : null,
  }
}

/**
 * 登录（A3）。签名与 mock 实现一致：`login(account, password)`。
 * 口令**逐字**透传（不 trim）。
 */
export async function login(account, password) {
  const body = { password }
  const id = identifierOf(account)
  if (id.email) body.email = id.email
  if (id.phone) body.phone = id.phone
  if (body.phone === undefined && body.email === undefined) {
    throw createApiError({
      status: 400, reason: 'INVALID_INPUT', endpoint: apiUrl('/auth/login'), method: 'POST',
      payload: { ok: false, reason: 'INVALID_INPUT', message: '请输入账号（邮箱或手机号）。' },
    })
  }
  if (typeof password !== 'string' || password === '') {
    throw createApiError({
      status: 400, reason: 'INVALID_INPUT', endpoint: apiUrl('/auth/login'), method: 'POST',
      payload: { ok: false, reason: 'INVALID_INPUT', message: '请输入密码。' },
    })
  }

  const { payload } = await request('/auth/login', { method: 'POST', body })
  const user = normalizeUser(payload.user)
  const session = payload.session || null
  if (session && session.token) {
    writeSession({ token: session.token, expires_at: session.expires_at, user })
  }
  return {
    ok: true,
    user,
    session,
    sessionToken: session ? session.token : '',
    expiresAt: session ? session.expires_at : null,
  }
}

/**
 * 登出（A4）。服务端**不维护 jti 黑名单**（令牌无状态）⇒ 登出的实质动作就是**丢令牌**；
 * 因此无论服务端怎么答（含 401 已失效），本层都清掉本地会话并视为成功。
 */
export async function logout() {
  const token = sessionToken()
  if (!token) {
    clearSession()
    return true
  }
  try {
    await request('/auth/logout', { method: 'POST', authed: true })
  } catch (error) {
    // 401（令牌已失效 / 已登出）/ 网络不可达都算「已经登出」：本地照样丢令牌。
    void error
  } finally {
    clearSession()
  }
  return true
}

/**
 * 取当前会话用户（A4 `getSession`）。
 * 无令牌 / 本地已过期 ⇒ `null`（**不发请求**，并派发过期事件）；
 * 401 ⇒ 清会话后 `null`；其余失败（503 / 网络）**照常抛**，由调用方决定展示。
 */
export async function me() {
  const session = readSession()
  if (!session) return null
  if (isSessionExpired(session)) {
    clearSession()
    emitSessionExpired({
      reason: 'SESSION_INVALID', serverReason: 'EXPIRED_LOCALLY', endpoint: apiUrl('/me'), method: 'GET',
    })
    return null
  }
  try {
    const { payload } = await request('/me', { method: 'GET', authed: true })
    const user = normalizeUser(payload.user)
    if (user) {
      writeSession({ token: session.token, expires_at: session.expires_at, user })
    }
    return user
  } catch (error) {
    if (error && error.sessionInvalid) return null
    throw error
  }
}

/* ---------------------------------------------------------------------------
 * 失败面判定（页面只用这些谓词，不写字面量 —— 兼容服务端 reason 漂移）
 * ------------------------------------------------------------------------- */

/** 401：会话无效 / 登录凭据不通过（登录页与其它页语义不同，故判定后再分派文案）。 */
export function isAuthFailure(error) {
  if (!error) return false
  return error.sessionInvalid === true || error.httpStatus === 401
    || error.reason === 'UNAUTHORIZED' || error.reason === 'SESSION_INVALID'
}

/** 429：被限流。 */
export function isRateLimited(error) {
  return Boolean(error) && (error.reason === 'RATE_LIMITED' || error.httpStatus === 429)
}

/** 409：标识已存在（注册）。 */
export function isAlreadyExists(error) {
  return Boolean(error) && (error.reason === 'ALREADY_EXISTS' || error.httpStatus === 409)
}

/** 503：服务端未配置 / 存储不可用（fail-closed）。 */
export function isServiceUnavailable(error) {
  if (!error) return false
  return error.httpStatus === 503
    || REASON_ALIASES[error.reason] === 'CONFIG_MISSING'
}
