import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { enrichmentTasks, processEnrichmentQueue, stopEnrichmentWorker } from '../src/core/enrichment-queue.js'
import { createServer } from '../src/app/server.js'
import { submitIngest, processIngestQueue, savedIngestJobs, retryIngestJob, stopIngestWorker } from '../src/core/ingestion.js'
let workspace: Awaited<ReturnType<typeof testWorkspace>>
let original: typeof embedder.embedMany
before(async () => { workspace = await testWorkspace(); original = embedder.embedMany })
beforeEach(async () => { await stopIngestWorker(); await clearKnowledge(); embedder.embedMany = original })
after(async () => { await stopIngestWorker(); await workspace.close() })

test('acknowledgement persists original input; expired running work recovers idempotently', async () => {
  const job = await submitIngest(workspace.principal, 'file', { filename: 'recover.txt', data: Buffer.from('恢复任务原始内容') })
  const stored = await queryOne<{ payload: any }>('SELECT payload FROM jobs WHERE id=$1', [job.job_id])
  assert.equal(Buffer.from(stored!.payload.request.data, 'base64').toString(), '恢复任务原始内容')
  assert.ok(!JSON.stringify(stored!.payload).includes('owner-token'))
  await processIngestQueue()
  await query("UPDATE jobs SET status='running',updated_at=now()-interval '5 minutes' WHERE id=$1", [job.job_id])
  await processIngestQueue()
  await processEnrichmentQueue()
  const jobs = await savedIngestJobs(workspace.principal)
  assert.equal(jobs[0]!.status, 'done')
  assert.match(String((await enrichmentTasks(workspace.principal))[0]?.error), /抽取失败.*offline/)
  assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents'))?.enrichment_status, 'failed')
  assert.equal((await query('SELECT id FROM entities')).length, 0)
  assert.equal((await query('SELECT id FROM documents')).length, 1)
  assert.equal((await query('SELECT id FROM document_versions')).length, 1)
})

test('ordinary imports extract entities and resume unfinished extraction without reindexing', async () => {
  const upload = { filename: 'architecture.txt', data: Buffer.from('知织使用数据库。') }
  const complete = harness.complete
  let extractionCalls = 0
  harness.complete = async (_prompt, system) => {
    if (system?.includes('事实校验器')) return { text: JSON.stringify([{ index: 1, keep: true, reason: '' }]), tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true }
    extractionCalls++
    return {
      text: JSON.stringify([{ subject: '知织', predicate: '使用', object: '数据库', quote: '知织使用数据库' }]),
      tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true,
    }
  }
  try {
    await submitIngest(workspace.principal, 'file', upload)
    await processIngestQueue()
    await processEnrichmentQueue()
    const doc = await queryOne<{ id: string; enrichment_status: string; source_trust: number; is_core: boolean }>(
      'SELECT id, enrichment_status, source_trust, is_core FROM documents',
    )
    assert.equal(doc?.enrichment_status, 'done')
    assert.equal(doc?.source_trust, 0.5)
    assert.equal(doc?.is_core, false)
    assert.deepEqual((await query<{ canonical_name: string }>('SELECT canonical_name FROM entities'))
      .map((row) => row.canonical_name).sort(), ['数据库', '知织'])
    assert.equal((await query('SELECT id FROM fact_evidence WHERE doc_id=$1', [doc!.id])).length, 1)

    await submitIngest(workspace.principal, 'file', upload)
    await processIngestQueue()
    assert.equal(extractionCalls, 1)

    assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents WHERE id=$1', [doc!.id]))?.enrichment_status, 'done')
    assert.equal((await query('SELECT id FROM document_versions')).length, 1)
    assert.equal((await query('SELECT id FROM fact_evidence WHERE doc_id=$1', [doc!.id])).length, 1)
  } finally {
    harness.complete = complete
  }
})

