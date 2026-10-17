/**
 * 客户 API Key（印源自有集合 `yinyuan_api_keys`；**只读写本集合**）。
 *
 * ★ 行形（写死；字段名即落库名）：
 *      {
 *        _id:          'k-<sha256(明文).hex 前 16 位>',
 *        user_id:      'u-…',                       // 归属账号（users.js 的 id）
 *        label:        '<人读标签，≤64>',
 *        key_hash:     '<sha256(明文).hex，64 位小写>',
 *        prefix:       'yy_<明文前 8 位>',           // 只作界面辨识，**不足以校验**
 *        status:       'active' | 'revoked',
 *        created_at:   '<UTC ISO8601>',
 *        expires_at:   '<UTC ISO8601>' | null,      // B2：`ttl` 口径；null ＝ 不过期
 *        last_used_at: '<UTC ISO8601>' | null,
 *        call_count:   <整数>,
 *        revoked_at:   '<UTC ISO8601>' | null,
 *        rotated_from: '<旧 key id>' | null,
 *        rotated_to:   '<新 key id>' | null
 *      }
 *
 * ★ 明文口径：`yy_` + **32 字节 CSPRNG** 的 base64url（43 字符）＝ 46 字符。
 *   **明文只在 create / rotate 的返回值里出现这一次**；库内只有 `sha256(明文)`（不存明文、
 *   不存可逆变换）。⇒ 丢了的 key 只能重建，不能找回。
 *
 * ★ 校验口径：**按 `sha256(明文)` 等值查**（先查形态、再查库）；命中且 `status==='active'`
 *   才通行。撤销**只改状态、不删行**（保留审计与「为什么这把失效了」的判据）。
 *
 * ★ 失败结构化，reason 取值面：
 *      KEY_FORMAT_INVALID   不像本系统签发的 key（无库查询，直接拒）
 *      KEY_INVALID          查无此 key
 *      KEY_REVOKED          有这把、但已撤销/停用
 *      KEY_EXPIRED          有这把、但已过 `expires_at`（B2 新增：`ttl` 口径）
 *      KEY_NOT_ACTIVE       rotate 的目标不是 active
 *      NOT_FOUND            按 id 找不到
 *      INVALID_INPUT        创建参数不合法
 *      STORAGE_UNAVAILABLE  云库不可用（**调用方须 fail-closed**）
 *
 * ★ 注入式数据层同 `users.js`（CloudBase v3 实签名，自检用内存假 DB）。
 */
import { createHash, randomBytes } from 'node:crypto'

/** 集合名（**本模块唯一可触达的集合**）。 */
export const COLLECTION = 'yinyuan_api_keys'

/** 明文前缀（同时是形态判据的第一道）。 */
export const KEY_PREFIX = 'yy_'

/** 随机部分字节数（32 字节 = 256 bit）。 */
export const KEY_RANDOM_BYTES = 32

/** 明文总长度上限（形态校验用；实际恒为 46）。 */
const KEY_MAX_LENGTH = 200

/** `prefix` 字段里保留的明文字符数（`yy_` 之后）。 */
const PREFIX_KEEP = 8

/** 单账号列表上限（避免无界读）。 */
export const LIST_LIMIT = 200

/** key 有效期口径（B2）：最短 60 秒、最长 365 天；`ttl` 缺省 ⇒ 不过期。 */
export const MIN_KEY_TTL_SECONDS = 60
export const MAX_KEY_TTL_SECONDS = 365 * 24 * 60 * 60

export const REASONS = Object.freeze({
  KEY_FORMAT_INVALID: 'KEY_FORMAT_INVALID',
  KEY_INVALID: 'KEY_INVALID',
  KEY_REVOKED: 'KEY_REVOKED',
  KEY_EXPIRED: 'KEY_EXPIRED',
  KEY_NOT_ACTIVE: 'KEY_NOT_ACTIVE',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE'
})

/* ── 摘要 / 形态 ───────────────────────────────────────────────── */

/** `sha256(明文)` 的十六进制摘要（**唯一入库形态**）。 */
export function keyHashOf(plain) {
  return createHash('sha256').update(String(plain), 'utf8').digest('hex')
}

