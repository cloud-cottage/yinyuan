/**
 * GET /api/v1/inscriptions?limit=&offset= —— 玺印（印面）列表，只读。
 *
 * 来源：云库**正式集合** `xiai_seals` + `xiai_faces`（Kevin 裁定：只取正式集合，
 *       **不得**回落 `xiai_seal_imports` 等导入暂存集合）。
 * 合并顺序：`xiai_seals` 全量在前（各集合内按 `_id` 升序），再 `xiai_faces`；
 * total ＝ 两集合条数之和。分页对**合并后**的序列生效（limit 缺省 50 / 上限 200 / offset ≥ 0）。
 * 字段空值**如实返回**：undefined/null ⇒ null，空串如实为 ''；**不编造、不填充**。
 */
import { countDocs, fetchMergedPage, readId, readString } from '../_lib/dataset.js'
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
  const totals = await Promise.all(SOURCES.map((source) => countDocs(db, source.collection)))
  const sources = SOURCES.map((source, index) => ({ ...source, total: totals[index] }))
  const total = totals.reduce((sum, n) => sum + n, 0)
  const items = await fetchMergedPage(db, sources, offset, limit)
  return { total, limit, offset, items }
})
