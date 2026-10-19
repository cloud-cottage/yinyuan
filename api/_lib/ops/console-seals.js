/**
 * ★ 2026-10-19 函数合并（21→8）：本模块自 `api/v1/seals.js` 迁入 `api/_lib/ops/`（下划线目录不注册为 Serverless Function）；对外 URL / 行为 / 日志路由名逐字不变，入口改为 `api/console/index.js（op=seals）` 按 `?op=` 分派。
 * `/api/v1/seals` —— A25（列表）＋ A26（单条）**公开只读**端点，营销面用，**无需会话**。
 *
 * ★ 数据源白名单（硬约束）：只读正式集合 `xiai_seals`（79 行）＋ `xiai_faces`（79 行）；
 *   **不读** `xiai_seal_imports` / `xiai_face_imports` 等任何 `*_imports` 暂存集合。
 *   这一条是「对客只取正式集合」口径（§7.11-2 / §7.12-1）在本端点的落点，可判负。
 *
 * ★ 路由形态（与 `api/v1/keys` 同一套结论）：本仓的动态段文件（方括号文件 / `:path*`）
 *   在 Vercel **不注册**，故 `/api/v1/seals/{id}` 由平台层 rewrite 折成 query：
 *     vercel.json：`/api/v1/seals/:id` ⇒ `/api/console?op=seals&id=:id`（2026-10-19 函数合并后
 *     指向 `api/console/index.js`；位于末条 `/api/(.*)` 兜底之前，与 keys 两条同批）
 *   本文件是**单入口分派**：`?id=` 优先 ⇒ 单条；否则（`req.url` 0 段）⇒ 列表。
 *   同时兼容「URL 里带段」的直调（本地自检 / 不经 rewrite 的直调），两条通道落到同一 set of handlers。
 *
 * ★ 对外形态（统一信封，`respond.sendJson` 统一挂 `Cache-Control: no-store` 与 CORS）：
 *   GET 列表 200 `{ ok:true, data:{ items, total, limit, offset } }`
 *   GET 单条 200 `{ ok:true, data:{ …Seal } }`
 *   不存在  404 `{ ok:false, reason:'NOT_FOUND', message:'玺印条目不存在。' }`（**不得 500**）
 *   非 GET  405 ＋ `Allow: GET`
 *   云库未配 503 `NOT_CONFIGURED`（`NotConfiguredError` 由 `createRouteHandler` 统一转）
 *   参数错  400 `INVALID_PARAM`（`limit=abc` / `offset=-1` 等，由 `parsePaging` 抛）
 *
 * ★ 分页口径：`limit` 缺省 50、上限 200（超出**截断不报错**）、`offset ≥ 0`；顺序 ＝ `_id` 升序。
 *
 * ★ 字段面：按 spec §3.8 / §3.9 契约名（`sealId` / `sealName` / `sealType` / `assets[].assetId` …），
 *   空值**如实返回**（字符串 → `""`、数值 → `null`），**绝不编造**：
 *   - 库内 `seal_name` / `transcription` 各仅 2/79 非空、`author` / `shape` / `seal_type` 全空 ⇒ 原样回 `""`；
 *   - 影像尺寸取自本方玺印 `provenance.record_json.assets[]` 的 `width` / `height`（同 kind+seq 唯一命中才采用），
 *     命不中 ⇒ `null`（不猜、不按比例推算）；
 *   - `assets[]` 的 `assetId` / `kind` 取自 `xiai_faces`（`face_image_id` ⇒ FACE、`edge_image_ids[]` ⇒ EDGE）。
 *   `id` 与 `sealId` **同值**：`authors` / `inscriptions` 已用 `id` 作对外主键，本端点保留契约名 `sealId`
 *   的同时给出 `id`，供跨端点同一口径取用（非另造字段，见交付「待入规范条目」）。
 */
import { countDocs, fetchPage, fetchWhereIn, readId, readNumber, readString } from '../dataset.js'
import { getSearchParams, parsePaging } from '../pagination.js'
import { failWith } from '../respond.js'
import { createRouteHandler } from '../routeHandler.js'

/** 影像类型（spec §3.9 `ImageAsset.kind`）。 */
const ASSET_KIND = Object.freeze({ FACE: 'FACE', EDGE: 'EDGE', IMPRESSION: 'IMPRESSION' })

/**
 * 本方玺印的汇入记录（`provenance.record_json`，同集合内的 JSON 字符串）。
 * 解析失败 / 缺失 ⇒ `null`（后续字段一律如实缺省，不猜）。
 */
