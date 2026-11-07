import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { ingestParsed, stopIngestWorker } from '../src/core/ingestion.js'
import { parseTextContent } from '../src/adapters/parsing/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'
import { reindexDocument } from '../src/core/reindexing.js'
import { shouldEnrich, evidenceWeight } from '../src/core/source-policy.js'
let workspace: Awaited<ReturnType<typeof testWorkspace>>
let original: typeof embedder.embedMany
before(async () => { workspace=await testWorkspace(); original=embedder.embedMany })
beforeEach(async () => { await clearKnowledge(); embedder.embedMany=original })
after(async () => { await stopIngestWorker(); await workspace.close() })

test('reindex preserves historical chunk identities and rolls back when embedding fails', async () => {
  const first=await ingestParsed(workspace.principal,parseTextContent('第一版完整原文','Index'),{sourceType:'text',uri:'index-fixture'})
  await ingestParsed(workspace.principal,parseTextContent('第二版完整原文','Index'),{sourceType:'text',uri:'index-fixture'})
  const before=await query<{id:string;dense:number[]}>('SELECT id,dense FROM chunks ORDER BY id')
  embedder.embedMany=async () => { throw new Error('unavailable') }
  await assert.rejects(reindexDocument(workspace.principal.tenantId,String(first.document_id)))
  assert.deepEqual(await query('SELECT id,dense FROM chunks ORDER BY id'),before)
  embedder.embedMany=async texts => texts.map(() => ({dense:[0,1,0],sparse:{learned:0.8},model:'replacement',dim:3}))
  await reindexDocument(workspace.principal.tenantId,String(first.document_id))
  const after=await query<{id:string;embedding_model:string;is_parent:boolean}>('SELECT id,embedding_model,is_parent FROM chunks ORDER BY id')
  assert.deepEqual(after.map(row=>row.id),before.map(row=>row.id))
  assert.ok(after.filter(row=>!row.is_parent).every(row=>row.embedding_model==='replacement'))
  assert.equal((await query('SELECT id FROM document_versions')).length,2)
})

test('legacy deferred documents can still be enriched based on source policy or use', async () => {
  const result=await ingestParsed(workspace.principal,parseTextContent('旧文档可检索，尚未抽取事实。','Policy'),{sourceType:'text'})
  const docId=String(result.document_id)
  assert.equal(await shouldEnrich(docId),false)
  assert.equal(evidenceWeight({quality_score:1,source_trust:0.2}),0.2)
  await query('UPDATE documents SET is_core=true WHERE id=$1',[docId])
  assert.equal(await shouldEnrich(docId),true)
  await query('UPDATE documents SET is_core=false,source_trust=0.8 WHERE id=$1',[docId])
  assert.equal(await shouldEnrich(docId),true)
  await query('UPDATE documents SET source_trust=0.5 WHERE id=$1',[docId])
  const chunk=await queryOne<{id:string}>('SELECT id FROM chunks WHERE doc_id=$1 AND is_parent=false',[docId])
  for(let i=0;i<3;i++) await query('INSERT INTO citations(id,message_id,chunk_id,doc_id,quote,rank) VALUES($1,$2,$3,$4,$5,1)',[`policy-cite-${i}`,`answer-${i}`,chunk!.id,docId,'旧文档'])
  assert.equal(await shouldEnrich(docId),true)
})
