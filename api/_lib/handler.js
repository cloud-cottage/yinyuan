/**
 * GET 处理器工厂（印源对外只读 API v1）。
 *
 * 判定顺序（三端点一致，勿改）：
 *   1) 方法非 GET               ⇒ 405 METHOD_NOT_ALLOWED（带 Allow: GET）
 *   2) 未配置 `YINYUAN_API_KEY`  ⇒ 503 NOT_CONFIGURED
 *   3) key 缺失或不匹配          ⇒ 401 UNAUTHORIZED
 *   4) 未配置任一 `CB_*`         ⇒ 503 NOT_CONFIGURED（**不回落假数据/静态快照**）
 *   5) 实例级缓存命中            ⇒ 200（**不再打云库**；键含鉴权指纹；只缓存成功数据）
 *   6) 取数失败                 ⇒ 500 INTERNAL_ERROR（对外只给固定文案，细节只进服务端日志）
 *
 * 每个 handler 都是 Vercel 可直接调用的默认导出 `(req, res) => Promise<void>`。
 */
import { checkApiKey, extractApiKey } from './auth.js'
import { isCloudBaseConfigured } from './cloudbase.js'
import { handlePreflight } from './cors.js'
import { authFingerprint, cacheKeyOf, markHit, markMiss, readCache, writeCache } from './instance-cache.js'
import { getSearchParams } from './pagination.js'
import { enforceRateLimit } from './ratelimit.js'
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
    const startedAt = Date.now()
    try {
      const method = String((req && req.method) || 'GET').toUpperCase()
      // ★ CORS 预检（v1.42 §7.13-3 ④ ／ ⑥）：`OPTIONS` ＋ `Origin` ＋
      //   `Access-Control-Request-Method` ⇒ 204 无体三头齐，**先于方法门**。
      //   非预检 `OPTIONS`（缺任一头）不命中 ⇒ 继续落到下面的方法门，仍 405 ＋ `Allow: GET`。
      if (handlePreflight(req, res)) return
      if (method !== 'GET') {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET')
        return failWith(res, 405, 'METHOD_NOT_ALLOWED')
      }

      const authResult = checkApiKey(req)
      if (!authResult.ok) return failWith(res, authResult.status, authResult.reason)

      if (!isCloudBaseConfigured()) return failWith(res, 503, 'NOT_CONFIGURED')

      // ★ 每日限额（v1.43 §7.13-2 ／ §7.14-1 ／ AC-130 ～ AC-132）：计数点钉在
      //   「方法门 → 鉴权 → 路由命中 → 数据源已配置」**之后** ⇒ `401` ／ `404` ／ `405` ／ `503`
      //   与预检 `OPTIONS` 一律不计数（计数面 ＝ 鉴权通过后的全部请求，含 200 ／ 400 ／ 500）。
      //   **存储不可用 / 超时 ⇒ 放行且不 5xx**（降级在 ratelimit.js 内完成，只留一行服务端日志）；
      //   超限时本函数已回 `429` ＋ `RATE_LIMITED`（错误面：no-store、无 CDN 指令、带 CORS）。
      const withinQuota = await enforceRateLimit(req, res, extractApiKey(req))
      if (!withinQuota) return undefined

      // ★ 实例级缓存（2026-10-17 并发修复）：**鉴权通过之后**才查缓存，
      //   且缓存键内含**鉴权指纹**（sha256(key) 前 16 位）⇒ 金钥错配取不到别人的 200 缓存体；
      //   错误面（401/405/503/500）走各自分支，永不读也永不写本缓存。
      const cacheKey = cacheKeyOf(routeName, req, authFingerprint(extractApiKey(req)))
      const cached = readCache(cacheKey)
      if (cached !== null) {
        markHit()
        // 诊断：只记路由 + 请求形状（limit/offset 白名单化）+ 毫秒；不含 key、不含缓存键原文
        console.log(
          `[api/${routeName}] ok cache=hit ms=${Date.now() - startedAt} params=${describeShape(req)}`
        )
        return ok(res, cached)
      }
      markMiss()

      // 取数带**请求级软截止**：到点由本服务回 500（契约内），不落到平台层函数超时页
      const data = await withDeadline(run(req), READ_DEADLINE_MS)
      // ★ 只有成功取数才写缓存（失败分支在 catch 里，不经过这里）
      writeCache(cacheKey, data)
      console.log(
        `[api/${routeName}] ok cache=miss ms=${Date.now() - startedAt} params=${describeShape(req)}`
      )
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
