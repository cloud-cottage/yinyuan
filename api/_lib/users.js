/**
 * 客户账号（印源自有账号表 `yinyuan_users`；**只读写本集合**）。
 *
 * ★ 行形（写死；字段名即落库名）：
 *      {
 *        _id:            'u-<sha256(归一化标识).hex 前 16 位>',
 *        phone?:         '<归一化手机号>',      // 与 email 至少有一个
 *        email?:         '<归一化邮箱>',
 *        password_hash:  { v, algo, N, r, p, keylen, hash, salt },   // passwordHash.js 的产物，**不是明文**
 *        role:           'user' | 'admin',
 *        status:         'active' | 'disabled',
 *        created_at:     '<UTC ISO8601>',
 *        last_login_at:  '<UTC ISO8601>' | null,
 *        status_updated_at?: '<UTC ISO8601>'
 *      }
 *
 * ★ 归一化口径（写死，改即改派生 id）：
 *   手机号  trim → 去掉全部空白与 `-` `(` `)` → 去掉**首个** `+` → 必须为 6~20 位纯数字
 *   邮箱    trim → `toLowerCase()` → 必须形如 `x@y.z`（长度 ≤254）
 *   —— **不剥国家码**（`+86` / `86` 前缀）：静默改写会把两个不同账号并成一行。
 *   —— 标识取**手机号优先**：两者都给时，id 由手机号派生（邮箱只作查找别名）。
 *
 * ★ 与 xiai 的关系：**同精神、独立命名空间** —— id 形态同为 `u-` + sha256 前 16 位十六进制，
 *   但本模块**只碰 `yinyuan_users`**，绝不读写 xiai 的任何集合（`xiai_persons` 等）。
 *
 * ★ 失败一律结构化 `{ok:false, reason}`，reason 取值面：
 *      INVALID_INPUT       参数/标识形态不合法
 *      ALREADY_EXISTS      该标识已注册（不返回既有行，避免借注册探测账号存在性之外的信息）
 *      NOT_FOUND           按 id / role 变更时目标不存在
 *      STORAGE_UNAVAILABLE 云库不可用（**调用方须 fail-closed**，不得当成「账号不存在」）
 *
 * ★ 注入式数据层：所有函数首参是 `db`（CloudBase database 句柄，`getDb()` 的返回值）。
 *   用到的方法面极小且与 `@cloudbase/node-sdk` v3 实签名一致：
 *     db.collection(name).where(obj).limit(n).get()   -> { data: [...] }
 *     db.collection(name).doc(id).create(obj)          -> { id }        （已存在 ⇒ 报错）
 *     db.collection(name).doc(id).get()                -> { data: [...] }
 *     db.collection(name).doc(id).update(obj)          -> { updated }
 *   自检脚本用内存假 DB 实现同一面，不连云库。
 */
import { createHash } from 'node:crypto'
import { checkPasswordPolicy, hashPassword } from './passwordHash.js'

/** 集合名（**本模块唯一可触达的集合**）。 */
export const COLLECTION = 'yinyuan_users'

/** id 前缀（与 xiai `uidOf` 同形态、不同库）。 */
export const ID_PREFIX = 'u-'

/** 摘要取前多少位十六进制字符（16 hex = 64 bit，碰撞面在账号量级内可忽略）。 */
export const ID_HEX_LENGTH = 16

/** 角色取值面（授权语义属路由面，本模块只保证取值封闭）。 */
export const ROLES = Object.freeze(['user', 'admin'])

/** 状态取值面。 */
export const STATUSES = Object.freeze(['active', 'disabled'])

export const REASONS = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  NOT_FOUND: 'NOT_FOUND',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE'
})

/* ── 归一化 ─────────────────────────────────────────────────────── */

/** 手机号归一化；不合法 ⇒ ''（不抛）。 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return ''
  let value = raw.trim().replace(/[\s\-()]/g, '')
  if (value.startsWith('+')) value = value.slice(1)
  if (!/^\d{6,20}$/.test(value)) return ''
  return value
}

/** 邮箱归一化（小写）；不合法 ⇒ ''。 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().toLowerCase()
  if (value.length === 0 || value.length > 254) return ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return ''
  return value
}

/** 由归一化标识派生 id；两侧都无有效标识 ⇒ ''。 */
export function userIdOf({ phone, email } = {}) {
  const canonical = normalizePhone(phone) || normalizeEmail(email)
  if (canonical === '') return ''
  return `${ID_PREFIX}${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, ID_HEX_LENGTH)}`
}

/* ── 内部工具 ───────────────────────────────────────────────────── */

function nowIso(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

/** SDK 可能「回错误码而不抛」（throwOnCode 取决配置）⇒ 两种形态都要当失败。 */
function isFailedResult(result) {
  return !result || (typeof result.code === 'string' && result.code !== '')
}

function describeStorageError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error || '')
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 160)
}

function storageFailure(where, error) {
  // 只记「哪一步 + 摘要」；不含手机号 / 邮箱 / 口令 / 云库凭据
  console.error(`[api] users ${where} failed: ${describeStorageError(error)}`)
  return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE }
}

async function queryOne(db, where, whereLabel) {
  try {
    const result = await db.collection(COLLECTION).where(where).limit(1).get()
    if (isFailedResult(result)) throw new Error(result.message || 'query failed')
    const rows = Array.isArray(result.data) ? result.data : []
    return { ok: true, user: rows.length > 0 ? rows[0] : null }
  } catch (error) {
    return storageFailure(whereLabel, error)
  }
}

