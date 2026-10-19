/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/auth/register.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/auth/index.js（op=register）` 按 `?op=` 分派。
 * POST /api/v1/auth/register —— 客户自助注册（B2）。
 *
 * 体（`application/json`，≤8 KiB）：`{ phone?, email?, password }`（**手机号优先**，二选一必给）
 *   - 标识由 `users.js` 归一化（手机号去空白/`-`/`()`、去首个 `+`，不剥国家码；邮箱 trim+小写）
 *   - 口令**不做 trim / 归一化**（B1 刻意口径：按调用方给的 UTF-8 字节逐字节参与 scrypt）
 *
 * 响应：
 *   201 `{ ok:true, session:{token,token_type,expires_in,expires_at}, user:{...} }`
 *   400 INVALID_INPUT    标识非法 / 口令不合政策 / 体不是合法 JSON 对象
 *   409 ALREADY_EXISTS   该标识已注册
 *   429 RATE_LIMITED     同一 IP 1 小时超过 5 次（`AUTH_THROTTLE.REGISTER`）
 *   503 NOT_CONFIGURED   存储不可用，或服务端未配置会话密钥（fail-closed，不给半成品账号）
 *   413 BODY_TOO_LARGE   体超过 8 KiB
 *   405 METHOD_NOT_ALLOWED（`Allow: POST`）
 *
 * 顺序纪律：**先建账号 → 再签会话**；签名失败（缺密钥）⇒ 503（账号已建，用户可用 login 重试），
 * 绝不返回「有账号没会话」的 201。
 */
import {
  SESSION_DEFAULT_TTL_SECONDS,
  failureOf,
  issueSession
} from '../accountContract.js'
import { checkPasswordPolicy } from '../passwordHash.js'
import { AUTH_THROTTLE } from '../ratelimit.js'
import { clientIpOf, createRouteHandler } from '../routeHandler.js'
import { create as createUser } from '../users.js'

/** 输入形状校验（类型错了是调用方错误 ⇒ 400；不 trim 口令）。 */
function readInput(body) {
  const phone = body.phone
  const email = body.email
  const password = body.password
  if (phone === undefined && email === undefined) return { ok: false }
  if (phone !== undefined && typeof phone !== 'string') return { ok: false }
  if (email !== undefined && typeof email !== 'string') return { ok: false }
  if (typeof password !== 'string') return { ok: false }
  if (!checkPasswordPolicy(password).ok) return { ok: false }
  return { ok: true, phone, email, password }
}

export function createRegisterHandler(options = {}) {
  return createRouteHandler('v1/auth/register', {
    methods: ['POST'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    throttleOptions: options.throttleOptions,
    throttles: [
      {
        ...AUTH_THROTTLE.REGISTER,
        identifierOf: ({ req }) => clientIpOf(req)
      }
    ],
    run: async ({ body, db }) => {
      const input = readInput(body || {})
      if (!input.ok) {
        return { status: 400, body: { ok: false, reason: 'INVALID_INPUT', message: '手机号/邮箱或口令不符合要求。' } }
      }

      const created = await createUser(db, {
        phone: input.phone,
        email: input.email,
        password: input.password
      })
      if (!created.ok) {
        const failure = failureOf(created.reason)
        if (failure.status === 503) {
          console.error(`[api/v1/auth/register] storage unavailable reason=${created.reason}`)
        }
        return {
          status: failure.status,
          body: {
            ok: false,
            reason: failure.reason,
            message:
              failure.reason === 'ALREADY_EXISTS'
                ? '该手机号或邮箱已注册。'
                : failure.status === 503
                  ? '注册服务暂时不可用，请稍后重试。'
                  : '手机号/邮箱或口令不符合要求。'
          }
        }
      }

      const issued = issueSession(created.user, {
        ttlSeconds: SESSION_DEFAULT_TTL_SECONDS,
        nowSeconds: options.nowSeconds,
        secret: options.secret
      })
      if (!issued.ok) {
        return { status: 503, body: { ok: false, reason: 'NOT_CONFIGURED', message: '注册服务暂时不可用，请稍后重试。' } }
      }

      return { status: 201, body: { ok: true, session: issued.session, user: created.user } }
    }
  })
}

export default createRegisterHandler()
