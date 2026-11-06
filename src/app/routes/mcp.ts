import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { ask } from '../../core/answering.js'
import { retrieve } from '../../core/retrieval.js'
import { factDict } from '../../core/serializers.js'
import { canRead } from '../../core/security.js'
import { newId } from '../../core/ids.js'
import type { EntityRow, FactRow } from '../../core/rows.js'

const TOOLS = [
  {
    name: 'kb_search',
    description: '在用户可见的知识库中做混合检索，返回带 ACL 过滤的 chunk 引用。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'integer', default: 8 } },
      required: ['query'],
    },
  },
  {
    name: 'kb_ask',
    description: '基于知识库回答并返回逐句引用；证据不足时明确拒答。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        mode: { type: 'string', enum: ['quick', 'deep', 'graph', 'timeline', 'compare'] },
        as_of: { type: 'string' },
      },
      required: ['question'],
    },
  },
  {
    name: 'kb_get_document',
    description: '读取一篇可见文档的结构、chunk 与事实。',
    inputSchema: { type: 'object', properties: { doc_id: { type: 'string' } }, required: ['doc_id'] },
  },
  {
    name: 'kb_entity_timeline',
    description: '查询实体的时间线事实与出处。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, as_of: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'kb_add_note',
    description: '写入一条个人记忆，默认不污染知识层。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'kb_report_gap',
    description: '上报一个知识缺口，进入运营台缺口清单。',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
]

function result(id: string | number | null, payload: unknown) {
  return { jsonrpc: '2.0', id, result: payload }
}

function error(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function toolResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = request.body as {
      jsonrpc?: string
      id?: string | number | null
      method: string
      params?: Record<string, unknown>
    }
    const id = payload.id ?? null
    if (payload.method === 'initialize') {
      return result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'knowweave', version: '0.1.0' },
      })
    }
    if (payload.method === 'tools/list') return result(id, { tools: TOOLS })
    if (payload.method === 'ping') return result(id, {})
    if (payload.method !== 'tools/call') return error(id, -32601, `method not found: ${payload.method}`)

    const params = payload.params ?? {}
    const name = params.name as string
    const args = (params.arguments ?? {}) as Record<string, unknown>
    try {
      if (name === 'kb_search') {
        const retrieved = await retrieve(principal, String(args.query ?? ''), { topK: Number(args.top_k ?? 8) })
        return result(id, toolResult({
          hits: retrieved.hits.map((hit) => hit.toDict()),
          facts: retrieved.facts,
          stats: retrieved.stats,
        }))
      }
      if (name === 'kb_ask') {
        return result(id, toolResult(await ask(principal, {
          question: String(args.question ?? ''),
          mode: args.mode as string | undefined,
          asOf: (args.as_of as string) ?? null,
        })))
      }
      if (name === 'kb_get_document') {
        // 复用文档详情逻辑：这里直接返回最小结构，避免路由内部循环依赖。
        const docId = String(args.doc_id ?? '')
        const document = await queryOne<{
          id: string
          tenant_id: string
          title: string
          acl_principals: string[]
          current_version: number
        }>('SELECT id, tenant_id, title, acl_principals, current_version FROM documents WHERE id = $1', [docId])
        if (!document || document.tenant_id !== principal.tenantId || !canRead(principal, document.acl_principals)) {
          return error(id, -32004, '文档不存在或无权访问')
        }
        const chunks = await query<{ id: string; text: string; heading_path: string[]; page: number | null }>(
          `SELECT id, text, heading_path, page FROM chunks WHERE doc_id = $1 AND is_parent = false
             AND version_id IN (SELECT id FROM document_versions WHERE doc_id = $1 AND version = $2)
           ORDER BY seq LIMIT 60`,
          [docId, document.current_version],
        )
        return result(id, toolResult({ document, chunks }))
      }
      if (name === 'kb_entity_timeline') {
        const entityName = String(args.name ?? '')
        const entity = await queryOne<EntityRow>(
          `SELECT * FROM entities WHERE tenant_id = $1 AND canonical_name ILIKE $2 AND status = 'active' LIMIT 1`,
          [principal.tenantId, `%${entityName}%`],
        )
        if (!entity || !canRead(principal, entity.acl_principals)) return error(id, -32004, '实体不存在或无权访问')
        const facts = await query<FactRow>('SELECT * FROM facts WHERE subject_id = $1', [entity.id])
        const timeline = []
        for (const fact of facts) {
          if (canRead(principal, fact.acl_principals)) timeline.push(await factDict(fact))
        }
        return result(id, toolResult({ entity: entity.canonical_name, timeline }))
      }
      if (name === 'kb_add_note') {
        const memoryId = newId('mem')
        await query(
          `INSERT INTO memory_items (id, tenant_id, user_id, scope, kind, text, confidence)
           VALUES ($1, $2, $3, 'personal', 'mcp_note', $4, 0.5)`,
          [memoryId, principal.tenantId, principal.userId, String(args.text ?? '')],
        )
        return result(id, toolResult({ memory_id: memoryId }))
      }
      if (name === 'kb_report_gap') {
        const gapId = newId('gap')
        const question = String(args.question ?? '').toLowerCase().replace(/\s+/g, ' ')
        await query(
          `INSERT INTO gaps (id, tenant_id, question, count, suggested_sources)
           VALUES ($1, $2, $3, 1, '[]'::jsonb)`,
          [gapId, principal.tenantId, question],
        )
        return result(id, toolResult({ gap_id: gapId }))
      }
      return error(id, -32602, `unknown tool: ${name}`)
    } catch (err) {
      return error(id, -32000, err instanceof Error ? err.message : String(err))
    }
  })
}