/** 明文形态是否像本系统签发的 key（不查库）。 */
export function isKeyShaped(plain) {
  if (typeof plain !== 'string') return false
  if (plain.length <= KEY_PREFIX.length || plain.length > KEY_MAX_LENGTH) return false
  if (!plain.startsWith(KEY_PREFIX)) return false
  return /^[A-Za-z0-9_-]+$/.test(plain.slice(KEY_PREFIX.length))
}

/** 展示前缀（`yy_` + 明文前 8 位）；明文过短 ⇒ 整串（仅形式兜底）。 */
function prefixOf(plain) {
  return plain.slice(0, KEY_PREFIX.length + PREFIX_KEEP)
}

function nowIso(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

function isFailedResult(result) {
  return !result || (typeof result.code === 'string' && result.code !== '')
}

function describeStorageError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error || '')
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 160)
}

function storageFailure(where, error) {
  console.error(`[api] apiKeys ${where} failed: ${describeStorageError(error)}`)
  return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE }
}

/* ── 对外投影（**永不回明文 / key_hash**） ───────────────────────── */

export function toPublicKey(row) {
  if (!row || typeof row !== 'object') return null
  return {
    id: row._id || null,
    prefix: row.prefix || null,
    label: row.label || null,
    status: row.status || 'active',
    createdAt: row.created_at || null,
    expiresAt: row.expires_at || null,
    lastUsedAt: row.last_used_at || null,
    callCount: typeof row.call_count === 'number' ? row.call_count : 0,
    revokedAt: row.revoked_at || null,
    rotatedFrom: row.rotated_from || null,
    rotatedTo: row.rotated_to || null
  }
}

/* ── 读面 ──────────────────────────────────────────────────────── */

async function getById(db, keyId) {
  try {
    const result = await db.collection(COLLECTION).doc(keyId).get()
    if (isFailedResult(result)) throw new Error(result.message || 'get failed')
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : []
    return { ok: true, row: rows.length > 0 ? rows[0] : null }
  } catch (error) {
    return storageFailure('getById', error)
  }
}

/* ── 写面 ──────────────────────────────────────────────────────── */

/**
 * 铸一把新 key。**明文只在此返回值里出现这一次。**
 * @param {object} db CloudBase database 句柄
 * @param {{userId:string, label?:string, now?:number|string|Date, rotatedFrom?:string}} input
 * @returns {Promise<{ok:true, plain:string, key:object}|{ok:false, reason:string}>}
 */
export async function create(db, input) {
  const userId = input && typeof input.userId === 'string' ? input.userId.trim() : ''
  if (userId === '' || userId.length > 128) return { ok: false, reason: REASONS.INVALID_INPUT }
  const rawLabel = input && input.label !== undefined && input.label !== null ? String(input.label) : ''
  const label = (rawLabel.trim() || '默认密钥').slice(0, 64)

  // ★ 有效期（B2 `ttl` 口径）：缺省 null ＝ 不过期；给了就必须是 [60s, 365d] 的整数秒。
  let expiresAt = null
  const rawTtl = input && input.ttlSeconds
  if (rawTtl !== undefined && rawTtl !== null) {
    const ttl = Math.floor(Number(rawTtl))
    if (!Number.isFinite(ttl) || ttl < MIN_KEY_TTL_SECONDS || ttl > MAX_KEY_TTL_SECONDS) {
      return { ok: false, reason: REASONS.INVALID_INPUT }
    }
    expiresAt = new Date(new Date(nowIso(input && input.now)).getTime() + ttl * 1000).toISOString()
  }

  // 32 字节随机 ⇒ id 冲突概率可忽略；仍给 2 次重铸，避免把极小概率当异常
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plain = `${KEY_PREFIX}${randomBytes(KEY_RANDOM_BYTES).toString('base64url')}`
    const keyHash = keyHashOf(plain)
    const keyId = `k-${keyHash.slice(0, 16)}`
    const row = {
      user_id: userId,
      label,
      key_hash: keyHash,
      prefix: prefixOf(plain),
      status: 'active',
      created_at: nowIso(input && input.now),
      expires_at: expiresAt,
      last_used_at: null,
      call_count: 0,
      revoked_at: null,
      rotated_from: input && input.rotatedFrom ? String(input.rotatedFrom) : null,
      rotated_to: null
    }
    try {
      const result = await db.collection(COLLECTION).doc(keyId).create(row)
      if (isFailedResult(result)) {
        const message = String(result.message || '')
        if (/exist|duplicate|重复|已存在/i.test(message) || /DUPLICATE/i.test(String(result.code))) {
          continue
        }
        throw new Error(message || 'create failed')
      }
      return { ok: true, plain, key: toPublicKey({ _id: keyId, ...row }) }
    } catch (error) {
      const message = describeStorageError(error)
      if (/exist|duplicate|重复|已存在/i.test(message)) continue
      return storageFailure('create', error)
    }
  }
  return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE }
}

