/**
 * `/api/v1/seals`（A25 列表 ＋ A26 单条）公开只读端点契约冒烟
 * —— **真 HTTP ＋ 真 handler ＋ 内存假 DB**（不连云库、不打生产、不写任何数据）。
 *
 * 覆盖：
 *   1) 公开面：无会话 / 无 key ⇒ 200；统一信封 `{ok:true,data:{items,total,limit,offset}}`；
 *      `Cache-Control: no-store`
 *   2) 分页：`limit=5` 回 5 条；`limit=500` 显式截断到 200（`data.limit===200`，不报错）；
 *      `offset` 越界 ⇒ 空 items；缺省 `limit=50` / `offset=0`
 *   3) 参数错：`limit=abc` / `offset=-1` ⇒ 400 `INVALID_PARAM`
 *   4) 单条：`?id=`（平台 rewrite 通道）与 URL 段（直调通道）都 200；字段面按 §3.8/§3.9；
 *      影像尺寸取得则给数值、取不到则 `null`（不编造）
 *   5) 不存在 ⇒ 404 `NOT_FOUND`（**不 500**）；多段路径 ⇒ 404
 *   6) 方法门：`POST` ⇒ 405 ＋ `Allow: GET`
 *   7) 数据源白名单：全程 **只碰** `xiai_seals` / `xiai_faces`，任何 `*_imports` 集合零访问
 *
 * 跑法：`node tests/seals-endpoints.test.mjs`（退出码 0 ＝ 全绿）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createSealsCatchAllHandler, projectSeal, sealShapeOf } from '../api/v1/seals.js'

let passCount = 0
let failCount = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passCount += 1
    console.log(`✓ ${name}`)
    return
  }
  failCount += 1
  failures.push(name)
  console.log(`✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), { actual, expected })
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
}

/* ── 内存假 DB（CloudBase v3 读面子集：count / orderBy+skip+limit / where+limit） ── */

const IN = Symbol('in')

function createFakeDb(seed) {
  const store = new Map()
  const touched = []
  const command = { in: (values) => ({ [IN]: Array.isArray(values) ? values.slice() : [] }) }

  function rowsOf(name) {
    if (!touched.includes(name)) touched.push(name)
    if (!store.has(name)) throw new Error(`missing collection: ${name}`)
    return store.get(name)
  }

  function chain(name) {
    const state = { where: null, order: null, skip: 0, limit: null }
    const api = {
      where(filter) {
        state.where = filter
        return api
      },
      orderBy(field, dir) {
        state.order = { field, dir }
        return api
      },
      skip(n) {
        state.skip = n
        return api
      },
      limit(n) {
        state.limit = n
        return api
      },
      count() {
        return Promise.resolve({ total: filterRows(rowsOf(name)).length })
      },
      get() {
        const matched = filterRows(rowsOf(name))
        const sorted = state.order ? matched.slice().sort((a, b) => {
          const av = a[state.order.field]
          const bv = b[state.order.field]
          const cmp = av < bv ? -1 : av > bv ? 1 : 0
          return state.order.dir === 'desc' ? -cmp : cmp
        }) : matched
        const start = state.skip || 0
        const end = state.limit === null ? undefined : start + state.limit
        return Promise.resolve({ data: sorted.slice(start, end) })
      }
    }
    function filterRows(list) {
      if (!state.where) return list.slice()
      return list.filter((row) =>
        Object.entries(state.where).every(([field, expected]) => {
          if (expected && typeof expected === 'object' && expected[IN]) {
            return expected[IN].includes(row[field])
          }
          return row[field] === expected
        })
      )
    }
    return api
  }

  return {
    touched,
    db: {
      command,
      collection(name) {
        return chain(name)
      }
    },
    seed(name, rows) {
      store.set(name, rows)
    }
  }
}

/* ── 夹具：3 方玺印（真实库同类形状：snake_case ＋ provenance.record_json） ── */

function sealRow({ id, sealName = '', dynasty = '', material = 'UNKNOWN', assets = [], type = '' }) {
  return {
    _id: `xf-${id}`,
    id,
    seal_name: sealName,
    transcription: sealName,
    dynasty,
    author: '',
    material,
    shape: '',
    seal_type: type,
    seal_style: '朱文',
    review_status: 'DRAFT',
    created_at: '2026-09-20T10:08:36+08:00',
    updated_at: '2026-09-20T10:08:36+08:00',
    provenance: {
      record_json: JSON.stringify({
        schemaVersion: 'yinsuo.feicui.seal.v1',
        sealCode: null,
        sealName: sealName || null,
        dynasty: dynasty || null,
        sizeMm: null,
        bbox: { x1: 190, y1: 192, x2: 344, y2: 340, unit: 'pt' },
        rightsStatus: 'UNKNOWN',
        reviewStatus: 'DRAFT',
        assets
      })
    }
  }
}

