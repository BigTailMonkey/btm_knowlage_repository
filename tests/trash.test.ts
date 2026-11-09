import assert from 'node:assert/strict'
import { test } from 'node:test'

import { testWorkspace } from './helpers.js'
import { createServer } from '../src/app/server.js'
import { embedder } from '../src/adapters/embeddings/index.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { purgeDocument, purgeExpiredTrash, restoreDocument, trashDocument, trashDocuments } from '../src/core/trash.js'
import { query, queryOne } from '../src/db/index.js'
import type { Principal } from '../src/core/security.js'

const ACL = '["tenant:public"]'

async function ingest(principal: Principal, title: string, text: string) {
  return ingestParsed(principal, parseText(text, title), { sourceType: 'text', uri: `trash-test:${title}` })
}

test('moving to trash keeps only the document itself and closes its pending reviews', async () => {
  const workspace = await testWorkspace()
  try {
    const principal = workspace.principal
    const tenant = principal.tenantId
    const doc = await ingest(principal, '回收站样例', '回收站样例文档的原始正文内容。')
    const other = await ingest(principal, '另一份来源', '另一份来源的正文内容。')
    const docId = String(doc.document_id)
    const otherId = String(other.document_id)
    await query(`INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,acl_principals)
      VALUES ('e-own',$1,'回收站实体','回收站实体',$2::jsonb),('e-shared',$1,'共享实体','共享实体',$2::jsonb)`, [tenant, ACL])
    await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,source_doc_id,status,acl_principals)
      VALUES ('own-fact',$1,'e-own','属性','值',$2,'active',$3::jsonb),
             ('shared-fact',$1,'e-shared','属性','值',$2,'active',$3::jsonb)`, [tenant, docId, ACL])
    await query(`INSERT INTO fact_evidence(id,fact_id,doc_id,quote)
      VALUES ('ev-own','own-fact',$1,'回收站样例文档的原始正文内容。'),
             ('ev-shared-doc','shared-fact',$1,'回收站样例文档的原始正文内容。'),
             ('ev-shared-other','shared-fact',$2,'另一份来源的正文内容。')`, [docId, otherId])
    await query(`INSERT INTO review_queue(id,tenant_id,kind,payload)
      VALUES ('rev-own',$1,'fact_review','{"new_fact_id":"own-fact"}'::jsonb)`, [tenant])

    const chunkCount = (await query('SELECT id FROM chunks WHERE doc_id=$1', [docId])).length
    const blocks = await query<{ id: string }>('SELECT id FROM blocks WHERE doc_id=$1', [docId])
    const versions = await query<{ id: string }>('SELECT id FROM document_versions WHERE doc_id=$1', [docId])
    const otherChunks = await query<{ id: string }>('SELECT id FROM chunks WHERE doc_id=$1', [otherId])

    const result = await trashDocument(principal, docId)
    assert.equal(result.status, 'tombstoned')
    assert.equal(result.removed_chunks, chunkCount)
    assert.equal(result.closed_reviews, 1)

    const document = await queryOne<{ status: string; deleted_at: string | null; deleted_by: string | null }>(
      'SELECT status,deleted_at,deleted_by FROM documents WHERE id=$1', [docId])
    assert.equal(document?.status, 'tombstoned')
    assert.ok(document?.deleted_at)
    assert.equal(document?.deleted_by, principal.userId)
    // 只保留文档本体：版本、结构块、原文都还在，检索单元与证据都已清除。
    assert.equal((await query('SELECT id FROM blocks WHERE doc_id=$1', [docId])).length, blocks.length)
    assert.equal((await query('SELECT id FROM document_versions WHERE doc_id=$1', [docId])).length, versions.length)
    assert.equal((await queryOne<{ text: string }>('SELECT text FROM document_versions WHERE doc_id=$1', [docId]))?.text, '回收站样例文档的原始正文内容。')
    assert.equal((await query('SELECT id FROM chunks WHERE doc_id=$1', [docId])).length, 0)
    assert.equal((await query('SELECT id FROM fact_evidence WHERE doc_id=$1', [docId])).length, 0)
    assert.equal((await query('SELECT id FROM chunks WHERE doc_id=$1', [otherId])).length, otherChunks.length)
    assert.equal((await query('SELECT id FROM knowledge_summaries WHERE tenant_id=$1', [tenant])).length, 0)
    // 单源事实撤回，仍有其他出处的共享事实保持有效。
    assert.deepEqual(
      await query<{ id: string; status: string }>('SELECT id,status FROM facts ORDER BY id'),
      [{ id: 'own-fact', status: 'retracted' }, { id: 'shared-fact', status: 'active' }],
    )
    // 相关待审项关闭，队列里不再留下无法处理的死项。
    const review = await queryOne<{ status: string; resolution: Record<string, unknown> | null }>(
      'SELECT status,resolution FROM review_queue WHERE id=$1', ['rev-own'])
    assert.equal(review?.status, 'resolved')
    assert.equal(review?.resolution?.action, 'document_trashed')
    assert.equal((await query("SELECT id FROM review_queue WHERE tenant_id=$1 AND status='open'", [tenant])).length, 0)
    await assert.rejects(trashDocument(principal, docId), /已在回收站/)
  } finally { await workspace.close() }
})

test('restore re-chunks, re-embeds and queues fresh fact extraction', async () => {
  const workspace = await testWorkspace()
  try {
    const principal = workspace.principal
    const tenant = principal.tenantId
    const doc = await ingest(principal, '恢复样例', '恢复样例的第一段正文。')
    const docId = String(doc.document_id)
    const versionId = String(doc.version_id)
    const chunkTexts = (await query<{ text: string }>(
      'SELECT text FROM chunks WHERE doc_id=$1 AND is_parent=false ORDER BY seq', [docId])).map((row) => row.text)
    await query(`INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,acl_principals)
      VALUES ('e-restore',$1,'恢复实体','恢复实体',$2::jsonb)`, [tenant, ACL])
    await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,source_doc_id,status,acl_principals)
      VALUES ('restore-fact',$1,'e-restore','属性','值',$2,'active',$3::jsonb)`, [tenant, docId, ACL])
    await query(`INSERT INTO fact_evidence(id,fact_id,doc_id,quote) VALUES('ev-restore','restore-fact',$1,'恢复样例的第一段正文。')`, [docId])
    await query(`INSERT INTO review_queue(id,tenant_id,kind,payload) VALUES('rev-restore',$1,'fact_review','{"new_fact_id":"restore-fact"}'::jsonb)`, [tenant])

    await trashDocument(principal, docId)
    assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts WHERE id=$1', ['restore-fact']))?.status, 'retracted')

    const result = await restoreDocument(principal, docId)
    assert.equal(result.status, 'active')
    const document = await queryOne<{ status: string; deleted_at: string | null; deleted_by: string | null; enrichment_status: string }>(
      'SELECT status,deleted_at,deleted_by,enrichment_status FROM documents WHERE id=$1', [docId])
    assert.equal(document?.status, 'active')
    assert.equal(document?.deleted_at, null)
    assert.equal(document?.deleted_by, null)
    assert.equal(document?.enrichment_status, 'pending')

    // 重新切分得到与删除前一致的检索单元文本，并按新 ID 重新向量化。
    const restored = await query<{ id: string; text: string; dense: number[]; embedding_model: string }>(
      'SELECT id,text,dense,embedding_model FROM chunks WHERE doc_id=$1 AND is_parent=false ORDER BY seq', [docId])
    assert.deepEqual(restored.map((chunk) => chunk.text), chunkTexts)
    for (const chunk of restored) {
      assert.ok(chunk.dense.length > 0)
      assert.equal(chunk.embedding_model, 'test-embedding')
    }
    // 引用高亮依赖 chunk_spans 与新检索单元 ID 的映射。
    const meta = await queryOne<{ meta: { chunk_spans?: Record<string, unknown> } }>(
      'SELECT meta FROM document_versions WHERE id=$1', [versionId])
    const spans = meta?.meta.chunk_spans ?? {}
    for (const chunk of await query<{ id: string }>('SELECT id FROM chunks WHERE doc_id=$1', [docId])) {
      assert.ok(chunk.id in spans)
    }
    // 事实与实体走重新抽取，旧证据不会被“复原”。
    assert.equal((await query('SELECT id FROM fact_evidence WHERE doc_id=$1', [docId])).length, 0)
    assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts WHERE id=$1', ['restore-fact']))?.status, 'retracted')
    const enrich = await queryOne<{ status: string }>(
      "SELECT status FROM jobs WHERE type='enrich' AND payload->>'document_id'=$1", [docId])
    assert.equal(enrich?.status, 'pending')
    await assert.rejects(restoreDocument(principal, docId), /不在回收站/)
  } finally { await workspace.close() }
})