test('model failures leave indexing and later extraction unblocked and can be retried individually or in bulk', { timeout: 10_000 }, async () => {
  const app = await createServer()
  app.log.level = 'silent'
  const previous = harness.complete
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  let recovered = false
  harness.complete = async (prompt, system) => {
    if (system?.includes('事实校验器')) return { text: '[]', ok: true, error: null, model: 'stub', provider: 'stub', tokensIn: 0, tokensOut: 0, latencyMs: 0 }
    if (!recovered && prompt.includes('首先失败')) {
      started()
      await held
    }
    const ok = recovered || prompt.includes('独立成功')
    return { text: ok ? '[]' : '', ok, error: ok ? null : 'HTTP 503', model: 'stub', provider: 'stub', tokensIn: 0, tokensOut: 0, latencyMs: 0 }
  }
  const retry = (documentIds?: string[]) => app.inject({
    method: 'POST', url: '/api/v1/documents/extractions/retry', headers: workspace.headers,
    payload: documentIds ? { document_ids: documentIds } : {},
  })
  try {
    await submitIngest(workspace.principal, 'text', { title: '首先失败', text: '第一份文档用于验证队列。' })
    await entered
    for (const [title, text] of [['独立成功', '第二份文档用于验证队列。'], ['后来失败', '第三份文档用于验证队列。'], ['再次失败', '第四份文档用于验证队列。']]) {
      await submitIngest(workspace.principal, 'text', { title, text })
    }
    await processIngestQueue()
    assert.equal((await savedIngestJobs(workspace.principal)).filter(row => row.status === 'done').length, 4)
    release()
    await processEnrichmentQueue()
    assert.equal((await queryOne<{ enrichment_status: string }>("SELECT enrichment_status FROM documents WHERE title='独立成功'"))?.enrichment_status, 'empty')
    const failed = await enrichmentTasks(workspace.principal)
    assert.equal(failed.length, 3)
    assert.ok(failed.every(task => task.status === 'failed' && task.error?.includes('HTTP 503')))
    recovered = true
    assert.equal((await retry([failed[0]!.id])).json().queued, 1)
    await processEnrichmentQueue()
    assert.equal((await enrichmentTasks(workspace.principal)).length, 2)
    assert.equal((await retry()).json().queued, 2)
    await processEnrichmentQueue()
    assert.deepEqual(await enrichmentTasks(workspace.principal), [])
    assert.equal((await query('SELECT id FROM document_versions')).length, 4)
  } finally {
    release()
    await stopEnrichmentWorker()
    harness.complete = previous
    await app.close()
  }
})

test('index retries use the persisted parse checkpoint and keep failed uploads unpublished', async () => {
  embedder.embedMany = async () => { throw new Error('transient vectors') }
  const job = await submitIngest(workspace.principal, 'file', { filename: 'retry.txt', data: Buffer.from('需要恢复的完整原文') })
  await processIngestQueue()
  const failed = await queryOne<{ status: string; payload: any }>('SELECT status,payload FROM jobs WHERE id=$1', [job.job_id])
  assert.equal(failed!.status, 'failed')
  assert.ok(failed!.payload.checkpoint.parsed.blocks.length)
  assert.equal((await query('SELECT id FROM documents')).length, 0)
  embedder.embedMany = original
  await retryIngestJob(workspace.principal, String(job.job_id), 'index')
  await processIngestQueue()
  assert.equal((await savedIngestJobs(workspace.principal))[0]!.status, 'done')
  assert.equal((await query("SELECT id FROM review_queue WHERE status='open' AND kind='parse_failure'")).length, 0)
})

test('manual corrected text can recover an unavailable parser while preserving source identity', async () => {
  const job = await submitIngest(workspace.principal, 'file', { filename: 'scan.pdf', data: Buffer.from('not a pdf') })
  await processIngestQueue()
  assert.equal((await savedIngestJobs(workspace.principal))[0]!.status, 'failed')
  await retryIngestJob(workspace.principal, String(job.job_id), 'index', '人工核对后的扫描件内容。')
  await processIngestQueue()
  const doc = await queryOne<{ uri: string }>('SELECT uri FROM documents')
  assert.equal(doc!.uri, 'upload:scan.pdf')
  assert.equal((await savedIngestJobs(workspace.principal))[0]!.status, 'done')
})

test('fresh leases are not stolen and automatic retry stops after three failures', async () => {
  const id = 'leased-job'
  await query(`INSERT INTO jobs(id,tenant_id,type,status,attempts,payload) VALUES($1,$2,'ingest','running',1,$3::jsonb)`,
    [id, workspace.principal.tenantId, JSON.stringify({ user_id: workspace.principal.userId, source: 'text', request: { text: '租约测试' } })])
  await processIngestQueue()
  assert.equal((await queryOne<{ attempts: number }>('SELECT attempts FROM jobs WHERE id=$1', [id]))!.attempts, 1)
  embedder.embedMany = async () => { throw new Error('offline') }
  await query("UPDATE jobs SET status='failed',updated_at=now()-interval '1 minute',attempts=2 WHERE id=$1", [id])
  await processIngestQueue()
  await query("UPDATE jobs SET updated_at=now()-interval '1 minute' WHERE id=$1", [id])
  await processIngestQueue()
  const row = await queryOne<{ status: string; attempts: number }>('SELECT status,attempts FROM jobs WHERE id=$1', [id])
  assert.deepEqual(row, { status: 'failed', attempts: 3 })
})
