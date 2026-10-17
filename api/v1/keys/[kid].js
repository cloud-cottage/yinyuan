/**
 * `/api/v1/keys/{kid}` —— 单把密钥的状态变更与逻辑撤销（B2；**需会话**）。
 *
 * PATCH 200 `{ ok:true, key:{ id, prefix, label, status, created_at, last_used_at, call_count } }`
 *       体 `{ status: 'active' | 'revoked' }`（`revoked` 走撤销，`active` 可把已撤销的重新启用）
 * DELETE 200 `{ ok:true }` —— **逻辑撤销**（只改 `status`/`revoked_at`，**不物理删行**，留审计）
 *
 * ★ 越权隔离（硬要求）：别人的 `kid` ⇒ **404 NOT_FOUND**（**绝不回 403**，否则等于告诉对方
 *   「这个 id 存在，只是不属于你」）。不存在的 `kid` 与别人的 `kid` **同形同样**。
 * 其余：400 INVALID_INPUT / 401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: PATCH, DELETE`）
 *      409 KEY_NOT_ACTIVE / 503 NOT_CONFIGURED
 */
import { failureOf, pathKidOf, projectKey } from '../../_lib/accountContract.js'
import { ownerOf, revoke, setKeyStatus } from '../../_lib/apiKeys.js'
import { createRouteHandler } from '../../_lib/routeHandler.js'
import { authenticateSession } from '../../_lib/sessionAuth.js'

const NOT_FOUND_BODY = { ok: false, reason: 'NOT_FOUND', message: '密钥不存在。' }

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

export default createKeyItemHandler()
