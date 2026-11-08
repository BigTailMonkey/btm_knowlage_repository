import { createHash } from 'node:crypto'

import { settings } from '../config.js'
import { query, queryOne, transaction } from '../db/index.js'
import { embedder } from '../adapters/embeddings/index.js'
import type { Embedding } from '../adapters/embeddings/index.js'
import { parseBytes, ParsedDocument, parseHtml, parseTextContent } from '../adapters/parsing/index.js'
import { chunkBlocks, MAX_TOKENS } from './chunking.js'
import { newId } from './ids.js'
import type { DocumentRow } from './rows.js'
import { canRead, Principal } from './security.js'
import { TraceRecorder } from './tracing.js'
import { enqueueEnrichment, processEnrichmentQueue, stopEnrichmentWorker } from './enrichment-queue.js'

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function resolveAcl(acl?: string[] | null): string[] {
  const cleaned = (acl ?? []).map((value) => value.trim()).filter(Boolean)
  return cleaned.length ? cleaned : ['tenant:public']
}

interface JobRecord {
  id: string
  tenantId: string
  userId: string
  title: string
  source: string
  status: string
  stage: string
  percent: number
  docId: string | null
  chunks: number
  version: number
  duplicate: boolean
  message: string
  error: string | null
  createdAt: string
  timestamp: number
}

const INGEST_JOBS = new Map<string, JobRecord>()
const ACTIVE = new Set(['pending', 'running'])
const KEEP_SECONDS = 3600

function prune(): void {
  const cutoff = Date.now() - KEEP_SECONDS * 1000
  for (const [id, record] of INGEST_JOBS) {
    if (!ACTIVE.has(record.status) && record.timestamp < cutoff) INGEST_JOBS.delete(id)
  }
}

function publicJob(record: JobRecord): Record<string, unknown> {
  return {
    job_id: record.id,
    title: record.title,
    source: record.source,
    status: record.status,
    stage: record.stage,
    percent: record.percent,
    doc_id: record.docId,
    chunks: record.chunks,
    version: record.version,
    duplicate: record.duplicate,
    message: record.message,
    error: record.error,
    created_at: record.createdAt,
  }
}

