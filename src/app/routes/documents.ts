import { FastifyInstance } from 'fastify'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConverter } from '@deepseek-ai/libreoffice-kit'

import { authenticate, currentPrincipal } from '../server.js'
import { settings } from '../../config.js'
import { query, queryOne } from '../../db/index.js'
import { chunkDict, documentDict, entityDict, factDict } from '../../core/serializers.js'
import { ingestParsed, savedIngestJobs, retryIngestJob, submitIngest } from '../../core/ingestion.js'
import { parseBytes, parseTextContent } from '../../adapters/parsing/index.js'
import { requireEditor, canRead } from '../../core/security.js'
import { isEntityName } from '../../core/learning.js'
import { enrichmentTasks, processEnrichmentQueue, requestEnrichment } from '../../core/enrichment-queue.js'
import { DISPLAYABLE_FACT } from '../../core/fact-visibility.js'
import { reindexDocument } from '../../core/reindexing.js'
import { continuationView, linkContinuation, unlinkContinuation } from '../../core/continuation.js'
import { purgeDocument, restoreDocument, trashDocument, trashDocuments } from '../../core/trash.js'
import { evidenceWeight } from '../../core/source-policy.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from '../../core/rows.js'

function parseAcl(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

async function visibleDocument(principal: ReturnType<typeof currentPrincipal>, docId: string): Promise<DocumentRow> {
  const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
  if (
    !document ||
    document.tenant_id !== principal.tenantId ||
    !canRead(principal, document.acl_principals) ||
    document.status === 'tombstoned'
  ) {
    throw Object.assign(new Error('文档不存在或无权访问'), { statusCode: 404 })
  }
  return document
}

let activeWordPreviews = 0

async function renderWordPreview(data: Buffer, signal: AbortSignal): Promise<Buffer> {
  if (activeWordPreviews >= 2) throw Object.assign(new Error('文档转换繁忙，请稍后重试'), { statusCode: 503 })
  activeWordPreviews += 1
  let directory: string | undefined
  let converter: Awaited<ReturnType<typeof createConverter>> | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'knowweave-preview-'))
    const inputPath = join(directory, 'source.docx')
    const outputPath = join(directory, 'preview.pdf')
    await writeFile(inputPath, data, { mode: 0o600, signal })
    converter = await createConverter({
      timeoutMs: 30_000,
      maxInputBytes: 30 * 1024 * 1024,
      maxOutputBytes: 50 * 1024 * 1024,
      fontMetadataCacheDirectory: false,
    })
    await converter.render({ inputPath, outputPath }, signal)
    return await readFile(outputPath, { signal })
  } catch {
    throw Object.assign(new Error('Word 版式预览暂不可用'), { statusCode: 422 })
  } finally {
    try {
      await converter?.dispose()
    } finally {
      activeWordPreviews -= 1
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/upload', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const part = await request.file()
    if (!part) throw Object.assign(new Error('文件为空'), { statusCode: 400 })
    const chunks: Buffer[] = []
    for await (const chunk of part.file) chunks.push(Buffer.from(chunk))
    const data = Buffer.concat(chunks)
    if (!data.length) throw Object.assign(new Error('文件为空'), { statusCode: 400 })
    if (data.length > 30 * 1024 * 1024) throw Object.assign(new Error('文件超过 30MB'), { statusCode: 413 })
    const fields = part.fields as Record<string, { value?: unknown }>
    return submitIngest(principal, 'file', {
      title: typeof fields.title?.value === 'string' ? fields.title.value : null,
      filename: part.filename || 'document.txt',
      data,
      acl: parseAcl(fields.acl?.value),
      documentId: typeof fields.doc_id?.value === 'string' ? fields.doc_id.value : null,
      sourceUri: typeof fields.source_uri?.value === 'string' && fields.source_uri.value.startsWith('directory:') ? fields.source_uri.value : null,
    })
  })

  app.post('/text', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const payload = request.body as { text?: string; title?: string; acl?: string[]; doc_id?: string }
    if (!payload?.text) throw Object.assign(new Error('text 不能为空'), { statusCode: 400 })
    return submitIngest(principal, 'text', {
      text: payload.text,
      title: payload.title ?? null,
      acl: payload.acl ?? null,
      documentId: payload.doc_id ?? null,
    })
  })

  app.post('/url', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const payload = request.body as { url?: string; title?: string; acl?: string[]; doc_id?: string }
    if (!payload?.url || !/^https?:\/\//i.test(payload.url)) {
      throw Object.assign(new Error('仅支持 http/https URL'), { statusCode: 400 })
    }
    return submitIngest(principal, 'url', { url: payload.url, title: payload.title ?? null, acl: payload.acl ?? null, documentId: payload.doc_id ?? null })
  })

  app.get('/jobs', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const active = (request.query as { active?: string }).active === 'true'
    return { items: await savedIngestJobs(principal, active) }
  })

  app.post('/jobs/:job_id/retry', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const stage = (request.body as { stage?: string } | undefined)?.stage ?? 'index'
    if (!['parse', 'index'].includes(stage)) throw Object.assign(new Error('stage 必须为 parse 或 index'), { statusCode: 400 })
    return retryIngestJob(principal, (request.params as { job_id: string }).job_id, stage as 'parse' | 'index', (request.body as { corrected_text?: string } | undefined)?.corrected_text)
  })

  app.get('/extractions', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    return {
      items: await enrichmentTasks(principal),
      can_retry: ['owner', 'admin', 'editor'].includes(principal.role),
    }
  })

  app.post('/extractions/retry', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const ids = (request.body as { document_ids?: unknown } | undefined)?.document_ids
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id))) {
      throw Object.assign(new Error('document_ids 必须为非空文档 ID 列表'), { statusCode: 400 })
    }
    const selected = ids ? new Set<string>(ids as string[]) : null
    const tasks = await enrichmentTasks(principal)
    let queued = 0
    for (const task of tasks) {
      if (task.status === 'failed' && (!selected || selected.has(task.id)) && await requestEnrichment(principal, task.id, 'failed')) queued++
    }
    if (queued) void processEnrichmentQueue().catch(app.log.error.bind(app.log))
    return { queued }
  })

  app.get('/acl-options', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const users = await query<{ groups: string[] }>(
      'SELECT groups FROM users WHERE tenant_id = $1',
      [principal.tenantId],
    )
    const groups = new Set<string>()
    for (const user of users) for (const group of user.groups ?? []) groups.add(group)
    return { groups: [...groups].sort() }
  })

  app.get('/trash', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    return {
      items: await trashDocuments(principal),
      retention_days: settings.trashRetentionDays,
      can_manage: ['owner', 'admin', 'editor'].includes(principal.role),
    }
  })

  app.get('/', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const params = request.query as Record<string, string | undefined>
    const status = params.status ?? 'active'
    const limit = Math.min(200, Math.max(1, Number(params.limit ?? 50)))
    const offset = Math.max(0, Number(params.offset ?? 0))
    const where = ['tenant_id = $1']
    const values: unknown[] = [principal.tenantId]
    if (status) {
      values.push(status)
      where.push(`status = $${values.length}`)
    }
    if (params.source_type) {
      values.push(params.source_type)
      where.push(`source_type = $${values.length}`)
    }
    if (params.q) {
      values.push(`%${params.q}%`)
      where.push(`title ILIKE $${values.length}`)
    }
    const documents = await query<DocumentRow>(
      `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
      values,
    )
    const visible = documents.filter((document) => canRead(principal, document.acl_principals))
    return {
      total: visible.length,
      limit,
      offset,
      items: await Promise.all(visible.map((document) => documentDict(document))),
    }
  })

  app.get('/:doc_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { doc_id: docId } = request.params as { doc_id: string }
    const document = await visibleDocument(principal, docId)
    const versions = await query<VersionRow>(
      'SELECT * FROM document_versions WHERE doc_id = $1 ORDER BY version DESC',
      [document.id],
    )
    const requestedVersion = (request.query as { version_id?: string }).version_id
    const selectedVersion = requestedVersion ? versions.find((version) => version.id === requestedVersion) : versions.find((version) => version.version === document.current_version)
    if (!selectedVersion) throw Object.assign(new Error('文档版本不存在'), { statusCode: 404 })
    const chunks = await query<ChunkRow>(
      `SELECT * FROM chunks WHERE doc_id = $1 AND is_parent = false
         AND version_id = $2
       ORDER BY seq`,
      [document.id, selectedVersion.id],
    )
    const sourcedFacts = await query<FactRow & { displayable: boolean }>(
      `SELECT f.*, ${DISPLAYABLE_FACT} AS displayable FROM facts f
       WHERE f.tenant_id = $1 AND EXISTS (
         SELECT 1 FROM fact_evidence evidence WHERE evidence.fact_id = f.id AND evidence.doc_id = $2
       )`,
      [principal.tenantId, document.id],
    )
    const facts = []
    const entityIds = new Set<string>()
    let reviewOnlyFacts = 0
    for (const fact of sourcedFacts) {
      if (!canRead(principal, fact.acl_principals)) continue
      if (!fact.displayable) {
        if (fact.status === 'disputed') reviewOnlyFacts += 1
        continue
      }
      const item = await factDict(fact)
      if (!isEntityName(String(item.subject)) || (fact.object_id && !isEntityName(String(item.object)))) continue
      facts.push(item)
      entityIds.add(fact.subject_id)
      if (fact.object_id) entityIds.add(fact.object_id)
    }
    const entities = []
    for (const entityId of entityIds) {
      const entity = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [entityId])
      if (entity && canRead(principal, entity.acl_principals)) entities.push(entityDict(entity))
    }
    return {
      document: await documentDict(document),
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        parser: version.parser,
        hash: version.hash.slice(0, 16),
        chars: version.text.length,
        created_at: version.created_at,
      })),
      source: { version_id: selectedVersion.id, version: selectedVersion.version, text: selectedVersion.text, parser: selectedVersion.parser, coordinate_system: selectedVersion.meta.coordinate_system ?? null },
      chunks: chunks.map((chunk) => ({ ...chunkDict(chunk, document), version_id: selectedVersion.id, bbox: chunk.bbox, spans: (selectedVersion.meta.chunk_spans as Record<string, unknown> | undefined)?.[chunk.id] ?? [] })),
      facts,
      entities,
      review_only_facts: reviewOnlyFacts,
      continuation: await continuationView(principal, document),
    }
  })

  app.get('/:doc_id/citation/:version_id', { preHandler: authenticate }, async (request, reply) => {
    const principal = currentPrincipal(request)
    const { doc_id: docId, version_id: versionId } = request.params as { doc_id: string; version_id: string }
    const { chunk_id: chunkId, format } = request.query as { chunk_id?: string; format?: string }
    reply.header('Cache-Control', 'private, no-store')
    const document = await visibleDocument(principal, docId)
    const version = await queryOne<VersionRow>(
      'SELECT * FROM document_versions WHERE id = $1 AND doc_id = $2 AND tenant_id = $3',
      [versionId, document.id, principal.tenantId],
    )
    const unavailable = () => Object.assign(new Error('引用不存在或无权访问'), { statusCode: 404 })
    if (!version || document.status !== 'active') throw unavailable()
    const chunks = await query<Pick<ChunkRow, 'id' | 'text' | 'page' | 'acl_principals'>>(
      'SELECT id, text, page, acl_principals FROM chunks WHERE version_id = $1 AND doc_id = $2 AND tenant_id = $3 AND is_parent = false ORDER BY seq',
      [versionId, document.id, principal.tenantId],
    )
    const visibleChunks = chunks.filter((chunk) => canRead(principal, chunk.acl_principals))
    const cited = visibleChunks.find((chunk) => chunk.id === chunkId)
    if (chunkId && !cited) throw unavailable()
    const partial = visibleChunks.length !== chunks.length
    if (partial && !visibleChunks.length) throw unavailable()
    const wantsPdf = format === 'pdf'
    const upload = partial ? null : await queryOne<{ filename: string; data: string | null }>(
      `SELECT payload #>> '{request,filename}' AS filename,
              CASE WHEN $6::boolean THEN payload #>> '{request,data}' END AS data
       FROM jobs WHERE tenant_id = $1 AND type = 'ingest' AND payload->>'source' = 'file'
         AND payload->>'doc_id' = $2
         AND (payload #>> '{request,filename}') ~* '\\.(pdf|docx)$'
         AND coalesce(payload #>> '{request,data}', '') <> ''
         AND (id = $5 OR (payload->>'version' = $3 AND input_hash = $4))
       ORDER BY (id = $5) DESC NULLS LAST, created_at DESC LIMIT 1`,
      [principal.tenantId, document.id, String(version.version), version.hash, version.meta.source_job_id ?? null, wantsPdf],
    )
    const fileType = upload?.filename.toLowerCase().endsWith('.pdf') ? 'pdf' : upload ? 'docx' : null
    if (wantsPdf) {
      if (!upload?.data) throw unavailable()
      const bytes = Buffer.from(upload.data, 'base64')
      if (fileType === 'pdf' && !bytes.subarray(0, 1024).includes('%PDF-')) throw unavailable()
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once('close', abort)
      try {
        const pdf = fileType === 'docx' ? await renderWordPreview(bytes, controller.signal) : bytes
        return reply.type('application/pdf').header('X-Content-Type-Options', 'nosniff').send(pdf)
      } finally {
        reply.raw.off('close', abort)
      }
    }
    const spans = version.meta.chunk_spans as Record<string, unknown> | undefined
    return {
      title: document.title,
      version: version.version,
      page: cited?.page ?? null,
      file_type: fileType,
      source: { text: partial ? (cited ? cited.text : visibleChunks.map((chunk) => chunk.text).join('\n\n')) : version.text },
      chunks: cited ? [{ id: cited.id, spans: partial ? [{ start: 0, end: cited.text.length }] : spans?.[cited.id] ?? [], text: cited.text }] : [],
    }
  })

  app.post('/:doc_id/continuation', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { doc_id: docId } = request.params as { doc_id: string }
    return linkContinuation(principal, docId, (request.body ?? {}) as {
      other_doc_id?: unknown
      relation?: unknown
      effective_date?: unknown
      note?: unknown
    })
  })

  app.delete('/:doc_id/continuation', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { doc_id: docId } = request.params as { doc_id: string }
    const relation = (request.query as { relation?: string }).relation
    return unlinkContinuation(principal, docId, relation)
  })

  app.post('/:doc_id/reprocess', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    await visibleDocument(principal, docId)
    const scope = (request.body as { scope?: string } | undefined)?.scope ?? 'facts'
    if (!['facts','index','all'].includes(scope)) throw Object.assign(new Error('scope 必须为 facts、index 或 all'), { statusCode: 400 })
    if (scope !== 'facts') {
      const result = await reindexDocument(principal.tenantId, docId)
      if (scope === 'all') {
        await requestEnrichment(principal, docId)
        void processEnrichmentQueue().catch(app.log.error.bind(app.log))
      }
      return result
    }
    await requestEnrichment(principal, docId)
    void processEnrichmentQueue().catch(app.log.error.bind(app.log))
    return { document_id: docId, status: 'queued', message: '已排入事实抽取队列' }
  })

  app.patch('/:doc_id/policy', { preHandler: authenticate }, async request => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const document = await visibleDocument(principal,(request.params as { doc_id: string }).doc_id)
    const payload = request.body as { source_trust?: number; is_core?: boolean }
    if (!payload || payload.source_trust !== undefined && (!Number.isFinite(payload.source_trust) || payload.source_trust < 0 || payload.source_trust > 1)
      || payload.is_core !== undefined && typeof payload.is_core !== 'boolean') throw Object.assign(new Error('source_trust 必须为0–1，is_core必须为布尔值'), { statusCode: 400 })
    const trust=payload.source_trust ?? document.source_trust ?? 0.5
    await query('UPDATE documents SET source_trust=$1,is_core=$2 WHERE id=$3', [trust,payload.is_core ?? document.is_core ?? false,document.id])
    await query('UPDATE fact_evidence SET weight=$1 WHERE doc_id=$2', [evidenceWeight({...document,source_trust:trust}),document.id])
    if (payload.is_core || trust >= 0.8) {
      await requestEnrichment(principal, document.id)
      void processEnrichmentQueue().catch(app.log.error.bind(app.log))
    }
    return { document_id: document.id, source_trust: trust, is_core: payload.is_core ?? document.is_core ?? false }
  })

  app.delete('/:doc_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    const document = await visibleDocument(principal, docId)
    return trashDocument(principal, document.id)
  })

  app.post('/:doc_id/restore', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    const result = await restoreDocument(principal, docId)
    void processEnrichmentQueue().catch(app.log.error.bind(app.log))
    return result
  })

  app.delete('/:doc_id/permanent', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    return purgeDocument(principal, docId)
  })
}

export const documentInternals = { parseBytes, parseTextContent, ingestParsed }
