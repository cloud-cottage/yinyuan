/**
 * 印源客户账号内核自检（**内存假 DB，不连云库、不读生产数据**）。
 *
 * 覆盖：
 *   1) passwordHash：散列形态 / 正确与错误口令 / 盐随机 / 篡改与非法记录 / 参数白名单 / 口令政策
 *   2) session：签验往返 / 默认 7 天 TTL / 篡改 / 过期 / 未生效 / 缺密钥与短密钥 / 严格 base64url
 *   3) users：create / findById / findByPhone / findByEmail / 归一化 / 重复注册 / 状态与登录时刻 / 存储不可用
 *   4) apiKeys：创建（明文只回一次）/ 校验 / 禁用后拒 / 轮换后旧 key 失效 / 列表不回敏感值 / touch
 *   5) auth：env 通道仍过 / DB 通道过 / 都不匹配拒 / 缺凭据 / 缺 env 且 DB 不可用 ⇒ fail-closed
 *
 * 跑法：node scripts/verify-yinyuan-auth-core.mjs   （退出码 0 ＝ 全绿）
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  PARAMS,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyPasswordDetailed
} from '../api/_lib/passwordHash.js'
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  isSessionConfigured,
  signSession,
  verifySession
} from '../api/_lib/session.js'
import * as users from '../api/_lib/users.js'
import * as apiKeys from '../api/_lib/apiKeys.js'
import { AUTH_VIA, checkApiKey, checkApiKeyAsync } from '../api/_lib/auth.js'

/* ── 断言小工具（不引第三方） ─────────────────────────────────────── */

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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 内存假 DB（实现 users.js / apiKeys.js 用到的那一小片 CloudBase v3 面） ── */

function createFakeDb() {
  const collections = new Map()
  const state = {
    collections,
    failing: false,
    setFailing(value) {
      state.failing = Boolean(value)
    }
  }

  function guard() {
    if (state.failing) {
      const error = new Error('simulated cloudbase failure')
      error.code = 'ETIMEDOUT'
      throw error
    }
  }

  function ensure(name) {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }

  function matches(row, where) {
    return Object.entries(where).every(([key, value]) => row[key] === value)
  }

  const db = {
    command: { inc: (value) => ({ __op: 'inc', value }) },
    collection(name) {
      const docs = ensure(name)
      return {
        where(condition) {
          let limit = Number.POSITIVE_INFINITY
          const query = {
            limit(n) {
              limit = n
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
                if (rows.length >= limit) break
              }
              return { data: rows }
            }
          }
          return query
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
            async set(row) {
              guard()
              docs.set(id, { _id: id, ...structuredClone(row) })
              return { updated: 1 }
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
        },
        async add(row) {
          guard()
          const id = row._id || `gen-${docs.size + 1}`
          docs.set(id, { ...structuredClone(row), _id: id })
          return { id }
        }
      }
    }
  }

  return { db, state }
}

/* ── 环境变量存档（跑完必须原样还原） ─────────────────────────────── */

const ENV_KEYS = ['YINYUAN_API_KEY', 'YINYUAN_SESSION_SECRET']
const ENV_BACKUP = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ENV_BACKUP[key] === undefined) delete process.env[key]
    else process.env[key] = ENV_BACKUP[key]
  }
}

const PASSWORD = 'correct horse battery staple'
const SESSION_SECRET = randomBytes(32).toString('base64url')

function requestWithKey(key, header = 'authorization') {
  if (header === 'authorization') return { headers: { authorization: `ApiKey ${key}` } }
  return { headers: { 'x-api-key': key } }
}

