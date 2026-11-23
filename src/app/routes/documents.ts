import { integerParam } from '../../util/input.js'
import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { settings } from '../../config.js'
import { query, queryOne } from '../../db/index.js'
import { chunkDict, documentDict, entityDict, factDict } from '../../core/serializers.js'
import { decideIngestDuplicate, ingestParsed, savedIngestJobs, retryIngestJob, submitIngest } from '../../core/ingestion.js'
import { parseBytes, parseTextContent } from '../../adapters/parsing/index.js'
import { convertWord } from '../../adapters/parsing/word.js'
import { requireEditor, canRead, principalSet } from '../../core/security.js'
import { isEntityName } from '../../core/learning.js'
import { enrichmentTasks, processEnrichmentQueue, requestEnrichment } from '../../core/enrichment-queue.js'
import { DISPLAYABLE_FACT } from '../../core/fact-visibility.js'
import { reindexDocument } from '../../core/reindexing.js'
import { continuationView, detachContinuation, linkContinuation, unlinkContinuation } from '../../core/continuation.js'
import { purgeDocument, restoreDocument, trashDocument, trashDocuments } from '../../core/trash.js'
import { evidenceWeight } from '../../core/source-policy.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from '../../core/rows.js'

function parseAcl(raw: unknown): string[] | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw Object.assign(new Error('acl 必须为逗号分隔的授权主体'), { statusCode: 400 })
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

const ORIGINAL_FILE_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

