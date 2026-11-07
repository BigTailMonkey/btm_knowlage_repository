import { settings } from '../config.js'
import { semanticRerank } from '../adapters/reranking/index.js'
import { query, queryOne } from '../db/index.js'
import { cosine, embedder, keywordOverlap, sparseDot, tokenize } from '../adapters/embeddings/index.js'
import type { ChunkRow, DocumentRow, EntityRow } from './rows.js'
import { canRead, Principal, principalSet } from './security.js'
import type { TraceRecorder } from './tracing.js'
import { todayLocal } from './ids.js'

const RRF_K = 60

type RetrievalDocument = DocumentRow & { selected_version?: number }

/** Historical queries use calendar dates in the configured workspace timezone. */
export function normalizeAsOf(value?: string | null): string | null {
  if (!value) return null
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw Object.assign(new Error('as_of 必须为 YYYY-MM-DD 日期'), { statusCode: 400 })
  }
  const parsed = new Date(`${normalized}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw Object.assign(new Error('as_of 日期无效'), { statusCode: 400 })
  }
  return normalized
}

function dateValue(value: string | Date | null): string | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value?.slice(0, 10) ?? null
}

export function factIsEffective(
  fact: { status: string; valid_from: string | Date | null; valid_to: string | Date | null },
  asOf: string | null,
): boolean {
  if (!['active', ...(asOf ? ['superseded'] : [])].includes(fact.status)) return false
  const date = asOf ?? todayLocal(settings.timezone)
  const from = dateValue(fact.valid_from)
  const to = dateValue(fact.valid_to)
  return (!from || from <= date) && (!to || to > date)
}

function snippet(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

export class Hit {
  constructor(
    readonly chunk: ChunkRow,
    readonly document: RetrievalDocument,
    readonly dense: number,
    readonly sparse: number,
    readonly rrf: number,
    readonly rerank: number,
    readonly coverage: number,
    readonly source: string,
    public parentText = '',
  ) {}

  toDict(): Record<string, unknown> {
    return {
      chunk_id: this.chunk.id,
      doc_id: this.document.id,
      doc_title: this.document.title,
      version_id: this.chunk.version_id,
      version: this.document.selected_version ?? this.document.current_version,
      text: this.chunk.text,
      quote: snippet(this.chunk.text),
      context: this.parentText || this.chunk.text,
      heading_path: this.chunk.heading_path,
      page: this.chunk.page,
      bbox: this.chunk.bbox,
      block_type: this.chunk.block_type,
      scores: {
        dense: Number(this.dense.toFixed(4)),
        sparse: Number(this.sparse.toFixed(4)),
        rrf: Number(this.rrf.toFixed(4)),
        rerank: Number(this.rerank.toFixed(4)),
      },
      acl_version: this.chunk.acl_version,
      source: this.source,
    }
  }
}

export interface RetrievalResult {
  summaries?: Array<{ text: string; evidence_ids: string[] }>
  hits: Hit[]
  facts: Array<Record<string, unknown>>
  entities: EntityRow[]
  stats: Record<string, unknown>
  rejectedCandidates: number
  query: string
  asOf: string | null
}

async function loadCandidates(tenantId: string, asOf: string | null): Promise<Array<[ChunkRow, RetrievalDocument]>> {
  const versionFilter = asOf
    ? `v.id = (SELECT historical.id FROM document_versions historical
               WHERE historical.doc_id = d.id
                 AND historical.created_at < (($2::date + interval '1 day') AT TIME ZONE $3)
               ORDER BY historical.created_at DESC, historical.version DESC LIMIT 1)`
    : 'v.version = d.current_version'
  const rows = await query<{ chunk: ChunkRow; document: RetrievalDocument }>(
    `SELECT to_jsonb(c) AS chunk,
            to_jsonb(d) || jsonb_build_object('selected_version', v.version) AS document
     FROM chunks c
     JOIN documents d ON c.doc_id = d.id
     JOIN document_versions v ON c.version_id = v.id
     WHERE d.tenant_id = $1 AND d.status = 'active'
       AND ${versionFilter} AND c.is_parent = false`,
    asOf ? [tenantId, asOf, settings.timezone] : [tenantId],
  )
  return rows.map((row) => [row.chunk, row.document])
}

function rrf(rankedLists: string[][]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranked of rankedLists) {
    ranked.forEach((chunkId, index) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  return scores
}

export async function linkEntities(principal: Principal, text: string): Promise<EntityRow[]> {
  const entities = await query<EntityRow>(
    "SELECT * FROM entities WHERE tenant_id = $1 AND status = 'active'",
    [principal.tenantId],
  )
  const visible = entities.filter((entity) => canRead(principal, entity.acl_principals))
  const aliases = await query<{ entity_id: string; normalized_alias: string }>(
    'SELECT entity_id, normalized_alias FROM entity_aliases',
  )
  const aliasMap = new Map(aliases.map((alias) => [alias.normalized_alias, alias.entity_id]))
  const normalizedQuery = text.toLowerCase().replace(/\s+/g, '')
  const matched: EntityRow[] = []
  for (const entity of visible) {
    const names = new Set([entity.normalized_name.toLowerCase(), entity.canonical_name.toLowerCase()])
    for (const [key, entityId] of aliasMap) if (entityId === entity.id) names.add(key.toLowerCase())
    if (normalizedQuery && [...names].some((name) => {
      const normalizedName = name.replace(/\s+/g, '')
      return normalizedName && (normalizedQuery.includes(normalizedName) || normalizedName.includes(normalizedQuery))
    })) {
      matched.push(entity)
    }
  }
  const queryTokens = new Set(tokenize(text))
  for (const entity of visible) {
    if (matched.includes(entity)) continue
    const nameTokens = new Set(tokenize(entity.canonical_name))
    if (!nameTokens.size) continue
    let hit = 0
    for (const token of nameTokens) if (queryTokens.has(token)) hit += 1
    if (hit / nameTokens.size >= 0.6) matched.push(entity)
  }
  return matched.slice(0, 5)
}

export async function factsForEntities(
  principal: Principal,
  entities: EntityRow[],
  asOf: string | null = null,
  allowedChunkIds?: Set<string>,
): Promise<Array<Record<string, unknown>>> {
  if (!entities.length) return []
  const entityIds = entities.map((entity) => entity.id)
  const facts = await query<{
    id: string
    subject_id: string
    object_id: string | null
    predicate: string
    object_literal: string | null
    valid_from: string | null
    valid_to: string | null
    confidence: number
    status: string
    acl_principals: string[]
  }>(
    `SELECT id, subject_id, object_id, predicate, object_literal, valid_from, valid_to,
            confidence, status, acl_principals
     FROM facts WHERE tenant_id = $1 AND (subject_id = ANY($2) OR object_id = ANY($2))`,
    [principal.tenantId, entityIds],
  )
  const output: Array<Record<string, unknown>> = []
  for (const fact of facts) {
    if (!canRead(principal, fact.acl_principals)) continue
    if (!factIsEffective(fact, asOf)) continue
    const subject = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.subject_id])
    const object = fact.object_id
      ? await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.object_id])
      : null
    if (!subject || subject.tenant_id !== principal.tenantId || !canRead(principal, subject.acl_principals)) continue
    if (fact.object_id && (!object || object.tenant_id !== principal.tenantId || !canRead(principal, object.acl_principals))) continue
    const evidence = await query<{ chunk_id: string | null }>(
      `SELECT e.chunk_id FROM fact_evidence e
       JOIN documents d ON d.id = e.doc_id
       WHERE e.fact_id = $1 AND d.tenant_id = $2 AND d.status = 'active'`,
      [fact.id, principal.tenantId],
    )
    const chunkIds = evidence.map((row) => row.chunk_id)
      .filter((id): id is string => Boolean(id) && (!allowedChunkIds || allowedChunkIds.has(id!)))
    if (!chunkIds.length) continue
    output.push({
      fact_id: fact.id,
      subject_id: fact.subject_id,
      object_id: fact.object_id,
      subject: subject?.canonical_name ?? fact.subject_id,
      predicate: fact.predicate,
      object: object?.canonical_name ?? fact.object_literal,
      valid_from: dateValue(fact.valid_from),
      valid_to: dateValue(fact.valid_to),
      confidence: fact.confidence,
      status: fact.status,
      evidence_chunk_ids: chunkIds,
    })
  }
  return output
}

export interface RetrievalOptions {
  topK?: number
  docIds?: string[] | null
  sourceType?: string | null
  asOf?: string | null
  recorder?: TraceRecorder | null
  mode?: string
  graphHops?: number
}

export async function retrieve(
  principal: Principal,
  text: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const started = Date.now()
  text = text.trim()
  if (!text) throw Object.assign(new Error('query 不能为空'), { statusCode: 400 })
  const topK = Math.max(1, Math.min(100, Math.floor(Number(options.topK) || 8)))
  const mode = options.mode ?? 'quick'
  const asOf = normalizeAsOf(options.asOf)
  const graphHops = Math.max(1, Math.min(3, Math.floor(Number(options.graphHops) || (mode === 'graph' ? 2 : 1))))
  let candidates = await loadCandidates(principal.tenantId, asOf)
  if (options.docIds?.length) {
    const allowed = new Set(options.docIds)
    candidates = candidates.filter((pair) => allowed.has(pair[1].id))
  }
  if (options.sourceType) candidates = candidates.filter((pair) => pair[1].source_type === options.sourceType)

  let visible = candidates.filter(([chunk, document]) => canRead(principal, document.acl_principals) && canRead(principal, chunk.acl_principals))
  const rejected = candidates.length - visible.length
  options.recorder?.addSpan({
    stage: 'acl.filter',
    params: { tenant_id: principal.tenantId, principals: [...principalSet(principal)].sort() },
    output: { in: candidates.length, visible: visible.length, rejected },
    latencyMs: 1,
  })
  // An exact cited document title is an explicit source scope, not a weak keyword.
  const titles = new Set([...text.matchAll(/《([^》]+)》/g)].map(match=>match[1]!.trim().normalize('NFKC').toLowerCase()))
  const scoped = visible.filter(([,document])=>titles.has(document.title.trim().normalize('NFKC').toLowerCase()))
  if (scoped.length) {
    options.recorder?.addSpan({stage:'source.scope',output:{before:visible.length,after:scoped.length,document_ids:[...new Set(scoped.map(([,document])=>document.id))]}})
    visible=scoped
  }
  if (!visible.length) {
    return {
      hits: [],
      facts: [],
      entities: [],
      stats: { candidates: 0, visible: 0, rejected },
      rejectedCandidates: rejected,
      query: text,
      asOf,
    }
  }

  const queryVec = await embedder.embedQuery(text)
  const queryTokens = tokenize(text)

  let t0 = Date.now()
  const denseScores: Array<[string, number]> = visible.map(([chunk]) => [chunk.id, cosine(queryVec.dense, chunk.dense ?? [])])
  denseScores.sort((a, b) => b[1] - a[1])
  const denseRanked = denseScores.filter(([, score]) => score > 0.02).slice(0, 50).map(([id]) => id)
  options.recorder?.addSpan({
    stage: 'recall.dense',
    params: { top: 50, model: embedder.model },
    output: { kept: denseRanked.length, best: denseScores[0] ? Number(denseScores[0][1].toFixed(4)) : 0 },
    latencyMs: Date.now() - t0,
  })

  t0 = Date.now()
  const sparseScores: Array<[string, number]> = visible.map(([chunk]) => [
    chunk.id,
    sparseDot(queryVec.sparse, chunk.sparse ?? {}),
  ])
  sparseScores.sort((a, b) => b[1] - a[1])
  const sparseRanked = sparseScores.filter(([, score]) => score > 0).slice(0, 50).map(([id]) => id)
  options.recorder?.addSpan({
    stage: 'recall.sparse',
    params: { top: 50 },
    output: { kept: sparseRanked.length, best: sparseScores[0] ? Number(sparseScores[0][1].toFixed(4)) : 0 },
    latencyMs: Date.now() - t0,
  })

  t0 = Date.now()
  const entities = await linkEntities(principal, text)
  const visibleChunkIds = new Set(visible.map(([chunk]) => chunk.id))
  const facts: Array<Record<string, unknown>> = []
  const visitedEntities = new Set(entities.map((entity) => entity.id))
  const visitedFacts = new Set<string>()
  let frontier = entities
  let traversedHops = 0
  for (let hop = 0; hop < graphHops && frontier.length; hop += 1) {
    traversedHops += 1
    const connected = await factsForEntities(principal, frontier, asOf, visibleChunkIds)
    const nextIds = new Set<string>()
    for (const fact of connected) {
      const factId = String(fact.fact_id)
      if (!visitedFacts.has(factId) && facts.length < 200) {
        visitedFacts.add(factId)
        facts.push(fact)
      }
      for (const id of [fact.subject_id, fact.object_id]) {
        if (typeof id === 'string' && !visitedEntities.has(id) && visitedEntities.size + nextIds.size < 100) nextIds.add(id)
      }
    }
    if (!nextIds.size || facts.length >= 200) break
    const nextEntities = await query<EntityRow>(
      "SELECT * FROM entities WHERE tenant_id = $1 AND id = ANY($2) AND status = 'active'",
      [principal.tenantId, [...nextIds]],
    )
    frontier = nextEntities.filter((entity) => canRead(principal, entity.acl_principals))
    for (const entity of frontier) visitedEntities.add(entity.id)
  }
  const graphChunkIds: string[] = []
  for (const fact of facts) {
    for (const chunkId of fact.evidence_chunk_ids as string[]) {
      if (!graphChunkIds.includes(chunkId)) graphChunkIds.push(chunkId)
    }
  }
  options.recorder?.addSpan({
    stage: 'recall.graph',
    params: { entities: entities.map((entity) => entity.canonical_name), max_hops: graphHops },
    output: { facts: facts.length, chunks: graphChunkIds.length, traversed_hops: traversedHops },
    latencyMs: Date.now() - t0,
  })

  t0 = Date.now()
  const fused = rrf([denseRanked, sparseRanked, graphChunkIds])
  options.recorder?.addSpan({
    stage: 'rank.rrf',
    params: { k: RRF_K },
    output: { candidates: fused.size },
    latencyMs: Date.now() - t0,
  })

  const byId = new Map(visible.map(([chunk, document]) => [chunk.id, { chunk, document }]))
  const denseMap = new Map(denseScores)
  const sparseMap = new Map(sparseScores)
  const graphSet = new Set(graphChunkIds)
  const maxSparse = Math.max(1, ...sparseScores.map(([, value]) => value))

  t0 = Date.now()
  let reranked: Hit[] = []
  for (const [chunkId, rrfScore] of [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(30, topK))) {
    const pair = byId.get(chunkId)
    if (!pair) continue
    const { chunk, document } = pair
    const dense = Math.max(0, denseMap.get(chunkId) ?? 0)
    const sparse = Math.max(0, sparseMap.get(chunkId) ?? 0)
    const sparseNorm = maxSparse ? Math.min(1, sparse / maxSparse) : 0
    const coverage = keywordOverlap(queryTokens, chunk.text)
    const headingHit = keywordOverlap(queryTokens, `${(chunk.heading_path ?? []).join(' ')} ${document.title}`)
    const phraseBonus = chunk.text.toLowerCase().includes(text.toLowerCase()) ? 0.08 : 0
    const graphBonus = graphSet.has(chunkId) ? 0.07 : 0
    const score = Math.max(0, Math.min(1,
      0.40 * dense +
      0.20 * sparseNorm +
      0.24 * coverage +
      0.06 * headingHit +
      phraseBonus +
      graphBonus +
      Math.max(-0.05, Math.min(0.05, ((chunk.weight ?? 1) - 1) * 0.05))))
    reranked.push(
      new Hit(chunk, document, dense, sparseNorm, rrfScore, Number(score.toFixed(4)), coverage, graphSet.has(chunkId) ? 'graph' : 'chunk'),
    )
  }
  const semantic = await semanticRerank(text, reranked.map((hit) => hit.chunk.text))
  if (semantic) reranked = reranked.map((hit, index) => new Hit(hit.chunk, hit.document, hit.dense, hit.sparse, hit.rrf,
    Math.max(0, Math.min(1, semantic[index]! + Math.max(-0.05, Math.min(0.05, (hit.chunk.weight - 1) * 0.05)))), hit.coverage, hit.source))
  reranked.sort((a, b) => b.rerank - a.rerank)
  options.recorder?.addSpan({
    stage: 'rank.rerank',
    params: { candidates: reranked.length, threshold: settings.rerankThreshold, algorithm: semantic ? settings.rerankModel || 'semantic-service' : 'heuristic' },
    output: { top: reranked.slice(0, 5).map((hit) => ({ chunk_id: hit.chunk.id, score: hit.rerank })) },
    latencyMs: Date.now() - t0,
  })

  const final = reranked.slice(0, topK)
  const selected = new Set(final.map((hit) => hit.chunk.id))
  const summaries = mode === 'graph' && !asOf ? (await query<{ text: string; evidence_ids: string[]; acl_principals: string[] }>(
    "SELECT text,evidence_ids,acl_principals FROM knowledge_summaries WHERE tenant_id=$1 AND kind='community' ORDER BY updated_at DESC LIMIT 30", [principal.tenantId]))
    .filter((row) => canRead(principal, row.acl_principals) && row.evidence_ids.length > 0 && row.evidence_ids.every((id) => selected.has(id))).slice(0, 3) : []
  for (const hit of final) {
    if (hit.chunk.parent_id) {
      const parent = await queryOne<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [hit.chunk.parent_id])
      if (parent && parent.doc_id === hit.chunk.doc_id && parent.version_id === hit.chunk.version_id
        && parent.tenant_id === principal.tenantId && canRead(principal, parent.acl_principals)) hit.parentText = parent.text
    }
  }
  return {
    hits: final,
    summaries,
    facts,
    entities,
    stats: {
      candidates: candidates.length,
      visible: visible.length,
      rejected,
      dense: denseRanked.length,
      sparse: sparseRanked.length,
      graph_chunks: graphChunkIds.length,
      graph_hops: traversedHops,
      fused: fused.size,
      reranked: reranked.length,
      top_score: final[0]?.rerank ?? 0,
      mode,
      latency_ms: Date.now() - started,
    },
    rejectedCandidates: rejected,
    query: text,
    asOf,
  }
}
