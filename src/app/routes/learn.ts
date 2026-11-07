import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { entityDict, factDict } from '../../core/serializers.js'
import { extractFactsForDocument, resolveReview, runReflection } from '../../core/learning.js'
import { ingestParsed } from '../../core/ingestion.js'
import { parseTextContent } from '../../adapters/parsing/index.js'
import { canRead, requireAdmin } from '../../core/security.js'
import { newId } from '../../core/ids.js'
import type { DocumentRow, EntityRow, FactRow } from '../../core/rows.js'

export async function learnRoutes(app: FastifyInstance): Promise<void> {
  app.get('/entities', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const params = request.query as Record<string, string | undefined>
    const limit = Math.min(200, Math.max(1, Number(params.limit ?? 60)))
    const where = [`tenant_id = $1`, `status = 'active'`]
    const values: unknown[] = [principal.tenantId]
    if (params.q) {
      values.push(`%${params.q}%`)
      where.push(`canonical_name ILIKE $${values.length}`)
    }
    if (params.type) {
      values.push(params.type)
      where.push(`type = $${values.length}`)
    }
    const entities = await query<EntityRow>(
      `SELECT * FROM entities WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`,
      values,
    )
    const visible = entities.filter((entity) => canRead(principal, entity.acl_principals))
    const items = []
    for (const entity of visible) {
      const facts = await query<FactRow>(
        `SELECT * FROM facts WHERE tenant_id = $1 AND (subject_id = $2 OR object_id = $2)`,
        [principal.tenantId, entity.id],
      )
      items.push({ ...entityDict(entity), facts: facts.filter((fact) => canRead(principal, fact.acl_principals)).length })
    }
    return { items }
  })

  app.get('/entities/:entity_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { entity_id: entityId } = request.params as { entity_id: string }
    const asOf = (request.query as { as_of?: string }).as_of
    const entity = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [entityId])
    if (!entity || entity.tenant_id !== principal.tenantId || !canRead(principal, entity.acl_principals)) {
      throw Object.assign(new Error('实体不存在或无权访问'), { statusCode: 404 })
    }
    const facts = await query<FactRow>(
      `SELECT * FROM facts WHERE tenant_id = $1 AND (subject_id = $2 OR object_id = $2)
       ORDER BY valid_from, recorded_at`,
      [principal.tenantId, entity.id],
    )
    const items = []
    for (const fact of facts) {
      if (!canRead(principal, fact.acl_principals)) continue
      if (asOf) {
        if (fact.valid_from && String(fact.valid_from).slice(0, 10) > asOf) continue
        if (fact.valid_to && String(fact.valid_to).slice(0, 10) <= asOf) continue
      }
      items.push(await factDict(fact))
    }
    const documents: Array<{ id: string; title: string; source_type: string }> = []
    for (const docId of new Set(items.map((item) => item.source_doc_id).filter(Boolean))) {
      const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [String(docId)])
      if (document && canRead(principal, document.acl_principals)) {
        documents.push({ id: document.id, title: document.title, source_type: document.source_type })
      }
    }
    return { entity: entityDict(entity), facts: items, documents, aliases: [] }
  })

  app.get('/facts', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const params = request.query as Record<string, string | undefined>
    const limit = Math.min(200, Math.max(1, Number(params.limit ?? 60)))
    const where = ['tenant_id = $1']
    const values: unknown[] = [principal.tenantId]
    if (params.status) {
      values.push(params.status)
      where.push(`status = $${values.length}`)
    }
    if (params.subject) {
      const entity = await queryOne<EntityRow>(
        'SELECT * FROM entities WHERE tenant_id = $1 AND canonical_name = $2',
        [principal.tenantId, params.subject],
      )
      if (entity) {
        values.push(entity.id)
        where.push(`subject_id = $${values.length}`)
      }
    }
    const facts = await query<FactRow>(
      `SELECT * FROM facts WHERE ${where.join(' AND ')} ORDER BY recorded_at DESC LIMIT ${limit}`,
      values,
    )
    const items = []
    for (const fact of facts) {
      if (canRead(principal, fact.acl_principals)) items.push(await factDict(fact))
    }
    return { items }
  })

  app.get('/graph', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const limit = Math.min(300, Math.max(10, Number((request.query as { limit?: string }).limit ?? 80)))
    const facts = await query<FactRow>(
      `SELECT * FROM facts WHERE tenant_id = $1 AND status IN ('active', 'disputed')
       ORDER BY confidence DESC LIMIT ${limit * 3}`,
      [principal.tenantId],
    )
    const visible = facts.filter((fact) => canRead(principal, fact.acl_principals))
    const nodeIds = new Set<string>()
    const edges = []
    for (const fact of visible.slice(0, limit)) {
      nodeIds.add(fact.subject_id)
      nodeIds.add(fact.object_id ?? fact.subject_id)
      const subject = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.subject_id])
      const target = fact.object_id
        ? await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.object_id])
        : null
      const targetId = fact.object_id ?? `lit_${fact.id}`
      edges.push({
        id: fact.id,
        source: fact.subject_id,
        target: targetId,
        label: fact.predicate,
        object_literal: fact.object_literal,
        status: fact.status,
        confidence: fact.confidence,
      })
      nodeIds.add(targetId)
      void subject
      void target
    }
    const nodes = []
    for (const nodeId of nodeIds) {
      if (nodeId.startsWith('lit_')) {
        const literal = edges.find((edge) => edge.target === nodeId)?.object_literal ?? ''
        nodes.push({ id: nodeId, name: literal || nodeId, type: 'literal' })
      } else {
        const entity = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [nodeId])
        if (entity && canRead(principal, entity.acl_principals)) {
          nodes.push({ id: entity.id, name: entity.canonical_name, type: entity.type })
        }
      }
    }
    return { nodes, edges }
  })

  app.get('/review', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const status = (request.query as { status?: string }).status ?? 'open'
    const items = await query<{
      id: string
      kind: string
      title: string
      payload: Record<string, unknown>
      status: string
      created_at: string
    }>(
      `SELECT id, kind, title, payload, status, created_at FROM review_queue
       WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`,
      [principal.tenantId, status],
    )
    return {
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        payload: item.payload,
        status: item.status,
        created_at: item.created_at,
      })),
    }
  })

  app.post('/review/:review_id/resolve', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { review_id: reviewId } = request.params as { review_id: string }
    const payload = request.body as { action: string; note?: string }
    const review = await queryOne<{ id: string; tenant_id: string; kind: string; status: string; payload: Record<string, unknown> }>(
      'SELECT id, tenant_id, kind, status, payload FROM review_queue WHERE id = $1',
      [reviewId],
    )
    if (!review || review.tenant_id !== principal.tenantId) {
      throw Object.assign(new Error('审阅项不存在'), { statusCode: 404 })
    }
    if (review.kind === 'memory_promotion') {
      if (review.status !== 'open') throw Object.assign(new Error('审阅项已处理'), { statusCode: 409 })
      const memory = await queryOne<{ id: string; text: string }>(
        'SELECT id, text FROM memory_items WHERE id = $1',
        [String(review.payload.memory_id ?? '')],
      )
      if (['accept_new', 'merge'].includes(payload.action) && memory) {
        const document = await ingestParsed(principal,parseTextContent(memory.text,`审阅记忆 ${memory.id}`),{sourceType:'text',uri:`memory:${memory.id}`,acl:['tenant:public']})
        await extractFactsForDocument(principal,String(document.document_id))
        const fact = await queryOne<{ fact_id: string }>('SELECT fact_id FROM fact_evidence WHERE doc_id=$1 ORDER BY id LIMIT 1',[document.document_id])
        await query('UPDATE memory_items SET promoted_fact_id = $1 WHERE id = $2', [fact?.fact_id ?? null, memory.id])
      }
      await query(
        `UPDATE review_queue SET status = 'resolved', resolution = $1::jsonb, resolved_at = now() WHERE id = $2`,
        [JSON.stringify({ action: payload.action, note: payload.note ?? '' }), reviewId],
      )
      return { review_id: reviewId, status: 'resolved' }
    }
    return resolveReview(principal, reviewId, payload.action, payload.note ?? '')
  })

  app.get('/memory', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const items = await query<{
      id: string
      kind: string
      scope: string
      text: string
      confidence: number
      promoted_fact_id: string | null
      expires_at: string | null
      created_at: string
    }>(
      `SELECT id, kind, scope, text, confidence, promoted_fact_id, expires_at, created_at, tags
       FROM memory_items WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [principal.tenantId, principal.userId],
    )
    return { items }
  })

  app.post('/memory', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = request.body as { text: string; kind?: string; scope?: string; expires_at?: string; tags?: string[] }
    if (!payload?.text) throw Object.assign(new Error('text 不能为空'), { statusCode: 400 })
    if (payload.tags !== undefined && (!Array.isArray(payload.tags) || !payload.tags.every(tag=>typeof tag==='string'))) throw Object.assign(new Error('tags必须为字符串数组'),{statusCode:400})
    const id = newId('mem')
    await query(
      `INSERT INTO memory_items (id, tenant_id, user_id, scope, kind, text, confidence, expires_at,tags)
       VALUES ($1, $2, $3, $4, $5, $6, 0.55, $7,$8::jsonb)`,
      [id, principal.tenantId, principal.userId, payload.scope ?? 'personal', payload.kind ?? 'note', payload.text, payload.expires_at ?? null,JSON.stringify(payload.tags ?? [])],
    )
    return { id, status: 'created' }
  })

  app.delete('/memory/:memory_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { memory_id: memoryId } = request.params as { memory_id: string }
    const memory = await queryOne<{ id: string; tenant_id: string; user_id: string }>(
      'SELECT id, tenant_id, user_id FROM memory_items WHERE id = $1',
      [memoryId],
    )
    if (!memory || memory.tenant_id !== principal.tenantId || memory.user_id !== principal.userId) {
      throw Object.assign(new Error('记忆不存在'), { statusCode: 404 })
    }
    await query('DELETE FROM memory_items WHERE id = $1', [memoryId])
    return { status: 'deleted' }
  })

  app.post('/memory/:memory_id/promote', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { memory_id: memoryId } = request.params as { memory_id: string }
    const memory = await queryOne<{ id: string; tenant_id: string; user_id: string; text: string }>(
      'SELECT id, tenant_id, user_id, text FROM memory_items WHERE id = $1',
      [memoryId],
    )
    if (!memory || memory.tenant_id !== principal.tenantId || memory.user_id !== principal.userId) {
      throw Object.assign(new Error('记忆不存在'), { statusCode: 404 })
    }
    const reviewId = newId('rev')
    await query(
      `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
       VALUES ($1, $2, 'memory_promotion', $3, $4::jsonb, 'open')`,
      [
        reviewId,
        principal.tenantId,
        `记忆晋升：${memory.text.slice(0, 48)}`,
        JSON.stringify({
          memory_id: memory.id,
          text: memory.text,
          reason: '记忆默认不污染知识层，晋升为事实需要人工审阅。',
        }),
      ],
    )
    return { review_id: reviewId, status: 'pending_review' }
  })

  app.get('/gaps', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const status = (request.query as { status?: string }).status ?? 'open'
    const gaps = await query<{
      id: string
      question: string
      count: number
      status: string
      suggested_sources: string[]
      updated_at: string
    }>(
      `SELECT id, question, count, status, suggested_sources, updated_at FROM gaps
       WHERE tenant_id = $1 AND status = $2 ORDER BY count DESC, updated_at DESC`,
      [principal.tenantId, status],
    )
    return { items: gaps }
  })

  app.post('/gaps/:gap_id/resolve', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { gap_id: gapId } = request.params as { gap_id: string }
    const payload = request.body as { status?: string }
    const gap = await queryOne<{ id: string; tenant_id: string }>('SELECT id, tenant_id FROM gaps WHERE id = $1', [gapId])
    if (!gap || gap.tenant_id !== principal.tenantId) throw Object.assign(new Error('缺口不存在'), { statusCode: 404 })
    const status = payload.status ?? 'resolved'
    await query('UPDATE gaps SET status = $1, updated_at = now() WHERE id = $2', [status, gapId])
    return { gap_id: gapId, status }
  })

  app.post('/reflection/run', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    return runReflection(principal.tenantId)
  })
}