async function versionFile(version: VersionRow, includeData = false) {
  if (typeof version.meta.source_pdf_hash === 'string') {
    const pdf = await queryOne<{ filename: string; data: string | null }>(
      `SELECT payload #>> ARRAY['source_pdfs', $4, 'filename'] AS filename,
              CASE WHEN $5::boolean THEN payload #>> ARRAY['source_pdfs', $4, 'data'] END AS data
       FROM jobs WHERE tenant_id = $1 AND payload->>'doc_id' = $2 AND id = $3
         AND type = 'ingest' AND payload->>'source' = 'url' AND (payload->'source_pdfs') ? $4`,
      [version.tenant_id, version.doc_id, version.meta.source_job_id ?? null, version.meta.source_pdf_hash, includeData],
    )
    return pdf ? { ...pdf, type: 'pdf' as const } : null
  }
  const upload = await queryOne<{ filename: string; data: string | null }>(
    `SELECT payload #>> '{request,filename}' AS filename,
            CASE WHEN $6::boolean THEN payload #>> '{request,data}' END AS data
     FROM jobs WHERE tenant_id = $1 AND type = 'ingest' AND payload->>'source' = 'file'
       AND payload->>'doc_id' = $2
       AND (payload #>> '{request,filename}') ~* '\\.(pdf|docx?)$'
       AND coalesce(payload #>> '{request,data}', '') <> ''
       AND (id = $5 OR (payload->>'version' = $3 AND input_hash = $4))
     ORDER BY (id = $5) DESC NULLS LAST, created_at DESC LIMIT 1`,
    [version.tenant_id, version.doc_id, String(version.version), version.hash, version.meta.source_job_id ?? null, includeData],
  )
  if (!upload) return null
  const filename = upload.filename.split(/[/\\]/).at(-1)!
  const type = filename.split('.').at(-1)!.toLowerCase() as keyof typeof ORIGINAL_FILE_TYPES
  return { filename, type, data: upload.data }
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/upload', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    if (!request.isMultipart()) throw Object.assign(new Error('请使用 multipart/form-data 上传文件'), { statusCode: 415 })
    const part = await request.file()
    if (!part) throw Object.assign(new Error('文件为空'), { statusCode: 400 })
    const chunks: Buffer[] = []
    for await (const chunk of part.file) chunks.push(Buffer.from(chunk))
    const data = Buffer.concat(chunks)
    if (!data.length) throw Object.assign(new Error('文件为空'), { statusCode: 400 })
    if (data.length > 30 * 1024 * 1024) throw Object.assign(new Error('文件超过 30MB'), { statusCode: 413 })
    const fields = part.fields as Record<string, { value?: unknown }>
    const sourceUri = typeof fields.source_uri?.value === 'string' && fields.source_uri.value.startsWith('directory:') ? fields.source_uri.value : null
    return submitIngest(principal, 'file', {
      title: typeof fields.title?.value === 'string' ? fields.title.value : null,
      filename: part.filename || 'document.txt',
      data,
      acl: parseAcl(fields.acl?.value),
      documentId: typeof fields.doc_id?.value === 'string' ? fields.doc_id.value : null,
      sourceUri,
      confirmDuplicates: !sourceUri,
    })
  })

  app.post('/text', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const payload = request.body as { text?: string; title?: string; acl?: string[]; doc_id?: string }
    if (typeof payload?.text !== 'string' || !payload.text.trim()) throw Object.assign(new Error('text 必须为非空字符串'), { statusCode: 400 })
    return submitIngest(principal, 'text', {
      text: payload.text,
      title: payload.title ?? null,
      acl: payload.acl ?? null,
      documentId: payload.doc_id ?? null,
      confirmDuplicates: true,
    })
  })

  app.post('/url', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const payload = request.body as { url?: string; title?: string; acl?: string[]; doc_id?: string }
    if (typeof payload?.url !== 'string' || !/^https?:\/\//i.test(payload.url)) {
      throw Object.assign(new Error('仅支持 http/https URL'), { statusCode: 400 })
    }
    return submitIngest(principal, 'url', { url: payload.url, title: payload.title ?? null, acl: payload.acl ?? null, documentId: payload.doc_id ?? null, confirmDuplicates: true })
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

  app.post('/jobs/:job_id/duplicate', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const action = (request.body as { action?: string } | null)?.action
    if (action !== 'continue' && action !== 'skip') {
      throw Object.assign(new Error('请选择继续导入或跳过'), { statusCode: 400 })
    }
    return decideIngestDuplicate(principal, (request.params as { job_id: string }).job_id, action)
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
    const body = request.body as { document_ids?: unknown; reset?: unknown } | undefined
    const ids = body?.document_ids
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id))) {
      throw Object.assign(new Error('document_ids 必须为非空文档 ID 列表'), { statusCode: 400 })
    }
    if (body?.reset !== undefined && typeof body.reset !== 'boolean') {
      throw Object.assign(new Error('reset 必须为布尔值'), { statusCode: 400 })
    }
    const reset = body?.reset === true
    const selected = ids ? new Set<string>(ids as string[]) : null
    const tasks = await enrichmentTasks(principal)
    let queued = 0
    for (const task of tasks) {
      if (task.status === 'failed' && (!selected || selected.has(task.id))
        && await requestEnrichment(principal, task.id, 'failed', undefined, { reset })) queued++
    }
    if (queued) void processEnrichmentQueue().catch(app.log.error.bind(app.log))
    return { queued, reset }
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
    const status = params.status || 'active'
    if (!['active', 'tombstoned'].includes(status)) throw Object.assign(new Error('status 必须为 active 或 tombstoned'), { statusCode: 400 })
    const limit = integerParam(params.limit, 'limit', 50, 1, 200)
    const offset = integerParam(params.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
    const where = ['tenant_id = $1', `jsonb_typeof(acl_principals) = 'array' AND acl_principals ?| $2::text[]`]
    const values: unknown[] = [principal.tenantId, [...principalSet(principal)]]
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
    const count = await queryOne<{ total: string }>(`SELECT count(*)::text AS total FROM documents WHERE ${where.join(' AND ')}`, values)
    const visible = documents.filter((document) => canRead(principal, document.acl_principals))
    return {
      total: Number(count?.total ?? 0),
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
    const file = chunks.every((chunk) => canRead(principal, chunk.acl_principals)) ? await versionFile(selectedVersion) : null
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
      source: {
        version_id: selectedVersion.id, version: selectedVersion.version, text: selectedVersion.text, parser: selectedVersion.parser,
        coordinate_system: selectedVersion.meta.coordinate_system ?? null,
        file: file ? { filename: file.filename, type: file.type } : null,
      },
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
    const wantsFile = format === 'pdf' || format === 'original'
    const file = partial ? null : await versionFile(version, wantsFile)
    if (wantsFile) {
      if (!file?.data) throw unavailable()
      const bytes = Buffer.from(file.data, 'base64')
      reply.header('X-Content-Type-Options', 'nosniff')
      if (format === 'original') {
        const filename = encodeURIComponent(file.filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`)
        return reply.type(ORIGINAL_FILE_TYPES[file.type]).header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`).send(bytes)
      }
      if (file.type === 'pdf') {
        if (!bytes.subarray(0, 1024).includes('%PDF-')) throw unavailable()
        return reply.type('application/pdf').send(bytes)
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once('close', abort)
      try {
        const pdf = await convertWord(bytes, file.type, 'pdf', controller.signal)
        return reply.type('application/pdf').send(pdf)
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 503) throw error
        throw Object.assign(new Error('Word 版式预览暂不可用'), { statusCode: 422 })
      } finally {
        reply.raw.off('close', abort)
      }
    }
    const spans = version.meta.chunk_spans as Record<string, unknown> | undefined
    return {
      title: document.title,
      version: version.version,
      page: cited?.page ?? null,
      file_type: file?.type ?? null,
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
    const { relation, reconnect, predecessor_id, successor_id } = request.query as Record<string, string | undefined>
    if (reconnect === undefined) return unlinkContinuation(principal, docId, relation)
    if (reconnect !== 'true' && reconnect !== 'false') {
      throw Object.assign(new Error('reconnect 必须为 true 或 false'), { statusCode: 400 })
    }
    const expected = predecessor_id !== undefined || successor_id !== undefined
      ? { predecessorId: predecessor_id ?? '', successorId: successor_id ?? '' }
      : undefined
    return detachContinuation(principal, docId, reconnect === 'true', expected)
  })

  app.post('/:doc_id/reprocess', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    await visibleDocument(principal, docId)
    const body = request.body as { scope?: string; reset?: unknown } | undefined
    const scope = body?.scope ?? 'facts'
    if (!['facts','index','all'].includes(scope)) throw Object.assign(new Error('scope 必须为 facts、index 或 all'), { statusCode: 400 })
    if (body?.reset !== undefined && typeof body.reset !== 'boolean') {
      throw Object.assign(new Error('reset 必须为布尔值'), { statusCode: 400 })
    }
    const reset = body?.reset === true
    if (scope !== 'facts') {
      const result = await reindexDocument(principal.tenantId, docId)
      if (scope === 'all') {
        await requestEnrichment(principal, docId, undefined, undefined, { reset })
        void processEnrichmentQueue().catch(app.log.error.bind(app.log))
      }
      return result
    }
    await requestEnrichment(principal, docId, undefined, undefined, { reset })
    void processEnrichmentQueue().catch(app.log.error.bind(app.log))
    return { document_id: docId, status: 'queued', reset, message: reset ? '已排入事实抽取队列（从头重抽）' : '已排入事实抽取队列' }
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
