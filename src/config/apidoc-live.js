/**
 * API 文档内容 —— 第三段：**已上线接口**章节（3 个已开放调用的只读端点）。
 *
 * 单一真源拆分：本文件与 `apidoc.js` / `apidoc-endpoints.js` 合计 3 个内容模块，
 * `apidoc.js` 负责汇总导出，页面只从 `@/config/apidoc.js` 读数据（本文件不直接对外）。
 *
 * 口径来源（不在此处复述规范正文，只落对客文案）：
 *   规范 v1.43 §7.14-2（W-YS-9 结案）／ 判据 AC-137 ～ AC-142。
 *
 * 撰写纪律：
 *   - 对客措辞：只说「能拿到什么、怎么传参、返回什么、有什么限制」；
 *     不写实现者口吻与实现细节（规范 §7.14-2 ⑩）。
 *   - 字段清单与线上真实响应逐字一致（`authors` 14 字段 / `inscriptions` 7 字段 /
 *     `dynasties` 四块）；字段名一律用响应里的原名，不改写、不自造别名。
 *   - `total` 为动态值：示例一律用占位表达，并注明「示例值，实际以响应为准」。
 *   - 既有 6 个端点的「规划中，暂未开放」章节（`apidoc-endpoints.js`）与本模块并存，
 *     本模块只新增、不改动、不合并既有章节。
 *
 * parts 片段类型：{ t } 纯文本 · { c } 行内代码 · { b } 加粗
 * 块类型：h1 h2 h3 p strong? code quote ul ol table hr
 */

const BASE = 'https://yinyuan2026.vercel.app/api/v1'

/** 六个端点共用的鉴权头说明。 */
const authParts = [
  { t: '请求头须携带 ' },
  { c: 'Authorization: ApiKey <key>' },
  { t: '。若未携带该头，可改用 ' },
  { c: 'X-API-Key: <key>' },
  { t: '；两个头同时出现时以 ' },
  { c: 'Authorization' },
  { t: ' 为准。其中 ' },
  { c: '<key>' },
  { t: ' 请替换为你自己的 API key。' },
]

/** 两个分页端点共用的分页说明。 */
const pagingParts = [
  { c: 'limit' },
  { t: '：每页条数，缺省 ' },
  { c: '50' },
  { t: '，上限 ' },
  { c: '200' },
  { t: '（超过上限按上限截断，不报错）。' },
  { c: 'offset' },
  { t: '：起始位置，缺省 ' },
  { c: '0' },
  { t: '，须 ≥ 0。' },
  { c: 'limit' },
  { t: ' 与 ' },
  { c: 'offset' },
  { t: ' 均须为非负整数，否则返回 ' },
  { c: '400' },
  { t: ' 与 ' },
  { c: 'INVALID_PARAM' },
  { t: '。' },
]

/** 六个端点共用的错误码与限流说明（七值 ＋ 429 三要素）。 */
const errorCodeParts = [
  { t: '错误码：' },
  { c: '400 INVALID_PARAM' },
  { t: '、' },
  { c: '401 UNAUTHORIZED' },
  { t: '、' },
  { c: '404 NOT_FOUND' },
  { t: '、' },
  { c: '405 METHOD_NOT_ALLOWED' },
  { t: '、' },
  { c: '429 RATE_LIMITED' },
  { t: '、' },
  { c: '500 INTERNAL_ERROR' },
  { t: '、' },
  { c: '503 NOT_CONFIGURED' },
  { t: '（含义见本章「错误码与限流」）。限流：每日最多 1000 次，按 API key 计数，按自然日（Asia/Shanghai）00:00:00 重置；当日超出上限后返回 ' },
  { c: '429' },
  { t: '，当日不可再调用，请次日再试。' },
]

