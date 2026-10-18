/**
 * 用 esbuild 打包 `scripts/smoke-console-api.mjs`（解析 `@` 别名 + 注入 `import.meta.env`）后执行。
 *
 * 与 `scripts/build-smoke.mjs` 同套路，差别只有两点：
 *   · `VITE_DATA_SOURCE=api`（本单验证的是真实实现分支）；
 *   · 产物与日志独立命名，避免与 mock 冒烟互相覆盖。
 *
 * 用法：`node scripts/build-smoke-console-api.mjs`（不依赖 dev server，全程假 fetch）
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = join(tmpdir(), 'yinyuan-console-api-smoke.mjs')
const env = JSON.stringify({ VITE_DATA_SOURCE: 'api', VITE_API_BASE_URL: '/api/v1', MODE: 'production' })

execFileSync('npx', ['esbuild', 'scripts/smoke-console-api.mjs', '--bundle', '--format=esm', '--platform=node',
  '--target=node18', `--outfile=${outfile}`, `--alias:@=${join(root, 'src')}`, `--define:import.meta.env=${env}`,
  '--log-level=warning'], { cwd: root, stdio: 'inherit' })

execFileSync(process.execPath, [outfile], { cwd: root, stdio: 'inherit' })
