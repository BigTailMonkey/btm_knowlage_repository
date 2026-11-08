import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { ask } from '../../core/answering.js'
import { factIsEffective, normalizeAsOf, retrieve } from '../../core/retrieval.js'
import { factDict } from '../../core/serializers.js'
import { canRead } from '../../core/security.js'
import { newId } from '../../core/ids.js'
import { queryKnowledgeGraph, queryStructuredFacts } from '../../core/knowledge-query.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from '../../core/rows.js'

const NATIVE_READ_TOOLS = new Set(['kb_search', 'kb_graph', 'kb_query_facts', 'kb_get_document', 'kb_entity_timeline'])

const sourceFilters = {
  doc_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
  source_type: { type: 'string' },
  as_of: { type: 'string', format: 'date' },
}
const predicates = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }

const TOOLS = [
  {
    name: 'kb_search',
    description: '按自然语言检索知识库，融合语义向量、关键词和图谱证据，返回原文、可见实体和事实。找概念、术语、原文或实体 ID 时使用。graph 模式可做多跳扩展；需要确认两实体之间的具体路径时用 kb_graph。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'integer', minimum: 1, maximum: 100, default: 8 },
        mode: { type: 'string', enum: ['quick', 'graph'], default: 'quick' },
        graph_hops: { type: 'integer', minimum: 1, maximum: 3 },
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
    name: 'kb_graph',
    description: '沿知识图谱查看实体的依赖、归属、关联和影响链。起点、终点可用实体 ID、准确名称或别名；支持方向、谓词、1 至 3 跳和来源过滤。每条边含原文引用。指定终点时返回查到的路径；结果截断时不能断言路径不存在。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        start: { type: 'string' },
        target: { type: 'string' },
        direction: { type: 'string', enum: ['both', 'outgoing', 'incoming'], default: 'both' },
        predicates,
        hops: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
        filters: { type: 'object', additionalProperties: false, properties: sourceFilters },
      },
      required: ['start'],
    },
  },
  {
    name: 'kb_query_facts',
    description: '对可见、在所选日期有效且有可见原文支持的结构化事实做精确筛选、计数或分组。适用于多少条、按关系/实体分组、按生效月份统计。total 是分页前的事实记录总数，引用样例只展示部分出处。普通文档和表格请用 kb_search 查原文。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['list', 'count'], default: 'list' },
        group_by: { type: 'string', enum: ['predicate', 'subject', 'object', 'valid_from_month'], description: '仅 count 支持' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '仅用于列表或分组分页' },
        offset: { type: 'integer', minimum: 0, maximum: 100000, description: '仅用于列表或分组分页' },
        filters: {
          type: 'object', additionalProperties: false,
          properties: {
            ...sourceFilters,
            subject: { type: 'string', description: '实体 ID、准确名称或别名' },
            object: { type: 'string', description: '实体 ID、准确名称或别名' },
            object_literal: { type: 'string', description: '精确匹配文本值' },
            predicates,
            valid_from_gte: { type: 'string', format: 'date' },
            valid_from_lte: { type: 'string', format: 'date' },
          },
        },
      },
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
    description: '核对可见文档的原文、结构和事实。带上证据的 version_id 可读取对应历史版本，默认读取当前版本。',
    inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, version_id: { type: 'string' } }, required: ['doc_id'] },
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

function previewCitation(_key: string, value: unknown) {
  if (!value || typeof value !== 'object' || !('doc_id' in value) || !('version_id' in value)) return value
  const ids = [value.doc_id, value.version_id]
  if ('chunk_id' in value && value.chunk_id != null) ids.push(value.chunk_id)
  if (!ids.every((id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id))) return value
  return { ...value, preview_url: `https://citation.knowweave.invalid/${ids.join('/')}` }
}

