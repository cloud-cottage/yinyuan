/**
 * `/api/v1/keys` —— 客户 API Key 三个端点的**唯一实现** ＋ 形态分派（B2 对外契约一字不改）。
 *
 * ★ 路由形态为什么长这样（2026-10-18 线上实测，两步）：
 *   ① 具名动态段文件 `api/v1/keys/[kid].js`、`api/v1/keys/[kid]/rotate.js` 部署后**全部 404**，
 *      且响应体/头与 `/api/v1/bogus` **逐字同形**（真函数应答的 JSON 404）⇒ 动态段文件**没被注册成路由**。
 *   ② 换成方括号组 `api/v1/keys/[...path].js`（`api/[...path].js` 那套）后：`/api/v1/keys/{kid}` 仍落
 *      同一个 404（⇒ 嵌套方括号文件**同样没被注册**），且 `/api/v1/keys` 变 504 超时（该文件被
 *      `index.js` 以方括号路径 import ⇒ 打包/加载失败）。⇒ **本项目只注册「无方括号的静态文件路径」**
 *      （`api/v1/auth/login.js`、`api/v1/me.js` 均在线），二级以下目录的动态段一律不可用。
 *
 * ★ 因此动态路径改由平台层 rewrite 承载（`vercel.json`，位于末条 `/api/(.*)` 兜底**之前**）：
 *      /api/v1/keys/:kid          ⇒ /api/v1/keys?kid=:kid
 *      /api/v1/keys/:kid/rotate   ⇒ /api/v1/keys?kid=:kid&action=rotate
 *   即**静态文件一入口** + query 携带段信息；对外 URL、状态码、字段面、Allow、文案**全部不变**。
 *   本文件同时兼容「URL 里带段」的直调（自检/本地 `http.createServer` 就是这种），
 *   故分派判据 = `kid` 查询优先、其次 `req.url` 段数；两条路径落到同一套 handler。
 *
 * ★ 形态（逐字沿用 B2）：
 *   0 段          ⇒ GET 列表 200 ／ POST 铸造 201     （`Allow: GET, POST`）
 *   1 段 `{kid}`  ⇒ PATCH 200 ／ DELETE 200           （`Allow: PATCH, DELETE`）
 *   `{kid}/rotate`⇒ POST 201                          （`Allow: POST`）
 *   其它          ⇒ 404 `NOT_FOUND`（`respond.failWith`，与全站兜底同信封）
 */
import {
  KEY_LIMIT_MAX,
  failureOf,
  pathKidOf,
  projectIssuedKey,
  projectKey
} from '../../_lib/accountContract.js'
import {
  create as createKey,
  listByUser,
  ownerOf,
  revoke,
  rotate,
  setKeyStatus
} from '../../_lib/apiKeys.js'
import { handlePreflight } from '../../_lib/cors.js'
import { failWith } from '../../_lib/respond.js'
import { createRouteHandler } from '../../_lib/routeHandler.js'
import { authenticateSession } from '../../_lib/sessionAuth.js'

const NOT_FOUND_BODY = { ok: false, reason: 'NOT_FOUND', message: '密钥不存在。' }

/* ══ 0 段：列表 / 铸造 ══════════════════════════════════════════════
 * GET  200 `{ ok:true, items:[{ id, prefix, label, status, created_at, last_used_at, call_count }] }`
 *      —— **只回自己的**（`listByUser(session.uid)`），**永不回明文 / hash**（`apiKeys.toPublicKey` 起就不含）。
 * POST 201 `{ ok:true, key:{ id, prefix, label, plain } }`（体 `{label?, ttl?}`）
 *      —— `plain` **只此一次**；`ttl` 为有效期秒数（60 ~ 365 天），缺省不过期。
 *      409 KEY_LIMIT：该账号 `active` 密钥已达 10 把（revoked 的旧行不计入，轮换不会被自己卡住）。
 * 其余：400 INVALID_INPUT / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET, POST`）
 *      413 BODY_TOO_LARGE / 503 NOT_CONFIGURED
 */

/** 体校验：`label` 字符串（≤64）、`ttl` 正整数秒（区间由 apiKeys 判）。 */
function readKeyInput(body) {
  const source = body || {}
  const label = source.label
  if (label !== undefined && label !== null && typeof label !== 'string') return { ok: false }
  if (typeof label === 'string' && label.length > 64) return { ok: false }
  const ttl = source.ttl
  if (ttl !== undefined && ttl !== null) {
    const n = Number(ttl)
    if (!Number.isFinite(n) || Math.floor(n) !== n) return { ok: false }
  }
  return { ok: true, label, ttl }
}