test('a failed re-embedding leaves the document in the trash', async () => {
  const workspace = await testWorkspace()
  try {
    const principal = workspace.principal
    const doc = await ingest(principal, '向量失败样例', '向量失败样例的正文内容。')
    const docId = String(doc.document_id)
    await trashDocument(principal, docId)
    const embed = embedder.embedMany
    embedder.embedMany = async () => { throw new Error('向量服务不可用') }
    try {
      await assert.rejects(restoreDocument(principal, docId), /向量服务不可用/)
    } finally { embedder.embedMany = embed }
    assert.equal((await queryOne<{ status: string }>('SELECT status FROM documents WHERE id=$1', [docId]))?.status, 'tombstoned')
    assert.equal((await query('SELECT id FROM chunks WHERE doc_id=$1', [docId])).length, 0)
  } finally { await workspace.close() }
})

test('permanent deletion clears every trace of the document and its orphan entities', async () => {
  const workspace = await testWorkspace()
  try {
    const principal = workspace.principal
    const tenant = principal.tenantId
    const trash = await ingest(principal, '彻底删除样例', '彻底删除样例的正文内容。')
    const keep = await ingest(principal, '保留样例', '保留样例的正文内容。')
    const trashId = String(trash.document_id)
    const keepId = String(keep.document_id)
    await query(`INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,acl_principals)
      VALUES ('e-orphan',$1,'临时实体','临时实体',$2::jsonb),('e-kept',$1,'保留实体','保留实体',$2::jsonb)`, [tenant, ACL])
    await query(`INSERT INTO entity_aliases(id,entity_id,alias,normalized_alias) VALUES('ali-orphan','e-orphan','临时实体','临时实体')`)
    await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,source_doc_id,status,acl_principals)
      VALUES ('temp-fact',$1,'e-orphan','属性','值',$2,'active',$3::jsonb),
             ('kept-fact',$1,'e-kept','属性','值',$4,'active',$3::jsonb)`, [tenant, trashId, ACL, keepId])
    await query(`INSERT INTO fact_evidence(id,fact_id,doc_id,quote)
      VALUES ('ev-temp','temp-fact',$1,'彻底删除样例的正文内容。'),
             ('ev-kept-trash','kept-fact',$1,'彻底删除样例的正文内容。'),
             ('ev-kept-keep','kept-fact',$2,'保留样例的正文内容。')`, [trashId, keepId])
    await query(`INSERT INTO citations(id,message_id,doc_id,quote) VALUES('cit-trash','m1',$1,'彻底删除样例的正文内容。')`, [trashId])
    await query(`INSERT INTO eval_cases(id,tenant_id,question,expected_docs) VALUES('case-1',$1,'问题',$2::jsonb)`, [tenant, JSON.stringify([trashId])])
    await query(`INSERT INTO review_queue(id,tenant_id,kind,payload,status,resolution)
      VALUES('rev-purged',$1,'fact_review','{"new_fact_id":"temp-fact"}'::jsonb,'resolved','{"action":"document_trashed"}'::jsonb)`, [tenant])

    await trashDocument(principal, trashId)
    const result = await purgeDocument(principal, trashId)
    assert.equal(result.status, 'purged')
    assert.equal(result.removed_facts, 1)
    assert.deepEqual(await query('SELECT id FROM documents ORDER BY id'), [{ id: keepId }])
    assert.equal((await query('SELECT id FROM document_versions WHERE doc_id=$1', [trashId])).length, 0)
    assert.equal((await query('SELECT id FROM blocks WHERE doc_id=$1', [trashId])).length, 0)
    assert.equal((await query('SELECT id FROM chunks WHERE doc_id=$1', [trashId])).length, 0)
    // 原始文件与审计任务都在 jobs 里，一并清除；其他文档的任务保留。purge 审计记录只留文档 ID 与计数。
    assert.equal((await query("SELECT id FROM jobs WHERE type<>'purge' AND (payload->>'doc_id'=$1 OR payload->>'document_id'=$1)", [trashId])).length, 0)
    assert.equal((await query('SELECT id FROM facts WHERE id=$1', ['temp-fact'])).length, 0)
    assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts WHERE id=$1', ['kept-fact']))?.status, 'active')
    assert.equal((await query('SELECT id FROM entity_aliases WHERE entity_id=$1', ['e-orphan'])).length, 0)
    assert.equal((await query('SELECT id FROM entities WHERE id=$1', ['e-orphan'])).length, 0)
    assert.equal((await query('SELECT id FROM entities WHERE id=$1', ['e-kept'])).length, 1)
    assert.equal((await query('SELECT id FROM citations WHERE doc_id=$1', [trashId])).length, 0)
    assert.equal((await query('SELECT id FROM review_queue WHERE id=$1', ['rev-purged'])).length, 0)
    assert.deepEqual((await queryOne<{ expected_docs: string[] }>('SELECT expected_docs FROM eval_cases WHERE id=$1', ['case-1']))?.expected_docs, [])
    assert.equal((await query('SELECT id FROM knowledge_summaries WHERE tenant_id=$1', [tenant])).length, 0)
    // 彻底删除后同一内容可以重新入库为全新文档。
    const reimported = await ingest(principal, '彻底删除样例', '彻底删除样例的正文内容。')
    assert.notEqual(String(reimported.document_id), trashId)
    await assert.rejects(purgeDocument(principal, trashId), /不存在/)
  } finally { await workspace.close() }
})

test('expired trash is purged by retention days and kept when retention is zero', async () => {
  const workspace = await testWorkspace()
  try {
    const principal = workspace.principal
    const tenant = principal.tenantId
    const old = await ingest(principal, '过期样例', '过期样例正文。')
    const fresh = await ingest(principal, '保留样例二', '保留样例二正文。')
    await trashDocument(principal, String(old.document_id))
    await trashDocument(principal, String(fresh.document_id))
    await query("UPDATE documents SET deleted_at = now() - interval '40 days' WHERE id=$1", [old.document_id])
    assert.equal(await purgeExpiredTrash(tenant, 30), 1)
    assert.deepEqual(
      (await query<{ id: string }>('SELECT id FROM documents ORDER BY id')).map((row) => row.id),
      [fresh.document_id],
    )
    assert.equal(await purgeExpiredTrash(tenant, 0), 0)
    assert.equal((await query('SELECT id FROM documents')).length, 1)
  } finally { await workspace.close() }
})

test('document API exposes the trash list with restore and permanent deletion', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  try {
    const principal = workspace.principal
    const doc = await ingest(principal, '接口样例', '接口样例正文。')
    const docId = String(doc.document_id)
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/documents/${docId}`, headers: workspace.headers })
    assert.equal(del.statusCode, 200)
    assert.equal(del.json().status, 'tombstoned')
    assert.equal((await app.inject({ url: `/api/v1/documents/${docId}`, headers: workspace.headers })).statusCode, 404)
    const trash = (await app.inject({ url: '/api/v1/documents/trash', headers: workspace.headers })).json()
    assert.equal(trash.retention_days, 30)
    assert.equal(trash.can_manage, true)
    assert.deepEqual(trash.items.map((item: { id: string }) => item.id), [docId])
    assert.ok(trash.items[0].deleted_at)
    assert.ok(trash.items[0].expires_at)
    const restore = await app.inject({ method: 'POST', url: `/api/v1/documents/${docId}/restore`, headers: workspace.headers })
    assert.equal(restore.statusCode, 200)
    assert.equal(restore.json().status, 'active')
    assert.equal((await app.inject({ url: `/api/v1/documents/${docId}`, headers: workspace.headers })).statusCode, 200)
    assert.equal((await trashDocuments(principal)).length, 0)
    await app.inject({ method: 'DELETE', url: `/api/v1/documents/${docId}`, headers: workspace.headers })
    const purge = await app.inject({ method: 'DELETE', url: `/api/v1/documents/${docId}/permanent`, headers: workspace.headers })
    assert.equal(purge.statusCode, 200)
    assert.equal(purge.json().status, 'purged')
    const missing = await app.inject({ method: 'DELETE', url: `/api/v1/documents/${docId}/permanent`, headers: workspace.headers })
    assert.equal(missing.statusCode, 404)
    // 未移入回收站的文档不能直接彻底删除。
    const direct = await ingest(principal, '直接删除样例', '直接删除样例正文。')
    const rejected = await app.inject({ method: 'DELETE', url: `/api/v1/documents/${direct.document_id}/permanent`, headers: workspace.headers })
    assert.equal(rejected.statusCode, 409)
  } finally { await app.close(); await workspace.close() }
})