/**
 * 校验明文 key。**只认 `status:'active'`**。
 * @returns {Promise<{ok:true, userId:string, keyId:string}|{ok:false, reason:string}>}
 */
export async function verifyKey(db, plain) {
  if (!isKeyShaped(plain)) return { ok: false, reason: REASONS.KEY_FORMAT_INVALID }
  const keyHash = keyHashOf(plain)
  try {
    const result = await db.collection(COLLECTION).where({ key_hash: keyHash }).limit(1).get()
    if (isFailedResult(result)) throw new Error(result.message || 'query failed')
    const rows = Array.isArray(result.data) ? result.data : []
    if (rows.length === 0) return { ok: false, reason: REASONS.KEY_INVALID }
    const row = rows[0]
    if (!row || typeof row.user_id !== 'string' || row.user_id === '') {
      return { ok: false, reason: REASONS.KEY_INVALID }
    }
    if (row.status !== 'active') return { ok: false, reason: REASONS.KEY_REVOKED }
    // ★ 有效期（B2）：`expires_at` 缺省/为空 ＝ 不过期；过期按「已撤销」同形拒（不区分原因给调用方）
    if (row.expires_at) {
      const expiresMs = Date.parse(String(row.expires_at))
      if (Number.isFinite(expiresMs) && Date.now() > expiresMs) {
        return { ok: false, reason: REASONS.KEY_EXPIRED }
      }
    }
    return { ok: true, userId: row.user_id, keyId: row._id || null }
  } catch (error) {
    return storageFailure('verifyKey', error)
  }
}

/**
 * 列出某账号的 key（**永不回明文 / hash**；按 `created_at` 倒序）。
 * @returns {Promise<{ok:true, keys:object[]}|{ok:false, reason:string}>}
 */
export async function listByUser(db, userId) {
  if (typeof userId !== 'string' || userId === '') {
    return { ok: false, reason: REASONS.INVALID_INPUT }
  }
  try {
    const result = await db.collection(COLLECTION).where({ user_id: userId }).limit(LIST_LIMIT).get()
    if (isFailedResult(result)) throw new Error(result.message || 'query failed')
    const rows = Array.isArray(result.data) ? result.data : []
    const keys = rows
      .map(toPublicKey)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    if (rows.length >= LIST_LIMIT) {
      console.warn(`[api] apiKeys list truncated at ${LIST_LIMIT} for one user`)
    }
    return { ok: true, keys }
  } catch (error) {
    return storageFailure('listByUser', error)
  }
}

