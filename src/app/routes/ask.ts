import { integerParam, objectParam, textParam } from '../../util/input.js'
import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne, transaction } from '../../db/index.js'
import { ask, type AnswerFailure } from '../../core/answering.js'
import { setConversationArchived } from '../../core/conversation-archive.js'
import { retrieve } from '../../core/retrieval.js'
import { newId } from '../../core/ids.js'
import { TraceRecorder } from '../../core/tracing.js'
import type { ChunkRow } from '../../core/rows.js'
import { canRead } from '../../core/security.js'

export async function askRoutes(app: FastifyInstance): Promise<void> {
  app.post('/search', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = objectParam(request.body) as {
      query: string
      top_k?: number
      doc_ids?: string[]
      source_type?: string
      as_of?: string
    }
    const text = textParam(payload.query, 'query')
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
    const payload = objectParam(request.body) as {
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
    const params = request.query as { limit?: string; archived?: string }
    const limit = integerParam(params.limit, 'limit', 30, 1, 100)
    const archived = params.archived === '1' || params.archived === 'true'
    const conversations = await query<{ id: string; title: string; created_at: string; last_activity_at: string; archived_at: string | null }>(
      `SELECT c.id, c.title, c.created_at, c.archived_at,
              COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) AS last_activity_at
       FROM conversations c
       WHERE c.tenant_id = $1 AND c.user_id = $2 AND c.archived_at ${archived ? 'IS NOT NULL' : 'IS NULL'}
       ORDER BY last_activity_at DESC LIMIT ${limit}`,
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
        last_activity_at: conversation.last_activity_at,
        archived_at: conversation.archived_at,
      })
    }
    return { items }
  })

  app.get('/conversations/:conversation_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { conversation_id: conversationId } = request.params as { conversation_id: string }
    const conversation = await queryOne<{ id: string; tenant_id: string; user_id: string; title: string; archived_at: string | null }>(
      'SELECT id, tenant_id, user_id, title, archived_at FROM conversations WHERE id = $1',
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
      latency_ms: number
      created_at: string
      answer_failure: AnswerFailure | null
      refused: boolean
    }>(
      `SELECT m.id, m.role, m.content, m.mode, m.trace_id, m.confidence, m.latency_ms,
              m.created_at, m.answer_failure,
              COALESCE(t.status = 'refused', false) AS refused
       FROM messages m LEFT JOIN traces t ON t.id = m.trace_id AND t.tenant_id = $2 AND t.user_id = $3
       WHERE m.conversation_id = $1 ORDER BY m.created_at`,
      [conversationId, principal.tenantId, principal.userId],
    )
    const diagnosticIds = new Set(messages.flatMap(({ answer_failure: failure }) =>
      failure ? [...failure.selected, ...failure.excluded].map((item) => item.chunk_id) : []))
    const diagnosticChunks = diagnosticIds.size
      ? await query<{ id: string; chunk_acl: string[]; document_acl: string[] }>(
        `SELECT c.id, c.acl_principals AS chunk_acl, d.acl_principals AS document_acl
         FROM chunks c JOIN documents d ON d.id = c.doc_id
         WHERE c.id = ANY($1) AND c.tenant_id = $2 AND d.tenant_id = $2 AND d.status = 'active'`,
        [[...diagnosticIds], principal.tenantId],
      )
      : []
    const readableDiagnosticIds = new Set(diagnosticChunks
      .filter((row) => canRead(principal, row.document_acl) && canRead(principal, row.chunk_acl))
      .map((row) => row.id))
    const items: Array<Record<string, unknown>> = []
    const docIds = new Set<string>()
    for (const message of messages) {
      const citations = await query<{
        chunk_id: string | null
        doc_id: string | null
        quote: string
        page: number | null
        rank: number
        version_id: string | null
      }>(
        `SELECT ci.chunk_id, ci.doc_id, ci.quote, ci.page, ci.rank, c.version_id
         FROM citations ci LEFT JOIN chunks c ON c.id = ci.chunk_id
         WHERE ci.message_id = $1 ORDER BY ci.rank`,
        [message.id],
      )
      for (const citation of citations) if (citation.doc_id) docIds.add(citation.doc_id)
      const failure = message.answer_failure
      if (failure) {
        const selected = failure.selected.filter((item) => readableDiagnosticIds.has(item.chunk_id))
        failure.excluded = failure.excluded.filter((item) => readableDiagnosticIds.has(item.chunk_id))
        if (selected.length !== failure.selected.length) {
          failure.model_reason = ''
          failure.verification.issues = []
        }
        failure.selected = selected
      }
      items.push({
        id: message.id,
        role: message.role,
        content: message.content,
        mode: message.mode,
        trace_id: message.trace_id,
        confidence: message.confidence,
        latency_ms: message.latency_ms,
        created_at: message.created_at,
        citations,
        refused: message.role === 'assistant' && (Boolean(failure) || message.refused),
        failure,
      })
    }
    const titles = new Map<string, string>()
    for (const docId of docIds) {
      const document = await queryOne<{ title: string }>('SELECT title FROM documents WHERE id = $1', [docId])
      if (document) titles.set(docId, document.title)
    }
    for (const item of items) {
      for (const citation of item.citations as Array<Record<string, unknown>>) {
        const memory = citation.doc_id === null && citation.chunk_id === null
        citation.doc_title = memory ? '个人记忆' : titles.get(String(citation.doc_id)) ?? ''
        if (memory) citation.source = 'memory'
      }
    }
    return { id: conversation.id, title: conversation.title, archived_at: conversation.archived_at, messages: items }
  })

  app.post('/conversations/:conversation_id/archive', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { conversation_id: conversationId } = request.params as { conversation_id: string }
    return setConversationArchived(principal, conversationId, true)
  })

  app.post('/conversations/:conversation_id/unarchive', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { conversation_id: conversationId } = request.params as { conversation_id: string }
    return setConversationArchived(principal, conversationId, false)
  })

  app.post('/feedback', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = objectParam(request.body) as {
      target_type: string
      target_id: string
      value: number
      comment?: string
    }
    if (!['chunk', 'message'].includes(payload.target_type)) throw Object.assign(new Error('target_type 必须为 chunk 或 message'), { statusCode: 400 })
    payload.target_id = textParam(payload.target_id, 'target_id', 200)
    if (payload.comment !== undefined && (typeof payload.comment !== 'string' || payload.comment.includes('\u0000') || payload.comment.length > 2000)) {
      throw Object.assign(new Error('comment 必须为不含 NUL 的字符串，最长 2000 字符'), { statusCode: 400 })
    }
    if (![1, -1].includes(payload.value)) throw Object.assign(new Error('反馈值必须是 1 或 -1'), { statusCode: 400 })
    const chunkIds: string[] = []
    if (payload.target_type === 'chunk') {
      const chunk = await queryOne<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [payload.target_id])
      if (!chunk || chunk.tenant_id !== principal.tenantId) {
        throw Object.assign(new Error('chunk 不存在'), { statusCode: 404 })
      }
      chunkIds.push(chunk.id)
    }
    if (payload.target_type === 'message') {
      const message = await queryOne<{ id: string }>(
        `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND m.role = 'assistant' AND c.tenant_id = $2 AND c.user_id = $3`,
        [payload.target_id, principal.tenantId, principal.userId],
      )
      if (!message) throw Object.assign(new Error('回答不存在'), { statusCode: 404 })
      const citations = await query<{ chunk_id: string }>('SELECT DISTINCT chunk_id FROM citations WHERE message_id = $1 AND chunk_id IS NOT NULL', [message.id])
      chunkIds.push(...citations.map((citation) => citation.chunk_id))
    }
    await transaction(async (client) => {
      const previous = (await client.query<{ id: string; value: number }>(
        'SELECT id, value FROM feedback WHERE tenant_id = $1 AND user_id = $2 AND target_type = $3 AND target_id = $4 ORDER BY created_at DESC LIMIT 1',
        [principal.tenantId, principal.userId, payload.target_type, payload.target_id],
      ))[0]
      const delta = payload.value - (previous?.value ?? 0)
      for (const chunkId of new Set(chunkIds)) {
        await client.query('UPDATE chunks SET weight = greatest(0.5, least(1.6, weight + $1)) WHERE id = $2 AND tenant_id = $3', [0.12 * delta, chunkId, principal.tenantId])
        await client.query('UPDATE fact_evidence SET weight = greatest(0.5, least(1.6, weight + $1)) WHERE chunk_id = $2', [0.12 * delta, chunkId])
      }
      if (previous) await client.query('UPDATE feedback SET value = $1, comment = $2 WHERE id = $3', [payload.value, payload.comment ?? null, previous.id])
      else await client.query(
        `INSERT INTO feedback (id, tenant_id, user_id, target_type, target_id, value, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('fb'), principal.tenantId, principal.userId, payload.target_type, payload.target_id, payload.value, payload.comment ?? null],
      )
    })
    const recorder = new TraceRecorder(principal.tenantId, principal.userId, 'feedback')
    recorder.addSpan({
      stage: 'feedback',
      params: { target_type: payload.target_type, target_id: payload.target_id },
      output: { value: payload.value },
    })
    await recorder.finish(payload.comment ?? '')
    return { status: 'ok', message: chunkIds.length ? '反馈已应用到引用证据' : '反馈已记录', updated_chunks: new Set(chunkIds).size }
  })
}
