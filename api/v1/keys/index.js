/**
 * `/api/v1/keys`（0 段入口）—— **薄再导出**，不含任何逻辑。
 *
 * 三个密钥端点的实现与路径分派全部在 `./[...path].js`（唯一来源）；本文件只保证
 * 「精确路径 `/api/v1/keys`」有一个静态文件接住（静态优先于动态段，行为确定），
 * 并留一条 `vercel.json` 兜底 rewrite 的落点（`/api/v1/keys` ⇒ `api/v1/keys/index.js`）。
 *
 * 默认导出刻意指向 **0 段 handler 本身**（而非分派器）：静态入口不依赖 URL 解析。
 */
export { createKeysHandler as default, createKeysHandler } from './[...path].js'
