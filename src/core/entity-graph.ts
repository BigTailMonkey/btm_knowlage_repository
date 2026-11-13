import { query } from '../db/index.js'
import { DISPLAYABLE_FACT } from './fact-visibility.js'
import { isEntityName } from './learning.js'
import { relationRef } from './relation-types.js'
import type { EntityRow, FactRow } from './rows.js'
import { canRead, type Principal } from './security.js'

/** 字面值事实在图上不是节点，而是挂在主语身上的属性。 */
export interface GraphAttribute {
  fact_id: string
  predicate: string
  relation: { key: string; label: string }
  value: string
  status: string
  confidence: number
}

export interface GraphNode {
  id: string
  name: string
  type: string
  /** 距离焦点几跳；无焦点时为 0 */
  hop: number
  /** 当前图上入度 + 出度，用于节点大小 */
  degree: number
  attrs: GraphAttribute[]
}

export interface GraphEdge {
  id: string
  source: string
  /** 宾语实体；字面值事实为 null（这类事实只作为属性出现，不画连线） */
  target: string | null
  /** 原文谓语，保留用于溯源和 tooltip */
  predicate: string
  /** 兼容旧字段：与 predicate 相同 */
  label: string
  relation: { key: string; label: string }
  value: string | null
  object_literal: string | null
  status: string
  confidence: number
  hop: number
}

export interface EntityGraph {
  focus: string | null
  hops: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 因上限被截掉的节点与关系条数，前端用来提示「还有 N 条未显示」 */
  hidden: { nodes: number; edges: number }
}

interface NodeState {
  entity: EntityRow
  hop: number
  degree: number
  attrs: GraphAttribute[]
}

export interface GraphOptions {
  /** 全景包含有可见事实的所有实体及关系 */
  overview?: boolean
  /** 焦点实体；为空时退化为全局按置信度取样 */
  focus?: string | null
  /** 以焦点为起点的最大跳数，1 表示只看直接关系 */
  hops?: number
  /** 节点与关系的上限 */
  limit?: number
}

function attributeOf(fact: FactRow): GraphAttribute {
  return {
    fact_id: fact.id,
    predicate: fact.predicate,
    relation: relationRef(fact.predicate),
    value: fact.object_literal ?? '',
    status: fact.status,
    confidence: Number((fact.confidence ?? 0).toFixed(3)),
  }
}

/**
 * 组装实体关系图。
 *
 * 节点只放真实实体：只有身份的实体才占位置，字面值（`object_literal`）作为属性挂在主语上，
 * 不再造 `lit_` 假节点。每条事实按谓语归一出 `relation`，供边标签与图例使用。
 */
