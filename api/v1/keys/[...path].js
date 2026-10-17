/**
 * `/api/v1/keys/**` —— 密钥三端点的**唯一实现** ＋ 路径段分派（B2 对外契约一字不改）。
 *
 * ★ 为什么收进一个 catch-all（2026-10-18 线上实测）：具名动态段文件
 *   `api/v1/keys/[kid].js` 与 `api/v1/keys/[kid]/rotate.js` 部署后**全部 404**
 *   （`{"ok":false,"reason":"NOT_FOUND","message":"接口不存在。"}`，与 `/api/v1/bogus` 逐字同形）
 *   ⇒ 动态段文件在本项目里**没被注册成路由**，不是 handler 的问题（同 commit 的静态路径端点全部在线）。
 *   仓内已有可用先例 `api/[...path].js`（其注释记载：`:path*` 形态线上不吃尾斜杠，最终改用方括号组形态）
 *   ⇒ 本单把三个端点合并到**一个**方括号组文件，段数在 handler 内自判，不再依赖动态段文件注册。
 *
 * ★ 路由形态（对外契约逐字不变，只是入口文件变了）：
 *   /api/v1/keys                0 段 ⇒ GET 列表 200 ／ POST 铸造 201   （`Allow: GET, POST`）
 *   /api/v1/keys/{kid}          1 段 ⇒ PATCH 200 ／ DELETE 200        （`Allow: PATCH, DELETE`）
 *   /api/v1/keys/{kid}/rotate   2 段且尾段 = rotate ⇒ POST 201        （`Allow: POST`）
 *   其它形态（`{kid}/bogus`、3 段及以上）⇒ 404 `NOT_FOUND`（复用 `respond.failWith`，与全站兜底同信封）
 *
 * ★ 为什么不把 405 的门槛提到分派层：`Allow` 头必须与 B2 逐字一致（每个形态不同），
 *   故分派只决定「交给哪个 `createRouteHandler`」，方法门/体解析/认证/日志全部沿用原工厂。
 *
 * ★ `api/v1/keys/index.js` 现在只是本文件的**薄再导出**（不复制任何逻辑）：
 *   一是让 0 段入口保持静态文件（静态优先于动态段，行为确定）；
 *   二是留一条 `vercel.json` 兜底 rewrite 的落点（`/api/v1/keys` ⇒ `api/v1/keys/index.js`），
 *   若线上仍不认多段 catch-all 可整体切到那条 rewrite，而不必再动实现。
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

/* ══ 0 段：`/api/v1/keys` ⇒ 列表 / 铸造 ══════════════════════════════
 * GET  200 `{ ok:true, items:[{ id, prefix, label, status, created_at, last_used_at, call_count }] }`
 *      —— **只回自己的**（`listByUser(session.uid)`），**永不回明文 / hash**。
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

/* ══ 1 段：`/api/v1/keys/{kid}` ⇒ 状态变更 / 逻辑撤销 ══════════════════
 * PATCH 200 `{ ok:true, key:{ id, prefix, label, status, created_at, last_used_at, call_count } }`
 *       体 `{ status: 'active' | 'revoked' }`（`revoked` 走撤销，`active` 可把已撤销的重新启用）
 * DELETE 200 `{ ok:true }` —— **逻辑撤销**（只改 `status`/`revoked_at`，**不物理删行**，留审计）
 *
 * ★ 越权隔离（硬要求）：别人的 `kid` ⇒ **404 NOT_FOUND**（**绝不回 403**）。
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

/* ══ 分派层 ═════════════════════════════════════════════════════════
 * 段数取自 `req.url` 本身（不依赖 Vercel 注入的 `req.query.path` 形态：
 * 该 query 在不同 catch-all 形态下可能是字符串、数组或缺席 —— 只信原始 URL）。
 */

/**
 * `/api/v1/keys` 之后的路径段。
 * @returns {string[]} 已去空段、已 %-解码（解码失败保留原文）
 */
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
 * 单入口分派器：0 段 ⇒ 列表；1 段 ⇒ 单把；`<kid>/rotate` ⇒ 轮换；其它 ⇒ 404。
 * 三个子 handler 各带自己的方法门，故 `Allow` 头与 B2 逐字一致。
 */
export function createKeysCatchAllHandler(options = {}) {
  const listOrCreate = createKeysHandler(options)
  const item = createKeyItemHandler(options)
  const rotateOne = createKeyRotateHandler(options)

  return async function handler(req, res) {
    const segments = keyPathSegments(req)
    if (segments.length === 0) return listOrCreate(req, res)
    if (segments.length === 1) return item(req, res)
    if (segments.length === 2 && segments[1] === 'rotate') return rotateOne(req, res)
    // 未识别的形态：与全站兜底同信封（预检仍 204，方法不当不额外泄露）
    if (handlePreflight(req, res)) return undefined
    failWith(res, 404, 'NOT_FOUND')
    return undefined
  }
}

export default createKeysCatchAllHandler()
