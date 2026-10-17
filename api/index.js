/**
 * `/api`（裸路径）兜底：返回 **JSON 404**。
 *
 * 背景：`vercel.json` 末条 SPA 兜底排除式排除的是 `api/`（带斜杠），裸 `/api` 仍会被改写成
 * index.html；本文件把 `/api` 占成真实函数路由（文件系统匹配优先于 rewrite）⇒ 不再落 SPA HTML。
 * 同上，`/api/**` 的其它未命中路径由 `api/[...path].js` 兜住。
 */
import { failWith } from './_lib/respond.js'

export default function handler(req, res) {
  failWith(res, 404, 'NOT_FOUND')
}