async function getById(db, id) {
  try {
    const result = await db.collection(COLLECTION).doc(id).get()
    if (isFailedResult(result)) throw new Error(result.message || 'get failed')
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : []
    return { ok: true, user: rows.length > 0 ? rows[0] : null }
  } catch (error) {
    return storageFailure('getById', error)
  }
}

/* ── 对外投影（**永不回 password_hash**） ─────────────────────────── */

export function toPublicUser(row) {
  if (!row || typeof row !== 'object') return null
  return {
    id: row._id || null,
    phone: row.phone || null,
    email: row.email || null,
    role: row.role || 'user',
    status: row.status || 'active',
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null
  }
}

/* ── CRUD ───────────────────────────────────────────────────────── */

/**
 * 建账号（口令在此处散列，**明文不入行**）。
 * @param {object} db CloudBase database 句柄
 * @param {{phone?:string, email?:string, password:string, role?:string, status?:string,
 *          now?:number|string|Date}} input
 * @returns {Promise<{ok:true, user:object}|{ok:false, reason:string}>}
 */
export async function create(db, input) {
  const { phone, email, password } = input || {}
  const normalizedPhone = phone === undefined || phone === null ? '' : normalizePhone(phone)
  const normalizedEmail = email === undefined || email === null ? '' : normalizeEmail(email)
  if (phone !== undefined && phone !== null && normalizedPhone === '') {
    return { ok: false, reason: REASONS.INVALID_INPUT }
  }
  if (email !== undefined && email !== null && normalizedEmail === '') {
    return { ok: false, reason: REASONS.INVALID_INPUT }
  }
  if (normalizedPhone === '' && normalizedEmail === '') {
    return { ok: false, reason: REASONS.INVALID_INPUT }
  }
  const policy = checkPasswordPolicy(password)
  if (!policy.ok) return { ok: false, reason: REASONS.INVALID_INPUT }

  const role = input && input.role !== undefined ? String(input.role) : 'user'
  if (!ROLES.includes(role)) return { ok: false, reason: REASONS.INVALID_INPUT }
  const status = input && input.status !== undefined ? String(input.status) : 'active'
  if (!STATUSES.includes(status)) return { ok: false, reason: REASONS.INVALID_INPUT }

  const id = userIdOf({ phone: normalizedPhone, email: normalizedEmail })
  if (id === '') return { ok: false, reason: REASONS.INVALID_INPUT }

  let stored = null
  try {
    stored = await hashPassword(password)
  } catch (error) {
    return storageFailure('hashPassword', error)
  }

  const row = {
    phone: normalizedPhone || undefined,
    email: normalizedEmail || undefined,
    password_hash: stored,
    role,
    status,
    created_at: nowIso(input && input.now),
    last_login_at: null
  }
  if (row.phone === undefined) delete row.phone
  if (row.email === undefined) delete row.email

  try {
    const result = await db.collection(COLLECTION).doc(id).create(row)
    if (isFailedResult(result)) {
      // 已存在（唯一 _id 冲突）与其它写失败要分开：前者是业务冲突，后者是存储问题
      const message = String(result.message || '')
      if (/exist|duplicate|重复|已存在/i.test(message) || /DUPLICATE/i.test(String(result.code))) {
        return { ok: false, reason: REASONS.ALREADY_EXISTS }
      }
      throw new Error(message || 'create failed')
    }
    return { ok: true, user: toPublicUser({ _id: id, ...row }) }
  } catch (error) {
    const message = describeStorageError(error)
    if (/exist|duplicate|重复|已存在/i.test(message)) {
      return { ok: false, reason: REASONS.ALREADY_EXISTS }
    }
    return storageFailure('create', error)
  }
}

/** 按 id 取行（**含 password_hash**：仅供服务端登录流程使用）。 */
export async function findById(db, id) {
  if (typeof id !== 'string' || id === '') return { ok: true, user: null }
  return getById(db, id)
}

/** 按手机号取行（内部先归一化；含 password_hash）。 */
export async function findByPhone(db, phone) {
  const normalized = normalizePhone(phone)
  if (normalized === '') return { ok: true, user: null }
  return queryOne(db, { phone: normalized }, 'findByPhone')
}

/** 按邮箱取行（内部先归一化；含 password_hash）。 */
export async function findByEmail(db, email) {
  const normalized = normalizeEmail(email)
  if (normalized === '') return { ok: true, user: null }
  return queryOne(db, { email: normalized }, 'findByEmail')
}

/** 记一次成功登录时刻。 */
export async function updateLastLogin(db, id, now) {
  if (typeof id !== 'string' || id === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  try {
    const result = await db.collection(COLLECTION).doc(id).update({ last_login_at: nowIso(now) })
    if (isFailedResult(result)) throw new Error(result.message || 'update failed')
    return { ok: true, lastLoginAt: nowIso(now) }
  } catch (error) {
    return storageFailure('updateLastLogin', error)
  }
}

/** 改状态（`active` / `disabled`；停用即时生效于**新签发**，既有令牌靠路由层复核 status）。 */
export async function setStatus(db, id, status, now) {
  if (typeof id !== 'string' || id === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  if (!STATUSES.includes(String(status))) return { ok: false, reason: REASONS.INVALID_INPUT }
  const stamp = nowIso(now)
  try {
    const result = await db
      .collection(COLLECTION)
      .doc(id)
      .update({ status: String(status), status_updated_at: stamp })
    if (isFailedResult(result)) throw new Error(result.message || 'update failed')
    return { ok: true, status: String(status), statusUpdatedAt: stamp }
  } catch (error) {
    return storageFailure('setStatus', error)
  }
}
