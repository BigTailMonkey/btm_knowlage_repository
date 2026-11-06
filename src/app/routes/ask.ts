import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { ask } from '../../core/answering.js'
import { retrieve } from '../../core/retrieval.js'
import { newId } from '../../core/ids.js'
import { TraceRecorder } from '../../core/tracing.js'
import type { ChunkRow } from '../../core/rows.js'

export async function askRoutes(app: FastifyInstance): Promise<void> {
  app.post('/search', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = request.body as {
      query: string
      top_k?: number
      doc_ids?: string[]
      source_type?: string
      as_of?: string
    }
    const text = (payload.query ?? '').trim()
    if (!text) throw Object.assign(new Error('query 不能为空'), { statusCode: 400 })
    const recorder = new TraceRecorder(principal.tenantId, principal.userId, 'search', text)
    const result = await retrieve(principal, text, {
      topK: payload.top_k ?? 8,
      docIds: payload.doc_ids ?? null,
      sourceType: payload.source_type ?? null,
      asOf: payload.as_of ?? null,
      recorder,
    })
    recorder.meta = { stats: result.stats }
    await recorder.finish(`hits=${result.hits.length}`)
    return {
      query: text,
      hits: result.hits.map((hit) => hit.toDict()),
      facts: result.facts,
      entities: result.entities.map((entity) => ({ id: entity.id, name: entity.canonical_name, type: entity.type })),
      stats: result.stats,
      trace_id: recorder.traceId,
    }
  })

  app.post('/ask', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = request.body as {
      question: string
      mode?: string
      top_k?: number
      as_of?: string
      conversation_id?: string
      doc_ids?: string[]
    }
    return ask(principal, {
      question: payload.question,
      mode: payload.mode,
      topK: payload.top_k,
      asOf: payload.as_of ?? null,
      conversationId: payload.conversation_id ?? null,
      docIds: payload.doc_ids ?? null,
    })
  })

  app.get('/conversations', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const limit = Math.min(100, Math.max(1, Number((request.query as { limit?: string }).limit ?? 30)))
    const conversations = await query<{ id: string; title: string; created_at: string }>(
      `SELECT id, title, created_at FROM conversations
       WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT ${limit}`,
      [principal.tenantId, principal.userId],
    )
    const items = []
    for (const conversation of conversations) {
      const count = await queryOne<{ count: string }>(
        'SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1',
        [conversation.id],
      )
      items.push({
        id: conversation.id,
        title: conversation.title,
        messages: Number(count?.count ?? 0),
        created_at: conversation.created_at,
      })
    }
    return { items }
  })

  app.get('/conversations/:conversation_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { conversation_id: conversationId } = request.params as { conversation_id: string }
    const conversation = await queryOne<{ id: string; tenant_id: string; user_id: string; title: string }>(
      'SELECT id, tenant_id, user_id, title FROM conversations WHERE id = $1',
      [conversationId],
    )
    if (!conversation || conversation.tenant_id !== principal.tenantId || conversation.user_id !== principal.userId) {
      throw Object.assign(new Error('会话不存在'), { statusCode: 404 })
    }
    const messages = await query<{
      id: string
      role: string
      content: string
      mode: string
      trace_id: string | null
      confidence: number
      created_at: string
    }>(
      `SELECT id, role, content, mode, trace_id, confidence, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
      [conversationId],
    )
    const items: Array<Record<string, unknown>> = []
    const docIds = new Set<string>()
    for (const message of messages) {
      const citations = await query<{
        chunk_id: string | null
        doc_id: string | null
        quote: string
        page: number | null
        rank: number
      }>(
        'SELECT chunk_id, doc_id, quote, page, rank FROM citations WHERE message_id = $1 ORDER BY rank',
        [message.id],
      )
      for (const citation of citations) if (citation.doc_id) docIds.add(citation.doc_id)
      items.push({
        id: message.id,
        role: message.role,
        content: message.content,
        mode: message.mode,
        trace_id: message.trace_id,
        confidence: message.confidence,
        created_at: message.created_at,
        citations,
      })
    }
    const titles = new Map<string, string>()
    for (const docId of docIds) {
      const document = await queryOne<{ title: string }>('SELECT title FROM documents WHERE id = $1', [docId])
      if (document) titles.set(docId, document.title)
    }
    for (const item of items) {
      for (const citation of item.citations as Array<Record<string, unknown>>) {
        citation.doc_title = titles.get(String(citation.doc_id)) ?? ''
      }
    }
    return { id: conversation.id, title: conversation.title, messages: items }
  })

  app.post('/feedback', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = request.body as {
      target_type: string
      target_id: string
      value: number
      comment?: string
    }
    if (payload.target_type === 'chunk') {
      const chunk = await queryOne<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [payload.target_id])
      if (!chunk || chunk.tenant_id !== principal.tenantId) {
        throw Object.assign(new Error('chunk 不存在'), { statusCode: 404 })
      }
      const weight = Math.max(0.5, Math.min(1.6, chunk.weight + 0.12 * payload.value))
      await query('UPDATE chunks SET weight = $1 WHERE id = $2', [weight, chunk.id])
    }
    await query(
      `INSERT INTO feedback (id, tenant_id, user_id, target_type, target_id, value, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId('fb'), principal.tenantId, principal.userId, payload.target_type, payload.target_id, payload.value, payload.comment ?? null],
    )
    const recorder = new TraceRecorder(principal.tenantId, principal.userId, 'feedback')
    recorder.addSpan({
      stage: 'feedback',
      params: { target_type: payload.target_type, target_id: payload.target_id },
      output: { value: payload.value },
    })
    await recorder.finish(payload.comment ?? '')
    return { status: 'ok', message: '反馈已记录' }
  })
}