/** 撤销（**只改状态、不删行**；重复撤销幂等）。 */
export async function revoke(db, keyId, now) {
  if (typeof keyId !== 'string' || keyId === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  const current = await getById(db, keyId)
  if (!current.ok) return current
  if (!current.row) return { ok: false, reason: REASONS.NOT_FOUND }
  if (current.row.status === 'revoked') {
    return { ok: true, key: toPublicKey(current.row), alreadyRevoked: true }
  }
  const stamp = nowIso(now)
  try {
    const result = await db
      .collection(COLLECTION)
      .doc(keyId)
      .update({ status: 'revoked', revoked_at: stamp })
    if (isFailedResult(result)) throw new Error(result.message || 'update failed')
    return { ok: true, key: toPublicKey({ ...current.row, status: 'revoked', revoked_at: stamp }) }
  } catch (error) {
    return storageFailure('revoke', error)
  }
}

/**
 * 轮换：**先铸新、后撤旧**（不出现「零可用 key」窗口），旧行**不删**，双向留痕。
 * @returns {Promise<{ok:true, plain:string, key:object, revokedId:string, revoked:boolean}|{ok:false, reason:string}>}
 */
export async function rotate(db, keyId, options = {}) {
  if (typeof keyId !== 'string' || keyId === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  const current = await getById(db, keyId)
  if (!current.ok) return current
  if (!current.row) return { ok: false, reason: REASONS.NOT_FOUND }
  if (current.row.status !== 'active') return { ok: false, reason: REASONS.KEY_NOT_ACTIVE }

  const created = await create(db, {
    userId: current.row.user_id,
    label: options.label !== undefined ? options.label : current.row.label,
    now: options.now,
    rotatedFrom: keyId
  })
  if (!created.ok) return created

  const stamp = nowIso(options.now)
  let revoked = false
  try {
    const result = await db
      .collection(COLLECTION)
      .doc(keyId)
      .update({ status: 'revoked', revoked_at: stamp, rotated_to: created.key.id })
    if (isFailedResult(result)) throw new Error(result.message || 'update failed')
    revoked = true
  } catch (error) {
    // 新 key 已铸成（明文不可回滚）⇒ 不把整次轮换判失败，如实回报「旧 key 未撤成」供上层重试
    console.error(`[api] apiKeys rotate revoke-old failed: ${describeStorageError(error)}`)
  }
  return { ok: true, plain: created.plain, key: created.key, revokedId: keyId, revoked }
}

/**
 * 归属查询（B2 授权面）：只回 `user_id`，**不回 key_hash / 明文**。
 * 找不到 ⇒ `{ok:true, userId:''}`（调用方按 `404 NOT_FOUND` 处理，避免泄露存在性）。
 * @returns {Promise<{ok:true, keyId:string, userId:string}|{ok:false, reason:string}>}
 */
export async function ownerOf(db, keyId) {
  if (typeof keyId !== 'string' || keyId === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  const current = await getById(db, keyId)
  if (!current.ok) return current
  if (!current.row) return { ok: true, keyId, userId: '' }
  return { ok: true, keyId, userId: String(current.row.user_id || '') }
}

/**
 * 改状态（B2 `PATCH /keys/{kid}`：`active` ⇄ `revoked`；**只改状态、不删行**）。
 * `revoked` 走 `revoke()`（幂等）；`active` 只清 `revoked_at`，保留 `rotated_*` 审计痕迹。
 * @returns {Promise<{ok:true, key:object, unchanged?:boolean}|{ok:false, reason:string}>}
 */
export async function setKeyStatus(db, keyId, status, now) {
  if (typeof keyId !== 'string' || keyId === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  const wanted = String(status)
  if (wanted !== 'active' && wanted !== 'revoked') return { ok: false, reason: REASONS.INVALID_INPUT }
  if (wanted === 'revoked') return revoke(db, keyId, now)

  const current = await getById(db, keyId)
  if (!current.ok) return current
  if (!current.row) return { ok: false, reason: REASONS.NOT_FOUND }
  if (current.row.status === 'active') {
    return { ok: true, key: toPublicKey(current.row), unchanged: true }
  }
  try {
    const result = await db.collection(COLLECTION).doc(keyId).update({ status: 'active', revoked_at: null })
    if (isFailedResult(result)) throw new Error(result.message || 'update failed')
    return { ok: true, key: toPublicKey({ ...current.row, status: 'active', revoked_at: null }) }
  } catch (error) {
    return storageFailure('setKeyStatus', error)
  }
}

/**
 * 记一次使用（`last_used_at` + `call_count++`）。
 * **best-effort：永不抛、永不阻塞主路径**（调用方 `void touch(...)` 即可）。
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function touch(db, keyId, options = {}) {
  if (typeof keyId !== 'string' || keyId === '') return { ok: false, reason: REASONS.INVALID_INPUT }
  const stamp = nowIso(options.now)
  try {
    const command = db && db.command
    const patch =
      command && typeof command.inc === 'function'
        ? { last_used_at: stamp, call_count: command.inc(1) }
        : { last_used_at: stamp }
    const result = await db.collection(COLLECTION).doc(keyId).update(patch)
    if (isFailedResult(result)) throw new Error(result.message || 'update failed')
    return { ok: true }
  } catch (error) {
    // 使用计数不参与鉴权判定 ⇒ 失败只留一行日志
    console.warn(`[api] apiKeys touch skipped: ${describeStorageError(error)}`)
    return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE }
  }
}
