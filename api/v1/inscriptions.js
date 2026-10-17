/**
 * GET /api/v1/inscriptions?limit=&offset= —— 玺印（印面）列表，只读。
 *
 * 来源：云库**正式集合** `xiai_seals` + `xiai_faces`（Kevin 裁定：只取正式集合，
 *       **不得**回落 `xiai_seal_imports` 等导入暂存集合）。
 * 合并顺序：`xiai_seals` 全量在前（各集合内按 `_id` 升序），再 `xiai_faces`；
 * total ＝ 两集合条数之和。分页对**合并后**的序列生效（limit 缺省 50 / 上限 200 / offset ≥ 0）。
 * 字段空值**如实返回**：undefined/null ⇒ null，空串如实为 ''；**不编造、不填充**。
 *
 * ★ 云库往返（2026-10-17 并发修复）：常见路径压成**一轮**往返。
 *   首个集合的取页 `skip` **恒等于 `offset`**（它前面没有别的集合），不依赖任何 count 结果
 *   ⇒ 它与两集合的 count **并行发出**（`Promise.all`）。旧实现是「先两路 count 一轮、再取页一轮」
 *   共 2 轮；现为 1 轮。仅当首集合这一页填不满 `limit`（需续取后续集合）时才多发一次请求。
 *   单请求云库调用数：常见路径 3 次（不变），跨集合续取情形 4 次（旧实现 3 次 / 2 轮）——
 *   以「少一轮建连」换「极端分页下多一次读」，对建连不稳的线路是净收益。
 */
import { countDocs, fetchPage, readId, readString } from '../_lib/dataset.js'
import { getDb } from '../_lib/cloudbase.js'
import { createGetHandler } from '../_lib/handler.js'
import { parsePaging } from '../_lib/pagination.js'

const SOURCES = [
  {
    collection: 'xiai_seals',
    key: 'seals',
    map: (doc) => ({
      id: readId(doc),
      collection: 'seals',
      seal_name: readString(doc.seal_name),
      transcription: readString(doc.transcription),
      author: readString(doc.author),
      dynasty: readString(doc.dynasty),
      seal_type: readString(doc.seal_type)
    })
  },
  {
    collection: 'xiai_faces',
    key: 'faces',
    map: (doc) => ({
      id: readId(doc),
      collection: 'faces',
      seal_name: readString(doc.seal_name),
      transcription: readString(doc.transcription),
      author: readString(doc.author),
      dynasty: readString(doc.dynasty),
      seal_type: readString(doc.seal_type)
    })
  }
]

export default createGetHandler('v1/inscriptions', async (req) => {
  const { limit, offset } = parsePaging(req)
  const db = getDb()

  // 首集合取页与两集合计数并行（一轮往返）；首集合局部 skip ＝ offset，故无需等计数结果。
  const [totals, firstRows] = await Promise.all([
    Promise.all(SOURCES.map((source) => countDocs(db, source.collection))),
    fetchPage(db, SOURCES[0].collection, offset, limit)
  ])
  const sources = SOURCES.map((source, index) => ({ ...source, total: totals[index] }))
  const total = totals.reduce((sum, n) => sum + n, 0)

  // 合并序列分页（口径与 fetchMergedPage 逐条一致：集合顺序 + 各集合内 _id 升序）
  const items = []
  for (let index = 0; index < sources.length && items.length < limit; index += 1) {
    const source = sources[index]
    // 局部 skip = max(0, offset − 前序集合条数之和)（offset 已被前序集合吃掉时从 0 开始）
    const consumed = sources.slice(0, index).reduce((sum, s) => sum + s.total, 0)
    const skip = index === 0 ? offset : Math.max(0, offset - consumed)
    if (skip >= source.total) continue
    const need = limit - items.length
    const rows = index === 0 ? firstRows : await fetchPage(db, source.collection, skip, need)
    for (const row of rows.slice(0, need)) items.push(source.map(row))
  }
  return { total, limit, offset, items }
})
