# 印源 Web 规范增量件 — v1.45（控制台真实数据面与计量）

- **版本**：v1.44 → **v1.45**（2026-10-19；修订人 Jing；只写规范／口径／判据＋快照＋增量件，不写任何产品代码、不改部署、不跑质检）
- **来源**：Zang 2026-10-19 派单事实（印源「真实数据上线」：生产已切 `api` 数据源并部署）＋ 实现方自报（含实测读数）＋ 本单只读代码核对（`api/**`／`src/**`／`vercel.json`／`scripts/seed-demo-account.mjs`，逐条 `path:line` 见主文件 §7.16）
- **改版前快照**：`docs/versions/yinyuan-web.spec.v1.44.md`（`cp -p`；`cmp` 逐字节一致；md5 `3c11c06f6c7854e6fe9a6e8864c6769b`；2,589 行 ／ 1,093,404 B）
- **主文件**：`docs/yinyuan-web.spec.md`（本轮落点：表头「版本」段前置、表头「最近修订」块新增 v1.45 行、§7.16 全新、§0.5 新增 v1.45 行、§0.7 v1.45 状态行、§11.2 新增 W 行四条、§12 V 组续 AC-148 ～ AC-164 ＋ 组导航 v1.45 续行、页脚横幅 v1.45）

## 一、新增章节 §7.16「控制台真实数据面与计量」（§7.16-1 ～ §7.16-10）

| 小节 | 内容（口径收口要点） |
| --- | --- |
| §7.16-1 | 部署形态：函数合并 21 → 8（恰 8 个，清单逐字；`api/_lib/**` 不注册为函数；`api/[...path].js` 已删）；rewrite 折段清单（auth×4＋me→`/api/auth?op=`、usage×5→`/api/usage?op=`、config/plans/account/ledger/seals→`/api/console?op=`、seals 单条→`?id=`、keys→`?kid=`、兜底 `/api/(.*)`→`/api`）；对外 URL 逐字不变；Hobby 上限 12；commit 链 `230edea…f02189d`＝12 个（派单称 10 ⇒ 差异登记 §0.7） |
| §7.16-2 | 公开面（config/plans/seals 列表＋单条）与会话面（account/ledger/usage×5/keys×5/me/auth-logout）封闭清单 |
| §7.16-3 | 契约面：`/config` 9 键白名单＋口令永不外发＋`demo.label` api 投影逐字；`/plans` 五块＋单一数据源；`/account` 零值投影＋不跨月结转；`/usage/*`×5 参数与 export 双口径；`/seals`（404 文案逐字、`id`/`sealId` 同值、空串口径、尺寸唯一命中否则 null）；`/ledger` 缺集合 `collectionReady:false` 如实空 |
| §7.16-4 | `POST /auth/demo-login`：无请求体；服务端账号（`YINYUAN_DEMO_EMAIL` 可覆盖）不建号 401；503／405；限流 30 次/10 分钟/IP；仅写 `last_login_at` 且 await |
| §7.16-5 | 计量：计数点＝鉴权＋限流后、实例缓存前；只计 key 通道（Session 不计；env 记 `u_org_env`/`env:default`）；429 不计数；缓存命中照计（`cacheHit` 诊断位）；明细 `ur-<sha256(traceId)前24>` 幂等＋日聚合 `ud-` unique upsert；写先于响应（响应后异步写被平台整体丢弃——实测根因）；预算 1500ms＋`METERING_FAILED` 一行 fail-open |
| §7.16-6 | `seeded` 不冒充真实（summary／records／daily 三处分列）＋演示账号预置（`demo@yinyuan.example`＋标准版 accounts 行＋近 7 天 18 条 seeded 明细；脚本幂等可重跑） |
| §7.16-7 | 前端：A18 `resolveScenarioSource` 单取数口缺项抛 `PRICING_INCOMPLETE` 不回落本地价；`stripDemoValueClaim` 声明分叉；api 模式全站零「示意值」；A25 切片不可达 CSS 占位（不重试、失败码不上屏）；A27 源尺寸透传缺口已登记未做（→ `W-YS-10`） |
| §7.16-8 | 未接线面（A19–A23／A28–A31 明确失败不伪造、页面如实「暂未接入」）＋「实现方自报（线上/部署面）」五项读数来源纪律 |
| §7.16-9 | 判据与统计影响（见下） |
| §7.16-10 | 未变动项与边界（§7.10 ～ §7.15 全节原文一字未改） |

