/**
 * POST `/api/v1/keys/{kid}/rotate` —— 轮换单把密钥（B2；**需会话**）。
 *
 * 201 `{ ok:true, key:{ id, prefix, label, plain } }`
 *   —— **先铸新、后撤旧**（不出现「零可用 key」窗口）；旧行 `status: revoked` 且 `rotated_to` 指向新行，
 *      **不删行**；新行 `rotated_from` 指向旧行。`plain` **只此一次**。
 *
 * 越权：别人的 `kid` ⇒ 404（与不存在同形）；自己已撤销的 key ⇒ 409 KEY_NOT_ACTIVE。
 * 其余：401 UNAUTHORIZED / 405 METHOD_NOT_ALLOWED（`Allow: POST`）/ 503 NOT_CONFIGURED
 */
import { failureOf, pathKidOf, projectIssuedKey } from '../../../_lib/accountContract.js'
import { ownerOf, rotate } from '../../../_lib/apiKeys.js'
import { createRouteHandler } from '../../../_lib/routeHandler.js'
import { authenticateSession } from '../../../_lib/sessionAuth.js'

const NOT_FOUND_BODY = { ok: false, reason: 'NOT_FOUND', message: '密钥不存在。' }

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

export default createKeyRotateHandler()