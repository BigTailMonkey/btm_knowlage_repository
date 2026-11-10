import { query, queryOne } from '../db/index.js'
import { continuationSummary } from './continuation.js'
import { iso } from './ids.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow } from './rows.js'
import { aclLabel } from './security.js'

export async function documentDict(document: DocumentRow): Promise<Record<string, unknown>> {
  const count = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM chunks
     WHERE doc_id = $1 AND is_parent = false
       AND version_id IN (SELECT id FROM document_versions WHERE doc_id = $1 AND version = $2)`,
    [document.id, document.current_version],
  )
  const continuation = await continuationSummary(document)
  return {
    id: document.id,
    title: document.title,
    source_type: document.source_type,
    uri: document.uri,
    status: document.status,
    version: document.current_version,
    content_hash: (document.content_hash ?? '').slice(0, 16),
    acl: document.acl_principals,
    acl_label: aclLabel(document.acl_principals),
    acl_version: document.acl_version,
    quality: Number((document.quality_score ?? 0).toFixed(3)),
    enrichment_status: document.enrichment_status,
    enrichment_error: document.enrichment_error,
    summary: document.summary,
    source_trust: document.source_trust ?? 0.5,
    is_core: document.is_core ?? false,
    deleted_at: document.deleted_at ?? null,
    deleted_by: document.deleted_by ?? null,
    chunks: Number(count?.count ?? 0),
    continuation,
    in_force: continuation ? Boolean(continuation.in_force) : document.status === 'active',
    created_at: iso(document.created_at),
    updated_at: iso(document.updated_at),
  }
}

export function entityDict(entity: EntityRow): Record<string, unknown> {
  return {
    id: entity.id,
    name: entity.canonical_name,
    type: entity.type,
    description: entity.description,
    status: entity.status,
    acl: entity.acl_principals,
    acl_label: aclLabel(entity.acl_principals),
    created_at: iso(entity.created_at),
  }
}

interface EvidenceRow {
  chunk_id: string | null
  doc_id: string
  quote: string
}

function dateOnly(value: unknown): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

export async function factDict(fact: FactRow): Promise<Record<string, unknown>> {
  const subject = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.subject_id])
  const object = fact.object_id
    ? await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [fact.object_id])
    : null
  const evidence = await query<EvidenceRow>(
    'SELECT chunk_id, doc_id, quote FROM fact_evidence WHERE fact_id = $1',
    [fact.id],
  )
  return {
    id: fact.id,
    subject_id: fact.subject_id,
    subject: subject?.canonical_name ?? fact.subject_id,
    subject_type: subject?.type ?? 'concept',
    predicate: fact.predicate,
    object_id: fact.object_id,
    object: object?.canonical_name ?? fact.object_literal,
    object_literal: fact.object_literal,
    valid_from: dateOnly(fact.valid_from),
    valid_to: dateOnly(fact.valid_to),
    recorded_at: iso(fact.recorded_at),
    confidence: Number((fact.confidence ?? 0).toFixed(3)),
    status: fact.status,
    superseded_by: fact.superseded_by,
    source_doc_id: fact.source_doc_id,
    acl: fact.acl_principals,
    acl_label: aclLabel(fact.acl_principals),
    evidence: evidence.map((row) => ({ chunk_id: row.chunk_id, doc_id: row.doc_id, quote: row.quote })),
  }
}

export function chunkDict(chunk: ChunkRow, document: DocumentRow | null = null): Record<string, unknown> {
  return {
    id: chunk.id,
    doc_id: chunk.doc_id,
    doc_title: document?.title ?? '',
    seq: chunk.seq,
    heading_path: chunk.heading_path,
    page: chunk.page,
    block_type: chunk.block_type,
    text: chunk.text,
    tokens: chunk.token_count,
    acl_label: aclLabel(chunk.acl_principals),
    acl_version: chunk.acl_version,
  }
}
