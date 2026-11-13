import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { enrichmentTasks, processEnrichmentQueue, requestEnrichment, stopEnrichmentWorker } from '../src/core/enrichment-queue.js'
import { extractionProgress } from '../src/core/extraction-progress.js'
import { createServer } from '../src/app/server.js'
import { settings } from '../src/config.js'
import { newId } from '../src/core/ids.js'
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

test('duplicate imports wait independently and accept one decision per job', async () => {
  const app = await createServer()
  app.log.level = 'silent'
  const post = (path: string, payload: object) =>
    app.inject({ method: 'POST', url: '/api/v1/documents' + path, payload, headers: workspace.headers })
  try {
    const text = '用于检查重复导入的完整内容。'
    const first = (await post('/text', { title: '原始文档', text })).json()
    await processIngestQueue()
    const skip = (await post('/text', { title: '重复甲', text })).json()
    const keep = (await post('/text', { title: '重复乙', text })).json()
    const other = (await post('/text', { title: '其他文档', text: '这一份内容不同，可以继续入库。' })).json()
    await processIngestQueue()
    const jobs = await savedIngestJobs(workspace.principal)
    const status = (id: string) => jobs.find(job => job.job_id === id)?.status
    assert.equal(status(first.job_id), 'done')
    assert.equal(status(skip.job_id), 'awaiting_duplicate')
    assert.equal(status(keep.job_id), 'awaiting_duplicate')
    assert.equal(status(other.job_id), 'done')
    assert.equal((await query('SELECT id FROM documents')).length, 2)

    assert.equal((await post(`/jobs/${skip.job_id}/duplicate`, { action: 'skip' })).json().status, 'skipped')
    assert.equal((await post(`/jobs/${skip.job_id}/duplicate`, { action: 'continue' })).statusCode, 409)
    assert.equal((await post(`/jobs/${keep.job_id}/duplicate`, { action: 'continue' })).statusCode, 200)
    await processIngestQueue()
    assert.deepEqual((await query<{ title: string }>('SELECT title FROM documents')).map(row => row.title).sort(),
      ['其他文档', '原始文档', '重复乙'].sort())

    // A worker restart after index commit must not insert another accepted copy.
    await query("UPDATE jobs SET status='running',updated_at=now()-interval '5 minutes' WHERE id=$1", [keep.job_id])
    await processIngestQueue()
    assert.equal((await query('SELECT id FROM documents')).length, 3)
  } finally {
    await app.close()
  }
})

test('running extraction reports batch base and request progress, then clears it', async () => {
  const complete = harness.complete
  const seen: Array<{ stage: string; batches_total: number; batches_done: number; requests: number } | null> = []
  harness.complete = async (_prompt, system) => {
    const doc = await queryOne<{ id: string; current_version: number }>('SELECT id,current_version FROM documents LIMIT 1')
    seen.push(doc ? extractionProgress(doc.id, doc.current_version) : null)
    if (system?.includes('事实校验器')) {
      return { text: '[]', tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true }
    }
    return {
      text: JSON.stringify([{ subject: '知织', predicate: '使用', object: '数据库', quote: '知织使用数据库' }]),
      tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true,
    }
  }
  try {
    await submitIngest(workspace.principal, 'file', { filename: 'progress.txt', data: Buffer.from('知织使用数据库。') })
    await processIngestQueue()
    await processEnrichmentQueue()
    assert.ok(seen.length >= 1, '抽取期间能读到进度')
    assert.equal(seen[0]?.batches_total, 1, '批次作为底数')
    assert.equal(seen[0]?.batches_done, 0)
    assert.match(String(seen[0]?.stage), /1\/1 批抽取/)
    const doc = await queryOne<{ id: string; current_version: number }>('SELECT id,current_version FROM documents')
    assert.equal(extractionProgress(doc!.id, doc!.current_version), null, '结束后进度清空')
  } finally {
    harness.complete = complete
  }
})

