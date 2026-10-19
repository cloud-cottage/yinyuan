/**
 * `/api`（裸路径）兜底：返回 **JSON 404**。
 *
 * 背景：`vercel.json` 末条 SPA 兜底排除式排除的是 `api/`（带斜杠），裸 `/api` 仍会被改写成
 * index.html；本文件把 `/api` 占成真实函数路由（文件系统匹配优先于 rewrite）⇒ 不再落 SPA HTML。
 * `/api/**` 的其它未命中路径（单段 / 多段 / 尾斜杠一律同形）现在**全部**由末条兜底 rewrite
 * `{ "/api/(.*)" ⇒ "/api" }` 接住落到本文件，输出同一个 JSON 404 信封。
 *   （2026-10-19 函数合并 21→8 时删除了 `api/[...path].js`：该文件在线上只注册成单段动态段，
 *   且本仓已实测方括号文件不可靠（commit ad6f35a 定案）；其单段 404 职责并入本文件 ——
 *   rewrite 兜底的 destination 恒为本文件，单段未知路径同样落 404 信封，形态逐字不变。）
 */
import { handlePreflight } from './_lib/cors.js'
import { failWith } from './_lib/respond.js'

export default function handler(req, res) {
  // 预检（`OPTIONS` ＋ `Origin` ＋ `Access-Control-Request-Method`）⇒ 204 三头齐（§7.13-3 ④）：
  // 未知路径同样放行预检，后续真实请求仍落下面的 JSON 404（该 404 亦带 `Allow-Origin`）。
  if (handlePreflight(req, res)) return
  failWith(res, 404, 'NOT_FOUND')
}