function recordOf(doc) {
  const raw = doc && doc.provenance && doc.provenance.record_json
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    return null
  }
}

/** 记录里的 `sizeMm`（`{width,height}` 均为数值才算数）。 */
function sizeMmOf(record) {
  const src = record && record.sizeMm
  if (!src || typeof src !== 'object') return null
  const width = readNumber(src.width)
  const height = readNumber(src.height)
  if (width === null || height === null) return null
  return { width, height }
}

/** 记录里的 `bbox`（原样透出，仅接受对象）。 */
function bboxOf(record) {
  const src = record && record.bbox
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null
  return src
}

/**
 * 影像尺寸：在 `record_json.assets[]` 里按 `kind` + `seq` 找**唯一**命中项。
 * 命中多项（同一 kind 多张）或没有命中 ⇒ `width` / `height` 皆 `null`（**不编造**）。
 */
function sizeOfAsset(record, kind, seq) {
  const assets = record && Array.isArray(record.assets) ? record.assets : []
  const candidates = assets.filter((asset) => {
    if (!asset || typeof asset !== 'object') return false
    if (readString(asset.kind) !== kind) return false
    const assetSeq = readNumber(asset.seq)
    return assetSeq === null ? seq === 0 : assetSeq === seq
  })
  if (candidates.length !== 1) return { width: null, height: null }
  return { width: readNumber(candidates[0].width), height: readNumber(candidates[0].height) }
}

/** 单个影像：`assetId` / `kind` / `seq` / `width` / `height`。 */
function projectAsset(assetId, kind, seq, record) {
  const size = sizeOfAsset(record, kind, seq)
  return { assetId, kind, seq, width: size.width, height: size.height }
}

/**
 * 影像 ID 尾号即源件序号（库内 ID 形态 `img-fx10-FACE-3` ⇒ seq 3）。
 * 解析不出数字 ⇒ 用 `fallback`（不猜具体值以外的东西）。
 */
function seqOfAssetId(assetId, fallback) {
  const matched = /-(\d+)$/.exec(assetId || '')
  return matched ? Number(matched[1]) : fallback
}

/**
 * 影像清单：`xiai_faces` 行给出 ID 与类型，尺寸按「同 kind + 同 seq」回查本方 `record_json.assets[]`。
 * 同一 `assetId` 只出现一次（去重，保持首次出现序）。
 */
function assetsOf(sealDoc, faceDocs) {
  const record = recordOf(sealDoc)
  const out = []
  const seen = new Set()
  const push = (assetId, kind, fallbackSeq) => {
    if (assetId === null || assetId === '' || seen.has(assetId)) return
    seen.add(assetId)
    out.push(projectAsset(assetId, kind, seqOfAssetId(assetId, fallbackSeq), record))
  }
  for (const face of faceDocs || []) {
    push(readString(face.face_image_id), ASSET_KIND.FACE, 0)
    const edges = Array.isArray(face.edge_image_ids) ? face.edge_image_ids : []
    edges.forEach((edgeId) => push(readString(edgeId), ASSET_KIND.EDGE, 0))
  }
  return out
}

/**
 * 玺印投影（契约 §3.8 ＋ 关联影像 §3.9 的展示最小面）。
 * @param {object} doc `xiai_seals` 行
 * @param {object[]} faceDocs 本方 `xiai_faces` 行
 */
export function projectSeal(doc, faceDocs = []) {
  const record = recordOf(doc)
  const id = readId(doc)
  return {
    // `id` 与 `sealId` 同值（跨端点主键口径；见文件头「字段面」）
    id,
    sealId: id,
    sealCode: record ? readString(record.sealCode) : null,
    sealName: readString(doc.seal_name),
    transcription: readString(doc.transcription),
    dynasty: readString(doc.dynasty),
    author: readString(doc.author),
    material: readString(doc.material),
    shape: readString(doc.shape),
    sealType: readString(doc.seal_type),
    sealStyle: readString(doc.seal_style),
    sizeMm: sizeMmOf(record),
    bbox: bboxOf(record),
    rightsStatus: record ? readString(record.rightsStatus) : null,
    reviewStatus: readString(doc.review_status),
    createdAt: readString(doc.created_at),
    updatedAt: readString(doc.updated_at),
    assets: assetsOf(doc, faceDocs)
  }
}

