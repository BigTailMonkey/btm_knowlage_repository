import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from './helpers.js'
import { query } from '../src/db/index.js'
import { settings } from '../src/config.js'
import { createServer } from '../src/app/server.js'
import { sparseVector, tokenize } from '../src/adapters/embeddings/index.js'
import { retrieve } from '../src/core/retrieval.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>

before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
beforeEach(clearKnowledge)
after(async () => { await app?.close(); await workspace?.close() })

async function document(id: string, title: string) {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals)
     VALUES ($1, $2, $3, $1, 'text', 1, '["tenant:public"]')`,
    [id, settings.defaultTenantId, title],
  )
}

async function versionAndChunk(docId: string, text: string, chunkId = `${docId}-chunk`) {
  const versionId = `${docId}-v1`
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ($1, $2, $3, 1, $1, 'test', $4)`,
    [versionId, docId, settings.defaultTenantId, text],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse)
     VALUES ($1, $2, $3, $4, 0, $5, '["tenant:public"]', '[1,0]', $6::jsonb)`,
    [chunkId, versionId, docId, settings.defaultTenantId, text, JSON.stringify(sparseVector(tokenize(text)))],
  )
  return { versionId, chunkId }
}

async function link(docId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: `/api/v1/documents/${docId}/continuation`, headers: workspace.headers, payload,
  })
}

async function structuredFacts(asOf?: string) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/mcp', headers: workspace.headers,
    payload: {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kb_query_facts', arguments: { operation: 'list', filters: asOf ? { as_of: asOf } : {} } },
    },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.error, undefined, JSON.stringify(body.error))
  return JSON.parse(body.result.content[0].text)
}

test('only the in-force policy is retrieved by default; as_of, explicit ids and exact titles reach history', async () => {
  await document('old-policy', '旧政策')
  await document('new-policy', '新政策')
  await versionAndChunk('old-policy', 'Aurora policy 2024 rule')
  await versionAndChunk('new-policy', 'Aurora policy 2025 rule')
  await query(
    `INSERT INTO entities (id, tenant_id, canonical_name, normalized_name, acl_principals)
     VALUES ('aurora', $1, 'Aurora', 'aurora', '["tenant:public"]')`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, status, acl_principals)
     VALUES ('fact-old', $1, 'aurora', 'relates', 'old rule', 'active', '["tenant:public"]')`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote)
     VALUES ('evidence-old', 'fact-old', 'old-policy-chunk', 'old-policy', 'old rule')`,
  )

  const created = await link('new-policy', {
    other_doc_id: 'old-policy', relation: 'continues', effective_date: '2025-01-01', note: '2025 年修订',
  })
  assert.equal(created.statusCode, 200, created.body)
  assert.equal(created.json().successor, null)
  assert.equal(created.json().predecessor.id, 'old-policy')

  const current = await retrieve(workspace.principal, 'Aurora policy')
  assert.deepEqual(current.hits.map((hit) => hit.document.id), ['new-policy'])
  assert.equal(current.facts.length, 0, 'facts supported only by the superseded policy must not leak')

  const historical = await retrieve(workspace.principal, 'Aurora policy', { asOf: '2024-06-01' })
  assert.deepEqual(historical.hits.map((hit) => hit.document.id), ['old-policy'])
  assert.equal(historical.facts.length, 1)

  assert.equal((await structuredFacts()).total, 0)
  assert.equal((await structuredFacts('2024-06-01')).total, 1)

  const future = await retrieve(workspace.principal, 'Aurora policy', { asOf: '2026-01-01' })
  assert.deepEqual(future.hits.map((hit) => hit.document.id), ['new-policy'])

  const explicit = await retrieve(workspace.principal, 'Aurora policy', { docIds: ['old-policy'] })
  assert.deepEqual(explicit.hits.map((hit) => hit.document.id), ['old-policy'])

  const titled = await retrieve(workspace.principal, '《旧政策》 Aurora policy')
  assert.deepEqual(titled.hits.map((hit) => hit.document.id), ['old-policy'])
})

test('a continuation chain selects exactly one in-force generation per date', async () => {
  await document('policy-2022', '2022 办法')
  await document('policy-2024', '2024 办法')
  await document('policy-2026', '2026 办法')
  await versionAndChunk('policy-2022', 'Aurora policy 2022 rule')
  await versionAndChunk('policy-2024', 'Aurora policy 2024 rule')
  await versionAndChunk('policy-2026', 'Aurora policy 2026 rule')

  assert.equal((await link('policy-2024', { other_doc_id: 'policy-2022', relation: 'continues', effective_date: '2024-01-01' })).statusCode, 200)
  assert.equal((await link('policy-2026', { other_doc_id: 'policy-2024', relation: 'continues', effective_date: '2026-01-01' })).statusCode, 200)

  assert.deepEqual((await retrieve(workspace.principal, 'Aurora policy')).hits.map((hit) => hit.document.id), ['policy-2026'])
  assert.deepEqual((await retrieve(workspace.principal, 'Aurora policy', { asOf: '2025-06-01' })).hits.map((hit) => hit.document.id), ['policy-2024'])
  assert.deepEqual((await retrieve(workspace.principal, 'Aurora policy', { asOf: '2023-06-01' })).hits.map((hit) => hit.document.id), ['policy-2022'])

  const middle = await app.inject({ method: 'GET', url: '/api/v1/documents/policy-2024', headers: workspace.headers })
  assert.equal(middle.statusCode, 200)
  const view = middle.json().continuation
  assert.deepEqual(view.chain.map((node: { id: string }) => node.id), ['policy-2022', 'policy-2024', 'policy-2026'])
  assert.equal(view.predecessor.id, 'policy-2022')
  assert.equal(view.successor.id, 'policy-2026')
  assert.equal(view.in_force, false, 'the 2026 generation is the one in force today')
})

test('continuation links reject self reference, duplicates, invalid dates and non-linear chains', async () => {
  await document('a', 'A')
  await document('b', 'B')
  await document('c', 'C')
  await versionAndChunk('a', 'Aurora A')
  await versionAndChunk('b', 'Aurora B')
  await versionAndChunk('c', 'Aurora C')

  assert.equal((await link('a', { other_doc_id: 'a', relation: 'continues', effective_date: '2024-01-01' })).statusCode, 400)
  assert.equal((await link('a', { other_doc_id: 'b', relation: 'continues', effective_date: '2024-02-30' })).statusCode, 400)

  assert.equal((await link('b', { other_doc_id: 'a', relation: 'continues', effective_date: '2024-01-01' })).statusCode, 200)
  assert.equal((await link('c', { other_doc_id: 'b', relation: 'continues', effective_date: '2025-01-01' })).statusCode, 200)
  assert.equal((await link('b', { other_doc_id: 'c', relation: 'continues', effective_date: '2026-01-01' })).statusCode, 409, 'B already has a successor')
  assert.equal((await link('a', { other_doc_id: 'c', relation: 'continued_by', effective_date: '2026-01-01' })).statusCode, 409, 'A already has a successor')

  const removed = await app.inject({
    method: 'DELETE', url: '/api/v1/documents/a/continuation?relation=continued_by', headers: workspace.headers,
  })
  assert.equal(removed.statusCode, 200)
  assert.equal(removed.json().successor, null)
  const current = await retrieve(workspace.principal, 'Aurora')
  assert.deepEqual(new Set(current.hits.map((hit) => hit.document.id)), new Set(['a', 'c']), 'B is still superseded by C')
})