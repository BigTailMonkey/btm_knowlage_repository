import { createHash } from 'node:crypto'

import { settings } from '../config.js'
import { query, queryOne } from '../db/index.js'
import { embedder } from '../adapters/embeddings/index.js'
import type { Embedding } from '../adapters/embeddings/index.js'
import { parseBytes, ParsedDocument, parseHtml, parseTextContent } from '../adapters/parsing/index.js'
import { chunkBlocks } from './chunking.js'
import { newId } from './ids.js'
import type { DocumentRow } from './rows.js'
import { Principal } from './security.js'
import { TraceRecorder } from './tracing.js'

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

export async function ingestParsed(
  principal: Principal,
  parsed: ParsedDocument,
  options: {
    sourceType: string
    uri?: string | null
    acl?: string[] | null
    progress?: (stage: string, percent: number) => void
    jobId?: string | null
  },
): Promise<Record<string, unknown>> {
  const started = Date.now()
  const fullText = parsed.blocks.map((block) => block.text).join('\n\n')
  const contentHash = sha256(fullText)
  const duplicate = await queryOne<DocumentRow>(
    `SELECT * FROM documents WHERE tenant_id = $1 AND content_hash = $2 AND status = 'active'`,
    [principal.tenantId, contentHash],
  )
  if (duplicate) {
    return {
      document_id: duplicate.id,
      duplicate: true,
      version: duplicate.current_version,
      chunks: 0,
      quality: duplicate.quality_score,
      message: '内容未变化，已跳过重复入库',
    }
  }

  const acl = resolveAcl(options.acl)
  const existing = options.uri
    ? await queryOne<DocumentRow>(
        `SELECT * FROM documents WHERE tenant_id = $1 AND uri = $2 AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
        [principal.tenantId, options.uri],
      )
    : null
  const recorder = new TraceRecorder(principal.tenantId, principal.userId, 'ingest', parsed.title)

  let documentId: string
  let versionNumber: number
  if (existing) {
    documentId = existing.id
    versionNumber = existing.current_version + 1
    await query(
      `UPDATE documents SET title = $1, source_type = $2, content_hash = $3, acl_principals = $4::jsonb,
         acl_version = acl_version + 1, current_version = $5, quality_score = $6,
         enrichment_status = 'pending', summary = $7, updated_at = now()
       WHERE id = $8`,
      [
        parsed.title || existing.title,
        options.sourceType,
        contentHash,
        JSON.stringify(acl),
        versionNumber,
        parsed.quality,
        fullText.slice(0, 240),
        documentId,
      ],
    )
  } else {
    documentId = newId('doc')
    versionNumber = 1
    await query(
      `INSERT INTO documents
         (id, tenant_id, title, source_type, uri, content_hash, acl_principals, acl_version,
          status, current_version, quality_score, enrichment_status, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, 'active', 1, $8, 'pending', $9)`,
      [
        documentId,
        principal.tenantId,
        parsed.title,
        options.sourceType,
        options.uri ?? null,
        contentHash,
        JSON.stringify(acl),
        parsed.quality,
        fullText.slice(0, 240),
      ],
    )
  }

  const versionId = newId('ver')
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [versionId, documentId, principal.tenantId, versionNumber, contentHash, parsed.parser, fullText, JSON.stringify(parsed.meta)],
  )

  for (const block of parsed.blocks) {
    await query(
      `INSERT INTO blocks (id, version_id, doc_id, type, page, bbox, order_index, heading_path, text)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)`,
      [
        newId('bl'),
        versionId,
        documentId,
        block.type,
        block.page,
        block.bbox ? JSON.stringify(block.bbox) : null,
        block.order,
        JSON.stringify(block.headingPath),
        block.text,
      ],
    )
  }

  const chunks = chunkBlocks(parsed.blocks)
  options.progress?.('切分', 45)
  const embeddingInputs = chunks
    .filter((chunk) => !chunk.isParent)
    .map((chunk) => ({
      id: chunk.id,
      text: `标题：${parsed.title}｜章节：${chunk.headingPath.join(' / ')}\n${chunk.text}`,
    }))
  const embeddings = new Map<string, Embedding>()
  const vectors = await embedder.embedMany(embeddingInputs.map((item) => item.text))
  embeddingInputs.forEach((item, index) => embeddings.set(item.id, vectors[index]!))
  options.progress?.('向量化', 90)
  options.progress?.('写入索引', 92)

  const aclVersion = existing ? existing.acl_version + 1 : 1
  for (const chunk of chunks) {
    const vector = embeddings.get(chunk.id)
    await query(
      `INSERT INTO chunks
         (id, version_id, doc_id, tenant_id, seq, heading_path, page, bbox, block_type, text,
          token_count, parent_id, is_parent, acl_principals, acl_version, dense, sparse,
          embedding_model, embedding_dim, weight)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13,
               $14::jsonb, $15, $16::jsonb, $17::jsonb, $18, $19, 1.0)`,
      [
        chunk.id,
        versionId,
        documentId,
        principal.tenantId,
        chunk.seq,
        JSON.stringify(chunk.headingPath),
        chunk.page,
        chunk.bbox ? JSON.stringify(chunk.bbox) : null,
        chunk.blockType,
        chunk.text,
        chunk.tokenCount,
        chunk.parentId,
        chunk.isParent,
        JSON.stringify(acl),
        aclVersion,
        JSON.stringify(vector?.dense ?? []),
        JSON.stringify(vector?.sparse ?? {}),
        vector?.model ?? '',
        vector?.dim ?? 0,
      ],
    )
  }

  const jobId = options.jobId ?? newId('job')
  if (options.jobId) {
    await query(
      `UPDATE jobs SET status = 'done', input_hash = $1, payload = $2::jsonb, updated_at = now() WHERE id = $3`,
      [contentHash, JSON.stringify({ doc_id: documentId, version: versionNumber, parser: parsed.parser }), jobId],
    )
  } else {
    await query(
      `INSERT INTO jobs (id, tenant_id, type, status, input_hash, payload)
       VALUES ($1, $2, 'ingest', 'done', $3, $4::jsonb)`,
      [jobId, principal.tenantId, contentHash, JSON.stringify({ doc_id: documentId, version: versionNumber, parser: parsed.parser })],
    )
  }

  recorder.addSpan({
    stage: 'ingest.parse',
    params: { parser: parsed.parser, source_type: options.sourceType },
    output: { blocks: parsed.blocks.length, quality: parsed.quality },
  })
  recorder.addSpan({
    stage: 'ingest.chunk',
    params: { max_chars: 460 },
    output: { chunks: chunks.filter((chunk) => !chunk.isParent).length },
    inputValue: fullText,
  })
  await recorder.finish(`${parsed.title} · v${versionNumber}`)

  return {
    document_id: documentId,
    duplicate: false,
    version: versionNumber,
    chunks: chunks.filter((chunk) => !chunk.isParent).length,
    quality: parsed.quality,
    parser: parsed.parser,
    job_id: jobId,
    trace_id: recorder.traceId,
    latency_ms: Date.now() - started,
    message: '文档已入库，正在后台抽取事实',
  }
}

async function scheduleEnrichment(docId: string, principal: Principal): Promise<void> {
  const { extractFactsForDocument } = await import('./learning.js')
  try {
    await extractFactsForDocument(principal, docId)
  } catch {
    // 后台边界：事实抽取失败不影响文档入库结果。
  }
}

export function submitIngest(
  principal: Principal,
  source: 'file' | 'text' | 'url',
  options: {
    title?: string | null
    filename?: string | null
    data?: Buffer | null
    text?: string | null
    url?: string | null
    acl?: string[] | null
  },
): Record<string, unknown> {
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

  void (async () => {
    await query(
      `INSERT INTO jobs (id, tenant_id, type, status, attempts, payload)
       VALUES ($1, $2, 'ingest', 'pending', 1, $3::jsonb)`,
      [jobId, principal.tenantId, JSON.stringify({ source, title: displayTitle })],
    )
    await runIngestJob(jobId, principal, source, options)
  })()

  return publicJob(record)
}

async function runIngestJob(
  jobId: string,
  principal: Principal,
  source: string,
  options: {
    title?: string | null
    filename?: string | null
    data?: Buffer | null
    text?: string | null
    url?: string | null
    acl?: string[] | null
  },
): Promise<void> {
  const update = (fields: Partial<JobRecord>) => Object.assign(INGEST_JOBS.get(jobId) ?? {}, fields)
  const report = (stage: string, percent: number) => update({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))) })
  update({ status: 'running', stage: '解析', percent: 5 })

  try {
    let parsed: ParsedDocument
    let sourceType: string
    let uri: string | null = null
    if (source === 'file') {
      if (!options.filename || !options.data) throw new Error('缺少文件内容')
      report('解析', 10)
      parsed = await parseBytes(options.filename, options.data, options.title ?? null)
      sourceType = options.filename.includes('.') ? options.filename.split('.').pop()!.toLowerCase() : 'file'
      uri = `upload:${options.filename}:${sha256(options.data).slice(0, 16)}`
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

    const result = await ingestParsed(principal, parsed, {
      sourceType,
      uri,
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
    })
    await query(
      `UPDATE jobs SET status = 'done', payload = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(result), jobId],
    )
    void scheduleEnrichment(result.document_id as string, principal)
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300) || '入库失败'
    update({ status: 'failed', stage: '失败', error: message })
    await query(
      `UPDATE jobs SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
      [message, jobId],
    )
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
  await query(`UPDATE documents SET status = 'tombstoned', updated_at = now() WHERE id = $1`, [docId])
  const evidence = await query<{ fact_id: string }>('SELECT fact_id FROM fact_evidence WHERE doc_id = $1', [docId])
  const affected = new Set(evidence.map((row) => row.fact_id))
  await query('DELETE FROM fact_evidence WHERE doc_id = $1', [docId])
  for (const factId of affected) {
    const remaining = await queryOne<{ count: string }>(
      'SELECT count(*)::text AS count FROM fact_evidence WHERE fact_id = $1',
      [factId],
    )
    if (!remaining || Number(remaining.count) === 0) {
      await query(`UPDATE facts SET status = 'retracted' WHERE id = $1`, [factId])
    }
  }
  await query(
    `INSERT INTO jobs (id, tenant_id, type, status, payload)
     VALUES ($1, $2, 'tombstone', 'done', $3::jsonb)`,
    [newId('job'), principal.tenantId, JSON.stringify({ doc_id: docId, affected_facts: [...affected] })],
  )
  return { document_id: docId, affected_facts: affected.size, status: 'tombstoned' }
}

export const ingestionConfig = { dataDir: settings.dataDir }