/** 查询串单值（`req.url` 优先、兼容 `req.query`；数组取首个）。 */
function queryValue(req, name) {
  const params = getSearchParams(req)
  const raw = params.get(name)
  return typeof raw === 'string' ? raw.trim() : ''
}

/** `/api/v1/seals` 之后的路径段（去空段、%-解码；解码失败保留原文）。 */
function pathSegments(req) {
  const pathname = String((req && req.url) || '').split('?')[0]
  const marker = '/seals'
  const at = pathname.indexOf(marker)
  if (at === -1) return []
  return pathname
    .slice(at + marker.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch (error) {
        return segment
      }
    })
}

/**
 * 请求形态：`'list'`（无 id）／`'item'`（`?id=` 或 URL 单段）／`'unknown'`（其余段数）。
 * @returns {'list'|'item'|'unknown'}
 */
export function sealShapeOf(req) {
  const fromQuery = queryValue(req, 'id')
  if (fromQuery !== '') return 'item'
  const segments = pathSegments(req)
  if (segments.length === 0) return 'list'
  if (segments.length === 1) return 'item'
  return 'unknown'
}

/** 请求的玺印 id（`?id=` 优先，其次 URL 段）。 */
export function sealIdOf(req) {
  const fromQuery = queryValue(req, 'id')
  if (fromQuery !== '') return fromQuery
  const segments = pathSegments(req)
  return segments.length === 1 ? segments[0] : ''
}

/** 按 `sealId` 分组 `xiai_faces` 行（键为字符串，空键丢弃）。 */
function groupFacesBySeal(faces) {
  const map = new Map()
  for (const face of faces) {
    const sealId = readString(face && face.sealId)
    if (sealId === null || sealId === '') continue
    if (!map.has(sealId)) map.set(sealId, [])
    map.get(sealId).push(face)
  }
  return map
}

const NOT_FOUND_BODY = { ok: false, reason: 'NOT_FOUND', message: '玺印条目不存在。' }

/** 分页列表（A25）：`{ items, total, limit, offset }`，items 已含每方影像。 */
export function createSealsHandler(options = {}) {
  return createRouteHandler('v1/seals', {
    methods: ['GET'],
    db: options.db || null,
    run: async ({ req, db }) => {
      const { limit, offset } = parsePaging(req)
      // 计数与取页并行（与 authors 同口径）：越界时取回的行丢弃、仍回空 items
      const [total, rows] = await Promise.all([
        countDocs(db, 'xiai_seals'),
        fetchPage(db, 'xiai_seals', offset, limit)
      ])
      const seals = offset >= total ? [] : rows
      const ids = seals.map((row) => readId(row)).filter((id) => id !== null && id !== '')
      const faces = ids.length === 0 ? [] : await fetchWhereIn(db, 'xiai_faces', 'sealId', ids)
      const bySeal = groupFacesBySeal(faces)
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            total,
            limit,
            offset,
            items: seals.map((row) => projectSeal(row, bySeal.get(readId(row)) || []))
          }
        }
      }
    }
  })
}

/** 单条（A26）：命中 ⇒ 200 单对象；未命中 ⇒ 404（**不 500**）。 */
export function createSealItemHandler(options = {}) {
  return createRouteHandler('v1/seals/{id}', {
    methods: ['GET'],
    db: options.db || null,
    run: async ({ req, db }) => {
      const id = sealIdOf(req)
      if (id === '') return { status: 404, body: NOT_FOUND_BODY }
      const rows = await fetchWhereIn(db, 'xiai_seals', 'id', [id], 1)
      const doc = rows[0]
      if (!doc) return { status: 404, body: NOT_FOUND_BODY }
      const faces = await fetchWhereIn(db, 'xiai_faces', 'sealId', [id])
      return { status: 200, body: { ok: true, data: projectSeal(doc, faces) } }
    }
  })
}

/**
 * 单入口分派器：`?id=` 优先 ⇒ 单条；否则列表；未识别段数 ⇒ 404（与全站兜底同信封）。
 * 两个子 handler 各自带方法门 ⇒ `Allow: GET` 与 405 文案一致。
 */
export function createSealsCatchAllHandler(options = {}) {
  const list = createSealsHandler(options)
  const item = createSealItemHandler(options)

  return async function handler(req, res) {
    const shape = sealShapeOf(req)
    if (shape === 'list') return list(req, res)
    if (shape === 'item') return item(req, res)
    return failWith(res, 404, 'NOT_FOUND')
  }
}

export default createSealsCatchAllHandler()
