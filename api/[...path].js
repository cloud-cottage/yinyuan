/**
 * 兜底路由（单段）：`/api/<一段未知路径>` ⇒ 返回 **JSON 404**。
 *
 * ★ 命名诚实说明（2026-10-17 线上实测修正）：本文件名叫 `[...path]`（Next.js 风格的
 *   catch-all 写法），但**本仓不是 Next.js 工程**，Vercel 文件系统路由只把它注册成
 *   **单段动态段**（等价 `/api/[x]`，只吃一段），并不吃两段及以上：
 *     /api/xyz         ⇒ 命中本文件 ⇒ JSON 404 ✔（实测）
 *     /api/[...path]   ⇒ 命中本文件 ⇒ JSON 404 ✔（字面方括号＝单段）
 *     /api/v1/bogus    ⇒ **不命中**本文件 ⇒ 落 Vercel 默认纯文本 404 ✘（修复前实测）
 *     /api/v1/a/b/c    ⇒ 同上不命中 ✘
 *   多段未知路径现由 `vercel.json` 末条兜底 rewrite（`/api/(.*)` ⇒ `/api`，即 `api/index.js`）接住。
 *   （先用过 `:path*` 形态，线上实测它不吃尾斜杠 `/api/v1/` ⇒ 改用本仓已验证可用的正则组形态。）
 *   本文件保留为单段层，与那条 rewrite 输出同一信封，删掉也不影响正确性（故意不删＝不动已上线文件结构）。
 *
 * 为什么需要兜底：`vercel.json` 的 SPA 改写默认会把 /api/** 吞成 index.html
 * （早先线上实测就是 200 + text/html）。现已把 `api/` 加进兜底排除式；
 * 但「排除后落到框架默认 404（纯文本）」仍不是对外契约想要的形态 ⇒ 用本文件钉死 JSON 信封。
 *
 * 路由优先级：具名文件（api/v1/dynasties.js）> 动态段 > 兜底 rewrite；
 * 且 **文件系统优先于 vercel.json rewrites** —— 本仓实测反证：裸 `/api` 会被末条 SPA
 * 改写命中（其否定前瞻只排除 `api/` 带斜杠）却仍由 `api/index.js` 应答 ⇒ filesystem 先于 rewrites
 * ⇒ 兜底 rewrite 不会截走三个真端点。
 * 说明：以 `_` 开头的文件（如 `api/_lib/*`）不会被 Vercel 注册成路由，仅作模块引用。
 */
import { handlePreflight } from './_lib/cors.js'
import { failWith } from './_lib/respond.js'

export default function handler(req, res) {
  // 预检 ⇒ 204 三头齐（§7.13-3 ④）；非预检 `OPTIONS` 与其余方法仍落 JSON 404。
  if (handlePreflight(req, res)) return
  failWith(res, 404, 'NOT_FOUND')
}