## 二、§12 V 组续 AC-148 ～ AC-164（17 条；编号续 AC-147、无重号／无跳号；AC 计数 147 → 164；V 组 46 → 63）

| 编号 | 一句话 |
| --- | --- |
| AC-148 | 部署形态：`api/**` 恰 8 函数、≤12（Hobby）、`[...path].js` 不得回归、rewrite 折段逐条、对外 URL 逐字不变 |
| AC-149 | 公开面／会话面封闭清单（公开面不带会话数据；会话面无会话必须 401） |
| AC-150 | `/config` 9 键白名单＋口令／验证码永不外发＋`demo.label` 逐字 |
| AC-151 | `/plans` 五块＋端点侧无价目字面量＋与 `src/config/pricing.js` 同源同值 |
| AC-152 | `/account` 零值投影（`accountExists:false`＋全 0＋`planId:null`）＋包量不跨月结转 |
| AC-153 | `/usage` 五端点参数契约＋export（CSV＋BOM＋双口径表尾＋游标分批＋`truncated` 如实） |
| AC-154 | `/seals` 契约（404 文案逐字、`id`/`sealId` 同值、空串口径、尺寸唯一命中否则 null） |
| AC-155 | `/ledger` 缺集合如实空（`collectionReady:false`；聚合不作存在性判据） |
| AC-156 | demo-login 契约与不建号（无请求体／401 同形不建号／503／405／30 次/10 分钟/IP／仅写 `last_login_at` 且 await） |
| AC-157 | 计量通道与计数点（只计 key 通道；401/404/405/预检/503/429 不计；缓存命中照计＋`cacheHit`） |
| AC-158 | 计量幂等与日聚合（`ur-`/`ud-` 派生 id；聚合可由明细完整重算；八字段口径） |
| AC-159 | 写先于响应＋1500ms 预算＋`METERING_FAILED` 一行 fail-open（「响应 200 而库 0 行」即判负） |
| AC-160 | `seeded` 口径与演示预置（三处分列；示例不计入 realCalls；脚本幂等可重跑） |
| AC-161 | api 模式全站零「示意值」（AC-88 扫描面 0 命中；mock 原文不动） |
| AC-162 | `resolveScenarioSource` 不回落本地价（api 取服务端 `pricingTable`；缺项抛 `PRICING_INCOMPLETE`） |
| AC-163 | A25 切片不可达降级（`data-slice-state=placeholder`＋占位文案逐字＋不重试＋失败码不上屏） |
| AC-164 | 未接线面如实（A19–A23／A28–A31 明确失败不伪造；页面如实「暂未接入」） |

## 三、§11.2 新增 W 行四条（另计；待决项仍 20 条、挂账项仍 2 条）

| 编号 | 一句话 | 状态 |
| --- | --- | --- |
| `W-YS-10` | A27 源尺寸透传缺口（改法已登记未做；维持缺省演示尺寸不判负） | 待裁 |
| `W-YS-11` | 首页双通道声明「零真实请求」措辞在 api 模式的精度（A27 计划请求是真实 JSON 请求） | 待裁 |
| `W-YS-12` | A19–A23 ／ A28–A31 的 api 模式接线时点 | 待裁（时点待 Kevin 裁） |
| `W-YS-13` | Vercel 计划是否升 Pro（影响函数上限与未来端点扩容） | **待 Kevin 裁，不代拍** |

## 四、如实登记

- **两处「派单 ↔ 磁盘事实差异」**（§0.7 v1.45 状态行）：① commit 链 `230edea…f02189d` 计数——派单 10 ↔ `git rev-list --count` 实测 12；② usage `range` 枚举——派单 `7d|30d|90d|all|from=&to=` ↔ 代码实含 `1d`（`api/_lib/usage.js:39`）。
- **实现方自报（线上／部署面，本单未复测）**：生产 `VITE_DATA_SOURCE=api`；Hobby 12 函数报错；demo-login 不建号 0 行；`void` 写不落库；浏览器 grep 六页「示意值」0 命中。——**验收复测前不得写成「已验证」**。
- **未测项照旧**（§7.15-5）：跨 CST 零点复测、线上降级演练仍未测。
