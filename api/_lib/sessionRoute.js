/**
 * 会话端点的鉴权装配（**薄包装，不复制路由工厂**）。
 *
 * 目的只有一个：控制台只读端点（config / plans / account / usage\/* / ledger）共用
 * 同一套「`Authorization: Session <token>` ⇒ 回表复核 ⇒ 401/503」语义，避免 9 个端点
 * 各写一遍参数并出现口径漂移。路由生命周期（方法门 / 405 + Allow / 统一信封 / 异常映射）
 * 仍然**全部**由 `routeHandler.js::createRouteHandler` 负责。
 */
import { authenticateSession } from './sessionAuth.js'

/**
 * @param {{nowSeconds?:number, secret?:string}} [options] 仅供自检注入时钟/密钥
 * @returns {(ctx:{req:object, db:object|null}) => Promise<object>}
 */
export function sessionAuthenticator(options = {}) {
  return async ({ req, db }) =>
    authenticateSession(req, {
      db,
      nowSeconds: options.nowSeconds,
      secret: options.secret
    })
}
