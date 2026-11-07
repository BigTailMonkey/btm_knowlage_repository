import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { settings } from '../src/config.js'
import { closePool, initSchema, query, seedIfEmpty } from '../src/db/index.js'
import { embedder, sparseVector, tokenize, type Embedding } from '../src/adapters/embeddings/index.js'
import { harness } from '../src/adapters/harness/index.js'
import type { Principal } from '../src/core/security.js'

export async function testWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'knowweave-node-test-'))
  Object.assign(settings, {
    dataDir: directory, databaseUrl: '', harnessEnabled: false, modelApiKey: '',
    embeddingApiKey: '', sidecarEnabled: false, reflectionEnabled: false,
    dshWebEnabled: false, seedDemo: true, semanticEntities: false, groundingVerifier: false, rerankUrl: '',
  })
  const embedding = (text: string): Embedding => ({
    dense: [1, 0], sparse: sparseVector(tokenize(text)), model: 'test-embedding', dim: 2,
  })
  embedder.embed = async (text) => embedding(text)
  embedder.embedQuery = async (text) => embedding(text)
  embedder.embedMany = async (texts) => texts.map(embedding)
  const disabled = async () => ({ text: '', tokensIn: 0, tokensOut: 0, model: 'test-model', provider: 'test', latencyMs: 0, error: 'offline', ok: false })
  harness.ask = disabled
  harness.complete = disabled
  await initSchema()
  await seedIfEmpty()
  const principal: Principal = {
    userId: 'u_owner', tenantId: settings.defaultTenantId, name: 'Test owner',
    role: 'owner', groups: ['everyone', 'finance', 'exec', 'engineering'], token: 'owner-token',
  }
  return {
    principal,
    headers: { authorization: 'Bearer owner-token' },
    async close() { await closePool(); await rm(directory, { recursive: true, force: true }) },
  }
}

export async function clearKnowledge(): Promise<void> {
  for (const table of ['eval_runs', 'eval_cases', 'reflection_runs', 'knowledge_summaries', 'feedback', 'citations', 'messages', 'conversations', 'replay_runs', 'usage_ledger', 'trace_spans', 'traces', 'review_queue', 'fact_evidence', 'facts', 'entity_aliases', 'entities', 'chunks', 'blocks', 'document_versions', 'documents', 'jobs', 'memory_items', 'gaps']) {
    await query(`DELETE FROM ${table}`)
  }
}