export function listIngestJobs(principal: Principal, activeOnly = false): Array<Record<string, unknown>> {
  return [...INGEST_JOBS.values()]
    .filter(
      (record) =>
        record.tenantId === principal.tenantId &&
        record.userId === principal.userId &&
        (!activeOnly || ACTIVE.has(record.status)),
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(publicJob)
}

interface IngestOptions {
  sourceType: string
  uri?: string | null
  documentId?: string | null
  acl?: string[] | null
  progress?: (stage: string, percent: number) => void
  jobId?: string | null
}

const INGEST_LOCKS = new Map<string, Promise<void>>()

/** Keep simultaneous updates of one source in order inside this service. */
export async function ingestParsed(
  principal: Principal,
  parsed: ParsedDocument,
  options: IngestOptions,
): Promise<Record<string, unknown>> {
  const identity = options.documentId || options.uri || sha256(parsed.blocks.map((block) => block.text).join('\n\n'))
  const key = `${principal.tenantId}\u0000${identity}`
  const previous = INGEST_LOCKS.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  INGEST_LOCKS.set(key, current)
  await previous
  try {
    return await ingestParsedVersion(principal, parsed, options)
  } finally {
    release()
    if (INGEST_LOCKS.get(key) === current) INGEST_LOCKS.delete(key)
  }
}

async function existingDocument(principal: Principal, options: IngestOptions): Promise<DocumentRow | null> {
  if (options.documentId) {
    const document = await queryOne<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [options.documentId, principal.tenantId],
    )
    if (!document || !canRead(principal, document.acl_principals)) {
      throw Object.assign(new Error('目标文档不存在或无权访问'), { statusCode: 404 })
    }
    return document
  }
  if (!options.uri) return null
  const exact = await queryOne<DocumentRow>(
    `SELECT * FROM documents WHERE tenant_id = $1 AND uri = $2 AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [principal.tenantId, options.uri],
  )
  if (exact) {
    if (!canRead(principal, exact.acl_principals)) throw Object.assign(new Error('目标文档不存在或无权访问'), { statusCode: 404 })
    return exact
  }
  if (!options.uri.startsWith('upload:')) return null
  // Earlier uploads included the content hash in their URI. Reuse the latest
  // matching document without deleting or merging any older document records.
  const candidates = await query<DocumentRow>(
    `SELECT * FROM documents WHERE tenant_id = $1 AND status = 'active'
       AND left(uri, char_length($2::text) + 1) = $2::text || ':'
     ORDER BY updated_at DESC`,
    [principal.tenantId, options.uri],
  )
  return candidates.find((document) =>
    /^[a-f0-9]{16}$/i.test(document.uri!.slice(options.uri!.length + 1)) && canRead(principal, document.acl_principals),
  ) ?? null
}

async function ingestParsedVersion(
  principal: Principal,
  parsed: ParsedDocument,
  options: IngestOptions,
): Promise<Record<string, unknown>> {
  const started = Date.now()
  const fullText = parsed.blocks.map((block) => block.text).join('\n\n')
  if (!fullText.trim()) throw Object.assign(new Error('未解析到可索引的文本内容'), { statusCode: 422 })
  const contentHash = sha256(fullText)
  const existing = await existingDocument(principal, options)
  // Source identity takes precedence over content deduplication: reverting an
  // existing document to old content is still a new version of that document.
  const duplicate = existing
    ? existing.content_hash === contentHash ? existing : null
    : options.uri ? null : await queryOne<DocumentRow>(
        `SELECT * FROM documents WHERE tenant_id = $1 AND content_hash = $2 AND status = 'active'`,
        [principal.tenantId, contentHash],
      )
  if (duplicate) {
    return {
      document_id: duplicate.id, duplicate: true, version: duplicate.current_version,
      chunks: 0, quality: duplicate.quality_score, message: '内容未变化，已跳过重复入库',
    }
  }

  const chunks = chunkBlocks(parsed.blocks)
  options.progress?.('切分', 45)
  const embeddingInputs = chunks.filter((chunk) => !chunk.isParent).map((chunk) => ({
    id: chunk.id, text: `标题：${parsed.title}｜章节：${chunk.headingPath.join(' / ')}\n${chunk.text}`,
  }))
  // Prepare all derived data before moving current_version. A failed vector
  // request must leave the last complete document version readable.
  const vectors = await embedder.embedMany(embeddingInputs.map((item) => item.text))
  if (vectors.length !== embeddingInputs.length || vectors.some((vector) => !vector?.dense.length)) {
    throw new Error('向量服务返回数量或内容不完整，文档版本未更新')
  }
  const embeddings = new Map<string, Embedding>()
  embeddingInputs.forEach((item, index) => embeddings.set(item.id, vectors[index]!))
  options.progress?.('向量化', 90)
  options.progress?.('写入索引', 92)

  const documentId = existing?.id ?? newId('doc')
  const versionId = newId('ver')
  const jobId = options.jobId ?? newId('job')
  const meta = {
    ...parsed.meta,
    ...(options.jobId ? { source_job_id: options.jobId } : {}),
    coordinate_system: 'normalized-text-utf16',
    chunk_spans: Object.fromEntries(chunks.map((chunk) => [chunk.id, chunk.sourceSpans])),
  }
  let versionNumber = 1
  await transaction(async (client) => {
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id=$1', [principal.tenantId])
    const latest = existing ? (await client.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND status = 'active' FOR UPDATE`,
      [documentId, principal.tenantId],
    ))[0] : null
    if (existing && !latest) throw new Error('目标文档已被删除，不能更新版本')
    versionNumber = latest ? latest.current_version + 1 : 1
    // Updating content does not implicitly change an existing document's ACL.
    const acl = options.acl == null && latest ? latest.acl_principals : resolveAcl(options.acl)
    const aclVersion = latest ? latest.acl_version + (JSON.stringify(acl) === JSON.stringify(latest.acl_principals) ? 0 : 1) : 1
    if (latest) {
      await client.query(
        `UPDATE documents SET title = $1, source_type = $2, content_hash = $3, acl_principals = $4::jsonb,
           acl_version = $5, current_version = $6, quality_score = $7,
           enrichment_status = 'pending', enrichment_error = NULL, summary = $8, uri = $9, updated_at = now() WHERE id = $10`,
        [parsed.title || latest.title, options.sourceType, contentHash, JSON.stringify(acl), aclVersion,
          versionNumber, parsed.quality, fullText.slice(0, 240), options.uri ?? latest.uri, documentId],
      )
    } else {
      await client.query(
        `INSERT INTO documents
           (id, tenant_id, title, source_type, uri, content_hash, acl_principals, acl_version,
            status, current_version, quality_score, enrichment_status, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, 'active', 1, $8, 'pending', $9)`,
        [documentId, principal.tenantId, parsed.title, options.sourceType, options.uri ?? null,
          contentHash, JSON.stringify(acl), parsed.quality, fullText.slice(0, 240)],
      )
    }
    await client.query(
      `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [versionId, documentId, principal.tenantId, versionNumber, contentHash, parsed.parser, fullText, JSON.stringify(meta)],
    )
    for (const block of parsed.blocks) {
      await client.query(
        `INSERT INTO blocks (id, version_id, doc_id, type, page, bbox, order_index, heading_path, text)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)`,
        [newId('bl'), versionId, documentId, block.type, block.page,
          block.bbox ? JSON.stringify(block.bbox) : null, block.order, JSON.stringify(block.headingPath), block.text],
      )
    }
    for (const chunk of chunks) {
      const vector = embeddings.get(chunk.id)
      await client.query(
        `INSERT INTO chunks
           (id, version_id, doc_id, tenant_id, seq, heading_path, page, bbox, block_type, text,
            token_count, parent_id, is_parent, acl_principals, acl_version, dense, sparse,
            embedding_model, embedding_dim, weight)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13,
                 $14::jsonb, $15, $16::jsonb, $17::jsonb, $18, $19, 1.0)`,
        [chunk.id, versionId, documentId, principal.tenantId, chunk.seq, JSON.stringify(chunk.headingPath),
          chunk.page, chunk.bbox ? JSON.stringify(chunk.bbox) : null, chunk.blockType, chunk.text,
          chunk.tokenCount, chunk.parentId, chunk.isParent, JSON.stringify(acl), aclVersion,
          JSON.stringify(vector?.dense ?? []), JSON.stringify(vector?.sparse ?? {}), vector?.model ?? '', vector?.dim ?? 0],
      )
    }
    if (options.jobId) {
      await enqueueEnrichment(client, principal, documentId, versionNumber)
      await client.query(
        `UPDATE jobs SET input_hash = $1, payload = payload || $2::jsonb, updated_at = now() WHERE id = $3`,
        [contentHash, JSON.stringify({ doc_id: documentId, version: versionNumber, parser: parsed.parser }), jobId],
      )
    } else {
      await client.query(
        `INSERT INTO jobs (id, tenant_id, type, status, input_hash, payload)
         VALUES ($1, $2, 'ingest', 'done', $3, $4::jsonb)`,
        [jobId, principal.tenantId, contentHash, JSON.stringify({ doc_id: documentId, version: versionNumber, parser: parsed.parser })],
      )
    }
  })

  const recorder = new TraceRecorder(principal.tenantId, principal.userId, 'ingest', parsed.title)
  recorder.addSpan({ stage: 'ingest.parse', params: { parser: parsed.parser, source_type: options.sourceType },
    output: { blocks: parsed.blocks.length, quality: parsed.quality } })
  recorder.addSpan({ stage: 'ingest.chunk', params: { max_tokens: MAX_TOKENS },
    output: { chunks: embeddingInputs.length }, inputValue: fullText })
  await recorder.finish(`${parsed.title} · v${versionNumber}`)
  return {
    document_id: documentId, version_id: versionId, duplicate: false, version: versionNumber,
    chunks: embeddingInputs.length, quality: parsed.quality, parser: parsed.parser, job_id: jobId,
    trace_id: recorder.traceId, latency_ms: Date.now() - started, message: '文档已入库',
  }
}

export async function submitIngest(
  principal: Principal,
  source: 'file' | 'text' | 'url',
  options: {
    title?: string | null
    filename?: string | null
    documentId?: string | null
    data?: Buffer | null
    text?: string | null
    url?: string | null
    sourceUri?: string | null
    acl?: string[] | null
  },
): Promise<Record<string, unknown>> {
  prune()
  const jobId = newId('job')
  const displayTitle =
    options.title ||
    (options.filename ? options.filename.replace(/\.\w+$/, '') || options.filename : '') ||
    options.url ||
    '未命名文档'
  const record: JobRecord = {
    id: jobId,
    tenantId: principal.tenantId,
    userId: principal.userId,
    title: displayTitle,
    source,
    status: 'pending',
    stage: '排队中',
    percent: 0,
    docId: null,
    chunks: 0,
    version: 0,
    duplicate: false,
    message: '',
    error: null,
    createdAt: new Date().toISOString(),
    timestamp: Date.now(),
  }
  INGEST_JOBS.set(jobId, record)

  const request = { ...options, rawHash: options.data ? sha256(options.data) : null, data: options.data?.toString('base64') ?? null }
  await query(
    `INSERT INTO jobs (id, tenant_id, type, status, attempts, payload)
     VALUES ($1, $2, 'ingest', 'pending', 0, $3::jsonb)`,
    [jobId, principal.tenantId, JSON.stringify({ source, user_id: principal.userId, request, view: record })],
  )
  void processIngestQueue().catch(() => undefined)

  return publicJob(record)
}

async function runIngestJob(
  jobId: string,
  principal: Principal,
  source: string,
  options: {
    title?: string | null
    filename?: string | null
    documentId?: string | null
    data?: Buffer | null
    text?: string | null
    url?: string | null
    sourceUri?: string | null
    acl?: string[] | null
  },
): Promise<void> {
  const update = (fields: Partial<JobRecord>) => Object.assign(INGEST_JOBS.get(jobId) ?? {}, fields)
  const report = (stage: string, percent: number) => update({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))) })
  update({ status: 'running', stage: '解析', percent: 5 })

  try {
    let parsed: ParsedDocument
    const saved = await queryOne<{ payload: Record<string, unknown> }>('SELECT payload FROM jobs WHERE id=$1', [jobId])
    const checkpoint = saved?.payload.checkpoint as { parsed: ParsedDocument; sourceType: string; uri: string | null } | undefined
    let sourceType: string
    let uri: string | null = null
    if (checkpoint) {
      parsed = checkpoint.parsed
      sourceType = checkpoint.sourceType
      uri = checkpoint.uri
      report('恢复解析结果', 40)
    } else if (source === 'file') {
      if (!options.filename || !options.data) throw new Error('缺少文件内容')
      report('解析', 10)
      parsed = await parseBytes(options.filename, options.data, options.title ?? null)
      sourceType = options.filename.includes('.') ? options.filename.split('.').pop()!.toLowerCase() : 'file'
      uri = options.sourceUri || `upload:${options.filename}`
    } else if (source === 'text') {
      if (!options.text) throw new Error('缺少文本内容')
      report('切分', 40)
      parsed = parseTextContent(options.text, options.title ?? null)
      sourceType = 'text'
    } else {
      if (!options.url) throw new Error('缺少 URL')
      report('抓取', 12)
      const fetched = await fetchUrl(options.url, options.title ?? null)
      parsed = fetched.parsed
      sourceType = fetched.sourceType
      uri = options.url
      report('切分', 40)
    }

    await query(`UPDATE jobs SET payload = payload || $1::jsonb, updated_at=now() WHERE id=$2`,
      [JSON.stringify({ checkpoint: { parsed, sourceType, uri } }), jobId])
    if (parsed.quality < settings.parseMinQuality || !parsed.blocks.some((block) => block.text.trim())) {
      throw Object.assign(new Error('解析质量不足，需人工修正或更换解析引擎'), { statusCode: 422 })
    }
    const result = await ingestParsed(principal, parsed, {
      sourceType,
      uri,
      documentId: options.documentId ?? null,
      acl: options.acl ?? null,
      progress: report,
      jobId,
    })
    update({
      status: 'done',
      stage: '完成',
      percent: 100,
      docId: result.document_id as string,
      chunks: result.chunks as number,
      version: result.version as number,
      duplicate: result.duplicate as boolean,
      message: result.message as string,
      error: null,
    })
    await query(
      `UPDATE jobs SET status = 'done', error = NULL, payload = payload || $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify({ ...result, result, view: INGEST_JOBS.get(jobId) }), jobId],
    )
    await query(`UPDATE review_queue SET status='resolved', resolution=$1::jsonb, resolved_at=now()
      WHERE tenant_id=$2 AND status='open' AND payload->>'job_id'=$3`, [JSON.stringify({ action: 'retry_succeeded', document_id: result.document_id }), principal.tenantId, jobId])
    void processEnrichmentQueue().catch(console.error)
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300) || '入库失败'
    update({ status: 'failed', stage: '失败', error: message })
    await query(
      `UPDATE jobs SET status = 'failed', error = $1, payload = payload || $3::jsonb, updated_at = now() WHERE id = $2`,
      [message, jobId, JSON.stringify({ view: INGEST_JOBS.get(jobId) })],
    )
    const review = await queryOne<{ id: string }>("SELECT id FROM review_queue WHERE tenant_id=$1 AND status='open' AND payload->>'job_id'=$2", [principal.tenantId, jobId])
    if (!review) await query(`INSERT INTO review_queue(id,tenant_id,kind,title,payload) VALUES($1,$2,'parse_failure',$3,$4::jsonb)`,
      [newId('rev'), principal.tenantId, options.title || options.filename || options.url || '文档解析失败', JSON.stringify({ job_id: jobId, reason: message })])
  }
}

