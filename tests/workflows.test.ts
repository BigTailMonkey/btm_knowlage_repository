import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { createServer } from '../src/app/server.js'
import { ingestParsed, stopIngestWorker } from '../src/core/ingestion.js'
import { processEnrichmentQueue } from '../src/core/enrichment-queue.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { runDailyReflection } from '../src/core/scheduling.js'
import { syncDirectory } from '../src/core/directory-sync.js'
import { verifySemanticGrounding } from '../src/core/grounding.js'
import { harness } from '../src/adapters/harness/index.js'
import { settings } from '../src/config.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>
const result=(text:string)=>({text,tokensIn:0,tokensOut:0,latencyMs:0,model:'test',provider:'test',ok:true,error:null})
before(async()=>{workspace=await testWorkspace();app=await createServer();app.log.level='silent'})
beforeEach(async()=>{await stopIngestWorker();await clearKnowledge();harness.ask=async()=>result('知织支持检索和引用。[1]');harness.complete=async()=>result('[]')})
after(async()=>{await stopIngestWorker();await app.close();await workspace.close()})

test('directory sync keeps folders independent, skips unchanged files, versions updates and only deletes explicitly',async()=>{
  const root=await mkdtemp(join(tmpdir(),'knowledge-folder-'))
  try{
    await mkdir(join(root,'a'));await mkdir(join(root,'b'));await mkdir(join(root,'.private'))
    await writeFile(join(root,'a','notes.md'),'# Alpha\n\nAlpha document.')
    await writeFile(join(root,'b','notes.md'),'# Beta\n\nBeta document.')
    await writeFile(join(root,'.private','secret.txt'),'must not import')
    const first=await syncDirectory(workspace.principal,root)
    assert.equal(first.scanned,2);assert.equal(first.submitted,2)
    assert.deepEqual(first.jobs.map(row=>row.status),['done','done'])
    const next=await syncDirectory(workspace.principal,root)
    assert.equal(next.unchanged,2);assert.equal(next.submitted,0)
    await writeFile(join(root,'a','notes.md'),'# Alpha\n\nUpdated Alpha document.')
    await syncDirectory(workspace.principal,root)
    assert.deepEqual((await query<{current_version:number}>('SELECT current_version FROM documents ORDER BY uri')).map(row=>row.current_version),[2,1])
    await rm(join(root,'b','notes.md'))
    await syncDirectory(workspace.principal,root)
    assert.equal((await query("SELECT id FROM documents WHERE status='active'")).length,2)
    await syncDirectory(workspace.principal,root,true)
    assert.equal((await query("SELECT id FROM documents WHERE status='active'")).length,1)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('daily maintenance honors workspace timezone and persistent once-per-day execution for every tenant',async()=>{
  settings.reflectionRunAt='03:00';settings.timezone='Asia/Shanghai'
  await query("INSERT INTO tenants(id,name) VALUES('second','Second')")
  assert.equal(await runDailyReflection(new Date('2026-11-06T18:59:00Z')),0)
  assert.equal(await runDailyReflection(new Date('2026-11-06T19:01:00Z')),2)
  assert.equal(await runDailyReflection(new Date('2026-11-06T20:00:00Z')),0)
  assert.equal((await query("SELECT id FROM jobs WHERE type='reflection_schedule' AND status='done'")).length,2)
  await query("DELETE FROM tenants WHERE id='second'")
})

test('semantic verifier requires complete positive structured decisions and fails closed on model errors',async()=>{
  harness.complete=async()=>result('{"supported":true,"unsupported_sentences":[]}')
  assert.equal(await verifySemanticGrounding('claim[1]',[{text:'source'}]),true)
  harness.complete=async()=>result('{"supported":true,"unsupported_sentences":["claim"]}')
  assert.equal(await verifySemanticGrounding('claim[1]',[{text:'source'}]),false)
  harness.complete=async()=>{throw new Error('offline')}
  await assert.rejects(verifySemanticGrounding('claim[1]',[{text:'source'}]), /offline/)
})

test('evaluation imports expected outcomes, runs actual answering, and does not create user conversations',async()=>{
  await ingestParsed(workspace.principal,parseText('知织支持检索和引用。','Knowledge fixture'),{sourceType:'text',uri:'eval:fixture'})
  let calls=0
  harness.ask=async()=>{calls+=1;return result('知织支持检索和引用。[1]')}
  const imported=await app.inject({method:'POST',url:'/api/v1/evals/cases',headers:workspace.headers,payload:{cases:[{question:'知织支持什么？',expected_docs:['Knowledge fixture'],expected_keywords:['引用'],should_refuse:false}]}})
  assert.equal(imported.statusCode,200)
  const evaluation=await app.inject({method:'POST',url:'/api/v1/evals/run',headers:workspace.headers,payload:{mode:'answer'}})
  assert.equal(evaluation.statusCode,200)
  const data=evaluation.json()
  assert.equal(calls,1);assert.equal(data.metrics.pass_rate,1);assert.equal(data.metrics.citation_accuracy,1)
  assert.equal(data.metrics.recall_at_10,1);assert.ok(data.metrics.p95_latency_ms>0)
  assert.equal(data.metrics.model_calls,1);assert.equal(data.metrics.model_successes,1)
  assert.equal((await query('SELECT id FROM conversations')).length,0)
  assert.equal((await query('SELECT id FROM memory_items')).length,0)
})

test('evaluation continues after a model failure and retries only requested cases', async () => {
  await ingestParsed(workspace.principal, parseText('知织支持检索和引用。', 'Knowledge fixture'), { sourceType: 'text' })
  const request = (method: 'GET' | 'POST', path: string, payload?: object) =>
    app.inject({ method, url: '/api/v1' + path, headers: workspace.headers, payload })
  const cases = ['知织支持什么检索？', '知织支持什么引用？'].map(question => ({
    question, expected_docs: ['Knowledge fixture'], expected_keywords: ['引用'], should_refuse: false,
  }))
  assert.equal((await request('POST', '/evals/cases', { cases })).statusCode, 200)
  harness.ask = async (_session, prompt) => prompt.includes(cases[0]!.question)
    ? { ...result(''), ok: false, error: 'HTTP 503' } : result('知织支持检索和引用。[1]')
  const run = (await request('POST', '/evals/run', {})).json()
  assert.equal(run.metrics.failed_cases, 1)
  assert.equal(run.results.filter((item: { pass: boolean }) => item.pass).length, 1)
  const failures = (await request('GET', '/evals/failures')).json().items
  assert.equal(failures.length, 1)
  assert.match(failures[0].error, /HTTP 503/)
  harness.ask = async () => result('知织支持检索和引用。[1]')
  const retried = (await request('POST', '/evals/run', { case_ids: [failures[0].case_id] })).json()
  assert.equal(retried.metrics.cases, 1)
  assert.equal(retried.metrics.pass_rate, 1)
  assert.deepEqual((await request('GET', '/evals/failures')).json().items, [])
})

test('automatic failure candidates need explicit approval before entering the golden evaluation',async()=>{
  await app.inject({method:'POST',url:'/api/v1/ask',headers:workspace.headers,payload:{question:'missing knowledge'}})
  const cases=(await app.inject({method:'GET',url:'/api/v1/evals/cases',headers:workspace.headers})).json().items
  assert.equal(cases.length,1);assert.match(cases[0].source,/^failure-candidate:/)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/evals/run',headers:workspace.headers})).statusCode,422)
  await app.inject({method:'PATCH',url:`/api/v1/evals/cases/${cases[0].id}`,headers:workspace.headers,payload:{expected_docs:[],expected_keywords:[],should_refuse:true}})
  await app.inject({method:'POST',url:`/api/v1/evals/cases/${cases[0].id}/approve`,headers:workspace.headers})
  const data=(await app.inject({method:'POST',url:'/api/v1/evals/run',headers:workspace.headers})).json()
  assert.equal(data.metrics.pass_rate,1);assert.equal(data.metrics.refusal_accuracy,1)
})

test('memory promotion preserves the full source and creates no unsupported active record fact',async()=>{
  const text='知织支持知识检索。'+'经过审阅的原始记忆内容。'.repeat(60)
  const memory=await app.inject({method:'POST',url:'/api/v1/memory',headers:workspace.headers,payload:{text}})
  const promotion=await app.inject({method:'POST',url:`/api/v1/memory/${memory.json().id}/promote`,headers:workspace.headers})
  harness.complete=async()=>({...result(''),ok:false,error:'HTTP 503'})
  const resolved=await app.inject({method:'POST',url:`/api/v1/review/${promotion.json().review_id}/resolve`,headers:workspace.headers,payload:{action:'accept_new'}})
  assert.equal(resolved.statusCode,200)
  assert.equal(resolved.json().status,'queued')
  await processEnrichmentQueue()
  const reviewId=promotion.json().review_id
  assert.match(String((await queryOne<{payload:{model_error:string}}>('SELECT payload FROM review_queue WHERE id=$1',[reviewId]))?.payload.model_error), /HTTP 503/)
  harness.complete=async()=>result('[]')
  const retry=await app.inject({method:'POST',url:'/api/v1/documents/extractions/retry',headers:workspace.headers,payload:{}})
  assert.equal(retry.json().queued,1)
  await processEnrichmentQueue()
  assert.equal((await queryOne<{status:string}>('SELECT status FROM review_queue WHERE id=$1',[reviewId]))?.status,'resolved')
  const versions=await query<{text:string}>('SELECT text FROM document_versions')
  assert.ok(versions.some(version=>version.text.includes(text)))
  assert.equal((await query("SELECT id FROM facts WHERE predicate='记录' AND status='active'")).length,0)
  assert.equal((await query('SELECT id FROM facts f WHERE NOT EXISTS(SELECT 1 FROM fact_evidence e WHERE e.fact_id=f.id)')).length,0)
})

test('MCP note tags round-trip and explicit personal corrections do not create knowledge facts',async()=>{
  const response=await app.inject({method:'POST',url:'/api/v1/mcp',headers:workspace.headers,payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'kb_add_note',arguments:{text:'个人注记',tags:['project','review']}}}})
  assert.equal(response.statusCode,200)
  const memories=await app.inject({method:'GET',url:'/api/v1/memory',headers:workspace.headers})
  assert.deepEqual(memories.json().items[0].tags,['project','review'])
  const correction=await app.inject({method:'POST',url:'/api/v1/ask',headers:workspace.headers,payload:{question:'纠正一下：我的项目代号为星海。'}})
  assert.equal(correction.statusCode,200)
  assert.match(correction.json().answer,/已记入个人记忆/)
  assert.equal((await query("SELECT id FROM memory_items WHERE text='我的项目代号为星海。'")).length,1)
  assert.equal((await query('SELECT id FROM facts')).length,0)
})