export async function buildEntityGraph(principal: Principal, options: GraphOptions = {}): Promise<EntityGraph> {
  const limit = Math.min(300, Math.max(10, options.limit ?? 80))
  const hops = Math.min(3, Math.max(1, options.hops ?? 1))
  const overview = options.overview === true
  const focusId = overview ? null : options.focus ?? null

  const entityCache = new Map<string, EntityRow | null>()
  async function readEntity(id: string): Promise<EntityRow | null> {
    if (!entityCache.has(id)) {
      const row = await query<EntityRow>('SELECT * FROM entities WHERE id = $1 AND tenant_id = $2', [id, principal.tenantId])
      entityCache.set(id, row[0] ?? null)
    }
    return entityCache.get(id) ?? null
  }
  const usable = (entity: EntityRow | null): entity is EntityRow =>
    entity !== null && entity.status !== 'retracted' && isEntityName(entity.canonical_name)
      && canRead(principal, entity.acl_principals)

  const nodes = new Map<string, NodeState>()
  const facts = new Map<string, FactRow>()
  const addNode = (entity: EntityRow, hop: number, next: string[] | null) => {
    if (nodes.has(entity.id)) return
    nodes.set(entity.id, { entity, hop, degree: 0, attrs: [] })
    next?.push(entity.id)
  }

  async function factsTouching(ids: string[]): Promise<FactRow[]> {
    if (!ids.length) return []
    const rows = await query<FactRow>(
      `SELECT f.* FROM facts f WHERE f.tenant_id = $1 AND ${DISPLAYABLE_FACT}
        AND (f.subject_id = ANY($2::text[]) OR f.object_id = ANY($2::text[]))
       ORDER BY f.confidence DESC`,
      [principal.tenantId, ids],
    )
    return rows.filter((row) => canRead(principal, row.acl_principals))
  }

  let focus: EntityRow | null = null
  if (overview) {
    const [entities, rows] = await Promise.all([
      query<EntityRow>("SELECT * FROM entities WHERE tenant_id = $1 AND status <> 'retracted'", [principal.tenantId]),
      query<FactRow>(
        `SELECT f.* FROM facts f WHERE f.tenant_id = $1 AND ${DISPLAYABLE_FACT}
         ORDER BY f.confidence DESC, f.id`,
        [principal.tenantId],
      ),
    ])
    const readable = new Map(entities.filter(usable).map((entity) => [entity.id, entity]))
    for (const fact of rows) {
      if (!canRead(principal, fact.acl_principals)) continue
      const subject = readable.get(fact.subject_id)
      const target = fact.object_id ? readable.get(fact.object_id) : undefined
      if (!subject || (fact.object_id && !target)) continue
      facts.set(fact.id, fact)
      addNode(subject, 0, null)
      if (target) addNode(target, 0, null)
    }
  } else if (focusId) {
    focus = await readEntity(focusId)
    if (!usable(focus)) throw Object.assign(new Error('实体不存在或无权访问'), { statusCode: 404 })
    addNode(focus, 0, null)
    let frontier = [focus.id]
    for (let hop = 1; hop <= hops && frontier.length; hop += 1) {
      const next: string[] = []
      for (const fact of await factsTouching(frontier)) {
        if (facts.has(fact.id)) continue
        const subject = await readEntity(fact.subject_id)
        if (!usable(subject)) continue
        const target = fact.object_id ? await readEntity(fact.object_id) : null
        // 宾语实体不可见或名字不完整时整条事实不上图，避免把噪声实体带进关系图
        if (fact.object_id && !usable(target)) continue
        facts.set(fact.id, fact)
        if (!target) continue
        // 事实的两个端点都可能是在这一跳新发现的（邻域查询是双向的）
        addNode(subject, hop, next)
        addNode(target, hop, next)
      }
      frontier = next
      // 异常稠密的实体不把整张图拖垮
      if (nodes.size > limit * 3) break
    }
  } else {
    // 无焦点：保留原来的全局取样口径，便于脚本与旧客户端继续使用
    const rows = await query<FactRow>(
      `SELECT f.* FROM facts f WHERE f.tenant_id = $1 AND f.status IN ('active', 'disputed') AND ${DISPLAYABLE_FACT}
       ORDER BY confidence DESC LIMIT ${limit * 3}`,
      [principal.tenantId],
    )
    for (const fact of rows) {
      if (facts.size >= limit) break
      if (!canRead(principal, fact.acl_principals)) continue
      const subject = await readEntity(fact.subject_id)
      if (!usable(subject)) continue
      const target = fact.object_id ? await readEntity(fact.object_id) : null
      if (fact.object_id && !usable(target)) continue
      facts.set(fact.id, fact)
      addNode(subject, 0, null)
      if (target) addNode(target, 0, null)
    }
  }

  // 属性：入图实体的字面值事实（含 1 跳以外邻居的属性），单独一轮补齐
  if (!overview && nodes.size) {
    const rows = await query<FactRow>(
      `SELECT f.* FROM facts f WHERE f.tenant_id = $1 AND ${DISPLAYABLE_FACT}
        AND f.object_id IS NULL AND f.subject_id = ANY($2::text[])
       ORDER BY f.confidence DESC`,
      [principal.tenantId, [...nodes.keys()]],
    )
    for (const row of rows) {
      if (!canRead(principal, row.acl_principals)) continue
      if (!facts.has(row.id)) facts.set(row.id, row)
    }
  }

  const edges: GraphEdge[] = []
  for (const fact of facts.values()) {
    const source = nodes.get(fact.subject_id)
    if (!source) continue
    const target = fact.object_id ? nodes.get(fact.object_id) : null
    if (fact.object_id && !target) continue
    if (!target) {
      source.attrs.push(attributeOf(fact))
      continue
    }
    edges.push({
      id: fact.id,
      source: fact.subject_id,
      target: fact.object_id,
      predicate: fact.predicate,
      label: fact.predicate,
      relation: relationRef(fact.predicate),
      value: fact.object_literal,
      object_literal: fact.object_literal,
      status: fact.status,
      confidence: Number((fact.confidence ?? 0).toFixed(3)),
      hop: Math.max(source.hop, target.hop),
    })
  }

  // 度数先按全量算，再据此排优先级后截断，保证截断后仍按真实枢纽度排序
  for (const edge of edges) {
    const source = nodes.get(edge.source)
    const target = edge.target ? nodes.get(edge.target) : null
    if (source) source.degree += 1
    if (target) target.degree += 1
  }

  const focusNodeId = focus?.id ?? null
  const rankedNodes = [...nodes.values()].sort((a, b) => {
    if (a.entity.id === focusNodeId) return -1
    if (b.entity.id === focusNodeId) return 1
    return a.hop - b.hop || b.degree - a.degree || a.entity.canonical_name.localeCompare(b.entity.canonical_name, 'zh')
      || a.entity.id.localeCompare(b.entity.id)
  })
  const selectedNodes = overview ? rankedNodes : rankedNodes.slice(0, limit)
  const keptNodes = new Set(selectedNodes.map((state) => state.entity.id))

  const rankedEdges = edges
    .filter((edge) => keptNodes.has(edge.source) && (!edge.target || keptNodes.has(edge.target)))
    .sort((a, b) => a.hop - b.hop || b.confidence - a.confidence)
  const keptEdges = overview ? rankedEdges : rankedEdges.slice(0, limit)

  const degree = new Map<string, number>()
  for (const edge of keptEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    if (edge.target) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  const serializedNodes: GraphNode[] = selectedNodes
    .map((state) => ({
      id: state.entity.id,
      name: state.entity.canonical_name,
      type: state.entity.type,
      hop: focusNodeId ? state.hop : 0,
      degree: degree.get(state.entity.id) ?? 0,
      attrs: state.attrs.sort((a, b) => b.confidence - a.confidence).slice(0, 12),
    }))

  return {
    focus: focusNodeId,
    hops,
    nodes: serializedNodes,
    edges: keptEdges,
    hidden: {
      nodes: Math.max(0, nodes.size - keptNodes.size),
      edges: Math.max(0, edges.length - keptEdges.length),
    },
  }
}
