/**
 * 演示账号的**服务端内侧**标识（2026-10-19 演示一键登录）。
 *
 * ★ 唯一来源：演示账号邮箱只在这里硬定（可被 `YINYUAN_DEMO_EMAIL` 覆盖，便于换环境），
 *   **绝不从请求体接收账号或口令**——请求方能指定账号就等于拿到「代签任意账号会话」的口子。
 * ★ 与 `src/config/app-config.js` 的 `demo.account` 同值（默认 `demo@yinyuan.example`）：
 *   前者是对外**展示**用的公开字段，后者是服务端**查找**用的键；两边改一处须同轮改另一处
 *   （`POST /api/v1/auth/demo-login` 只认本文件）。
 * ★ 口令不参与：演示登录不校验口令，因此本模块**没有**任何口令/散列常量。
 */
import { normalizeEmail } from './users.js'

/** 缺省演示账号邮箱（与种子脚本 `scripts/seed-demo-account.mjs` 的默认值一致）。 */
export const DEMO_ACCOUNT_EMAIL_DEFAULT = 'demo@yinyuan.example'

/**
 * 取演示账号标识（归一化后的邮箱）。
 * 环境变量缺省/形态非法 ⇒ 回落缺省值（**不抛**：演示登录不该因一个错配的 env 变 500）。
 * @param {object} [env] 进程环境（自检可注入）
 * @returns {string}
 */
export function demoAccountEmail(env = process.env) {
  const raw = env && typeof env.YINYUAN_DEMO_EMAIL === 'string' ? env.YINYUAN_DEMO_EMAIL : ''
  return normalizeEmail(raw) || DEMO_ACCOUNT_EMAIL_DEFAULT
}
