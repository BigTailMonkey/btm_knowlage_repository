import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { settings } from '../src/config.js'
import { harness } from '../src/adapters/harness/index.js'
import { semanticRerank } from '../src/adapters/reranking/index.js'
import { getOrCreateEntity, runReflection } from '../src/core/learning.js'
import { consolidateKnowledge } from '../src/core/consolidation.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { retrieve } from '../src/core/retrieval.js'
let workspace: Awaited<ReturnType<typeof testWorkspace>>
const originalFetch = globalThis.fetch
before(async () => { workspace = await testWorkspace() })
beforeEach(async () => { await clearKnowledge(); settings.semanticEntities = false; settings.rerankUrl = ''; globalThis.fetch = originalFetch })
after(async () => { globalThis.fetch = originalFetch; await workspace.close() })

test('semantic rerank validates index completeness and uses returned relevance, not list position', async () => {
  settings.rerankUrl = 'https://test.invalid/rerank'
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.documents, ['alpha', 'beta'])
    return Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] })
  }
  assert.deepEqual(await semanticRerank('query', ['alpha', 'beta']), [0.2, 0.9])
  globalThis.fetch = async () => Response.json({ results: [{ index: 0, relevance_score: 0.8 }, { index: 0, relevance_score: 0.7 }] })
  await assert.rejects(semanticRerank('query', ['alpha', 'beta']), /非法/)
})

test('semantic entity alignment requires an in-roster high-confidence identity decision', async () => {
  const first = await getOrCreateEntity(workspace.principal.tenantId, 'International Business Machines', 'org')
  settings.semanticEntities = true
  harness.complete = async () => ({ text: JSON.stringify({ same_entity: true, entity_id: first.id, confidence: 0.99 }), tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'stub', provider: 'stub', ok: true, error: null })
  const aligned = await getOrCreateEntity(workspace.principal.tenantId, 'IBM', 'org')
  assert.equal(aligned.id, first.id)
  assert.equal((await query("SELECT id FROM entity_aliases WHERE source='semantic-confirmed'")).length, 1)
  harness.complete = async () => ({ text: JSON.stringify({ same_entity: true, entity_id: 'foreign-id', confidence: 1 }), tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'stub', provider: 'stub', ok: true, error: null })
  assert.notEqual((await getOrCreateEntity(workspace.principal.tenantId, 'Different entity', 'org')).id, first.id)
})

test('reflection builds evidence-backed entity and community summaries, clusters gaps and decays only once per period', async () => {
  const tenant = workspace.principal.tenantId
  const doc = await ingestParsed(workspace.principal, parseText('Orchid uses Aurora for storage.', 'Orchid architecture'), { sourceType: 'text', uri: 'maintenance:doc' })
  const chunk = await queryOne<{ id: string }>('SELECT id FROM chunks WHERE doc_id=$1 AND is_parent=false', [doc.document_id])
  const entity = await getOrCreateEntity(tenant, 'Orchid')
  const object = await getOrCreateEntity(tenant, 'Aurora')
  await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_id,status,acl_principals) VALUES('supported',$1,$2,'uses',$3,'active','["tenant:public"]')`, [tenant, entity.id, object.id])
  await query(`INSERT INTO fact_evidence(id,fact_id,chunk_id,doc_id,quote,last_used_at) VALUES('ev','supported',$1,$2,'Orchid uses Aurora for storage.',now()-interval '60 days')`, [chunk!.id, doc.document_id])
  await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,status) VALUES('orphan',$1,$2,'missing','missing','active')`, [tenant, entity.id])
  await query(`INSERT INTO gaps(id,tenant_id,question,count) VALUES('gap-a',$1,'Orchid scaling?',2),('gap-b',$1,'Orchid scaling!',3)`, [tenant])
  const result = await runReflection(tenant)
  assert.equal(result.community_summaries, 1)
  assert.equal(result.orphaned_facts, 1)
  assert.equal(result.clustered_gaps, 1)
  assert.equal((await queryOne<{ weight: number }>("SELECT weight FROM fact_evidence WHERE id='ev'"))!.weight, 0.95)
  await consolidateKnowledge(tenant)
  assert.equal((await queryOne<{ weight: number }>("SELECT weight FROM fact_evidence WHERE id='ev'"))!.weight, 0.95)
  const retrieved = await retrieve(workspace.principal, 'Orchid', { mode: 'graph' })
  assert.equal(retrieved.summaries?.length, 1)
  assert.match(retrieved.summaries![0]!.text, /Orchid uses Aurora/)
  await query("UPDATE documents SET status='tombstoned' WHERE id=$1", [doc.document_id])
  await consolidateKnowledge(tenant)
  assert.equal((await query('SELECT id FROM knowledge_summaries')).length, 0)
})
