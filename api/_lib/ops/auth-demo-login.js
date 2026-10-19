/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/auth/demo-login.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/auth/index.js（op=demo-login）` 按 `?op=` 分派。
 * POST /api/v1/auth/demo-login —— 演示账号**一键登录**（服务端代签；2026-10-19 Zang 裁定二）。
 *
 * ★ 为什么要有这个端点：`/config` 公开后仍**不得**下发 `demo.password`（口令入客户端即泄露），
 *   所以「一键直连演示账号」不能靠客户端拿口令再打 `/auth/login` ⇒ 由服务端代签。
 *
 * 请求：**无请求体**（不读任何账号/口令字段；多余字段一律忽略 —— 请求方不能指定账号）。
 * 响应（**与 `/auth/login` 逐字同形**）：
 *   200 `{ ok:true, session:{token,token_type:'Session',expires_in,expires_at},
 *          user:{id,phone,email,role,status,createdAt,lastLoginAt} }`
 *   401 UNAUTHORIZED    演示账号不存在 / 已停用 —— **不自动建号、不回落 mock**
 *   429 RATE_LIMITED    同一 IP 10 分钟超 30 次（`AUTH_THROTTLE.DEMO_LOGIN_IP`，与 login 同量级）
 *   503 NOT_CONFIGURED  账号表不可用 / 服务端缺会话密钥
 *   405 METHOD_NOT_ALLOWED（`Allow: POST`）
 *
 * ★ 账号来源：只在服务端内侧硬定（`api/_lib/demoAccount.js`，默认 `demo@yinyuan.example`），
 *   可能被 `YINYUAN_DEMO_EMAIL` 覆盖；**不从请求体读**。
 * ★ 不校验口令（请求里根本没有口令）⇒ 响应与日志**没有任何口令/散列**；
 *   日志只记「状态码 + 方法 + 毫秒」与拒绝原因码，不记账号、不记令牌。
 * ★ `status === 'active'` 检查**照做**（演示身份不是跳过停用的理由）。
 * ★ 唯一写操作：沿用既有 login 路径的 `updateLastLogin`（best-effort，写失败不影响本次签发）。
 * ★ 复用 `issueSession` / `signSession` 与账号表读面，**不另写一套**签发逻辑。
 */
import {
  SESSION_DEFAULT_TTL_SECONDS,
  failureOf,
  issueSession
} from '../accountContract.js'
import { demoAccountEmail } from '../demoAccount.js'
import { AUTH_THROTTLE } from '../ratelimit.js'
import { clientIpOf, createRouteHandler } from '../routeHandler.js'
import { findByEmail, toPublicUser, updateLastLogin } from '../users.js'

/** 对外统一失败面（不含「账号不存在 / 已停用」的区分，不给探测面）。 */
const DEMO_LOGIN_FAILED = {
  ok: false,
  reason: 'UNAUTHORIZED',
  message: '演示账号不可用。'
}

export function createDemoLoginHandler(options = {}) {
  return createRouteHandler('v1/auth/demo-login', {
    methods: ['POST'],
    db: options.db || null,
    bodyLimitBytes: options.bodyLimitBytes,
    throttleOptions: options.throttleOptions,
    throttles: [
      { ...AUTH_THROTTLE.DEMO_LOGIN_IP, identifierOf: ({ req }) => clientIpOf(req) }
    ],
    run: async ({ db }) => {
      // 账号标识只来自服务端常量/env；即使请求体里有 email/password 也不看（此处不透传 body）
      const found = await findByEmail(db, demoAccountEmail(options.env))
      if (!found.ok) {
        console.error(`[api/v1/auth/demo-login] storage unavailable reason=${found.reason}`)
        const failure = failureOf(found.reason)
        return {
          status: failure.status,
          body: { ok: false, reason: failure.reason, message: '演示登录暂时不可用，请稍后重试。' }
        }
      }

      const row = found.user
      if (!row) {
        console.warn('[api/v1/auth/demo-login] rejected reason=DEMO_ACCOUNT_NOT_FOUND')
        return { status: 401, body: DEMO_LOGIN_FAILED }
      }
      if (String(row.status || '') !== 'active') {
        // 停用即 401（与 login 同口径：不告诉调用方「账号被停用了」）
        console.warn('[api/v1/auth/demo-login] rejected reason=ACCOUNT_DISABLED')
        return { status: 401, body: DEMO_LOGIN_FAILED }
      }

      // 登录时刻：沿用既有 login 的 `updateLastLogin`（**本端点唯一的写操作**，只写 `last_login_at`）。
      // ★ 这里 await 并在失败时忽略（仍需 best-effort：写失败不影响本次签发）。
      //   为什么不等价于 `login.js` 的 `void …`：响应一返回实例即冻结，未完成的写会被丢掉
      //   （本地 vercel dev 实测：`void` 写法下 `last_login_at` 不落库）⇒ 演示登录要让
      //   「最近登录」真能看见，故等写完再发响应。
      try {
        await updateLastLogin(db, row._id, options.now)
      } catch (error) {
        // `updateLastLogin` 内部已把失败转成 `{ok:false}` 并记一行日志；这里只兜底抛错
      }

      const user = toPublicUser(row)
      const issued = issueSession(user, {
        ttlSeconds: SESSION_DEFAULT_TTL_SECONDS,
        nowSeconds: options.nowSeconds,
        secret: options.secret
      })
      if (!issued.ok) {
        return {
          status: 503,
          body: { ok: false, reason: 'NOT_CONFIGURED', message: '演示登录暂时不可用，请稍后重试。' }
        }
      }
      return { status: 200, body: { ok: true, session: issued.session, user } }
    }
  })
}

export default createDemoLoginHandler()