export function createKeysHandler(options = {}) {
  return createRouteHandler('v1/keys', {
    methods: ['GET', 'POST'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    authenticate: async ({ req, db }) =>
      authenticateSession(req, { db, nowSeconds: options.nowSeconds, secret: options.secret }),
    run: async ({ req, body, db, auth }) => {
      const userId = auth.user && auth.user.id
      if (!userId) {
        // 令牌自洽但账号投影缺 id：服务端状态异常，按 401 处理（不猜）
        return { status: 401, body: { ok: false, reason: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录。' } }
      }

      if (String(req.method).toUpperCase() === 'GET') {
        const listed = await listByUser(db, userId)
        if (!listed.ok) {
          const failure = failureOf(listed.reason)
          return {
            status: failure.status,
            body: { ok: false, reason: failure.reason, message: '密钥列表暂时不可用，请稍后重试。' }
          }
        }
        return { status: 200, body: { ok: true, items: listed.keys.map(projectKey) } }
      }

      const input = readKeyInput(body)
      if (!input.ok) {
        return { status: 400, body: { ok: false, reason: 'INVALID_INPUT', message: '标签或有效期格式不正确。' } }
      }

      // 上限按 active 计（revoked 不计）：轮换（新铸 + 旧撤）不会把自己顶到上限
      const existing = await listByUser(db, userId)
      if (!existing.ok) {
        const failure = failureOf(existing.reason)
        return {
          status: failure.status,
          body: { ok: false, reason: failure.reason, message: '密钥服务暂时不可用，请稍后重试。' }
        }
      }
      const activeCount = existing.keys.filter((key) => key.status === 'active').length
      if (activeCount >= KEY_LIMIT_MAX) {
        return {
          status: 409,
          body: { ok: false, reason: 'KEY_LIMIT', message: `每个账号最多保留 ${KEY_LIMIT_MAX} 把有效密钥。` }
        }
      }

      const created = await createKey(db, {
        userId,
        label: input.label,
        ttlSeconds: input.ttl,
        now: options.now
      })
      if (!created.ok) {
        const failure = failureOf(created.reason)
        return {
          status: failure.status,
          body: { ok: false, reason: failure.reason, message: '密钥创建失败，请稍后重试。' }
        }
      }
      return { status: 201, body: { ok: true, key: projectIssuedKey(created.key, created.plain) } }
    }
  })
}

/* ══ 1 段：`/api/v1/keys/{kid}` —— 状态变更 / 逻辑撤销 ══════════════════
 * PATCH 200 `{ ok:true, key:{ id, prefix, label, status, created_at, last_used_at, call_count } }`
 *       体 `{ status: 'active' | 'revoked' }`（`revoked` 走撤销，`active` 可把已撤销的重新启用）
 * DELETE 200 `{ ok:true }` —— **逻辑撤销**（只改 `status`/`revoked_at`，**不物理删行**，留审计）
 *
 * ★ 越权隔离（硬要求）：别人的 `kid` ⇒ **404 NOT_FOUND**（**绝不回 403**，否则等于告诉对方
 *   「这个 id 存在，只是不属于你」）。不存在的 `kid` 与别人的 `kid` **同形同样**。
 * 其余：400 INVALID_INPUT / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: PATCH, DELETE`）
 *      409 KEY_NOT_ACTIVE / 503 NOT_CONFIGURED
 */

export function createKeyItemHandler(options = {}) {
  return createRouteHandler('v1/keys/{kid}', {
    methods: ['PATCH', 'DELETE'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    authenticate: async ({ req, db }) =>
      authenticateSession(req, { db, nowSeconds: options.nowSeconds, secret: options.secret }),
    run: async ({ req, body, db, auth }) => {
      const userId = auth.user && auth.user.id
      const kid = pathKidOf(req)
      if (!userId) {
        return { status: 401, body: { ok: false, reason: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录。' } }
      }
      if (kid === '') return { status: 404, body: NOT_FOUND_BODY }

      const owner = await ownerOf(db, kid)
      if (!owner.ok) {
        const failure = failureOf(owner.reason)
        return {
          status: failure.status,
          body: { ok: false, reason: failure.reason, message: '密钥服务暂时不可用，请稍后重试。' }
        }
      }
      // 别人的（或不存在）⇒ 一律 404
      if (owner.userId === '' || owner.userId !== userId) return { status: 404, body: NOT_FOUND_BODY }

      const method = String(req.method).toUpperCase()
      if (method === 'DELETE') {
        const result = await revoke(db, kid, options.now)
        if (!result.ok) {
          const failure = failureOf(result.reason)
          return {
            status: failure.status,
            body: { ok: false, reason: failure.reason, message: failure.status === 404 ? '密钥不存在。' : '密钥撤销失败，请稍后重试。' }
          }
        }
        return { status: 200, body: { ok: true } }
      }

      const wanted = body && body.status
      if (wanted !== 'active' && wanted !== 'revoked') {
        return { status: 400, body: { ok: false, reason: 'INVALID_INPUT', message: '状态只能是 active 或 revoked。' } }
      }
      const updated = await setKeyStatus(db, kid, wanted, options.now)
      if (!updated.ok) {
        const failure = failureOf(updated.reason)
        return {
          status: failure.status,
          body: {
            ok: false,
            reason: failure.reason,
            message: failure.status === 404 ? '密钥不存在。' : '密钥状态更新失败，请稍后重试。'
          }
        }
      }
      return { status: 200, body: { ok: true, key: projectKey(updated.key) } }
    }
  })
}

/* ══ 2 段 `{kid}/rotate`：轮换 ═══════════════════════════════════════
 * POST 201 `{ ok:true, key:{ id, prefix, label, plain } }`
 *   —— **先铸新、后撤旧**（不出现「零可用 key」窗口）；旧行 `status: revoked` 且 `rotated_to` 指向新行，
 *      **不删行**；新行 `rotated_from` 指向旧行。`plain` **只此一次**。
 * 越权：别人的 `kid` ⇒ 404（与不存在同形）；自己已撤销的 key ⇒ 409 KEY_NOT_ACTIVE。
 * 其余：401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: POST`）/ 503 NOT_CONFIGURED
 */

export function createKeyRotateHandler(options = {}) {
  return createRouteHandler('v1/keys/{kid}/rotate', {
    methods: ['POST'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    authenticate: async ({ req, db }) =>
      authenticateSession(req, { db, nowSeconds: options.nowSeconds, secret: options.secret }),
    run: async ({ req, db, auth }) => {
      const userId = auth.user && auth.user.id
      const kid = pathKidOf(req, 'rotate')
      if (!userId) {
        return { status: 401, body: { ok: false, reason: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录。' } }
      }
      if (kid === '') return { status: 404, body: NOT_FOUND_BODY }

      const owner = await ownerOf(db, kid)
      if (!owner.ok) {
        const failure = failureOf(owner.reason)
        return {
          status: failure.status,
          body: { ok: false, reason: failure.reason, message: '密钥服务暂时不可用，请稍后重试。' }
        }
      }
      if (owner.userId === '' || owner.userId !== userId) return { status: 404, body: NOT_FOUND_BODY }

      const rotated = await rotate(db, kid, { now: options.now })
      if (!rotated.ok) {
        const failure = failureOf(rotated.reason)
        return {
          status: failure.status,
          body: {
            ok: false,
            reason: failure.reason,
            message:
              failure.reason === 'KEY_NOT_ACTIVE'
                ? '该密钥已撤销，无法轮换，请新建。'
                : failure.status === 404
                  ? '密钥不存在。'
                  : '密钥轮换失败，请稍后重试。'
          }
        }
      }
      console.log(
        `[api/v1/keys/{kid}/rotate] rotated=1 oldRevoked=${rotated.revoked ? 1 : 0}`
      )
      return { status: 201, body: { ok: true, key: projectIssuedKey(rotated.key, rotated.plain) } }
    }
  })
}

/* ══ 形态分派 ═══════════════════════════════════════════════════════
 * 判据**双通道**（同一套 handler，行为一致）：
 *   ① 平台 rewrite 通道：`?kid=<kid>`（`&action=rotate`）—— 生产实际走这条；
 *   ② 直调通道：`req.url` 里的段数 —— 本地 `http.createServer` 自检、以及任何不经 rewrite 的直调。
 * 不信 `req.query.path`（各 catch-all 形态下是字符串/数组/缺席三态，不可靠）。
 */

const ROTATE_ACTION = 'rotate'

/** 查询串单值（数组取首个，非字符串当空）。 */
function queryValue(req, name) {
  const query = (req && req.query) || {}
  const raw = query[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}

/** `/api/v1/keys` 之后的路径段（已去空段，已 %-解码；解码失败保留原文）。 */
export function keyPathSegments(req) {
  const pathname = String((req && req.url) || '').split('?')[0]
  const marker = '/keys'
  const at = pathname.indexOf(marker)
  if (at === -1) return []
  return pathname
    .slice(at + marker.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch (error) {
        return segment
      }
    })
}

/**
 * 请求形态：`'list'`（0 段）／`'item'`（1 段）／`'rotate'`（`{kid}/rotate`）／`'unknown'`。
 * @returns {'list'|'item'|'rotate'|'unknown'}
 */
export function keyShapeOf(req) {
  const kid = queryValue(req, 'kid')
  const action = queryValue(req, 'action')
  if (kid !== '') return action === ROTATE_ACTION ? 'rotate' : 'item'
  const segments = keyPathSegments(req)
  if (segments.length === 0) return 'list'
  if (segments.length === 1) return 'item'
  if (segments.length === 2 && segments[1] === ROTATE_ACTION) return 'rotate'
  return 'unknown'
}

/**
 * 单入口分派器：按 `keyShapeOf` 交给对应 handler。
 * 三个子 handler 各带自己的方法门 ⇒ `Allow` 头与 B2 逐字一致。
 */
export function createKeysCatchAllHandler(options = {}) {
  const listOrCreate = createKeysHandler(options)
  const item = createKeyItemHandler(options)
  const rotateOne = createKeyRotateHandler(options)

  return async function handler(req, res) {
    const shape = keyShapeOf(req)
    if (shape === 'list') return listOrCreate(req, res)
    if (shape === 'item') return item(req, res)
    if (shape === 'rotate') return rotateOne(req, res)
    // 未识别的形态：与全站兜底同信封（预检仍 204）
    if (handlePreflight(req, res)) return undefined
    failWith(res, 404, 'NOT_FOUND')
    return undefined
  }
}

export default createKeysCatchAllHandler()
