/**
 * 兜底路由：任何未命中的 `/api/**` 路径一律返回 **JSON 404**。
 *
 * 为什么必须有：`vercel.json` 的末条 SPA 兜底改写默认会把 /api/** 吞成 index.html
 * （今天线上实测就是 200 + text/html）。现已把 `api/` 加进兜底排除式，
 * 但「排除后落到框架默认 404（纯文本）」仍不是对外契约想要的形态 ⇒ 用本文件钉死 JSON 信封。
 *
 * 路由优先级（Vercel 文件系统路由）：具名文件 > 动态段 > 本 catch-all
 * ⇒ `api/v1/dynasties.js` 等具名端点不会被本文件截走。
 * 说明：以 `_` 开头的文件（如 `api/_lib/*`）不会被 Vercel 注册成路由，仅作模块引用。
 */
import { failWith } from './_lib/respond.js'

export default function handler(req, res) {
  failWith(res, 404, 'NOT_FOUND')
}
