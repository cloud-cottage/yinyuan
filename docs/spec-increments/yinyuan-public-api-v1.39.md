# 增量件 · 印源 v1.39 —— 对外只读 API v1 登记（契约 / 鉴权 / 部署 / 值域纪律 / 数据现状）＋ §12 V 组 AC-102 ～ AC-111 ＋ W 行两条

- **单号**：J-yinyuan-v139（Jing / 规范方 · 印源线）
- **升版**：`docs/yinyuan-web.spec.md` **v1.38 → v1.39**（文件名不变）
- **基线（开工自算，与派单基线一致）**：主文件 md5 `e1b5d515fae7f83f59bc504059a18f94` / `wc -l` **1965 行** / **767,235 B**（**该文件无末行换行符**：`wc -l` 报 1965、`splitlines()` 报 **1966 行** —— **1966 行为真值**）；**AC 判据行 101 条**
- **快照**：**新建** `docs/versions/yinyuan-web.spec.v1.38.md` ＝ **改版前 v1.38 的逐字节副本**（`cp -p` → `cmp` **无差异**；md5 与改前主文件同为 `e1b5d515fae7f83f59bc504059a18f94`、**1965 行 / 767,235 B**；既有 `docs/versions/yinyuan-web.spec.v1.37.md` 未动）
- **来源**：**上线事实与契约面 ＝ 本会话（Zang）2026-10-17 派单 ＋ 本仓 `api/**` 代码只读核对 ＋ 线上探针**；**Kevin 2026-10-17 裁定：印文清单只取正式集合**；**数据现状与会话读数 ＝ 本文核验时点的只读实测**
- **AC 续号**：上版末号 **AC-101** ⇒ 本版 **AC-102 ～ AC-111**（**无重号、无跳号**）；**AC 计数 101 → 111**
- **性质**：**契约首度登记（本文件此前无任何对外只读 API 条款）＋ 判据新增 ＋ 待裁项登记**；**零取代**（历史行 / 既有条款逐字保留）

**开工实测（本单自跑，作为本版结论的实证）**

```
$ md5 docs/yinyuan-web.spec.md                        → e1b5d515fae7f83f59bc504059a18f94（改前）
$ wc -l -c docs/yinyuan-web.spec.md                   → 1965 767235（改前；splitlines＝1966 行）
$ grep -c '^- \[ \] AC-' docs/yinyuan-web.spec.md     → 101（改前）
$ cmp docs/yinyuan-web.spec.md docs/versions/yinyuan-web.spec.v1.38.md → 无差异（逐字节一致）

# 线上契约面（目标 https://yinyuan2026.vercel.app；核验时点 2026-10-17 08:59–09:02（CST））
$ curl -s -o /dev/null -w '%{http_code} %{content_type}' https://yinyuan2026.vercel.app/api/v1/dynasties      → 401 application/json（无 key）
$ curl … -H 'Authorization: ApiKey <错key>' …/api/v1/dynasties                                                → 401 application/json
$ curl … -H 'X-API-Key: <错key>' …/api/v1/dynasties                                                           → 401 application/json
$ curl -X POST …/api/v1/dynasties                                                                            → 405（Allow: GET）
$ curl …/api/xyz / /api/v1/bogus / /api/v1/ / /api                                                           → 404 application/json ×4（裸 /api 体＝{"ok":false,"reason":"NOT_FOUND","message":"接口不存在。"}）
$ curl https://yinyuan2026.vercel.app/                                                                        → 200 text/html（首页未被 api 兜底截走）
# 带合法 key（值不入仓、不入本件）
$ …/api/v1/dynasties        → 200；data.total=15；items[].seq 1…15；counts{faces:{戰國:23},seals:{戰國:23}}；unrecorded{faces:56,seals:56}
$ …/api/v1/authors?limit=1  → 200；data.total=300；14 字段逐字
$ …/api/v1/authors?limit=300&offset=299 → 200；data.limit 回显 200（截断）
$ …/api/v1/authors?limit=abc → 400 INVALID_PARAM；…?offset=-1 → 400 INVALID_PARAM；…?offset=99999 → 200 items:[]
$ …/api/v1/inscriptions?limit=1（连续 4 次，含 limit=0）→ 500 INTERNAL_ERROR（★ 与派单件「三端点实测已 200」不符）

# 值域单源对拍（只读）
$ api/_lib/dynasty-contract.js 的 DYNASTY_CONTRACT 与 xiai 仓 src/data/seed.js 的 DYNASTY_OPTIONS → 15 项逐字、逐序一致

# 云库只读探针（@cloudbase/node-sdk；env liwu-d8gek6jjdab1d087c）
xiai_persons 300 ／ xiai_person_imports 570（状态分布 ACCEPTED 570；与正式集合对齐后 270 未落正式集合）
xiai_seals 79 ／ xiai_faces 79（合计 158）／ xiai_seal_imports 3681（REJECTED 2604、PENDING 1077）／ xiai_face_imports 不存在
印文字段非空（两集合各自 79 行）：seal_name 2 ／ transcription 2 ／ dynasty 23 ／ author 0 ／ seal_type 0

# 本地真库（只读 mode=ro）
/Users/kevin/bistro/data/yinpu.db：seals 79 行；seal_name 非空 2、transcription 非空 2；stamps 8708 行、text 非空 2655（两表口径不同）
```