async function main() {
  /* ══ 1. passwordHash ═══════════════════════════════════════════ */
  section('1. passwordHash（scrypt）')
  const stored = await hashPassword(PASSWORD)
  ok(
    '形态含 v/algo/N/r/p/keylen/hash/salt',
    stored.v === 1 &&
      stored.algo === 'scrypt' &&
      stored.N === PARAMS.N &&
      stored.r === PARAMS.r &&
      stored.p === PARAMS.p &&
      stored.keylen === PARAMS.keylen &&
      typeof stored.hash === 'string' &&
      typeof stored.salt === 'string'
  )
  ok('记录里不含明文口令', !JSON.stringify(stored).includes(PASSWORD))
  ok('hash/salt 是 base64url（无 + / =）', /^[A-Za-z0-9_-]+$/.test(stored.hash) && /^[A-Za-z0-9_-]+$/.test(stored.salt))
  eq('正确口令 ⇒ true', await verifyPassword(PASSWORD, stored), true)
  eq('错误口令 ⇒ false', await verifyPassword(`${PASSWORD}!`, stored), false)
  const wrongDetail = await verifyPasswordDetailed(`${PASSWORD}!`, stored)
  eq('错误口令的判别码＝PASSWORD_MISMATCH', wrongDetail.reason, 'PASSWORD_MISMATCH')
  const storedAgain = await hashPassword(PASSWORD)
  ok('盐随机：同口令两次散列的 hash/salt 均不同', stored.hash !== storedAgain.hash && stored.salt !== storedAgain.salt)
  eq('被换成别人 hash 的记录 ⇒ false', await verifyPassword(PASSWORD, { ...stored, hash: storedAgain.hash }), false)
  eq('把 salt 改成非规范 base64 ⇒ false', await verifyPassword(PASSWORD, { ...stored, salt: `${stored.salt}=` }), false)
  eq('算法名不符 ⇒ false', await verifyPassword(PASSWORD, { ...stored, algo: 'bcrypt' }), false)
  eq('N 被写成 2^24（DoS 面）⇒ false', await verifyPassword(PASSWORD, { ...stored, N: 1 << 24 }), false)
  eq('stored 为 null ⇒ false（不抛）', await verifyPassword(PASSWORD, null), false)
  eq('空口令 ⇒ false', await verifyPassword('', stored), false)
  eq('口令 7 字符被政策拒', checkPasswordPolicy('1234567').ok, false)
  eq('口令 8 字符过政策', checkPasswordPolicy('12345678').ok, true)
  eq('非字符串口令被政策拒', checkPasswordPolicy(12345678).ok, false)
  let hashThrew = false
  try {
    await hashPassword('short')
  } catch (error) {
    hashThrew = error instanceof TypeError
  }
  eq('hashPassword 对政策外口令抛 TypeError（调用方编程错误面）', hashThrew, true)

  /* ══ 2. session ═════════════════════════════════════════════════ */
  section('2. session（HMAC 令牌）')
  process.env.YINYUAN_SESSION_SECRET = SESSION_SECRET
  ok('isSessionConfigured（≥32 字符）', isSessionConfigured() === true)

  const signed = signSession({ uid: 'u-0123456789abcdef', role: 'user' })
  eq('签发 ok', signed.ok, true)
  ok('令牌形态 v1.<payload>.<sig>（3 段）', /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(signed.token))
  eq('默认 TTL＝7 天', signed.claims.exp - signed.claims.iat, DEFAULT_TTL_SECONDS)
  eq('默认 TTL＝604800s', DEFAULT_TTL_SECONDS, 604800)
  ok('payload 含 v/uid/role/jti/iat/exp', ['v', 'uid', 'role', 'jti', 'iat', 'exp'].every((key) => key in signed.claims))
  const verified = verifySession({ token: signed.token })
  eq('验签 ok', verified.ok, true)
  eq('往返后 uid 一致', verified.claims.uid, 'u-0123456789abcdef')
  eq('往返后 role 一致', verified.claims.role, 'user')

  // 篡改 payload（改成别人的 uid，签名不变）
  const payloadSegment = signed.token.split('.')[1]
  const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))
  const tamperedClaims = { ...claims, uid: 'u-ffffffffffffffff' }
  const tamperedPayload = Buffer.from(JSON.stringify(tamperedClaims), 'utf8').toString('base64url')
  const tamperedToken = `v1.${tamperedPayload}.${signed.token.split('.')[2]}`
  const tampered = verifySession({ token: tamperedToken })
  eq('篡改 payload ⇒ 拒', tampered.ok, false)
  eq('篡改 payload 的对外 reason＝SESSION_INVALID', tampered.reason, 'SESSION_INVALID')
  eq('篡改 payload 的内部判别＝TOKEN_BAD_SIGNATURE', tampered.detail, 'TOKEN_BAD_SIGNATURE')

  // 篡改签名
  const signature = signed.token.split('.')[2]
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
  eq(
    '篡改签名 ⇒ TOKEN_BAD_SIGNATURE',
    verifySession({ token: `v1.${payloadSegment}.${flipped}` }).detail,
    'TOKEN_BAD_SIGNATURE'
  )
  // 严格 base64url：追加 `=` 填充即非规范形态
  eq(
    '签名段带 `=` 填充 ⇒ TOKEN_MALFORMED',
    verifySession({ token: `v1.${payloadSegment}.${signature}=` }).detail,
    'TOKEN_MALFORMED'
  )
  eq('段数不对 ⇒ TOKEN_MALFORMED', verifySession({ token: `${payloadSegment}.${signature}` }).detail, 'TOKEN_MALFORMED')
  eq('版本段不是 v1 ⇒ TOKEN_MALFORMED', verifySession({ token: `v2.${payloadSegment}.${signature}` }).detail, 'TOKEN_MALFORMED')
  eq('空令牌 ⇒ TOKEN_MISSING', verifySession({ token: '' }).detail, 'TOKEN_MISSING')
  eq('换一把密钥 ⇒ TOKEN_BAD_SIGNATURE', verifySession({ token: signed.token, secret: randomBytes(32).toString('base64url') }).detail, 'TOKEN_BAD_SIGNATURE')

  // 过期 / 未生效
  const shortLived = signSession({ uid: 'u-0123456789abcdef', role: 'user', ttlSeconds: 60 })
  const expiredCheck = verifySession({ token: shortLived.token, nowSeconds: shortLived.claims.iat + 61 })
  eq('过期 ⇒ 拒', expiredCheck.ok, false)
  eq('过期 ⇒ TOKEN_EXPIRED（对外仍 SESSION_INVALID）', expiredCheck.detail, 'TOKEN_EXPIRED')
  eq('过期对外 reason＝SESSION_INVALID', expiredCheck.reason, 'SESSION_INVALID')
  eq('尚未生效 ⇒ TOKEN_NOT_YET_VALID', verifySession({ token: shortLived.token, nowSeconds: shortLived.claims.iat - 10 }).detail, 'TOKEN_NOT_YET_VALID')
  eq('边界：恰在 exp 时仍有效', verifySession({ token: shortLived.token, nowSeconds: shortLived.claims.exp }).ok, true)

  // 密钥缺失 / 过短 ⇒ fail-closed
  delete process.env.YINYUAN_SESSION_SECRET
  eq('缺密钥 ⇒ isSessionConfigured=false', isSessionConfigured(), false)
  const noSecretSign = signSession({ uid: 'u-0123456789abcdef', role: 'user' })
  eq('缺密钥 ⇒ 签发 fail-closed', noSecretSign.ok, false)
  eq('缺密钥 ⇒ 对外 reason＝SESSION_INVALID', noSecretSign.reason, 'SESSION_INVALID')
  eq('缺密钥的内部判别＝SECRET_MISSING', noSecretSign.detail, 'SECRET_MISSING')
  eq('缺密钥 ⇒ 验签 fail-closed', verifySession({ token: signed.token }).detail, 'SECRET_MISSING')
  process.env.YINYUAN_SESSION_SECRET = 'too-short-secret'
  eq('密钥过短视同未配置', isSessionConfigured(), false)
  eq('密钥过短 ⇒ 签发仍 fail-closed', signSession({ uid: 'u-0123456789abcdef', role: 'user' }).ok, false)
  process.env.YINYUAN_SESSION_SECRET = SESSION_SECRET
  eq('恢复密钥后可签发', signSession({ uid: 'u-0123456789abcdef', role: 'user' }).ok, true)
  eq('非法 uid（含空格）⇒ TOKEN_MALFORMED', signSession({ uid: 'u-abc def', role: 'user' }).detail, 'TOKEN_MALFORMED')
  eq('TTL 超上限 ⇒ TOKEN_MALFORMED', signSession({ uid: 'u-0123456789abcdef', role: 'user', ttlSeconds: MAX_TTL_SECONDS + 1 }).detail, 'TOKEN_MALFORMED')

  /* ══ 3. users ══════════════════════════════════════════════════ */
  section('3. users（yinyuan_users）')
  const { db, state } = createFakeDb()
  const created = await users.create(db, { phone: '138 0013 8000', password: PASSWORD })
  eq('create ok', created.ok, true)
  const expectedId = `u-${createHash('sha256').update('13800138000', 'utf8').digest('hex').slice(0, 16)}`
  eq('id ＝ u- + sha256(归一化手机号) 前 16 位', created.user.id, expectedId)
  ok('create 返回值不含 password_hash', !('password_hash' in created.user))
  eq('默认 role=user', created.user.role, 'user')
  eq('默认 status=active', created.user.status, 'active')
  eq('last_login_at 初始为 null', created.user.lastLoginAt, null)

  const byPhone = await users.findByPhone(db, '138-0013-8000')
  eq('findByPhone（换格式）命中同一行', byPhone.ok && byPhone.user._id === created.user.id, true)
  ok('findByPhone 返回行含 password_hash（仅服务端用）', typeof byPhone.user.password_hash === 'object')
  eq('落库口令可校验', await verifyPassword(PASSWORD, byPhone.user.password_hash), true)
  const byId = await users.findById(db, created.user.id)
  eq('findById 命中', byId.ok && byId.user._id === created.user.id, true)

  eq(
    '重复注册 ⇒ ALREADY_EXISTS',
    (await users.create(db, { phone: '13800138000', password: PASSWORD })).reason,
    'ALREADY_EXISTS'
  )
  eq('非法手机号 ⇒ INVALID_INPUT', (await users.create(db, { phone: 'abc', password: PASSWORD })).reason, 'INVALID_INPUT')
  eq('口令过短 ⇒ INVALID_INPUT', (await users.create(db, { phone: '13900139000', password: 'short' })).reason, 'INVALID_INPUT')
  eq('非法 role ⇒ INVALID_INPUT', (await users.create(db, { phone: '13900139001', password: PASSWORD, role: 'root' })).reason, 'INVALID_INPUT')
  eq('无手机号也无邮箱 ⇒ INVALID_INPUT', (await users.create(db, { password: PASSWORD })).reason, 'INVALID_INPUT')

  const emailUser = await users.create(db, { email: '  Foo@Example.COM ', password: PASSWORD })
  eq('邮箱大小写/空格归一化后建号 ok', emailUser.ok, true)
  const expectedEmailId = `u-${createHash('sha256').update('foo@example.com', 'utf8').digest('hex').slice(0, 16)}`
  eq('id 由小写邮箱派生', emailUser.user.id, expectedEmailId)
  const byEmail = await users.findByEmail(db, 'FOO@example.com')
  eq('findByEmail 大小写无关命中', byEmail.ok && byEmail.user._id === emailUser.user.id, true)
  eq('邮箱归一化结果小写', byEmail.user.email, 'foo@example.com')
  eq('用户行里手机号已归一化', byId.user.phone, '13800138000')

  const loginStamp = '2026-10-17T03:04:05.000Z'
  eq('updateLastLogin ok', (await users.updateLastLogin(db, created.user.id, loginStamp)).ok, true)
  const afterLogin = await users.findById(db, created.user.id)
  eq('last_login_at 已写入', afterLogin.user.last_login_at, loginStamp)
  eq('setStatus(disabled) ok', (await users.setStatus(db, created.user.id, 'disabled')).ok, true)
  eq('status 落地', (await users.findById(db, created.user.id)).user.status, 'disabled')
  eq('非法状态 ⇒ INVALID_INPUT', (await users.setStatus(db, created.user.id, 'bogus')).reason, 'INVALID_INPUT')
  eq('userIdOf 对空标识返回空串', users.userIdOf({}), '')
  eq('userIdOf 手机号/邮箱都给时取手机号', users.userIdOf({ phone: '13800138000', email: 'foo@example.com' }), expectedId)
  eq('归一化：不做国家码剥离（+86 前缀保留）', users.normalizePhone('+86 138 0013 8000'), '8613800138000')

  // 存储不可用必须与「账号不存在」区分
  state.setFailing(true)
  eq('存储不可用 ⇒ findById 回 STORAGE_UNAVAILABLE', (await users.findById(db, created.user.id)).reason, 'STORAGE_UNAVAILABLE')
  eq('存储不可用 ⇒ findByPhone 回 STORAGE_UNAVAILABLE', (await users.findByPhone(db, '13800138000')).reason, 'STORAGE_UNAVAILABLE')
  eq('存储不可用 ⇒ create 回 STORAGE_UNAVAILABLE', (await users.create(db, { phone: '13700137000', password: PASSWORD })).reason, 'STORAGE_UNAVAILABLE')
  state.setFailing(false)

  /* ══ 4. apiKeys ════════════════════════════════════════════════ */
  section('4. apiKeys（yinyuan_api_keys）')
  const keyOne = await apiKeys.create(db, { userId: created.user.id, label: '生产密钥' })
  eq('create ok', keyOne.ok, true)
  ok('明文以 yy_ 开头', keyOne.plain.startsWith('yy_'))
  eq('明文长度 46（yy_ + 32 字节 base64url）', keyOne.plain.length, 46)
  eq('返回行不含明文', JSON.stringify(keyOne.key).includes(keyOne.plain), false)
  eq('返回行不含 key_hash', 'key_hash' in keyOne.key, false)
  eq('prefix 只留 yy_ 后 8 位（不足以校验）', keyOne.key.prefix, keyOne.plain.slice(0, 11))
  eq('初始 status=active', keyOne.key.status, 'active')
  eq('初始 call_count=0', keyOne.key.callCount, 0)

  const verifiedKey = await apiKeys.verifyKey(db, keyOne.plain)
  eq('verifyKey ok', verifiedKey.ok, true)
  eq('verifyKey 回 userId', verifiedKey.userId, created.user.id)
  eq('verifyKey 回 keyId', verifiedKey.keyId, keyOne.key.id)
  eq('未知但形态合法的 key ⇒ KEY_INVALID', (await apiKeys.verifyKey(db, `yy_${randomBytes(32).toString('base64url')}`)).reason, 'KEY_INVALID')
  eq('形态不符（无前缀）⇒ KEY_FORMAT_INVALID', (await apiKeys.verifyKey(db, 'not-a-key')).reason, 'KEY_FORMAT_INVALID')
  eq('形态不符（含空格）⇒ KEY_FORMAT_INVALID', (await apiKeys.verifyKey(db, 'yy_abc def')).reason, 'KEY_FORMAT_INVALID')
  eq('形态不符（空）⇒ KEY_FORMAT_INVALID', (await apiKeys.verifyKey(db, '')).reason, 'KEY_FORMAT_INVALID')

  const touched = await apiKeys.touch(db, keyOne.key.id, { now: loginStamp })
  eq('touch ok', touched.ok, true)
  const listedAfterTouch = await apiKeys.listByUser(db, created.user.id)
  const touchedRow = listedAfterTouch.keys.find((key) => key.id === keyOne.key.id)
  eq('touch 递增 call_count', touchedRow.callCount, 1)
  eq('touch 写 last_used_at', touchedRow.lastUsedAt, loginStamp)

  const listed = await apiKeys.listByUser(db, created.user.id)
  eq('listByUser ok', listed.ok, true)
  eq('列表不回明文', JSON.stringify(listed).includes(keyOne.plain), false)
  ok(
    '列表字段收敛（无 key_hash / password）',
    listed.keys.every((key) => !('key_hash' in key) && !('password_hash' in key) && !('plain' in key))
  )

  const revoked = await apiKeys.revoke(db, keyOne.key.id, loginStamp)
  eq('revoke ok', revoked.ok, true)
  eq('revoke 后 status=revoked', revoked.key.status, 'revoked')
  eq('revoke 后旧 key 立即失效', (await apiKeys.verifyKey(db, keyOne.plain)).reason, 'KEY_REVOKED')
  const revokedAgain = await apiKeys.revoke(db, keyOne.key.id)
  eq('重复 revoke 幂等', revokedAgain.ok && revokedAgain.alreadyRevoked, true)
  eq('rotate 已撤销的 key ⇒ KEY_NOT_ACTIVE', (await apiKeys.rotate(db, keyOne.key.id)).reason, 'KEY_NOT_ACTIVE')

  const keyTwo = await apiKeys.create(db, { userId: created.user.id, label: '待轮换' })
  const rotated = await apiKeys.rotate(db, keyTwo.key.id, { label: '轮换后' })
  eq('rotate ok', rotated.ok, true)
  ok('rotate 出新明文（与旧不同）', rotated.plain !== keyTwo.plain)
  eq('rotate 旧 key 被撤销', rotated.revoked, true)
  eq('rotate 后旧 key 失效', (await apiKeys.verifyKey(db, keyTwo.plain)).reason, 'KEY_REVOKED')
  eq('rotate 后新 key 可用', (await apiKeys.verifyKey(db, rotated.plain)).ok, true)
  const afterRotate = await apiKeys.listByUser(db, created.user.id)
  eq('旧行未被删除（只改状态）', afterRotate.keys.some((key) => key.id === keyTwo.key.id && key.status === 'revoked'), true)
  eq('旧行留痕 rotatedTo', afterRotate.keys.find((key) => key.id === keyTwo.key.id).rotatedTo, rotated.key.id)
  eq('新行留痕 rotatedFrom', afterRotate.keys.find((key) => key.id === rotated.key.id).rotatedFrom, keyTwo.key.id)
  eq('每个账号的列表都只含自己的 key', afterRotate.keys.every((key) => key.id !== keyOne.key.id || key.status === 'revoked'), true)
  eq('listByUser 对未知账号返回空数组', (await apiKeys.listByUser(db, 'u-0000000000000000')).keys.length, 0)

  state.setFailing(true)
  eq('存储不可用 ⇒ verifyKey 回 STORAGE_UNAVAILABLE', (await apiKeys.verifyKey(db, rotated.plain)).reason, 'STORAGE_UNAVAILABLE')
  eq('存储不可用 ⇒ touch 不抛、回失败', (await apiKeys.touch(db, rotated.key.id)).ok, false)
  state.setFailing(false)

  /* ══ 5. auth 双通道 ════════════════════════════════════════════ */
  section('5. auth（env → DB 双通道）')
  const envKey = `env-${randomBytes(18).toString('base64url')}`
  process.env.YINYUAN_API_KEY = envKey

  const syncEnv = checkApiKey(requestWithKey(envKey))
  eq('同步入口 ─ env key 通过（现网语义不变）', syncEnv.ok, true)
  eq('同步入口 ─ via=env', syncEnv.via, AUTH_VIA.ENV)

  const asyncEnv = await checkApiKeyAsync(requestWithKey(envKey), { db, track: false })
  eq('异步入口 ─ env key 通过', asyncEnv.ok, true)
  eq('异步入口 ─ env 优先（via=env）', asyncEnv.via, AUTH_VIA.ENV)
  eq('env 通道不回 userId（机构钥匙无账号身份）', 'userId' in asyncEnv, false)

  const asyncDb = await checkApiKeyAsync(requestWithKey(rotated.plain, 'x-api-key'), { db, track: false })
  eq('异步入口 ─ DB key 通过（X-API-Key 写法）', asyncDb.ok, true)
  eq('异步入口 ─ via=key', asyncDb.via, AUTH_VIA.KEY)
  eq('异步入口 ─ 附身份上下文 userId', asyncDb.userId, created.user.id)
  eq('结果体不含明文 key', JSON.stringify(asyncDb).includes(rotated.plain), false)

  const syncDbKey = checkApiKey(requestWithKey(rotated.plain))
  eq('同步入口 ─ DB key 不被承认（向后兼容判据：env-only）', syncDbKey.ok, false)
  eq('同步入口 ─ DB key 落 401', syncDbKey.status, 401)

  const noKey = await checkApiKeyAsync({ headers: {} }, { db, track: false })
  eq('缺凭据 ⇒ 401', noKey.status, 401)
  eq('缺凭据 ⇒ UNAUTHORIZED', noKey.reason, 'UNAUTHORIZED')
  const bothWrong = await checkApiKeyAsync(requestWithKey(`yy_${randomBytes(32).toString('base64url')}`), { db, track: false })
  eq('env 与 DB 都不匹配 ⇒ 401', bothWrong.status, 401)

  // 使用计数接入（track 默认 true、异步不阻塞）
  const countBefore = (await apiKeys.listByUser(db, created.user.id)).keys.find((key) => key.id === rotated.key.id).callCount
  await checkApiKeyAsync(requestWithKey(rotated.plain), { db })
  await sleep(30)
  const countAfter = (await apiKeys.listByUser(db, created.user.id)).keys.find((key) => key.id === rotated.key.id).callCount
  eq('DB 通道命中后异步记一次使用', countAfter, countBefore + 1)

  // env 未配置：DB 通道独立可用；既有 503 契约只留在同步入口
  delete process.env.YINYUAN_API_KEY
  eq('同步入口 ─ 未配置 env ⇒ 503（既有对外契约不变）', checkApiKey(requestWithKey(rotated.plain)).status, 503)
  const dbOnly = await checkApiKeyAsync(requestWithKey(rotated.plain), { db, track: false })
  eq('异步入口 ─ 仅 DB 通道也能通过', dbOnly.ok && dbOnly.via === AUTH_VIA.KEY, true)

  // 存储不可用 ⇒ fail-closed
  const brokenDb = createFakeDb()
  brokenDb.state.setFailing(true)
  const failClosed = await checkApiKeyAsync(requestWithKey(rotated.plain), { db: brokenDb.db, track: false })
  eq('env 未配置 + DB 不可用 ⇒ 503（fail-closed）', failClosed.status, 503)
  eq('fail-closed 的 reason＝NOT_CONFIGURED', failClosed.reason, 'NOT_CONFIGURED')

  process.env.YINYUAN_API_KEY = envKey
  const envWinsOverBrokenDb = await checkApiKeyAsync(requestWithKey(envKey), { db: brokenDb.db, track: false })
  eq('env 已配置时 DB 不可用不影响 env 通道', envWinsOverBrokenDb.ok && envWinsOverBrokenDb.via === AUTH_VIA.ENV, true)
  const wrongWithBrokenDb = await checkApiKeyAsync(requestWithKey(`yy_${randomBytes(32).toString('base64url')}`), { db: brokenDb.db, track: false })
  eq('env 已配置 + DB 不可用 + key 不匹配 ⇒ 401（不泄漏服务端状态）', wrongWithBrokenDb.status, 401)

  // 数据层隔离：本内核只碰 yinyuan_* 集合
  ok(
    `只触达 yinyuan_* 集合（实测：${[...state.collections.keys()].join(', ')}）`,
    [...state.collections.keys()].every((name) => name.startsWith('yinyuan_'))
  )
  eq('集合名固定', state.collections.has('yinyuan_users') && state.collections.has('yinyuan_api_keys'), true)
  eq('未触碰 xiai 集合（xiai_persons 不存在）', state.collections.has('xiai_persons'), false)
}

try {
  await main()
} catch (error) {
  failCount += 1
  failures.push('未捕获异常')
  console.error('\n未捕获异常：', error && error.stack ? error.stack : error)
} finally {
  restoreEnv()
}

console.log(`\n══ 自检结果：${passCount} 通过 / ${failCount} 失败 ══`)
if (failCount > 0) {
  console.log('失败项：')
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('全部通过。')