function toolResult(payload: unknown, native = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, native ? previewCitation : undefined) }], isError: false }
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', { preHandler: authenticate }, async (request, reply) => {
    const principal = currentPrincipal(request)
    const payload = request.body as {
      jsonrpc?: string
      id?: string | number | null
      method: string
      params?: Record<string, unknown>
    }
    const native = request.headers['x-knowweave-native'] === 'true'
    if (payload.method.startsWith('notifications/')) return reply.status(202).send()
    const id = payload.id ?? null
    if (payload.method === 'initialize') {
      return result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'knowweave', version: '0.1.0' },
      })
    }
    if (payload.method === 'tools/list') {
      const tools = native ? TOOLS.filter((tool) => NATIVE_READ_TOOLS.has(tool.name)).map((tool) => ({
        ...tool,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      })) : TOOLS
      return result(id, { tools })
    }
    if (payload.method === 'ping') return result(id, {})
    if (payload.method !== 'tools/call') return error(id, -32601, `method not found: ${payload.method}`)

    const params = payload.params ?? {}
    const name = params.name as string
    if (native && !NATIVE_READ_TOOLS.has(name)) return error(id, -32601, '原生知识库对话仅提供只读检索工具')
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
        if (args.mode !== undefined && args.mode !== 'quick' && args.mode !== 'graph') return error(id, -32602, 'mode 必须为 quick 或 graph')
        const graphHops = args.graph_hops
        if (graphHops !== undefined && (typeof graphHops !== 'number' || !Number.isInteger(graphHops) || graphHops < 1 || graphHops > 3)) {
          return error(id, -32602, 'graph_hops 必须为 1 至 3 的整数')
        }
        const retrieved = await retrieve(principal, String(args.query ?? ''), {
          topK: Number(args.top_k ?? 8),
          docIds: (filters.doc_ids as string[] | undefined) ?? null,
          sourceType: typeof filters.source_type === 'string' ? filters.source_type : null,
          asOf: typeof filters.as_of === 'string' ? filters.as_of : null,
          mode: args.mode as 'quick' | 'graph' | undefined,
          graphHops,
        })
        return result(id, toolResult({
          hits: retrieved.hits.map((hit) => hit.toDict()),
          facts: retrieved.facts,
          entities: retrieved.entities.map((entity) => ({ id: entity.id, name: entity.canonical_name, type: entity.type })),
          summaries: retrieved.summaries ?? [],
          as_of: retrieved.asOf,
          stats: retrieved.stats,
        }, native))
      }
      if (name === 'kb_graph') return result(id, toolResult(await queryKnowledgeGraph(principal, args), native))
      if (name === 'kb_query_facts') return result(id, toolResult(await queryStructuredFacts(principal, args), native))
      if (name === 'kb_ask') {
        return result(id, toolResult(await ask(principal, {
          question: String(args.question ?? ''),
          mode: args.mode as string | undefined,
          asOf: (args.as_of as string) ?? null,
        })))
      }
      if (name === 'kb_get_document') {
        const docId = String(args.doc_id ?? '')
        const versionId = args.version_id
        if (versionId !== undefined && (typeof versionId !== 'string' || !versionId.trim())) return error(id, -32602, 'version_id 必须为非空字符串')
        const document = await queryOne<DocumentRow>("SELECT * FROM documents WHERE id = $1 AND status = 'active'", [docId])
        if (!document || document.tenant_id !== principal.tenantId || !canRead(principal, document.acl_principals)) {
          return error(id, -32004, '文档不存在或无权访问')
        }
        const version = await queryOne<VersionRow>(
          `SELECT * FROM document_versions WHERE doc_id = $1 AND tenant_id = $2
             AND CASE WHEN $3::text IS NULL THEN version = $4 ELSE id = $3 END`,
          [docId, principal.tenantId, versionId ?? null, document.current_version],
        )
        if (versionId && !version) return error(id, -32004, '文档版本不存在或无权访问')
        const chunks = await query<Pick<ChunkRow, 'id' | 'text' | 'heading_path' | 'page' | 'bbox' | 'block_type' | 'version_id' | 'acl_principals'>>(
          `SELECT id, text, heading_path, page, bbox, block_type, version_id, acl_principals
           FROM chunks WHERE doc_id = $1 AND is_parent = false AND version_id = $2 AND tenant_id = $3
           ORDER BY seq`,
          [docId, version?.id ?? null, principal.tenantId],
        )
        const visibleChunks = chunks.filter((chunk) => canRead(principal, chunk.acl_principals))
        const visibleIds = new Set(visibleChunks.map((chunk) => chunk.id))
        const partial = visibleChunks.length !== chunks.length
        const facts = await query<FactRow>(
          `SELECT DISTINCT f.* FROM facts f JOIN fact_evidence e ON e.fact_id = f.id
           JOIN chunks c ON c.id = e.chunk_id
           WHERE e.doc_id = $1 AND c.version_id = $2 AND f.tenant_id = $3 AND c.id = ANY($4::text[])`,
          [docId, version?.id ?? '', principal.tenantId, [...visibleIds]],
        )
        const visibleFacts = facts.filter((fact) => canRead(principal, fact.acl_principals) && factIsEffective(fact, null))
        const scopedFacts = await Promise.all(visibleFacts.map(async (fact) => {
          const data = await factDict(fact)
          const evidence = (data.evidence as Array<{ doc_id: string; chunk_id: string }>).filter((item) => item.doc_id === docId && visibleIds.has(item.chunk_id))
          return { ...data, evidence }
        }))
        return result(id, toolResult({
          ...(native && version ? { doc_id: docId, version_id: version.id } : {}),
          document,
          text: partial ? '' : version?.text ?? '',
          partial,
          version: version ? { id: version.id, version: version.version, parser: version.parser, created_at: version.created_at, meta: version.meta } : null,
          chunks: visibleChunks.map(({ acl_principals, ...chunk }) => chunk),
          facts: scopedFacts,
        }, native))
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