## 一、九项落位总览

| # | 事项 | 落点 | 判据 / 产物 |
| --- | --- | --- | --- |
| ① | **端点与语义**（三端点 / 方法门 / 合并与排序 / 不进 SPA 路由表） | **§7.10-1** | AC-102 / AC-103 / AC-110 |
| ② | **统一响应信封与错误面**（ok/data 与 ok:false/reason/message；六值封闭枚举；判定顺序；固定文案；响应头；遮罩纪律） | **§7.10-2** | AC-102 / AC-103 / AC-105 |
| ③ | **分页语义**（limit 缺省 50 / 上限 200 截断 / offset ≥ 0 / 非法 ⇒ 400 / 越界 ⇒ 空 items） | **§7.10-3** | AC-107 |
| ④ | **字段面逐字**（dynasties data 形状；authors 14 字段；inscriptions 7 字段；空值口径；不透内部字段） | **§7.10-4** | AC-108 |
| ⑤ | **鉴权面**（`Authorization: ApiKey <key>` ／ `X-API-Key: <key>`；key 只存 Vercel 环境变量 `YINYUAN_API_KEY`，**规范只写变量名**；未配 ⇒ 503 且**不回落假数据 / 静态快照**） | **§7.10-5** | AC-104 / AC-105 |
| ⑥ | **部署面与路由面**（外网地址 / Vercel 项目名 / push `main` 自动部署 / 环境变量四键 / `vercel.json` 兜底与 `api/` 排除式 / 公开仓纪律） | **§7.10-6** | AC-111 |
| ⑦ | **与 `/docs` 页既有接口文档的关系（★ 待裁，不代 Kevin 拍板）** | **§7.10-7** ＋ **§11.2 `W-YS-2`** | 待裁项（W 行另计） |
| ⑧ | **朝代值域单源双轨同步纪律**（xiai 真源 `DYNASTY_OPTIONS` ↔ 本仓 `api/_lib/dynasty-contract.js`；变更同步义务；读路径旧值原样） | **§7.10-8** | AC-109 |
| ⑨ | **数据现状如实登记（不得据此判负、不得美化）**（正式集合 300 ／ 导入行 570 全 ACCEPTED ／ 270 未落 ／ 印文字段各 2-79 ／ 本地库口径 ／ Kevin 裁定） | **§7.10-9** ＋ **§11.2 `W-YS-3`** | AC-110（只取正式集合） |

## 二、契约面逐字（落位 §7.10-1 ～ §7.10-4）

- **端点**：`GET /api/v1/dynasties`（**冻结 15 类值域 ＋ 库内 `counts` ＋ `unrecorded`**）｜`GET /api/v1/authors`（**正式集合 `xiai_persons`**）｜`GET /api/v1/inscriptions`（**正式集合 `xiai_seals` ＋ `xiai_faces`，合并序列，`total` ＝ 两集合之和**）。
- **信封**：成功 `200 {ok:true, data}`；失败 `{ok:false, reason, message}`（**无 `data`**）。
- **错误面**：`INVALID_PARAM`(400)｜`UNAUTHORIZED`(401)｜`NOT_FOUND`(404)｜`METHOD_NOT_ALLOWED`(405)｜`INTERNAL_ERROR`(500)｜`NOT_CONFIGURED`(503)。
- **判定顺序**：方法 → key 配置 → key 校验 → 数据源配置 → 取数（**不得调换**）。
- **字段面**：`authors.items[]` 14 字段 ＝ `id / source_person_id / name / family_name / given_name / courtesy_names / art_names / alias_names / birth_year / death_year / dynasty / native_place / biography / source`；`inscriptions.items[]` 7 字段 ＝ `id / collection / seal_name / transcription / author / dynasty / seal_type`。

## 三、待裁项（不代 Kevin 拍板）

