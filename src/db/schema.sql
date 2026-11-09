-- KnoWeave PostgreSQL schema. Vectors are derived data stored as JSONB and can
-- always be rebuilt from chunks; only relational facts are authoritative.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_users_tenant ON users (tenant_id);

CREATE TABLE IF NOT EXISTS acl_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  effect TEXT NOT NULL DEFAULT 'allow',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_acl_tenant ON acl_entries (tenant_id);
CREATE INDEX IF NOT EXISTS ix_acl_resource ON acl_entries (resource_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text',
  uri TEXT,
  content_hash TEXT NOT NULL,
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  acl_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  current_version INTEGER NOT NULL DEFAULT 1,
  quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  enrichment_status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_documents_tenant ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS ix_documents_hash ON documents (content_hash);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  parser TEXT NOT NULL,
  text TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_versions_doc ON document_versions (doc_id);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  doc_id TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL DEFAULT 'paragraph',
  page INTEGER,
  bbox JSONB,
  order_index INTEGER NOT NULL DEFAULT 0,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_blocks_version ON blocks (version_id);
CREATE INDEX IF NOT EXISTS ix_blocks_doc ON blocks (doc_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  doc_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  page INTEGER,
  bbox JSONB,
  block_type TEXT NOT NULL DEFAULT 'paragraph',
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  is_parent BOOLEAN NOT NULL DEFAULT false,
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  acl_version INTEGER NOT NULL DEFAULT 1,
  dense JSONB NOT NULL DEFAULT '[]'::jsonb,
  sparse JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_dim INTEGER NOT NULL DEFAULT 0,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_chunks_doc_version ON chunks (doc_id, version_id);
CREATE INDEX IF NOT EXISTS ix_chunks_tenant ON chunks (tenant_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'concept',
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_entities_tenant ON entities (tenant_id);
CREATE INDEX IF NOT EXISTS ix_entities_name ON entities (canonical_name);
CREATE INDEX IF NOT EXISTS ix_entities_norm ON entities (normalized_name);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'extraction'
);
CREATE INDEX IF NOT EXISTS ix_alias_entity ON entity_aliases (entity_id);
CREATE INDEX IF NOT EXISTS ix_alias_norm ON entity_aliases (normalized_alias);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,
  object_id TEXT REFERENCES entities(id),
  object_literal TEXT,
  valid_from DATE,
  valid_to DATE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  status TEXT NOT NULL DEFAULT 'active',
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  superseded_by TEXT,
  source_doc_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_facts_tenant ON facts (tenant_id);
CREATE INDEX IF NOT EXISTS ix_facts_subject ON facts (subject_id);
CREATE INDEX IF NOT EXISTS ix_facts_status ON facts (status);

CREATE TABLE IF NOT EXISTS fact_evidence (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id),
  chunk_id TEXT,
  doc_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  span JSONB,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_evidence_fact ON fact_evidence (fact_id);
CREATE INDEX IF NOT EXISTS ix_evidence_doc ON fact_evidence (doc_id);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  kind TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  expires_at TIMESTAMPTZ,
  promoted_fact_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_memory_user ON memory_items (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_conversations_user ON conversations (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'quick',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_messages_conversation ON messages (conversation_id);

CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chunk_id TEXT,
  fact_id TEXT,
  doc_id TEXT,
  quote TEXT NOT NULL DEFAULT '',
  page INTEGER,
  rank INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_citations_message ON citations (message_id);

CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_review_tenant ON review_queue (tenant_id);
CREATE INDEX IF NOT EXISTS ix_review_status ON review_queue (status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  input_hash TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jobs_tenant ON jobs (tenant_id);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_traces_tenant ON traces (tenant_id);

CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_id TEXT,
  stage TEXT NOT NULL,
  input_hash TEXT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_spans_trace ON trace_spans (trace_id);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  trace_id TEXT,
  span_id TEXT,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  feature TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  price_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_usage_tenant ON usage_ledger (tenant_id);
CREATE INDEX IF NOT EXISTS ix_usage_feature ON usage_ledger (feature);

CREATE TABLE IF NOT EXISTS model_prices (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '1M_tokens',
  input_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  effective_from DATE NOT NULL,
  effective_to DATE
);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  period TEXT NOT NULL DEFAULT 'month',
  limit_amount DOUBLE PRECISION NOT NULL DEFAULT 100,
  used_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  alert_at DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_budgets_tenant ON budgets (tenant_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_feedback_target ON feedback (target_id);

CREATE TABLE IF NOT EXISTS gaps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  question TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  suggested_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gaps_tenant ON gaps (tenant_id);

CREATE TABLE IF NOT EXISTS replay_runs (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  target_stage TEXT NOT NULL DEFAULT 'retrieve',
  overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  diff JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'done',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  question TEXT NOT NULL,
  expected_docs JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  should_refuse BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'golden',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reflection_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_summaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  acl_principals JSONB NOT NULL DEFAULT '[]'::jsonb,
  text TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_knowledge_summaries_tenant ON knowledge_summaries(tenant_id);
ALTER TABLE fact_evidence ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE fact_evidence ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS enrichment_error TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_trust DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_core BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_by TEXT;
CREATE INDEX IF NOT EXISTS ix_documents_trash ON documents (tenant_id, status, deleted_at);
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
