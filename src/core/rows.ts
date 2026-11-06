export interface DocumentRow {
  id: string
  tenant_id: string
  title: string
  source_type: string
  uri: string | null
  content_hash: string
  acl_principals: string[]
  acl_version: number
  status: string
  current_version: number
  quality_score: number
  enrichment_status: string
  summary: string | null
  created_at: string
  updated_at: string
}

export interface VersionRow {
  id: string
  doc_id: string
  tenant_id: string
  version: number
  hash: string
  parser: string
  text: string
  meta: Record<string, unknown>
  created_at: string
}

export interface ChunkRow {
  id: string
  version_id: string
  doc_id: string
  tenant_id: string
  seq: number
  heading_path: string[]
  page: number | null
  bbox: number[] | null
  block_type: string
  text: string
  token_count: number
  parent_id: string | null
  is_parent: boolean
  acl_principals: string[]
  acl_version: number
  dense: number[]
  sparse: Record<string, number>
  embedding_model: string
  embedding_dim: number
  weight: number
  created_at: string
}

export interface EntityRow {
  id: string
  tenant_id: string
  type: string
  canonical_name: string
  normalized_name: string
  description: string | null
  status: string
  acl_principals: string[]
  created_at: string
  updated_at: string
}

export interface FactRow {
  id: string
  tenant_id: string
  subject_id: string
  predicate: string
  object_id: string | null
  object_literal: string | null
  valid_from: string | null
  valid_to: string | null
  recorded_at: string
  confidence: number
  status: string
  acl_principals: string[]
  superseded_by: string | null
  source_doc_id: string | null
  created_at: string
}

export interface TraceRow {
  id: string
  tenant_id: string
  user_id: string
  feature: string
  question: string
  answer: string
  status: string
  latency_ms: number
  meta: Record<string, unknown>
  created_at: string
}