async function fetchUrl(url: string, title: string | null): Promise<{ parsed: ParsedDocument; sourceType: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL')
  const response = await fetch(url, {
    headers: { 'user-agent': 'KnoWeave/0.1' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
    const buffer = Buffer.from(await response.arrayBuffer())
    return { parsed: await parseBytes(url, buffer, title), sourceType: 'pdf' }
  }
  return { parsed: parseHtml(await response.text(), title || url), sourceType: 'web' }
}

export async function tombstoneDocument(principal: Principal, docId: string): Promise<Record<string, unknown>> {
  const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
  if (!document || document.tenant_id !== principal.tenantId) throw new Error('文档不存在')
  const affected = new Set<string>()
  await transaction(async (client) => {
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id=$1', [principal.tenantId])
    await client.query(`UPDATE documents SET status = 'tombstoned', updated_at = now() WHERE id = $1`, [docId])
    const facts = await client.query<{ id: string }>(
      `SELECT id FROM facts WHERE tenant_id = $1 AND
         (source_doc_id = $2 OR id IN (SELECT fact_id FROM fact_evidence WHERE doc_id = $2))`,
      [principal.tenantId, docId],
    )
    for (const fact of facts) affected.add(fact.id)
    await client.query('DELETE FROM fact_evidence WHERE doc_id = $1', [docId])
    for (const factId of affected) {
      const remaining = (await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM fact_evidence WHERE fact_id = $1',
        [factId],
      ))[0]
      if (!remaining || Number(remaining.count) === 0) {
        await client.query(`UPDATE facts SET status = 'retracted' WHERE id = $1`, [factId])
      }
    }
  })
  await query(
    `INSERT INTO jobs (id, tenant_id, type, status, payload)
     VALUES ($1, $2, 'tombstone', 'done', $3::jsonb)`,
    [newId('job'), principal.tenantId, JSON.stringify({ doc_id: docId, affected_facts: [...affected] })],
  )
  return { document_id: docId, affected_facts: affected.size, status: 'tombstoned' }
}

export const ingestionConfig = { dataDir: settings.dataDir }

let queueTask: Promise<void> | null = null
let queueTimer: NodeJS.Timeout | null = null
let queueStopping = false
let queueAgain = false

interface SavedJob { id: string; tenant_id: string; status: string; attempts: number; error: string | null; payload: Record<string, any>; created_at: string }

function restoreJob(row: SavedJob): JobRecord {
  const result = row.payload.result ?? {}
  const previous = row.payload.view ?? {}
  const record: JobRecord = {
    id: row.id, tenantId: row.tenant_id, userId: row.payload.user_id ?? '',
    title: previous.title ?? row.payload.request?.title ?? '文档入库', source: row.payload.source ?? 'file',
    stage: row.status === 'done' ? '完成' : row.status === 'failed' ? '失败' : '排队中',
    percent: row.status === 'done' ? 100 : 0, docId: result.document_id ?? null,
    chunks: result.chunks ?? 0, version: result.version ?? 0, duplicate: Boolean(result.duplicate),
    message: result.message ?? '', error: row.error, createdAt: new Date(row.created_at).toISOString(), timestamp: new Date(row.created_at).getTime(),
    ...previous, status: row.status,
  }
  INGEST_JOBS.set(row.id, record)
  return record
}

export async function savedIngestJobs(principal: Principal, activeOnly = false): Promise<Array<Record<string, unknown>>> {
  const rows = await query<SavedJob>(
    `SELECT * FROM jobs WHERE tenant_id=$1 AND type='ingest' AND payload->>'user_id'=$2
     ORDER BY created_at DESC LIMIT 100`, [principal.tenantId, principal.userId])
  return rows.filter((row) => !activeOnly || ACTIVE.has(row.status)).map((row) => {
    const live = INGEST_JOBS.get(row.id)
    return publicJob(live?.status === row.status ? live : restoreJob(row))
  })
}

export async function retryIngestJob(principal: Principal, id: string, stage: 'parse' | 'index' = 'index', correctedText?: string): Promise<Record<string, unknown>> {
  if (correctedText?.trim()) {
    const row = await queryOne<SavedJob>("SELECT * FROM jobs WHERE id=$1 AND tenant_id=$2 AND payload->>'user_id'=$3 AND status IN('failed','done')", [id, principal.tenantId, principal.userId])
    if (!row) throw Object.assign(new Error('任务不存在或正在运行'), { statusCode: 409 })
    const source = row.payload.source
    const request = row.payload.request
    if (!request) throw Object.assign(new Error('旧任务缺少原始输入，无法人工修正'), { statusCode: 409 })
    const parsed = parseTextContent(correctedText, request.title || request.filename || '人工修正文档')
    parsed.meta.corrected_by = principal.userId
    const checkpoint = { parsed, sourceType: source === 'url' ? 'web' : source === 'file' ? request.filename?.split('.').pop() || 'file' : 'text', uri: source === 'file' ? request.sourceUri || `upload:${request.filename}` : source === 'url' ? request.url : null }
    await query('UPDATE jobs SET payload=payload || $1::jsonb WHERE id=$2', [JSON.stringify({ checkpoint }), id])
    stage = 'index'
  }
  const rows = await query<SavedJob>(
    `UPDATE jobs SET status='pending', error=NULL, attempts=0,
       payload=CASE WHEN $4='parse' THEN payload - 'checkpoint' ELSE payload END, updated_at=now()
     WHERE id=$1 AND tenant_id=$2 AND type='ingest' AND payload->>'user_id'=$3
       AND status IN ('failed','done') AND payload ? 'request' RETURNING *`,
    [id, principal.tenantId, principal.userId, stage])
  if (!rows[0]) throw Object.assign(new Error('任务不存在、正在运行或缺少可重试的原始输入'), { statusCode: 409 })
  const record = restoreJob(rows[0])
  void processIngestQueue().catch(() => undefined)
  return publicJob(record)
}

/** Database-backed queue. Claims and heartbeats allow recovery after a crashed worker. */
export function processIngestQueue(): Promise<void> {
  if (queueTask) { queueAgain = true; return queueTask }
  queueTask = (async () => {
    do {
    queueAgain = false
    await query(`UPDATE jobs SET status='pending' WHERE type='ingest' AND status='running'
      AND updated_at < now() - interval '2 minutes' AND payload ? 'request'`)
    // Retry transient failures, retaining the parse checkpoint, at most 3 times.
    await query(`UPDATE jobs SET status='pending' WHERE type='ingest' AND status='failed' AND attempts < 3
      AND updated_at < now() - interval '10 seconds' AND payload ? 'request'`)
    while (!queueStopping) {
      const rows = await query<SavedJob>(`UPDATE jobs SET status='running', attempts=attempts+1, updated_at=now()
        WHERE id=(SELECT id FROM jobs WHERE type='ingest' AND status='pending' AND payload ? 'request'
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) AND status='pending' RETURNING *`)
      const row = rows[0]
      if (!row) break
      restoreJob(row)
      const user = await queryOne<{ id: string; name: string; role: string; groups: string[]; token: string }>(
        "SELECT id,name,role,groups,token FROM users WHERE id=$1 AND tenant_id=$2 AND status='active'", [row.payload.user_id, row.tenant_id])
      if (!user) {
        await query("UPDATE jobs SET status='failed', attempts=3, error='任务主体不存在或已停用', updated_at=now() WHERE id=$1", [row.id])
        continue
      }
      const heartbeat = setInterval(() => { void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND status='running'", [row.id]).catch(() => undefined) }, 30_000)
      heartbeat.unref()
      try {
        const request = row.payload.request
        await runIngestJob(row.id, { userId: user.id, tenantId: row.tenant_id, name: user.name, role: user.role, groups: user.groups, token: user.token }, row.payload.source,
          { ...request, data: request.data ? Buffer.from(request.data, 'base64') : null })
      } finally { clearInterval(heartbeat) }
    }
    } while (queueAgain && !queueStopping)
  })().finally(() => { queueTask = null })
  return queueTask
}

export function startIngestWorker(): void {
  queueStopping = false
  if (queueTimer) return
  void processIngestQueue().catch(() => undefined)
  const processEnrichment = () => { void processEnrichmentQueue().catch(console.error) }
  processEnrichment()
  queueTimer = setInterval(() => {
    void processIngestQueue().catch(console.error)
    processEnrichment()
  }, 2000)
  queueTimer.unref()
}

export async function stopIngestWorker(): Promise<void> {
  queueStopping = true
  if (queueTimer) clearInterval(queueTimer)
  queueTimer = null
  await queueTask
  await stopEnrichmentWorker()
  queueStopping = false
}
