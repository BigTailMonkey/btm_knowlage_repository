import { settings } from '../config.js'
import { query, queryOne } from '../db/index.js'
import { cosine, embedder, keywordOverlap, sparseDot, tokenize } from '../adapters/embeddings/index.js'
import type { ChunkRow, DocumentRow, EntityRow } from './rows.js'
import { canRead, Principal, principalSet } from './security.js'
import type { TraceRecorder } from './tracing.js'

const RRF_K = 60

function snippet(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

export class Hit {
  constructor(
    readonly chunk: ChunkRow,
    readonly document: DocumentRow,
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
      text: this.chunk.text,
      quote: snippet(this.chunk.text),
      context: this.parentText || this.chunk.text,
      heading_path: this.chunk.heading_path,
      page: this.chunk.page,
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
  hits: Hit[]
  facts: Array<Record<string, unknown>>
  entities: EntityRow[]
  stats: Record<string, unknown>
  rejectedCandidates: number
  query: string
  asOf: string | null
}

async function loadCandidates(tenantId: string): Promise<Array<[ChunkRow, DocumentRow]>> {
  const rows = await query<{ chunk: ChunkRow; document: DocumentRow }>(
    `SELECT to_jsonb(c) AS chunk, to_jsonb(d) AS document
     FROM chunks c
     JOIN documents d ON c.doc_id = d.id
     JOIN document_versions v ON c.version_id = v.id
     WHERE d.tenant_id = $1 AND d.status = 'active'
       AND v.version = d.current_version AND c.is_parent = false`,
    [tenantId],
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
    'SELECT * FROM entities WHERE tenant_id = $1',
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
    if ([...names].some((name) => name && name.replace(/\s+/g, '').includes(normalizedQuery))) {
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
    if (asOf) {
      if (fact.valid_from && String(fact.valid_from).slice(0, 10) > asOf) continue
      if (fact.valid_to && String(fact.valid_to).slice(0, 10) <= asOf) continue
    }
    const subject = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.subject_id])
    const object = fact.object_id
      ? await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.object_id])
      : null
    const evidence = await query<{ chunk_id: string | null }>(
      'SELECT chunk_id FROM fact_evidence WHERE fact_id = $1',
      [fact.id],
    )
    output.push({
      fact_id: fact.id,
      subject: subject?.canonical_name ?? fact.subject_id,
      predicate: fact.predicate,
      object: object?.canonical_name ?? fact.object_literal,
      valid_from: fact.valid_from ? String(fact.valid_from).slice(0, 10) : null,
      valid_to: fact.valid_to ? String(fact.valid_to).slice(0, 10) : null,
      confidence: fact.confidence,
      status: fact.status,
      evidence_chunk_ids: evidence.map((row) => row.chunk_id).filter(Boolean),
    })
  }
  return output
}

export async function retrieve(
  principal: Principal,
  text: string,
  options: {
    topK?: number
    docIds?: string[] | null
    sourceType?: string | null
    asOf?: string | null
    recorder?: TraceRecorder | null
    mode?: string
  } = {},
): Promise<RetrievalResult> {
  const started = Date.now()
  const topK = options.topK ?? 8
  const mode = options.mode ?? 'quick'
  let candidates = await loadCandidates(principal.tenantId)
  if (options.docIds?.length) {
    const allowed = new Set(options.docIds)
    candidates = candidates.filter((pair) => allowed.has(pair[1].id))
  }
  if (options.sourceType) candidates = candidates.filter((pair) => pair[1].source_type === options.sourceType)

  const visible = candidates.filter((pair) => canRead(principal, pair[0].acl_principals))
  const rejected = candidates.length - visible.length
  options.recorder?.addSpan({
    stage: 'acl.filter',
    params: { tenant_id: principal.tenantId, principals: [...principalSet(principal)].sort() },
    output: { in: candidates.length, visible: visible.length, rejected },
    latencyMs: 1,
  })
  if (!visible.length) {
    return {
      hits: [],
      facts: [],
      entities: [],
      stats: { candidates: 0, visible: 0, rejected },
      rejectedCandidates: rejected,
      query: text,
      asOf: options.asOf ?? null,
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
  const facts = await factsForEntities(principal, entities, options.asOf ?? null)
  const graphChunkIds: string[] = []
  for (const fact of facts) {
    for (const chunkId of fact.evidence_chunk_ids as string[]) {
      if (!graphChunkIds.includes(chunkId)) graphChunkIds.push(chunkId)
    }
  }
  options.recorder?.addSpan({
    stage: 'recall.graph',
    params: { entities: entities.map((entity) => entity.canonical_name) },
    output: { facts: facts.length, chunks: graphChunkIds.length },
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
  const reranked: Hit[] = []
  for (const [chunkId, rrfScore] of [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    const pair = byId.get(chunkId)
    if (!pair) continue
    const { chunk, document } = pair
    const dense = Math.max(0, denseMap.get(chunkId) ?? 0)
    const sparse = Math.max(0, sparseMap.get(chunkId) ?? 0)
    const sparseNorm = maxSparse ? Math.min(1, sparse / maxSparse) : 0
    const coverage = keywordOverlap(queryTokens, chunk.text)
    const headingHit = keywordOverlap(queryTokens, `${(chunk.heading_path ?? []).join(' ')} ${document.title}`)
    const phraseBonus = text.trim() && text.trim().includes(chunk.text) ? 0.08 : 0
    const graphBonus = graphSet.has(chunkId) ? 0.07 : 0
    const score =
      0.40 * dense +
      0.20 * sparseNorm +
      0.24 * coverage +
      0.06 * headingHit +
      phraseBonus +
      graphBonus +
      Math.min(0.05, Math.max(0, (chunk.weight ?? 1) - 1) * 0.05)
    reranked.push(
      new Hit(chunk, document, dense, sparseNorm, rrfScore, Number(score.toFixed(4)), coverage, graphSet.has(chunkId) ? 'graph' : 'chunk'),
    )
  }
  reranked.sort((a, b) => b.rerank - a.rerank)
  options.recorder?.addSpan({
    stage: 'rank.rerank',
    params: { candidates: reranked.length, threshold: settings.rerankThreshold },
    output: { top: reranked.slice(0, 5).map((hit) => ({ chunk_id: hit.chunk.id, score: hit.rerank })) },
    latencyMs: Date.now() - t0,
  })

  const final = reranked.slice(0, topK)
  for (const hit of final) {
    if (hit.chunk.parent_id) {
      const parent = await queryOne<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [hit.chunk.parent_id])
      if (parent) hit.parentText = parent.text
    }
  }
  return {
    hits: final,
    facts,
    entities,
    stats: {
      candidates: candidates.length,
      visible: visible.length,
      rejected,
      dense: denseRanked.length,
      sparse: sparseRanked.length,
      graph_chunks: graphChunkIds.length,
      fused: fused.size,
      reranked: reranked.length,
      top_score: final[0]?.rerank ?? 0,
      mode,
      latency_ms: Date.now() - started,
    },
    rejectedCandidates: rejected,
    query: text,
    asOf: options.asOf ?? null,
  }
}