| W 行 | 待裁内容 | 现状差异（核验时点 2026-10-17） | 本版处置 |
| --- | --- | --- | --- |
| **`W-YS-2`** | **`/api/v1/**`（新上线）与 `/docs` 页既有接口文档的并存 / 取代 / 演进关系** | **既有 `/docs` 页**（内容源 `src/config/apidoc.js` ＋ `src/config/apidoc-endpoints.js`）＝ 基础地址 `https://api.example.com/yinyuan/v1`，端点 `/yinyuan/v1/all`（**每日最多 1000 次**）／`/preview/{resourceId}`／`/preview/batch`／`/detail/{resourceId}`／`/search/`／`/bill`；**新上线** ＝ `/api/v1/**` 三端点（**无「每日 1000 次」类限制**）⇒ **域名 / 路径 / 语义 / 字段面均不同** | **不代裁、不预判**；**`/docs` 页零改写**；**两份契约并存不得被按「已取代」处理** |
| **`W-YS-3`** | **正式集合缺行与印文字段空值的处置时点与对客披露口径** | `xiai_person_imports` **570 全 `ACCEPTED`** 而 **270 未落正式集合**；`xiai_seals` / `xiai_faces` 各 79 行而 **`seal_name` / `transcription` 各仅 2 行非空** | **只登记、不改实现、不美化**；**对外如实返回空值**（不编造填充）；**不回落导入行**（Kevin 2026-10-17 裁定） |

## 四、判据与统计影响

- **新增判据**：**§12 V 组（AC-V 系列）AC-102 ～ AC-111（10 条）**；**AC 计数 101 → 111**。
- **未变动项**：**§2.2 路由表仍 14 条**（`/api/**` **不进 SPA 路由表**，**AC-88 / AC-89 扫描面不变**）；**AC-01 ～ AC-101 判据实质一字未改**；**§0.1 R1–R14 一字未改**；**端口 5164 / `strictPort` 未动**；**§9.3 必填 11 项 / §9.4 幂等键口径一字未改**；**待决项仍 20 条 / 挂账项仍 2 条 / §0.7 冲突登记仍 6 行**（**W 行另计**）。
- **三处（实为四处）同步**：表头「版本」字段行首前置 v1.39 段 ＋ 表头「最近修订」块新增 v1.39 行 ＋ §0.5 变更记录表新增 v1.39 行 ＋ 页脚横幅 v1.39（另加 §0.7 v1.39 状态行 / §11.2 v1.39 补记 / §12 组导航 v1.39 续行）。

## 五、如实登记的两处「派单 ↔ 事实差异」（详见 §0.7 v1.39 状态行）

1. **三端点状态**：派单件称「三端点实测已 200」；**本文核验时点实测 ＝ `dynasties` 200 / `authors` 200、`inscriptions` 连续 4 次 `500 INTERNAL_ERROR`**（同一分钟内另两端点均 200 ⇒ 非全局故障）⇒ **本版未把三端点写成「已 200」**；**缺陷定位与修复归实现线**（**本文件零实现改动**）。
2. **本地真库口径**：派单件称 `bistro/data/yinpu.db`「同样只有 2 条有印文」；**实测该说法成立于 `seals` 表**（79 行；`seal_name` / `transcription` 各 2 行非空），而**同库 `stamps` 表 8,708 行、`text` 非空 2,655 行** ⇒ **本版限定到 `seals` 表登记，未沿用易被误读为全库的表述**。
   另记**一处措辞差异**：派单件称 `/docs` 页为「2 接口文档」，**实测该页端点 ≥ 6 条** ⇒ **按逐字核对到的清单登记**。

## 六、写入范围与边界

- **写入** ＝ **仅 `docs/yinyuan-web.spec.md`（升 v1.39）＋ 新建 `docs/versions/yinyuan-web.spec.v1.38.md`（改前逐字节快照）＋ 本增量件 `docs/spec-increments/yinyuan-public-api-v1.39.md`**。
- **未触碰**：`src/**`、`api/**`、`vercel.json`、`mockups/**`、`docs/xiai.spec.md`（**实现代码与 Vercel 配置零写入**）；**未改 Vercel 环境变量 / 未触发部署 CLI / 未跑质检 / 未起服务 / 未占端口 / 未 kill 任何进程**。
- **未做**：**未对拍「线上构建 ＝ 本仓 HEAD 构建」**（§7.10-6 已如实注明只登记 git 集成关系）；**503 面未在线上复现**（生产环境变量齐备，故 503 面为**契约面登记 ＋ 可复跑方式**，非线上实测）。
- **读取路径提示（非文件事实）**：本单核对时发现，**含 `Authorization: ApiKey <key>` 形态的长行在部分读取路径下会被掩码为 `ApiKey ***`**（逐字节检查确认**文件内容完好**：`Authorization: ApiKey <key>` 与 `X-API-Key: <key>` 各 5 处逐字在盘）—— **判「文件损坏」一律以 `cmp` / 逐字节比对为准**。