test('failed extraction resumes from the last finished batch instead of re-extracting it', async () => {
  // 9000+ 字 → 2 批；第 2 批首次失败，重试只补第 2 批
  const sentences = Array.from({ length: 900 }, (_, index) => `知织使用库${String(index).padStart(4, '0')}号`)
  const complete = harness.complete
  const ok = (text: string) => ({ text, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true })
  let batch1Calls = 0
  let batch2Calls = 0
  let failBatch2 = true
  const seenProgress: Array<{ batches_done: number; stage: string } | null> = []
  harness.complete = async (prompt, system) => {
    if (system?.includes('事实校验器')) {
      const numbered = [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
      return ok(JSON.stringify(numbered.map((index) => ({ index, keep: true, reason: '' }))))
    }
    const batch = Number(/分批：(\d+)/.exec(prompt)?.[1])
    const quote = /原文：\n([^\n]+)/.exec(prompt)?.[1] ?? ''
    const doc = await queryOne<{ id: string; current_version: number }>('SELECT id,current_version FROM documents LIMIT 1')
    if (doc) seenProgress.push(extractionProgress(doc.id, doc.current_version))
    if (batch === 1) batch1Calls += 1
    else {
      batch2Calls += 1
      if (failBatch2) return { text: '', tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: '模型接口返回 HTTP 429：rate limited', ok: false }
    }
    return ok(JSON.stringify([{
      subject: '知织', subject_type: 'org', predicate: '使用', object: quote.replace('知织使用', ''),
      object_type: 'org', quote,
    }]))
  }
  try {
    await submitIngest(workspace.principal, 'file', { filename: 'resume.txt', data: Buffer.from(sentences.join('\n')) })
    await processIngestQueue()
    await processEnrichmentQueue()
    const doc = await queryOne<{ id: string; enrichment_status: string }>('SELECT id,enrichment_status FROM documents')
    assert.equal(doc?.enrichment_status, 'failed')
    assert.equal(batch1Calls, 1)
    assert.equal(batch2Calls, 1)
    const saved = await queryOne<{ checkpoint: { batches: unknown[]; total: number } }>(
      "SELECT payload->'checkpoint' AS checkpoint FROM jobs WHERE id=$1", [`enrich:${doc!.id}:1`])
    assert.equal(saved?.checkpoint?.batches.length, 1, '已完成批次要落盘')
    assert.equal(saved?.checkpoint?.total, 2)

    failBatch2 = false
    seenProgress.length = 0
    assert.equal(await requestEnrichment(workspace.principal, doc!.id, 'failed'), true)
    await processEnrichmentQueue()
    assert.equal(batch1Calls, 1, '已完成的批次不再重复抽取')
    assert.equal(batch2Calls, 2, '只补没跑完的那一批')
    assert.equal(seenProgress[0]?.batches_done, 1, '续跑时进度接着已完成批次算')
    assert.match(String(seenProgress[0]?.stage), /续抽第 2\/2 批抽取/)
    assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents'))?.enrichment_status, 'done')
    assert.equal((await queryOne<{ checkpoint: unknown }>("SELECT payload->'checkpoint' AS checkpoint FROM jobs WHERE id=$1", [`enrich:${doc!.id}:1`]))?.checkpoint, null, '成功后清空检查点')
  } finally {
    harness.complete = complete
  }
})

test('forcing a fresh extraction drops the checkpoint and re-runs finished batches', async () => {
  const sentences = Array.from({ length: 900 }, (_, index) => `知织使用库${String(index).padStart(4, '0')}号`)
  const complete = harness.complete
  const ok = (text: string) => ({ text, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true })
  let batch1Calls = 0
  let batch2Calls = 0
  let failBatch2 = true
  harness.complete = async (prompt, system) => {
    if (system?.includes('事实校验器')) {
      const numbered = [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
      return ok(JSON.stringify(numbered.map((index) => ({ index, keep: true, reason: '' }))))
    }
    const batch = Number(/分批：(\d+)/.exec(prompt)?.[1])
    const quote = /原文：\n([^\n]+)/.exec(prompt)?.[1] ?? ''
    if (batch === 1) batch1Calls += 1
    else {
      batch2Calls += 1
      if (failBatch2) return { text: '', tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: '模型接口返回 HTTP 429：rate limited', ok: false }
    }
    return ok(JSON.stringify([{
      subject: '知织', subject_type: 'org', predicate: '使用', object: quote.replace('知织使用', ''),
      object_type: 'org', quote,
    }]))
  }
  try {
    await submitIngest(workspace.principal, 'file', { filename: 'reset.txt', data: Buffer.from(sentences.join('\n')) })
    await processIngestQueue()
    await processEnrichmentQueue()
    const doc = await queryOne<{ id: string; enrichment_status: string }>('SELECT id,enrichment_status FROM documents')
    assert.equal(doc?.enrichment_status, 'failed')
    assert.equal(batch1Calls, 1)
    assert.notEqual((await queryOne<{ checkpoint: unknown }>("SELECT payload->'checkpoint' AS checkpoint FROM jobs WHERE id=$1", [`enrich:${doc!.id}:1`]))?.checkpoint, null)

    // 强制重抽：检查点被丢掉，接口与数据都要回到从头开始
    const app = await createServer()
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/documents/extractions/retry', headers: workspace.headers,
        payload: { document_ids: [doc!.id], reset: true },
      })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { queued: 1, reset: true })
    } finally {
      await app.close()
    }
    assert.equal((await queryOne<{ checkpoint: unknown }>("SELECT payload->'checkpoint' AS checkpoint FROM jobs WHERE id=$1", [`enrich:${doc!.id}:1`]))?.checkpoint, null, '检查点已被丢弃')

    failBatch2 = false
    batch1Calls = 0
    batch2Calls = 0
    await processEnrichmentQueue()
    assert.equal(batch1Calls, 1, '强制重抽必须重新跑已完成的批次')
    assert.equal(batch2Calls, 1)
  } finally {
    harness.complete = complete
  }
})

