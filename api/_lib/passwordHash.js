/**
 * 口令散列（印源客户账号内核；**只用 node:crypto，零第三方依赖**）。
 *
 * ★ 口径（本文件头写死，改口径＝改本文件并同轮升版本号）：
 *   算法      scrypt（Node 内置 `crypto.scrypt`，RFC 7914）
 *   参数      N=16384 / r=8 / p=1（≈16 MiB 内存，单次派生在本机毫秒级）
 *   密钥长度  64 字节
 *   盐        16 字节，`crypto.randomBytes` 逐次随机（同一口令两次散列必不同）
 *   编码      `hash` / `salt` 一律 **base64url（无填充、规范形态）**，不落 hex
 *   落库形态  { v:1, algo:'scrypt', N, r, p, keylen, hash, salt }
 *   —— 明文口令**永不**入行、入日志、入响应；本模块也不回显输入。
 *
 * ★ 两处刻意的取舍：
 *   ① **不做任何归一化 / 变形**（不 trim、不 NFKC、不大小写折叠）—— 口令按调用方给出的
 *      UTF-8 字节**逐字节**参与派生。归一化会在用户不知情时改写口令，且令「同口令不同输入」
 *      在不同实现间不可复现。长度/空白校验放在 `checkPasswordPolicy`，由调用方显式判。
 *   ② **校验侧先验参再派生**：`stored.N/r/p/keylen` 来自库内行，一旦被写入超大值
 *      就是一次内存/CPU 拒绝服务。⇒ 先把参数钳进白名单区间，非法即当场拒，不进 scrypt。
 *
 * ★ 失败一律**结构化**（不抛未捕获异常）：`{ok:false, reason}`，`reason` 取值面封闭：
 *      PASSWORD_MISMATCH   口令不匹配（对外只应说「账号或口令不正确」）
 *      STORED_INVALID      落库记录形态/参数不合法（服务端数据问题，不是用户输错）
 *      INPUT_INVALID       调用方给的输入不是字符串 / 口令超长
 *      CRYPTO_UNAVAILABLE  派生本身失败（运行时问题）
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/** 算法标识（进库内行；换算法时**不得**复用本值）。 */
export const ALGO = 'scrypt'

/** 派生参数（现行口径）。 */
export const PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 })

/** 盐长度（字节）。 */
export const SALT_BYTES = 16

/** 口令长度口径（按 UTF-16 码元计，**不做 trim**）。 */
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128

/** scrypt 内存上限：N=16384,r=8 ⇒ 实际需 16 MiB，给 64 MiB 留出 r/p 调整余量。 */
const MAXMEM = 64 * 1024 * 1024

/** 校验侧接受的参数白名单区间（防「落库被写成大 N」型 DoS）。 */
const PARAM_BOUNDS = Object.freeze({
  N_MIN: 1024,
  N_MAX: 1 << 20,
  R_MIN: 1,
  R_MAX: 32,
  P_MIN: 1,
  P_MAX: 16,
  KEYLEN_MIN: 16,
  KEYLEN_MAX: 128
})

export const REASONS = Object.freeze({
  PASSWORD_MISMATCH: 'PASSWORD_MISMATCH',
  STORED_INVALID: 'STORED_INVALID',
  INPUT_INVALID: 'INPUT_INVALID',
  CRYPTO_UNAVAILABLE: 'CRYPTO_UNAVAILABLE'
})

/** base64url（无 `=` 填充）编码。 */
function encodeBase64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 严格 base64url 解码：非规范形态（含 `+` `/` `=`、非法字符、长度 %4==1、
 * 或**重编码不等于原文**）一律返回 null。理由：宽松解码会让同一字节串有多种写法，
 * 使「令牌/摘要逐字相等」这类判据失效。
 */
function decodeBase64urlStrict(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null
  if (segment.length % 4 === 1) return null
  const buffer = Buffer.from(segment, 'base64url')
  if (encodeBase64url(buffer) !== segment) return null
  return buffer
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

/** 落库参数是否落在白名单区间（并在 N 上要求 2 的幂 —— scrypt 的硬要求）。 */
function paramsAreSane({ N, r, p, keylen }) {
  if (!isInt(N) || !isInt(r) || !isInt(p) || !isInt(keylen)) return false
  if (N < PARAM_BOUNDS.N_MIN || N > PARAM_BOUNDS.N_MAX) return false
  if ((N & (N - 1)) !== 0) return false
  if (r < PARAM_BOUNDS.R_MIN || r > PARAM_BOUNDS.R_MAX) return false
  if (p < PARAM_BOUNDS.P_MIN || p > PARAM_BOUNDS.P_MAX) return false
  if (keylen < PARAM_BOUNDS.KEYLEN_MIN || keylen > PARAM_BOUNDS.KEYLEN_MAX) return false
  return true
}

function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey))
    )
  })
}

