import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { ask } from '../../core/answering.js'
import { factIsEffective, normalizeAsOf, retrieve } from '../../core/retrieval.js'
import { factDict } from '../../core/serializers.js'
import { canRead } from '../../core/security.js'
import { newId } from '../../core/ids.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from '../../core/rows.js'

const TOOLS = [
  {
    name: 'kb_search',
    description: '在用户可见的知识库中做混合检索，返回带 ACL 过滤的 chunk 引用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'integer', minimum: 1, maximum: 100, default: 8 },
        filters: {
          type: 'object',
          properties: {
            doc_ids: { type: 'array', items: { type: 'string' } },
            source_type: { type: 'string' },
            as_of: { type: 'string', format: 'date' },
          },
        },
      },
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
      properties: { entity_id: { type: 'string' }, name: { type: 'string' }, as_of: { type: 'string', format: 'date' } },
      anyOf: [{ required: ['entity_id'] }, { required: ['name'] }],
    },
  },
  {
    name: 'kb_add_note',
    description: '写入一条个人记忆，默认不污染知识层。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, tags: {type:'array',items:{type:'string'}} }, required: ['text'] },
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
        const filters = (args.filters ?? {}) as Record<string, unknown>
        if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return error(id, -32602, 'filters 必须为对象')
        if (filters.doc_ids !== undefined && (!Array.isArray(filters.doc_ids) || filters.doc_ids.some((value) => typeof value !== 'string'))) {
          return error(id, -32602, 'filters.doc_ids 必须为文档 ID 数组')
        }
        for (const key of ['source_type', 'as_of']) {
          if (filters[key] !== undefined && typeof filters[key] !== 'string') return error(id, -32602, `filters.${key} 必须为字符串`)
        }
        const retrieved = await retrieve(principal, String(args.query ?? ''), {
          topK: Number(args.top_k ?? 8),
          docIds: (filters.doc_ids as string[] | undefined) ?? null,
          sourceType: typeof filters.source_type === 'string' ? filters.source_type : null,
          asOf: typeof filters.as_of === 'string' ? filters.as_of : null,
        })
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
        const docId = String(args.doc_id ?? '')
        const document = await queryOne<DocumentRow>("SELECT * FROM documents WHERE id = $1 AND status = 'active'", [docId])
        if (!document || document.tenant_id !== principal.tenantId || !canRead(principal, document.acl_principals)) {
          return error(id, -32004, '文档不存在或无权访问')
        }
        const version = await queryOne<VersionRow>(
          'SELECT * FROM document_versions WHERE doc_id = $1 AND version = $2',
          [docId, document.current_version],
        )
        const chunks = await query<Pick<ChunkRow, 'id' | 'text' | 'heading_path' | 'page' | 'bbox' | 'block_type' | 'version_id'>>(
          `SELECT id, text, heading_path, page, bbox, block_type, version_id FROM chunks WHERE doc_id = $1 AND is_parent = false
             AND version_id IN (SELECT id FROM document_versions WHERE doc_id = $1 AND version = $2)
           ORDER BY seq`,
          [docId, document.current_version],
        )
        const facts = await query<FactRow>(
          `SELECT DISTINCT f.* FROM facts f JOIN fact_evidence e ON e.fact_id = f.id
           JOIN chunks c ON c.id = e.chunk_id
           WHERE e.doc_id = $1 AND c.version_id = $2 AND f.tenant_id = $3`,
          [docId, version?.id ?? '', principal.tenantId],
        )
        const visibleFacts = facts.filter((fact) => canRead(principal, fact.acl_principals) && factIsEffective(fact, null))
        return result(id, toolResult({
          document,
          text: version?.text ?? '',
          version: version ? { id: version.id, version: version.version, parser: version.parser, created_at: version.created_at, meta: version.meta } : null,
          chunks,
          facts: await Promise.all(visibleFacts.map(factDict)),
        }))
      }
      if (name === 'kb_entity_timeline') {
        const entityId = typeof args.entity_id === 'string' ? args.entity_id.trim() : ''
        const entityName = typeof args.name === 'string' ? args.name.trim() : ''
        if (!entityId && !entityName) return error(id, -32602, '需要 entity_id 或 name')
        const asOf = normalizeAsOf(typeof args.as_of === 'string' ? args.as_of : null)
        const matches = entityId
          ? await query<EntityRow>("SELECT * FROM entities WHERE tenant_id = $1 AND id = $2 AND status = 'active'", [principal.tenantId, entityId])
          : await query<EntityRow>(
            "SELECT * FROM entities WHERE tenant_id = $1 AND canonical_name ILIKE $2 AND status = 'active' ORDER BY canonical_name, id",
            [principal.tenantId, `%${entityName}%`],
          )
        const visible = matches.filter((entity) => canRead(principal, entity.acl_principals))
        const exact = visible.find((entity) => entity.canonical_name.toLowerCase() === entityName.toLowerCase())
        if (!entityId && !exact && visible.length > 1) return error(id, -32602, '匹配到多个实体，请使用 entity_id')
        const entity = exact ?? visible[0]
        if (!entity || !canRead(principal, entity.acl_principals)) return error(id, -32004, '实体不存在或无权访问')
        const facts = await query<FactRow>(
          `SELECT * FROM facts f WHERE f.tenant_id = $1 AND (f.subject_id = $2 OR f.object_id = $2)
             AND f.status IN ('active', 'superseded')
             AND EXISTS (SELECT 1 FROM fact_evidence e JOIN documents d ON d.id = e.doc_id
                         WHERE e.fact_id = f.id AND d.tenant_id = $1 AND d.status = 'active')
           ORDER BY f.valid_from ASC NULLS FIRST, f.recorded_at ASC, f.id`,
          [principal.tenantId, entity.id],
        )
        const timeline = []
        for (const fact of facts) {
          if (canRead(principal, fact.acl_principals) && (!asOf || factIsEffective(fact, asOf))) timeline.push(await factDict(fact))
        }
        return result(id, toolResult({ entity_id: entity.id, entity: entity.canonical_name, as_of: asOf, timeline }))
      }
      if (name === 'kb_add_note') {
        if (typeof args.text !== 'string' || !args.text.trim() || args.tags !== undefined && (!Array.isArray(args.tags) || !args.tags.every(tag=>typeof tag==='string'))) return error(id,-32602,'text或tags格式无效')
        const memoryId = newId('mem')
        await query(
          `INSERT INTO memory_items (id, tenant_id, user_id, scope, kind, text, confidence, tags)
           VALUES ($1, $2, $3, 'personal', 'mcp_note', $4, 0.5, $5::jsonb)`,
          [memoryId, principal.tenantId, principal.userId, args.text.trim(), JSON.stringify(args.tags ?? [])],
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
      return error(id, (err as { statusCode?: number }).statusCode === 400 ? -32602 : -32000, err instanceof Error ? err.message : String(err))
    }
  })
}
