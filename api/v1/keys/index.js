/**
 * `/api/v1/keys` —— 客户 API Key 的列表与铸造（B2；**需会话**，`Authorization: Session <token>`）。
 *
 * GET  200 `{ ok:true, items:[{ id, prefix, label, status, created_at, last_used_at, call_count }] }`
 *      —— **只回自己的**（`listByUser(session.uid)`），**永不回明文 / hash**（`apiKeys.toPublicKey` 起就不含）。
 * POST 201 `{ ok:true, key:{ id, prefix, label, plain } }`（体 `{label?, ttl?}`）
 *      —— `plain` **只此一次**；`ttl` 为有效期秒数（60 ~ 365 天），缺省不过期。
 *      409 KEY_LIMIT：该账号 `active` 密钥已达 10 把（revoked 的旧行不计入，轮换不会被自己卡住）。
 * 其余：400 INVALID_INPUT / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: GET, POST`）
 *      413 BODY_TOO_LARGE / 503 NOT_CONFIGURED
 */
import {
  KEY_LIMIT_MAX,
  failureOf,
  projectIssuedKey,
  projectKey
} from '../../_lib/accountContract.js'
import { create as createKey, listByUser } from '../../_lib/apiKeys.js'
import { createRouteHandler } from '../../_lib/routeHandler.js'
import { authenticateSession } from '../../_lib/sessionAuth.js'

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

export default createKeysHandler()
