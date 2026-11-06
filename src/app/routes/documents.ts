import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { chunkDict, documentDict, entityDict, factDict } from '../../core/serializers.js'
import { ingestParsed, listIngestJobs, submitIngest, tombstoneDocument } from '../../core/ingestion.js'
import { parseBytes, parseTextContent } from '../../adapters/parsing/index.js'
import { requireEditor, canRead } from '../../core/security.js'
import { extractFactsForDocument } from '../../core/learning.js'
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
    return { items: listIngestJobs(principal, active) }
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
    const evidence = await query<{ fact_id: string }>('SELECT fact_id FROM fact_evidence WHERE doc_id = $1', [document.id])
    const facts = []
    const entityIds = new Set<string>()
    for (const factId of new Set(evidence.map((row) => row.fact_id))) {
      const fact = await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [factId])
      if (!fact || !canRead(principal, fact.acl_principals)) continue
      facts.push(await factDict(fact))
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
    }
  })

  app.post('/:doc_id/reprocess', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    const document = await visibleDocument(principal, docId)
    void extractFactsForDocument(principal, document.id).catch(() => undefined)
    return { document_id: docId, status: 'queued', message: '已排入事实抽取队列' }
  })

  app.delete('/:doc_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireEditor(principal)
    const { doc_id: docId } = request.params as { doc_id: string }
    const document = await visibleDocument(principal, docId)
    return tombstoneDocument(principal, document.id)
  })
}

export const documentInternals = { parseBytes, parseTextContent, ingestParsed }