function buildFixture() {
  const fake = createFakeDb()
  fake.seed('xiai_seals', [
    sealRow({
      id: '66',
      sealName: '田用海厦',
      dynasty: '秦汉',
      assets: [{ kind: 'FACE', seq: 0, width: 307, height: 296, bytes: 23762 }]
    }),
    sealRow({ id: '67', sealName: '', dynasty: '', assets: [] }),
    sealRow({
      id: '1',
      sealName: '',
      dynasty: '',
      assets: [
        { kind: 'FACE', seq: 0, width: 123, height: 122 },
        { kind: 'EDGE', seq: 0, width: 88, height: 41 }
      ]
    }),
    // 源件序号写在影像 ID 尾号里（库内真实形态 `img-fx10-FACE-3`）
    sealRow({ id: '3', sealName: '', dynasty: '', assets: [{ kind: 'FACE', seq: 5, width: 140, height: 136 }] })
  ])
  fake.seed('xiai_faces', [
    { _id: 'fc-66', id: 'fc-66', sealId: '66', kind: 'FACE', face_image_id: 'img-fx66-FACE-0', edge_image_ids: [] },
    { _id: 'fc-67', id: 'fc-67', sealId: '67', kind: 'FACE', face_image_id: 'img-fx67-FACE-0', edge_image_ids: [] },
    { _id: 'fc-3', id: 'fc-3', sealId: '3', kind: 'FACE', face_image_id: 'img-fx3-FACE-5', edge_image_ids: [] },
    {
      _id: 'fc-1',
      id: 'fc-1',
      sealId: '1',
      kind: 'FACE',
      face_image_id: 'img-fx1-FACE-0',
      edge_image_ids: ['img-fx1-EDGE-0']
    }
  ])
  // 诱饵：导入暂存集合（白名单外，读即判负）——故意造一条「更像完整数据」的行
  fake.seed('xiai_seal_imports', [sealRow({ id: '999', sealName: '导入行', dynasty: '唐' })])
  return fake
}

