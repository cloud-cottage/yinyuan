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
import { getSearchParams } from './pagination.js'
import { READ_DEADLINE_MS, describeError, withDeadline } from './resilience.js'
import { InvalidParamError, NotConfiguredError, fail, failWith, ok } from './respond.js'

/** 请求形状（**只取白名单化的分页参数**：绝不回显任意查询串/请求头，key 永不入日志）。 */
function describeShape(req) {
  const params = getSearchParams(req)
  const parts = []
  for (const name of ['limit', 'offset']) {
    const raw = params.get(name)
    if (raw === null) continue
    const value = raw.trim()
    parts.push(`${name}=${/^\d{1,7}$/.test(value) ? value : 'nonNumeric'}`)
  }
  return parts.length > 0 ? parts.join('&') : '-'
}

/** 路径（去掉查询串后截断；路由路径不含凭据）。 */
function describePath(req) {
  const url = req && typeof req.url === 'string' ? req.url : ''
  const path = url.split('?')[0]
  return (path === '' ? '/' : path).slice(0, 120)
}

/** 错误摘要：单行、限长（不含堆栈、不含请求头、不含凭据）。 */
function describeMessage(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error || '')
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 160)
}

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

      // 取数带**请求级软截止**：到点由本服务回 500（契约内），不落到平台层函数超时页
      const data = await withDeadline(run(req), READ_DEADLINE_MS)
      return ok(res, data)
    } catch (error) {
      if (error instanceof InvalidParamError) {
        return fail(res, 400, 'INVALID_PARAM', error.message)
      }
      if (error instanceof NotConfiguredError) {
        return failWith(res, 503, 'NOT_CONFIGURED')
      }
      // 内部细节只进服务端日志，不进响应体（避免泄漏集合名 / 字段名 / 凭据形态）
      // 可观测性（2026-10-17 修复）：错误类名 + 错误码 + 端点 + 请求形状 + 摘要
      //   —— 便于下次直接从 vercel logs 定位；**不含 key、不含云库凭据、不含堆栈**。
      console.error(
        `[api/${routeName}] INTERNAL_ERROR method=GET path=${describePath(req)} params=${describeShape(req)} error=${(error && error.name) || 'Error'} code=${describeError(error)} message=${describeMessage(error)}`
      )
      return failWith(res, 500, 'INTERNAL_ERROR')
    }
  }
}
