/**
 * GET /api/v1/dynasties —— 朝代值域契约（15 类）+ 云库实际计数。
 *
 * 返回：
 *   data.total     = 15（值域条数，恒等 DYNASTY_CONTRACT.length）
 *   data.items     = [{ seq: 1..15, value }]（seq 即对外显示顺序）
 *   data.counts    = { faces: {值:条数}, seals: {值:条数} }（只含**非空**值；库内旧值原样列出）
 *   data.unrecorded= { faces, seals }（未记录朝代＝null/undefined/空串，不进 counts）
 *
 * 计数读云库正式集合 `xiai_faces` / `xiai_seals` 的 `dynasty` 字段聚合（只读）。
 */
import { countByField } from '../_lib/dataset.js'
import { DYNASTY_CONTRACT } from '../_lib/dynasty-contract.js'
import { getDb } from '../_lib/cloudbase.js'
import { createGetHandler } from '../_lib/handler.js'

/** 计数键排序：先按 15 类契约顺序，再把库内其它旧值按字典序追加在后。 */
function orderCounts(counts) {
  const ordered = {}
  for (const value of DYNASTY_CONTRACT) {
    if (Object.prototype.hasOwnProperty.call(counts, value)) ordered[value] = counts[value]
  }
  for (const key of Object.keys(counts).sort()) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) ordered[key] = counts[key]
  }
  return ordered
}

export default createGetHandler('v1/dynasties', async () => {
  const db = getDb()
  const [faces, seals] = await Promise.all([
    countByField(db, 'xiai_faces', 'dynasty'),
    countByField(db, 'xiai_seals', 'dynasty')
  ])
  return {
    total: DYNASTY_CONTRACT.length,
    items: DYNASTY_CONTRACT.map((value, index) => ({ seq: index + 1, value })),
    counts: {
      faces: orderCounts(faces.counts),
      seals: orderCounts(seals.counts)
    },
    unrecorded: {
      faces: faces.unrecorded,
      seals: seals.unrecorded
    }
  }
})
