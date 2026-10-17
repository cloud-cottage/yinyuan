/**
 * GET 处理器工厂（印源对外只读 API v1）。
 *
 * 判定顺序（三端点一致，勿改）：
 *   1) 方法非 GET               ⇒ 405 METHOD_NOT_ALLOWED（带 Allow: GET）
 *   2) 未配置 `YINYUAN_API_KEY`  ⇒ 503 NOT_CONFIGURED
 *   3) key 缺失或不匹配          ⇒ 401 UNAUTHORIZED
 *   4) 未配置任一 `CB_*`         ⇒ 503 NOT_CONFIGURED（**不回落假数据/静态快照**）
 *   5) 取数失败                 ⇒ 500 INTERNAL_ERROR（对外只给固定文案，细节只进服务端日志）
 *
 * 每个 handler 都是 Vercel 可直接调用的默认导出 `(req, res) => Promise<void>`。
 */
import { checkApiKey } from './auth.js'
import { isCloudBaseConfigured } from './cloudbase.js'
import { InvalidParamError, NotConfiguredError, fail, failWith, ok } from './respond.js'

export function createGetHandler(routeName, run) {
  return async function handler(req, res) {
    try {
      const method = String((req && req.method) || 'GET').toUpperCase()
      if (method !== 'GET') {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET')
        return failWith(res, 405, 'METHOD_NOT_ALLOWED')
      }

      const authResult = checkApiKey(req)
      if (!authResult.ok) return failWith(res, authResult.status, authResult.reason)

      if (!isCloudBaseConfigured()) return failWith(res, 503, 'NOT_CONFIGURED')

      const data = await run(req)
      return ok(res, data)
    } catch (error) {
      if (error instanceof InvalidParamError) {
        return fail(res, 400, 'INVALID_PARAM', error.message)
      }
      if (error instanceof NotConfiguredError) {
        return failWith(res, 503, 'NOT_CONFIGURED')
      }
      // 内部细节只进服务端日志，不进响应体（避免泄漏集合名 / 字段名 / 凭据形态）
      console.error(`[api/${routeName}] read failed: ${(error && error.message) || error}`)
      return failWith(res, 500, 'INTERNAL_ERROR')
    }
  }
}
