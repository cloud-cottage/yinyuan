/**
 * GET /api/v1/authors?limit=&offset= —— 作者（人物）列表，只读。
 *
 * 来源：云库**正式集合** `xiai_persons`（不读任何 `*_imports` 导入暂存集合）。
 * 分页：limit 缺省 50、上限 200（超出截断）、offset ≥ 0；顺序＝`_id` 升序。
 * 字段空值**如实返回**（字符串 → [] / null / 原样；年份 → number|null；名称数组 → []）。
 */
import { countDocs, fetchPage, readId, readNumber, readString, readStringArray } from '../_lib/dataset.js'
import { getDb } from '../_lib/cloudbase.js'
import { createGetHandler } from '../_lib/handler.js'
import { parsePaging } from '../_lib/pagination.js'

/** 对外字段映射（不透出内部主键以外的内部字段 / 管理字段）。 */
function mapPerson(doc) {
  const familyName = readString(doc.family_name)
  const givenName = readString(doc.given_name)
  const name = `${familyName || ''}${givenName || ''}`
  return {
    id: readId(doc),
    source_person_id: readString(doc.source_person_id),
    name: name === '' ? null : name,
    family_name: familyName,
    given_name: givenName,
    courtesy_names: readStringArray(doc.courtesy_names),
    art_names: readStringArray(doc.art_names),
    alias_names: readStringArray(doc.alias_names),
    birth_year: readNumber(doc.birth_year),
    death_year: readNumber(doc.death_year),
    dynasty: readString(doc.dynasty),
    native_place: readString(doc.native_place),
    biography: readString(doc.biography),
    source: readString(doc.source)
  }
}

export default createGetHandler('v1/authors', async (req) => {
  const { limit, offset } = parsePaging(req)
  const db = getDb()
  const total = await countDocs(db, 'xiai_persons')
  const rows = offset >= total ? [] : await fetchPage(db, 'xiai_persons', offset, limit)
  return { total, limit, offset, items: rows.map(mapPerson) }
})
