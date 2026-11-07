import { settings } from '../config.js'
import { query } from '../db/index.js'
import { todayLocal } from './ids.js'
import { normalizeAsOf } from './retrieval.js'
import { principalSet, type Principal } from './security.js'

const MAX_GRAPH_EDGES = 60

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 })
}

function inputObject(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} 必须为对象`)
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${name} 不支持字段 ${key}`)
  return value as Record<string, unknown>
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 500) invalid(`${name} 必须为非空字符串，最长 500 字符`)
  return value.trim()
}

function optionalList(value: unknown, name: string): string[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || !value.length || value.length > 50) invalid(`${name} 必须包含 1 至 50 项`)
  return [...new Set(value.map((item) => optionalText(item, name) ?? invalid(`${name} 包含空值`)))]
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${name} 必须为 ${min} 至 ${max} 的整数`)
  }
  return value
}

const sourceFields = ['doc_ids', 'source_type', 'as_of'] as const
const structuredFields = ['subject', 'object', 'predicates', 'object_literal', 'valid_from_gte', 'valid_from_lte'] as const

type EntityRef = { id: string; name: string }

type Evidence = {
  doc_id: string
  doc_title: string
  version_id: string
  version: number
  chunk_id: string
  page: number | null
  quote: string
}

interface KnowledgeFact {
  fact_id: string
  subject_id: string
  subject: string
  predicate: string
  object_id: string | null
  object: string | null
  object_literal: string | null
  valid_from: string | null
  valid_to: string | null
  confidence: number
  status: string
  evidence: Evidence[]
}

function sourceScope(principal: Principal, filters: Record<string, unknown>) {
  const asOf = normalizeAsOf(optionalText(filters.as_of, 'as_of'))
  return {
    asOf,
    docIds: optionalList(filters.doc_ids, 'doc_ids'),
    sourceType: optionalText(filters.source_type, 'source_type'),
    tenantId: principal.tenantId,
    principals: [...principalSet(principal)],
    effectiveDate: asOf ?? todayLocal(settings.timezone),
  }
}

type SourceScope = ReturnType<typeof sourceScope>

async function resolveEntity(scope: SourceScope, ref: string): Promise<EntityRef> {
  const matches = await query<EntityRef>(
    `SELECT e.id, e.canonical_name AS name FROM entities e
     WHERE e.tenant_id = $1 AND e.status = 'active'
       AND jsonb_typeof(e.acl_principals) = 'array' AND e.acl_principals ?| $2::text[]
       AND (e.id = $3 OR lower(e.canonical_name) = lower($3) OR e.normalized_name = lower($3)
            OR EXISTS (SELECT 1 FROM entity_aliases a WHERE a.entity_id = e.id AND a.normalized_alias = lower($3)))
     ORDER BY (e.id = $3) DESC, e.id LIMIT 2`,
    [scope.tenantId, scope.principals, ref],
  )
  const first = matches[0]
  if (!first) invalid('实体不存在或无权访问，可先用 kb_search 查找实体')
  if (first.id !== ref && matches.length > 1) invalid('实体名称或别名有多个匹配，请使用实体 ID')
  return first
}

function scopeParams(scope: SourceScope): unknown[] {
  return [scope.tenantId, scope.principals, scope.asOf, scope.effectiveDate, settings.timezone, scope.docIds, scope.sourceType]
}

// All facts must have a visible source in the selected document version. Use the
// same predicate for eligibility and citations, so counts cannot reveal hidden evidence.
function evidenceFrom(factId: 'f.id' | 'm.fact_id' | 'g.sample_fact_id'): string {
  return `FROM fact_evidence e
  JOIN chunks c ON c.id = e.chunk_id AND c.doc_id = e.doc_id AND c.tenant_id = $1
  JOIN documents d ON d.id = c.doc_id AND d.tenant_id = $1 AND d.status = 'active'
  JOIN document_versions v ON v.id = c.version_id AND v.doc_id = d.id AND v.tenant_id = $1
  WHERE e.fact_id = ${factId} AND NOT c.is_parent
    AND jsonb_typeof(d.acl_principals) = 'array' AND d.acl_principals ?| $2::text[]
    AND jsonb_typeof(c.acl_principals) = 'array' AND c.acl_principals ?| $2::text[]
    AND ($6::text[] IS NULL OR d.id = ANY($6))
    AND ($7::text IS NULL OR d.source_type = $7)
    AND CASE WHEN $3::date IS NULL THEN v.version = d.current_version
        ELSE v.id = (SELECT hv.id FROM document_versions hv WHERE hv.doc_id = d.id AND hv.tenant_id = $1
                     AND hv.created_at < (($3::date + interval '1 day') AT TIME ZONE $5)
                     ORDER BY hv.created_at DESC, hv.version DESC, hv.id DESC LIMIT 1) END`
}

const FACT_COLUMNS = `f.id AS fact_id, f.subject_id, s.canonical_name AS subject, f.predicate,
  f.object_id, coalesce(o.canonical_name, f.object_literal) AS object, f.object_literal,
  f.valid_from::text, f.valid_to::text, f.confidence, f.status`

const VISIBLE_FACTS_FROM = `FROM facts f
  JOIN entities s ON s.id = f.subject_id AND s.tenant_id = $1 AND s.status = 'active'
  LEFT JOIN entities o ON o.id = f.object_id AND o.tenant_id = $1 AND o.status = 'active'
  WHERE f.tenant_id = $1 AND (f.status = 'active' OR ($3::date IS NOT NULL AND f.status = 'superseded'))
    AND (f.valid_from IS NULL OR f.valid_from <= $4::date)
    AND (f.valid_to IS NULL OR f.valid_to > $4::date)
    AND jsonb_typeof(f.acl_principals) = 'array' AND f.acl_principals ?| $2::text[]
    AND jsonb_typeof(s.acl_principals) = 'array' AND s.acl_principals ?| $2::text[]
    AND (f.object_id IS NULL OR (jsonb_typeof(o.acl_principals) = 'array' AND o.acl_principals ?| $2::text[]))
    AND EXISTS (SELECT 1 ${evidenceFrom('f.id')})`

function evidenceFor(factId: 'f.id' | 'm.fact_id' | 'g.sample_fact_id'): string {
  return `(SELECT coalesce(jsonb_agg(to_jsonb(citation) ORDER BY citation.doc_id, citation.chunk_id, citation.quote), '[]'::jsonb)
    FROM (SELECT DISTINCT d.id AS doc_id, d.title AS doc_title, v.id AS version_id, v.version,
                 c.id AS chunk_id, c.page, left(e.quote, 500) AS quote
          ${evidenceFrom(factId)}
          ORDER BY doc_id, chunk_id, quote LIMIT 3) citation)`
}

export async function queryKnowledgeGraph(principal: Principal, input: unknown) {
  const args = inputObject(input, '查询参数', ['start', 'target', 'direction', 'predicates', 'hops', 'filters'])
  const { filters: rawFilters = {}, direction = 'both' } = args
  const filters = inputObject(rawFilters, 'filters', sourceFields)
  const scope = sourceScope(principal, filters)
  const startRef = optionalText(args.start, 'start') ?? invalid('需要起点实体 start')
  const targetRef = optionalText(args.target, 'target')
  if (direction !== 'both' && direction !== 'outgoing' && direction !== 'incoming') invalid('direction 无效')
  const predicates = optionalList(args.predicates, 'predicates')
  const hops = integer(args.hops, 'hops', 2, 1, 3)
  const [start, target] = await Promise.all([resolveEntity(scope, startRef), targetRef ? resolveEntity(scope, targetRef) : null])

  const paths = new Map<string, string[]>([[start.id, []]])
  const edges = new Map<string, KnowledgeFact & { hop: number }>()
  let frontier = [start.id]
  let truncated = false
  for (let hop = 1; hop <= hops && frontier.length && !(target && paths.has(target.id)); hop += 1) {
    const remaining = MAX_GRAPH_EDGES - edges.size
    const batch = await query<KnowledgeFact>(
      `SELECT ${FACT_COLUMNS}, ${evidenceFor('f.id')} AS evidence ${VISIBLE_FACTS_FROM}
       AND (($9 <> 'incoming' AND f.subject_id = ANY($8::text[])) OR ($9 <> 'outgoing' AND f.object_id = ANY($8)))
       AND ($10::text[] IS NULL OR f.predicate = ANY($10)) AND f.id <> ALL($11::text[])
       ORDER BY f.confidence DESC, f.id LIMIT $12`,
      [...scopeParams(scope), frontier, direction, predicates, [...edges.keys()], remaining + 1],
    )
    const next: string[] = []
    const origins = new Set(frontier)
    for (const fact of batch.slice(0, remaining)) {
      edges.set(fact.fact_id, { ...fact, hop })
      const forward = direction !== 'incoming' && origins.has(fact.subject_id)
      const origin = forward ? fact.subject_id : fact.object_id
      const destination = forward ? fact.object_id : fact.subject_id
      if (!origin || !destination || paths.has(destination)) continue
      paths.set(destination, [...paths.get(origin)!, fact.fact_id])
      next.push(destination)
    }
    truncated = batch.length > remaining
    if (truncated) break
    frontier = next
  }
  const path = target ? paths.get(target.id)?.map((id) => edges.get(id)!) ?? null : null
  return {
    start, target, direction, predicates, max_hops: hops, as_of: scope.asOf, effective_date: scope.effectiveDate,
    filters: { doc_ids: scope.docIds, source_type: scope.sourceType },
    edges: path ? [] : [...edges.values()], path, truncated,
  }
}

const GROUP_FIELDS = {
  predicate: { key: 'predicate', value: 'predicate' },
  subject: { key: 'subject_id', value: 'min(subject)' },
  object: { key: 'object_id, object', value: 'object' },
  valid_from_month: { key: 'left(valid_from, 7)', value: 'left(valid_from, 7)' },
} as const

export async function queryStructuredFacts(principal: Principal, input: unknown) {
  const args = inputObject(input, '查询参数', ['operation', 'group_by', 'filters', 'limit', 'offset'])
  const { filters: rawFilters = {}, operation = 'list' } = args
  const filters = inputObject(rawFilters, 'filters', [...sourceFields, ...structuredFields])
  const scope = sourceScope(principal, filters)
  if (operation !== 'list' && operation !== 'count') invalid('operation 必须为 list 或 count')
  const groupBy = optionalText(args.group_by, 'group_by')
  if (groupBy && (operation !== 'count' || !Object.hasOwn(GROUP_FIELDS, groupBy))) invalid('仅 count 支持指定的 group_by 字段')
  const group = groupBy as keyof typeof GROUP_FIELDS | null
  const limit = integer(args.limit, 'limit', 20, 1, 50)
  const offset = integer(args.offset, 'offset', 0, 0, 100000)
  if (operation === 'count' && !group && (args.limit !== undefined || args.offset !== undefined)) invalid('无分组的 count 不需要分页')
  const subjectRef = optionalText(filters.subject, 'subject')
  const objectRef = optionalText(filters.object, 'object')
  const predicates = optionalList(filters.predicates, 'predicates')
  const literal = optionalText(filters.object_literal, 'object_literal')
  const from = normalizeAsOf(optionalText(filters.valid_from_gte, 'valid_from_gte'))
  const to = normalizeAsOf(optionalText(filters.valid_from_lte, 'valid_from_lte'))
  if (from && to && from > to) invalid('valid_from 日期范围无效')
  const [subject, object] = await Promise.all([resolveOptional(subjectRef), resolveOptional(objectRef)])
  function resolveOptional(ref: string | null) { return ref ? resolveEntity(scope, ref) : null }

  const matched = `WITH matched AS (SELECT ${FACT_COLUMNS} ${VISIBLE_FACTS_FROM}
    AND ($8::text IS NULL OR f.subject_id = $8) AND ($9::text IS NULL OR f.object_id = $9)
    AND ($10::text[] IS NULL OR f.predicate = ANY($10)) AND ($11::text IS NULL OR f.object_literal = $11)
    AND ($12::date IS NULL OR f.valid_from >= $12) AND ($13::date IS NULL OR f.valid_from <= $13))`
  const params = [...scopeParams(scope), subject?.id ?? null, object?.id ?? null, predicates, literal, from, to]
  const context = {
    operation, as_of: scope.asOf, effective_date: scope.effectiveDate,
    scope: '用户可见、所选日期有效且有可见原文支持的结构化事实记录',
    filters: {
      doc_ids: scope.docIds, source_type: scope.sourceType, subject, object,
      predicates, object_literal: literal, valid_from_gte: from, valid_from_lte: to,
    },
  }
  if (group) {
    const { key, value } = GROUP_FIELDS[group]
    const entityId = group === 'subject' ? 'm.subject_id' : group === 'object' ? 'm.object_id' : 'NULL::text'
    const [result] = await query<{ total: number; total_groups: number; groups: unknown[] }>(
      `${matched}, grouped AS (SELECT ${value} AS value, min(fact_id) AS sample_fact_id,
               count(*)::int AS count FROM matched GROUP BY ${key}),
       page AS (SELECT g.value, g.count, ${entityId} AS entity_id, g.sample_fact_id, ${evidenceFor('g.sample_fact_id')} AS sample_evidence
                FROM grouped g JOIN matched m ON m.fact_id = g.sample_fact_id
                ORDER BY g.count DESC, g.value NULLS LAST, g.sample_fact_id LIMIT $14 OFFSET $15)
       SELECT (SELECT count(*)::int FROM matched) AS total, (SELECT count(*)::int FROM grouped) AS total_groups,
              coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY count DESC, value NULLS LAST, sample_fact_id) FROM page), '[]'::jsonb) AS groups`,
      [...params, limit, offset],
    )
    return { ...context, group_by: group, limit, offset, ...result!, has_more: offset + limit < result!.total_groups }
  }

  const [result] = await query<{ total: number; rows: KnowledgeFact[] }>(
    `${matched}, page AS (SELECT m.*, ${evidenceFor('m.fact_id')} AS evidence FROM matched m
       ORDER BY m.valid_from DESC NULLS LAST, m.fact_id LIMIT $14 OFFSET $15)
     SELECT (SELECT count(*)::int FROM matched) AS total,
            coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY valid_from DESC NULLS LAST, fact_id) FROM page), '[]'::jsonb) AS rows`,
    [...params, operation === 'count' ? 1 : limit, offset],
  )
  return operation === 'count'
    ? { ...context, total: result!.total, samples: result!.rows }
    : { ...context, limit, offset, ...result!, has_more: offset + limit < result!.total }
}