test('reset must be a boolean on the retry endpoint', async () => {
  const app = await createServer()
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/documents/extractions/retry', headers: workspace.headers,
      payload: { reset: 'yes' },
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().detail, /reset 必须为布尔值/)
  } finally {
    await app.close()
  }
})

test('failed merge resumes after the merged candidates without re-extracting', async () => {
  // 单批 8 条候选：前 6 条实体已存在，第 7 条触发语义判定并首次失败
  const lines = Array.from({ length: 8 }, (_, index) => `知织使用库${index + 1}号`)
  const complete = harness.complete
  const previousSemantic = settings.semanticEntities
  settings.semanticEntities = true
  const ok = (text: string) => ({ text, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: null, ok: true })
  let extractionCalls = 0
  let semanticCalls = 0
  let failSemantic = true
  try {
    for (const name of ['知织', ...lines.slice(0, 6).map((_, index) => `库${index + 1}号`)]) {
      await query(`INSERT INTO entities (id,tenant_id,type,canonical_name,normalized_name,description,status,acl_principals)
        VALUES ($1,$2,'org',$3,$3,'','active','["tenant:public"]'::jsonb)`, [newId('ent'), settings.defaultTenantId, name])
    }
    harness.complete = async (prompt, system) => {
      if (system?.includes('判定名称是否指同一实体')) {
        semanticCalls += 1
        if (failSemantic) return { text: '', tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', error: '模型接口返回 HTTP 429：限流', ok: false }
        return ok(JSON.stringify({ same_entity: false, entity_id: null, confidence: 0 }))
      }
      if (system?.includes('事实校验器')) {
        const numbered = [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
        return ok(JSON.stringify(numbered.map((index) => ({ index, keep: true, reason: '' }))))
      }
      extractionCalls += 1
      return ok(JSON.stringify(lines.map((line, index) => ({
        subject: '知织', subject_type: 'org', predicate: `使用${index + 1}`,
        object: `库${index + 1}号`, object_type: 'org', quote: line,
      }))))
    }
    await submitIngest(workspace.principal, 'file', { filename: 'merge-resume.txt', data: Buffer.from(lines.join('\n')) })
    await processIngestQueue()
    await processEnrichmentQueue()
    const doc = await queryOne<{ id: string; enrichment_status: string }>('SELECT id,enrichment_status FROM documents')
    assert.equal(doc?.enrichment_status, 'failed')
    assert.equal(extractionCalls, 1)
    assert.equal(semanticCalls, 1)
    const checkpoint = await queryOne<{ checkpoint: { merged: number } }>(
      "SELECT payload->'checkpoint' AS checkpoint FROM jobs WHERE id=$1", [`enrich:${doc!.id}:1`])
    assert.equal(checkpoint?.checkpoint?.merged, 5, '合并进度每 5 条落一次盘')
    assert.equal((await query('SELECT id FROM facts')).length, 6, '失败前已合并的 6 条事实保留')

    failSemantic = false
    assert.equal(await requestEnrichment(workspace.principal, doc!.id, 'failed'), true)
    await processEnrichmentQueue()
    assert.equal(extractionCalls, 1, '候选全部复用，不再重新抽取')
    assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents'))?.enrichment_status, 'done')
    assert.equal((await query('SELECT id FROM facts')).length, 8, '续跑后 8 条事实齐全且没有重复')
    assert.equal((await queryOne<{ checkpoint: unknown }>("SELECT payload->'checkpoint' AS checkpoint FROM jobs WHERE id=$1", [`enrich:${doc!.id}:1`]))?.checkpoint, null)
  } finally {
    harness.complete = complete
    settings.semanticEntities = previousSemantic
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
  assert.equal((await query("SELECT id FROM review_queue WHERE status='open' AND kind='parse_failure'")).length, 0)
  assert.equal((await query('SELECT id FROM documents')).length, 0)
  embedder.embedMany = original
  await retryIngestJob(workspace.principal, String(job.job_id), 'index')
  await processIngestQueue()
  assert.equal((await savedIngestJobs(workspace.principal))[0]!.status, 'done')
  assert.equal((await query("SELECT id FROM review_queue WHERE status='open' AND kind='parse_failure'")).length, 0)
})

test('unsupported Unicode in PDF parser output does not block checkpoint persistence or indexing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/health')) return Response.json({ status: 'ok' })
    assert.ok(url.endsWith('/parse'))
    return Response.json({
      title: '文\u0000档📄',
      parser: 'test-parser',
      quality: 1,
      blocks: [{ text: '可正常入库的\u0000正文。', headingPath: ['标\u0000题'], type: 'paragraph', order: 0, page: 1, bbox: null }],
      meta: { nested: ['损坏\uD800字符'] },
    })
  })
  settings.sidecarEnabled = true
  try {
    const job = await submitIngest(workspace.principal, 'file', { filename: 'unicode.pdf', data: Buffer.from('test PDF') })
    await processIngestQueue()
    const saved = await queryOne<{ status: string; payload: { checkpoint: { parsed: { title: string; meta: unknown } } } }>(
      'SELECT status,payload FROM jobs WHERE id=$1', [job.job_id],
    )
    assert.equal(saved?.status, 'done')
    assert.equal(saved.payload.checkpoint.parsed.title, '文档📄')
    assert.deepEqual(saved.payload.checkpoint.parsed.meta, { nested: ['损坏\uFFFD字符'] })
    assert.equal((await queryOne<{ text: string }>('SELECT text FROM document_versions'))?.text, '可正常入库的正文。')
    assert.deepEqual((await queryOne<{ heading_path: string[] }>('SELECT heading_path FROM blocks'))?.heading_path, ['标题'])
  } finally {
    settings.sidecarEnabled = false
  }
})

test('unusable extracted text enters review and corrected text closes the review', async () => {
  const job = await submitIngest(workspace.principal, 'file', { filename: 'empty.txt', data: Buffer.from('\u0000') })
  await processIngestQueue()
  const review = await queryOne<{ id: string }>("SELECT id FROM review_queue WHERE kind='parse_failure' AND status='open' AND payload->>'job_id'=$1", [job.job_id])
  assert.ok(review)
  await retryIngestJob(workspace.principal, String(job.job_id), 'index', '人工核对后的完整正文。')
  await processIngestQueue()
  assert.equal((await queryOne<{ status: string }>('SELECT status FROM review_queue WHERE id=$1', [review.id]))?.status, 'resolved')
})

test('manual corrected text can recover an unavailable parser while preserving source identity', async () => {
  const job = await submitIngest(workspace.principal, 'file', { filename: 'scan.pdf', data: Buffer.from('not a pdf') })
  await processIngestQueue()
  assert.equal((await savedIngestJobs(workspace.principal))[0]!.status, 'failed')
  assert.equal((await query("SELECT id FROM review_queue WHERE status='open' AND kind='parse_failure'")).length, 0)
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