function makeServer(fake) {
  const handler = createSealsCatchAllHandler({ db: fake.db })
  const server = http.createServer((req, res) => handler(req, res))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function request(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method || 'GET',
    headers: { ...(options.headers || {}) }
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch (error) {
    body = null
  }
  return { status: response.status, headers: response.headers, body, text }
}

/* ── 用例 ───────────────────────────────────────────────────────── */

async function main() {
  const fake = buildFixture()
  const { server, port } = await makeServer(fake)
  const importsTouched = () => fake.touched.filter((name) => /_imports$/.test(name))

  try {
    section('公开面（无会话 / 无 key）')
    const list = await request(port, '/api/v1/seals')
    eq('无会话 GET 列表 ⇒ 200', list.status, 200)
    ok('列表信封 {ok:true,data:{items,total,limit,offset}}', Boolean(
      list.body && list.body.ok === true && Array.isArray(list.body.data.items) &&
      typeof list.body.data.total === 'number' &&
      typeof list.body.data.limit === 'number' &&
      typeof list.body.data.offset === 'number'
    ), list.body)
    eq('缺省 limit=50', list.body.data.limit, 50)
    eq('缺省 offset=0', list.body.data.offset, 0)
    eq('total 为集合真实条数', list.body.data.total, 4)
    eq('Cache-Control: no-store', list.headers.get('cache-control'), 'no-store')
    eq('CORS 头恒 *', list.headers.get('access-control-allow-origin'), '*')

    section('分页')
    const limited = await request(port, '/api/v1/seals?limit=2')
    eq('limit=2 ⇒ 2 条', limited.body.data.items.length, 2)
    eq('limit=2 回显 limit', limited.body.data.limit, 2)
    const truncated = await request(port, '/api/v1/seals?limit=500')
    eq('limit=500 ⇒ 截断到 200（不报错）', truncated.body.data.limit, 200)
    eq('limit=500 仍 200', truncated.status, 200)
    const beyond = await request(port, '/api/v1/seals?offset=99')
    eq('offset 越界 ⇒ 空 items', beyond.body.data.items.length, 0)
    eq('offset 越界仍回 total', beyond.body.data.total, 4)
    eq('offset 回显', beyond.body.data.offset, 99)

    section('参数错')
    const badLimit = await request(port, '/api/v1/seals?limit=abc')
    eq('limit=abc ⇒ 400', badLimit.status, 400)
    eq('limit=abc reason', badLimit.body.reason, 'INVALID_PARAM')
    const badOffset = await request(port, '/api/v1/seals?offset=-1')
    eq('offset=-1 ⇒ 400', badOffset.status, 400)
    eq('offset=-1 reason', badOffset.body.reason, 'INVALID_PARAM')

    section('单条（rewrite 通道 ?id= ／ 直调通道 URL 段）')
    const byQuery = await request(port, '/api/v1/seals?id=66')
    eq('?id=66 ⇒ 200', byQuery.status, 200)
    eq('?id=66 sealId', byQuery.body.data.sealId, '66')
    eq('sealId 与 id 同值', byQuery.body.data.id, byQuery.body.data.sealId)
    eq('sealName 如实', byQuery.body.data.sealName, '田用海厦')
    eq('dynasty 如实', byQuery.body.data.dynasty, '秦汉')
    eq('assets[0].assetId 取自 xiai_faces', byQuery.body.data.assets[0].assetId, 'img-fx66-FACE-0')
    eq('assets[0].kind', byQuery.body.data.assets[0].kind, 'FACE')
    eq('assets[0].width 取真值', byQuery.body.data.assets[0].width, 307)
    eq('assets[0].height 取真值', byQuery.body.data.assets[0].height, 296)
    const byPath = await request(port, '/api/v1/seals/66')
    eq('URL 段直调 ⇒ 200（同一条）', byPath.status, 200)
    eq('两条通道同一实体', byPath.body.data.sealId, byQuery.body.data.sealId)

    const multi = await request(port, '/api/v1/seals/1')
    eq('多影像：FACE + EDGE 两件', multi.body.data.assets.length, 2)
    eq('EDGE 尺寸取真值', multi.body.data.assets[1].width, 88)

    const noSize = await request(port, '/api/v1/seals/67')
    eq('尺寸取不到 ⇒ width null（不编造）', noSize.body.data.assets[0].width, null)
    eq('尺寸取不到 ⇒ height null（不编造）', noSize.body.data.assets[0].height, null)
    eq('空字段如实回空串', noSize.body.data.sealName, '')

    const seqEncoded = await request(port, '/api/v1/seals/3')
    eq('ID 尾号即源件序号 ⇒ seq', seqEncoded.body.data.assets[0].seq, 5)
    eq('按同 kind+seq 命中尺寸（width）', seqEncoded.body.data.assets[0].width, 140)
    eq('按同 kind+seq 命中尺寸（height）', seqEncoded.body.data.assets[0].height, 136)

    section('不存在 / 多段路径 / 方法门')
    const missing = await request(port, '/api/v1/seals/does-not-exist')
    eq('不存在 ⇒ 404', missing.status, 404)
    eq('不存在 reason=NOT_FOUND', missing.body.reason, 'NOT_FOUND')
    const deep = await request(port, '/api/v1/seals/66/extra')
    eq('多段路径 ⇒ 404', deep.status, 404)
    const posted = await request(port, '/api/v1/seals', { method: 'POST' })
    eq('POST ⇒ 405', posted.status, 405)
    eq('405 带 Allow: GET', posted.headers.get('allow'), 'GET')
    eq('405 reason', posted.body.reason, 'METHOD_NOT_ALLOWED')

    section('数据源白名单')
    ok('全程未读任何 *_imports 集合', importsTouched().length === 0, importsTouched())
    ok('只碰 xiai_seals / xiai_faces', fake.touched.every((name) => name === 'xiai_seals' || name === 'xiai_faces'), fake.touched)

    section('纯函数：投影与形态分派')
    const projected = projectSeal({}, [])
    eq('投影空行 sealName 为 null（undefined ⇒ null，非编造空串）', projected.sealName, null)
    eq('形态：无 id ⇒ list', sealShapeOf({ url: '/api/v1/seals' }), 'list')
    eq('形态：?id= ⇒ item', sealShapeOf({ url: '/api/v1/seals?id=66' }), 'item')
    eq('形态：/seals/66 ⇒ item', sealShapeOf({ url: '/api/v1/seals/66' }), 'item')
    eq('形态：/seals/66/x ⇒ unknown', sealShapeOf({ url: '/api/v1/seals/66/x' }), 'unknown')

    section('云库未配置 ⇒ 503 NOT_CONFIGURED（fail-closed，不回落 mock）')
    {
      // 临时清空本进程的云库凭据，走「未配置」真实分支；结束后原样复原（不改磁盘、不落任何值）
      const saved = {}
      for (const name of ['CB_ENV', 'CB_SECRET_ID', 'CB_SECRET_KEY']) {
        saved[name] = process.env[name]
        delete process.env[name]
      }
      const bare = createSealsCatchAllHandler()
      const bareServer = http.createServer((req, res) => bare(req, res))
      const barePort = await new Promise((resolve) => {
        bareServer.listen(0, '127.0.0.1', () => resolve(bareServer.address().port))
      })
      try {
        const notConfigured = await request(barePort, '/api/v1/seals')
        eq('未配置 ⇒ 503', notConfigured.status, 503)
        eq('未配置 reason', notConfigured.body.reason, 'NOT_CONFIGURED')
        eq('未配置也带 no-store', notConfigured.headers.get('cache-control'), 'no-store')
      } finally {
        await new Promise((resolve) => bareServer.close(resolve))
        for (const name of Object.keys(saved)) {
          if (saved[name] !== undefined) process.env[name] = saved[name]
        }
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  console.log(`\n${passCount} passed, ${failCount} failed`)
  if (failCount > 0) {
    console.log(`failures: ${failures.join(' | ')}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
