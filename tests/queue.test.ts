import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'
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
  const jobs = await savedIngestJobs(workspace.principal)
  assert.equal(jobs[0]!.status, 'done')
  assert.equal((await query('SELECT id FROM documents')).length, 1)
  assert.equal((await query('SELECT id FROM document_versions')).length, 1)
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
