import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testWorkspace } from './helpers.js'
import { createServer } from '../src/app/server.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { query, queryOne } from '../src/db/index.js'

test('document API returns exact historical source and persisted UTF-16 citation ranges', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  try {
    const first = await ingestParsed(workspace.principal, parseText('第一版😀：保留原文与引用。', '版本文档'), { sourceType: 'text', uri: 'test:source' })
    const old = await queryOne<{ id: string }>('SELECT id FROM document_versions WHERE doc_id=$1', [first.document_id])
    await ingestParsed(workspace.principal, parseText('第二版：内容已经更新。', '版本文档'), { sourceType: 'text', uri: 'test:source' })
    const historical = await app.inject({ method: 'GET', url: `/api/v1/documents/${first.document_id}?version_id=${old!.id}`, headers: workspace.headers })
    assert.equal(historical.statusCode, 200)
    const data = historical.json()
    assert.equal(data.source.text, '第一版😀：保留原文与引用。')
    assert.equal(data.source.version, 1)
    assert.equal(data.source.coordinate_system, 'normalized-text-utf16')
    assert.equal(data.versions.length, 2)
    for (const chunk of data.chunks) {
      assert.equal(chunk.version_id, old!.id)
      assert.ok(chunk.spans.length)
      for (const span of chunk.spans) assert.ok(chunk.text.includes(data.source.text.slice(span.start, span.end)))
    }
    const current = await app.inject({ method: 'GET', url: `/api/v1/documents/${first.document_id}`, headers: workspace.headers })
    assert.equal(current.json().source.text, '第二版：内容已经更新。')
    const invalid = await app.inject({ method: 'GET', url: `/api/v1/documents/${first.document_id}?version_id=missing`, headers: workspace.headers })
    assert.equal(invalid.statusCode, 404)
  } finally { await app.close(); await workspace.close() }
})

test('low-confidence candidates stay in review and out of the document and graph views', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  try {
    const source = await ingestParsed(workspace.principal, parseText('请在所提供服务对应的选项上划“√”。协和医院提供随访服务。', '抽取样例'), { sourceType: 'text' })
    const tenant = workspace.principal.tenantId
    const acl = '["tenant:public"]'
    await query(`INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,acl_principals)
      VALUES ('fragment',$1,'请在所','请在所',$2::jsonb),('hospital',$1,'协和医院','协和医院',$2::jsonb)`, [tenant, acl])
    await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,status,confidence,acl_principals)
      VALUES ('legacy',$1,'fragment','提供','服务对应的选项上划“√”','disputed',0.52,$2::jsonb),
             ('valid',$1,'hospital','提供','随访服务','disputed',0.8,$2::jsonb)`, [tenant, acl])
    await query(`INSERT INTO fact_evidence(id,fact_id,doc_id,quote)
      VALUES ('legacy-evidence','legacy',$1,'请在所提供服务对应的选项上划“√”'),
             ('valid-evidence','valid',$1,'协和医院提供随访服务')`, [source.document_id])
    await query(`INSERT INTO review_queue(id,tenant_id,kind,payload)
      VALUES ('review-legacy',$1,'fact_validation','{"new_fact_id":"legacy","old_fact_ids":["valid","missing"]}'::jsonb)`, [tenant])
    const get = async (path: string) => (await app.inject({ url: '/api/v1' + path, headers: workspace.headers })).json()
    assert.deepEqual((await get('/entities')).items.map((entity: { name: string }) => entity.name), ['协和医院'])
    // 字面值事实不再造节点、也不画连线，只作为主语属性出现
    const graph = await get('/graph')
    assert.deepEqual(graph.edges.map((edge: { id: string }) => edge.id), [])
    assert.deepEqual(Object.values(graph.nodes).flatMap((node: any) => node.attrs.map((attr: { fact_id: string }) => attr.fact_id)), ['valid'])
    const doc = await get('/documents/' + source.document_id)
    assert.deepEqual(doc.entities.map((entity: { name: string }) => entity.name), ['协和医院'])
    assert.deepEqual(doc.facts.map((fact: { id: string }) => fact.id), ['valid'])
    assert.equal(doc.review_only_facts, 1)
    assert.equal((await get('/stats')).entities, 1)
    assert.deepEqual((await get('/facts')).items.map((fact: { id: string }) => fact.id), ['valid'])
    const review = (await get('/review')).items[0]
    assert.equal(review.payload.new_fact_id, 'legacy')
    assert.deepEqual(review.old_sources, [
      { title: '抽取样例', page: null, heading: null, seq: null, quote: '协和医院提供随访服务' },
      null,
    ])
    await query("UPDATE facts SET acl_principals = '[]'::jsonb WHERE id = 'valid'")
    assert.deepEqual((await get('/review')).items[0].old_sources, [null, null])
    await query("UPDATE facts SET status='active' WHERE id='legacy'")
    assert.ok((await get('/graph')).nodes.some((node: any) => node.attrs.some((attr: { fact_id: string }) => attr.fact_id === 'legacy')))
  } finally { await app.close(); await workspace.close() }
})

test('chat citation previews stay on the cited version and check source permissions', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  try {
    const source = '旧版引用😀'
    const first = await ingestParsed(workspace.principal, parseText(source, '历史 PDF'), { sourceType: 'pdf', uri: 'upload:history.pdf' })
    const versionId = first.version_id
    const chunk = await queryOne<{ id: string }>('SELECT id FROM chunks WHERE version_id=$1 AND is_parent=false', [versionId])
    const pdf = Buffer.from('%PDF-1.7\n%%EOF\n')
    await query(
      `UPDATE jobs SET payload = payload || $2::jsonb WHERE id = $1`,
      [first.job_id, JSON.stringify({ source: 'file', request: { filename: 'history.pdf', data: pdf.toString('base64') } })],
    )
    const second = await ingestParsed(workspace.principal, parseText('新版引用', '历史 PDF'), { sourceType: 'text', documentId: String(first.document_id) })
    const url = `/api/v1/documents/${first.document_id}/citation/${versionId}?chunk_id=${chunk!.id}`
    const get = (suffix = '', headers: Record<string, string> = workspace.headers) => app.inject({ method: 'GET', url: url + suffix, headers })
    const preview = (await get()).json()
    assert.equal(preview.source.text, source)
    assert.equal(preview.version, 1)
    assert.equal(preview.file_type, 'pdf')
    assert.deepEqual(preview.chunks[0].spans.map(({ start, end }: { start: number; end: number }) => ({ start, end })), [{ start: 0, end: source.length }])
    const file = await get('&format=pdf')
    assert.equal(file.statusCode, 200)
    assert.equal(file.headers['content-type'], 'application/pdf')
    assert.deepEqual(file.rawPayload, pdf)
    assert.equal((await get('&format=pdf', {})).statusCode, 401)
    assert.equal((await app.inject({ url: url.replace(String(versionId), String(second.version_id)), headers: workspace.headers })).statusCode, 404)
    await query("UPDATE chunks SET acl_principals = '[\"user:other\"]'::jsonb WHERE id = $1", [chunk!.id])
    assert.equal((await get()).statusCode, 404)
    assert.equal((await get('&format=pdf')).statusCode, 404)
  } finally { await app.close(); await workspace.close() }
})