export const liveBlocks = [
  { type: 'h2', t: '已上线接口（3 个）' },
  {
    type: 'p',
    parts: [
      { t: '本章列出当前可调用的 3 个只读接口，基础地址：' },
      { c: BASE },
      { t: '。三个接口的请求方法均为 ' },
      { c: 'GET' },
      { t: '，返回统一 JSON 信封：成功为 ' },
      { c: '{ok:true,data}' },
      { t: '，失败为 ' },
      { c: '{ok:false,reason,message}' },
      { t: '（失败响应不含 ' },
      { c: 'data' },
      { t: '）。' },
    ],
  },
  {
    type: 'p',
    parts: [
      {
        t: '示例中的 ',
      },
      { c: 'total' },
      {
        t: ' 与各项计数均为示例值，实际以响应为准。',
      },
    ],
  },

  /* ---------------- 已上线接口 1：朝代值域 ---------------- */
  { type: 'h3', t: 'GET https://yinyuan2026.vercel.app/api/v1/dynasties' },
  {
    type: 'p',
    parts: [
      { t: '返回朝代值域（共 15 个朝代）与各朝代的收录条数，可用于构建按朝代筛选的选项。' },
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '路径与方法' }] },
  {
    type: 'p',
    parts: [{ c: 'GET' }, { t: ' ' }, { c: 'https://yinyuan2026.vercel.app/api/v1/dynasties' }],
  },

  { type: 'p', strong: true, parts: [{ b: '鉴权头' }] },
  { type: 'p', parts: authParts },

  { type: 'p', strong: true, parts: [{ b: '分页参数' }] },
  {
    type: 'p',
    parts: [
      { t: '本接口不分页：' },
      { c: 'limit' },
      { t: ' 与 ' },
      { c: 'offset' },
      { t: ' 一律忽略，传入任意值都不报错，始终返回全部 15 项。' },
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '返回字段' }] },
  {
    type: 'table',
    head: [[{ t: '字段' }], [{ t: '说明' }]],
    rows: [
      [[{ c: 'data.total' }], [{ t: '朝代值域条数，固定为 15。' }]],
      [[{ c: 'data.items[]' }], [{ t: '朝代列表，按对外显示顺序排列，共 15 项。' }]],
      [[{ c: 'data.items[].seq' }], [{ t: '序号，1～15。' }]],
      [[{ c: 'data.items[].value' }], [{ t: '朝代名称。' }]],
      [
        [{ c: 'data.counts.faces' }],
        [{ t: '按朝代的印面条目数；键为朝代名称，只含条数大于 0 的朝代。' }],
      ],
      [
        [{ c: 'data.counts.seals' }],
        [{ t: '按朝代的玺印条目数；键为朝代名称，只含条数大于 0 的朝代。' }],
      ],
      [[{ c: 'data.unrecorded.faces' }], [{ t: '未记录朝代的印面条目数。' }]],
      [[{ c: 'data.unrecorded.seals' }], [{ t: '未记录朝代的玺印条目数。' }]],
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  {
    type: 'code',
    t: 'curl -s -H "Authorization: ApiKey <key>" "https://yinyuan2026.vercel.app/api/v1/dynasties"',
  },

  { type: 'p', strong: true, parts: [{ b: '响应示例（示例值，实际以响应为准）' }] },
  {
    type: 'code',
    t: `{
  "ok": true,
  "data": {
    "total": 15,
    "items": [
      { "seq": 1, "value": "商周暨春秋" },
      { "seq": 2, "value": "戰國" }
    ],
    "counts": {
      "faces": { "戰國": 23 },
      "seals": { "戰國": 23 }
    },
    "unrecorded": { "faces": 56, "seals": 56 }
  }
}`,
  },
  {
    type: 'p',
    parts: [
      { t: '为便于阅读，' },
      { c: 'items' },
      { t: ' 此处只列前 2 项，响应实际返回共 15 项；' },
      { c: 'counts' },
      { t: ' 与 ' },
      { c: 'unrecorded' },
      { t: ' 为示例值，实际以响应为准。' },
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '错误码与限流' }] },
  { type: 'p', parts: errorCodeParts },

  /* ---------------- 已上线接口 2：印人（作者） ---------------- */
  { type: 'h3', t: 'GET https://yinyuan2026.vercel.app/api/v1/authors' },
  {
    type: 'p',
    parts: [{ t: '按分页返回印人（作者）名录，每页附带总条数与本次分页位置。' }],
  },

  { type: 'p', strong: true, parts: [{ b: '路径与方法' }] },
  {
    type: 'p',
    parts: [{ c: 'GET' }, { t: ' ' }, { c: 'https://yinyuan2026.vercel.app/api/v1/authors' }],
  },

  { type: 'p', strong: true, parts: [{ b: '鉴权头' }] },
  { type: 'p', parts: authParts },

  { type: 'p', strong: true, parts: [{ b: '分页参数' }] },
  { type: 'p', parts: pagingParts },
  {
    type: 'p',
    parts: [
      { c: 'limit' },
      { t: ' 超过 ' },
      { c: '200' },
      { t: ' 时按 ' },
      { c: '200' },
      { t: ' 截断，响应中的 ' },
      { c: 'limit' },
      { t: ' 即为本次生效值（' },
      { c: '200' },
      { t: '），不报错。' },
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '返回字段' }] },
  {
    type: 'table',
    head: [[{ t: '字段' }], [{ t: '说明' }]],
    rows: [
      [[{ c: 'data.total' }], [{ t: '当前收录的印人条数，动态值，以响应为准。' }]],
      [[{ c: 'data.limit' }], [{ t: '本次生效的每页条数，上限 200。' }]],
      [[{ c: 'data.offset' }], [{ t: '本次起始位置。' }]],
      [[{ c: 'data.items[]' }], [{ t: '印人列表，每项 14 个字段，见下。' }]],
      [[{ c: 'id' }], [{ t: '印人编号。' }]],
      [[{ c: 'source_person_id' }], [{ t: '来源人物编号。' }]],
      [[{ c: 'name' }], [{ t: '姓名。' }]],
      [[{ c: 'family_name' }], [{ t: '姓，字符串；可能为空。' }]],
      [[{ c: 'given_name' }], [{ t: '名，字符串；可能为空。' }]],
      [[{ c: 'courtesy_names' }], [{ t: '字，数组；无值为空数组。' }]],
      [[{ c: 'art_names' }], [{ t: '号，数组；无值为空数组。' }]],
      [[{ c: 'alias_names' }], [{ t: '别名，数组；无值为空数组。' }]],
      [[{ c: 'birth_year' }], [{ t: '生年，数字；可能为 null。' }]],
      [[{ c: 'death_year' }], [{ t: '卒年，数字；可能为 null。' }]],
      [[{ c: 'dynasty' }], [{ t: '朝代，字符串；可能为空。' }]],
      [[{ c: 'native_place' }], [{ t: '籍贯，字符串；可能为空。' }]],
      [[{ c: 'biography' }], [{ t: '小传，字符串；可能为空。' }]],
      [[{ c: 'source' }], [{ t: '资料来源，字符串；可能为空。' }]],
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  {
    type: 'code',
    t: 'curl -s -H "Authorization: ApiKey <key>" "https://yinyuan2026.vercel.app/api/v1/authors?limit=20&offset=0"',
  },

  { type: 'p', strong: true, parts: [{ b: '响应示例（示例值，实际以响应为准）' }] },
  {
    type: 'code',
    t: `{
  "ok": true,
  "data": {
    "total": <当前收录条数>,
    "limit": 20,
    "offset": 0,
    "items": [
      {
        "id": "PR000000001",
        "source_person_id": "900289963",
        "name": "郭照",
        "family_name": "郭",
        "given_name": "照",
        "courtesy_names": ["容光", "子青"],
        "art_names": ["曉樓", "曉罍"],
        "alias_names": ["郭容光", "隱吾草堂"],
        "birth_year": 1827,
        "death_year": 1895,
        "dynasty": "清中期",
        "native_place": "浙江秀水（今嘉興）人。",
        "biography": "工書，擅畫，兼擅篆刻。",
        "source": "藝林悼友錄"
      }
    ]
  }
}`,
  },

  { type: 'p', strong: true, parts: [{ b: '错误码与限流' }] },
  { type: 'p', parts: errorCodeParts },

  /* ---------------- 已上线接口 3：印文 ---------------- */
  { type: 'h3', t: 'GET https://yinyuan2026.vercel.app/api/v1/inscriptions' },
  {
    type: 'p',
    parts: [{ t: '按分页返回印文条目，含玺印与印面两类，每条附来源标记。' }],
  },

  { type: 'p', strong: true, parts: [{ b: '路径与方法' }] },
  {
    type: 'p',
    parts: [{ c: 'GET' }, { t: ' ' }, { c: 'https://yinyuan2026.vercel.app/api/v1/inscriptions' }],
  },

  { type: 'p', strong: true, parts: [{ b: '鉴权头' }] },
  { type: 'p', parts: authParts },

  { type: 'p', strong: true, parts: [{ b: '分页参数' }] },
  { type: 'p', parts: pagingParts },
  {
    type: 'p',
    parts: [
      { c: 'limit' },
      { t: ' 超过 ' },
      { c: '200' },
      { t: ' 时按 ' },
      { c: '200' },
      { t: ' 截断，响应中的 ' },
      { c: 'limit' },
      { t: ' 即为本次生效值（' },
      { c: '200' },
      { t: '），不报错。' },
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '返回字段' }] },
  {
    type: 'table',
    head: [[{ t: '字段' }], [{ t: '说明' }]],
    rows: [
      [[{ c: 'data.total' }], [{ t: '当前收录的印文条数，动态值，以响应为准。' }]],
      [[{ c: 'data.limit' }], [{ t: '本次生效的每页条数，上限 200。' }]],
      [[{ c: 'data.offset' }], [{ t: '本次起始位置。' }]],
      [[{ c: 'data.items[]' }], [{ t: '印文条目列表，每项 7 个字段，见下。' }]],
      [[{ c: 'id' }], [{ t: '条目编号。' }]],
      [
        [{ c: 'collection' }],
        [{ t: '条目来源：' }, { c: 'seals' }, { t: ' 为玺印条目，' }, { c: 'faces' }, { t: ' 为印面条目。' }],
      ],
      [[{ c: 'seal_name' }], [{ t: '印名，字符串；可能为空。' }]],
      [[{ c: 'transcription' }], [{ t: '释文，字符串；可能为空。' }]],
      [[{ c: 'author' }], [{ t: '作者，字符串；可能为空。' }]],
      [[{ c: 'dynasty' }], [{ t: '朝代，字符串；可能为空。' }]],
      [[{ c: 'seal_type' }], [{ t: '类型，字符串；可能为空。' }]],
    ],
  },

  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  {
    type: 'code',
    t: 'curl -s -H "Authorization: ApiKey <key>" "https://yinyuan2026.vercel.app/api/v1/inscriptions?limit=20&offset=0"',
  },

  { type: 'p', strong: true, parts: [{ b: '响应示例（示例值，实际以响应为准）' }] },
  {
    type: 'code',
    t: `{
  "ok": true,
  "data": {
    "total": <当前收录条数>,
    "limit": 20,
    "offset": 0,
    "items": [
      {
        "id": "1",
        "collection": "seals",
        "seal_name": "郭照印",
        "transcription": "郭照之印",
        "author": "郭照",
        "dynasty": "清中期",
        "seal_type": "白文"
      }
    ]
  }
}`,
  },

  { type: 'p', strong: true, parts: [{ b: '错误码与限流' }] },
  { type: 'p', parts: errorCodeParts },

  /* ---------------- 本章：错误码与限流 ---------------- */
  { type: 'h3', t: '错误码与限流' },
  {
    type: 'p',
    parts: [
      { t: '本章三个接口共用同一套错误信封：' },
      { c: '{"ok":false,"reason":"...","message":"..."}' },
      { t: '。' },
    ],
  },
  {
    type: 'table',
    head: [[{ t: '状态码' }], [{ t: 'reason' }], [{ t: '说明' }]],
    rows: [
      [
        [{ c: '400' }],
        [{ c: 'INVALID_PARAM' }],
        [{ t: '参数不合法，如 ' }, { c: 'limit' }, { t: ' 或 ' }, { c: 'offset' }, { t: ' 不是非负整数。' }],
      ],
      [
        [{ c: '401' }],
        [{ c: 'UNAUTHORIZED' }],
        [{ t: '未携带 API key，或 API key 无效。' }],
      ],
      [[{ c: '404' }], [{ c: 'NOT_FOUND' }], [{ t: '请求路径不存在。' }]],
      [
        [{ c: '405' }],
        [{ c: 'METHOD_NOT_ALLOWED' }],
        [{ t: '请求方法不支持，仅支持 ' }, { c: 'GET' }, { t: '。' }],
      ],
      [[{ c: '429' }], [{ c: 'RATE_LIMITED' }], [{ t: '当日调用次数已达上限。' }]],
      [
        [{ c: '500' }],
        [{ c: 'INTERNAL_ERROR' }],
        [{ t: '服务端处理失败，可稍后重试。' }],
      ],
      [[{ c: '503' }], [{ c: 'NOT_CONFIGURED' }], [{ t: '服务暂不可用。' }]],
    ],
  },
  {
    type: 'p',
    parts: [
      { t: '限流：每日最多 1000 次，按 API key 计数；按自然日（Asia/Shanghai）00:00:00 重置；当日超出上限后不可再调用，请次日再试。' },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '错误响应示例' }] },
  {
    type: 'code',
    t: `{ "ok": false, "reason": "INVALID_PARAM", "message": "参数 limit 必须是非负整数。" }
{ "ok": false, "reason": "RATE_LIMITED", "message": "今日调用次数已达上限，请明日再试。" }`,
  },

  /* ---------------- 本章：对接提示（密钥安全） ---------------- */
  { type: 'h3', t: '对接提示：浏览器直连与密钥安全' },
  {
    type: 'p',
    parts: [
      {
        t: '在浏览器或前端页面里直接使用 API key，会把密钥暴露给终端用户：浏览器开发者工具的网络面板与前端产物都能读出明文，一旦泄露即可能被盗用。',
      },
    ],
  },
  {
    type: 'p',
    parts: [
      {
        t: '官方建议：正式集成经客户自己的后端代理转发请求，API key 只保存在服务端，浏览器端只与本方的后端通信；浏览器直连只适合试用、演示、内部工具等场景。',
      },
    ],
  },
]