/**
 * 口令强度/长度体检（**由调用方在散列前显式调用**；本模块不做隐式 trim）。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkPasswordPolicy(password) {
  if (typeof password !== 'string') {
    return { ok: false, reason: REASONS.INPUT_INVALID }
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: REASONS.INPUT_INVALID }
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: REASONS.INPUT_INVALID }
  }
  return { ok: true }
}

/**
 * 散列口令 ⇒ 可直接落库的记录（**不含明文**）。
 *
 * 输入不合法（非字符串 / 超出长度口径）时抛 `TypeError` / `RangeError` —— 这属**调用方
 * 编程错误**（用户输入必须先过 `checkPasswordPolicy`），不是运行期失败面；派生本身失败
 * 抛 `Error`（带 `code='CRYPTO_UNAVAILABLE'`）。
 *
 * @param {string} password 明文口令（逐字节 UTF-8）
 * @param {{N?:number, r?:number, p?:number, keylen?:number}} [overrides] 仅测试/迁移用
 * @returns {Promise<{v:1, algo:string, N:number, r:number, p:number, keylen:number, hash:string, salt:string}>}
 */
export async function hashPassword(password, overrides = {}) {
  const policy = checkPasswordPolicy(password)
  if (!policy.ok) throw new TypeError('password rejected by policy')
  const params = {
    N: isInt(overrides.N) ? overrides.N : PARAMS.N,
    r: isInt(overrides.r) ? overrides.r : PARAMS.r,
    p: isInt(overrides.p) ? overrides.p : PARAMS.p,
    keylen: isInt(overrides.keylen) ? overrides.keylen : PARAMS.keylen
  }
  if (!paramsAreSane(params)) throw new RangeError('scrypt params out of bounds')
  const salt = randomBytes(SALT_BYTES)
  let derived = null
  try {
    derived = await scryptAsync(password, salt, params.keylen, params)
  } catch (error) {
    const wrapped = new Error('password hash failed')
    wrapped.code = REASONS.CRYPTO_UNAVAILABLE
    throw wrapped
  }
  return {
    v: 1,
    algo: ALGO,
    N: params.N,
    r: params.r,
    p: params.p,
    keylen: params.keylen,
    hash: encodeBase64url(derived),
    salt: encodeBase64url(salt)
  }
}

/**
 * 校验口令（**带内部判别码**，供服务端日志用；对外一律折算成 `false`）。
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function verifyPasswordDetailed(password, stored) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, reason: REASONS.INPUT_INVALID }
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: REASONS.INPUT_INVALID }
  }
  if (!stored || typeof stored !== 'object') {
    return { ok: false, reason: REASONS.STORED_INVALID }
  }
  if (stored.algo !== ALGO) return { ok: false, reason: REASONS.STORED_INVALID }
  const params = {
    N: stored.N,
    r: stored.r,
    p: stored.p,
    keylen: stored.keylen
  }
  if (!paramsAreSane(params)) return { ok: false, reason: REASONS.STORED_INVALID }
  const salt = decodeBase64urlStrict(stored.salt)
  const expected = decodeBase64urlStrict(stored.hash)
  if (salt === null || expected === null) return { ok: false, reason: REASONS.STORED_INVALID }
  // 摘要长度必须与声明一致（否则 timingSafeEqual 会因长度不等而无法比较）
  if (expected.length !== params.keylen) return { ok: false, reason: REASONS.STORED_INVALID }
  let derived = null
  try {
    derived = await scryptAsync(password, salt, params.keylen, params)
  } catch (error) {
    return { ok: false, reason: REASONS.CRYPTO_UNAVAILABLE }
  }
  if (derived.length !== expected.length) return { ok: false, reason: REASONS.STORED_INVALID }
  // 定长比较：不短路、不泄漏「哪一位不同」
  if (!timingSafeEqual(derived, expected)) return { ok: false, reason: REASONS.PASSWORD_MISMATCH }
  return { ok: true }
}

/**
 * 校验口令 ⇒ 布尔（对外契约）。
 * 任何形态问题（记录被改坏 / 输入非字符串）都返回 false，**绝不抛**。
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const result = await verifyPasswordDetailed(password, stored)
  return result.ok === true
}

/** 落库参数是否与现行口径不同（历史行在下次成功登录时可静默重散列）。 */
export function needsRehash(stored) {
  if (!stored || typeof stored !== 'object') return true
  if (stored.algo !== ALGO) return true
  return (
    stored.N !== PARAMS.N ||
    stored.r !== PARAMS.r ||
    stored.p !== PARAMS.p ||
    stored.keylen !== PARAMS.keylen
  )
}

/** 契约别名（`hash` / `verify`）。 */
export { hashPassword as hash, verifyPassword as verify }
