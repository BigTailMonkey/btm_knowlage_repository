import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from './helpers.js'
import { query } from '../src/db/index.js'
import { settings } from '../src/config.js'
import { createServer } from '../src/app/server.js'
import { sparseVector, tokenize } from '../src/adapters/embeddings/index.js'
import { factIsEffective, normalizeAsOf, retrieve } from '../src/core/retrieval.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>

before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
beforeEach(clearKnowledge)
after(async () => { await app?.close(); await workspace?.close() })

async function document(id: string, sourceType = 'text', currentVersion = 1) {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals)
     VALUES ($1, $2, $1, $1, $3, $4, '["tenant:public"]')`,
    [id, settings.defaultTenantId, sourceType, currentVersion],
  )
}

async function version(docId: string, number: number, text: string, createdAt = '2023-01-01T00:00:00Z') {
  const id = `${docId}-v${number}`
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text, created_at)
     VALUES ($1, $2, $3, $4, $1, 'test', $5, $6)`,
    [id, docId, settings.defaultTenantId, number, text, createdAt],
  )
  return id
}

async function chunk(docId: string, versionId: string, id: string, text: string, seq = 0) {
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, page, bbox, acl_principals, dense, sparse)
     VALUES ($1, $2, $3, $4, $5, $6, 2, '[1,2,3,4]', '["tenant:public"]', '[1,0]', $7::jsonb)`,
    [id, versionId, docId, settings.defaultTenantId, seq, text, JSON.stringify(sparseVector(tokenize(text)))],
  )
}

async function entity(id: string, name: string) {
  await query(
    `INSERT INTO entities (id, tenant_id, canonical_name, normalized_name, acl_principals)
     VALUES ($1, $2, $3, $4, '["tenant:public"]')`,
    [id, settings.defaultTenantId, name, name.toLowerCase()],
  )
}

async function fact(id: string, subject: string, object: string | null, chunkId: string, docId: string, status = 'active', from: string | null = null, to: string | null = null) {
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_id, object_literal, status, valid_from, valid_to, acl_principals)
     VALUES ($1, $2, $3, 'relates', $4, 'value', $5, $6, $7, '["tenant:public"]')`,
    [id, settings.defaultTenantId, subject, object, status, from, to],
  )
  await query(
    "INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote) VALUES ($1,$2,$3,$4,'fixture')",
    [`e-${id}`, id, chunkId, docId],
  )
}

async function mcp(name: string, args: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/mcp', headers: workspace.headers,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.error, undefined, JSON.stringify(body.error))
  return JSON.parse(body.result.content[0].text)
}

test('as_of selects the latest version actually stored by that date and exposes source coordinates', async () => {
  await document('history', 'text', 2)
  const oldVersion = await version('history', 1, 'Aurora was available in 2023')
  const currentVersion = await version('history', 2, 'Aurora changed in 2025', '2025-01-01T00:00:00Z')
  await chunk('history', oldVersion, 'old-chunk', 'Aurora was available in 2023')
  await chunk('history', currentVersion, 'current-chunk', 'Aurora changed in 2025')
  const current = await retrieve(workspace.principal, 'Aurora')
  const historical = await retrieve(workspace.principal, 'Aurora', { asOf: '2024-06-01' })
  assert.deepEqual(current.hits.map(hit => hit.chunk.id), ['current-chunk'])
  assert.deepEqual(historical.hits.map(hit => hit.chunk.id), ['old-chunk'])
  assert.equal(historical.hits[0]!.toDict().version, 1)
  assert.equal(historical.hits[0]!.toDict().version_id, oldVersion)
  assert.deepEqual(historical.hits[0]!.toDict().bbox, [1, 2, 3, 4])
  assert.equal((await retrieve(workspace.principal, 'Aurora', { asOf: '2022-01-01' })).hits.length, 0)
  assert.throws(() => normalizeAsOf('2024-02-30'), /日期无效/)
})

test('graph mode traverses bounded multiple hops and applies document/source filters to facts', async () => {
  await document('graph')
  const v = await version('graph', 1, 'Aurora Borealis Cygnus')
  await chunk('graph', v, 'first-edge', 'Aurora relates to Borealis')
  await chunk('graph', v, 'second-edge', 'Borealis relates to Cygnus')
  await document('excluded', 'pdf')
  const excludedVersion = await version('excluded', 1, 'Aurora hidden relation')
  await chunk('excluded', excludedVersion, 'excluded-chunk', 'Aurora hidden relation')
  await entity('a', 'Aurora'); await entity('b', 'Borealis'); await entity('c', 'Cygnus')
  await fact('ab', 'a', 'b', 'first-edge', 'graph')
  await fact('bc', 'b', 'c', 'second-edge', 'graph')
  await fact('excluded-fact', 'a', 'c', 'excluded-chunk', 'excluded')
  await fact('disputed', 'a', 'c', 'first-edge', 'graph', 'disputed')
  await fact('retracted', 'a', 'c', 'first-edge', 'graph', 'retracted')
  await fact('future', 'a', 'c', 'first-edge', 'graph', 'active', '2999-01-01')
  const oneHop = await retrieve(workspace.principal, 'Aurora', { docIds: ['graph'], graphHops: 1 })
  assert.deepEqual(oneHop.facts.map(row => row.fact_id), ['ab'])
  const graph = await retrieve(workspace.principal, 'Aurora', { mode: 'graph', sourceType: 'text' })
  assert.deepEqual(graph.facts.map(row => row.fact_id).sort(), ['ab', 'bc'])
  assert.equal(graph.stats.graph_hops, 2)
  assert.ok(graph.hits.every(hit => hit.document.id === 'graph'))
})

test('only effective active facts enter current answers; superseded facts are usable historically', async () => {
  assert.equal(factIsEffective({ status: 'disputed', valid_from: null, valid_to: null }, '2024-01-01'), false)
  assert.equal(factIsEffective({ status: 'superseded', valid_from: '2023-01-01', valid_to: '2025-01-01' }, null), false)
  assert.equal(factIsEffective({ status: 'superseded', valid_from: new Date('2023-01-01'), valid_to: new Date('2025-01-01') }, '2024-01-01'), true)
  assert.equal(factIsEffective({ status: 'superseded', valid_from: '2023-01-01', valid_to: '2025-01-01' }, '2025-01-01'), false)
})

test('negative evidence feedback lowers its retrieval score', async () => {
  await document('weighted')
  const v = await version('weighted', 1, 'Aurora')
  await chunk('weighted', v, 'weighted-chunk', 'Aurora')
  const before = (await retrieve(workspace.principal, 'Aurora')).hits[0]!.rerank
  await query('UPDATE chunks SET weight = 0.5 WHERE id = $1', ['weighted-chunk'])
  const after = (await retrieve(workspace.principal, 'Aurora')).hits[0]!.rerank
  assert.ok(after < before)
})

test('MCP returns complete document text and more than sixty chunks, and honors search filters', async () => {
  await document('full')
  const text = Array.from({ length: 65 }, (_, index) => `Aurora passage ${index}`).join('\n')
  const v = await version('full', 1, text)
  for (let index = 0; index < 65; index += 1) await chunk('full', v, `full-${index}`, `Aurora passage ${index}`, index)
  await document('other', 'pdf')
  const other = await version('other', 1, 'Aurora in another document')
  await chunk('other', other, 'other-chunk', 'Aurora in another document')
  const full = await mcp('kb_get_document', { doc_id: 'full' })
  assert.equal(full.text, text)
  assert.equal(full.chunks.length, 65)
  const search = await mcp('kb_search', { query: 'Aurora', filters: { doc_ids: ['full'], source_type: 'text' }, top_k: 4 })
  assert.equal(search.hits.length, 4)
  assert.ok(search.hits.every((hit: { doc_id: string }) => hit.doc_id === 'full'))
  const larger = await mcp('kb_search', { query: 'Aurora', filters: { doc_ids: ['full'] }, top_k: 40 })
  assert.equal(larger.hits.length, 40)
})

test('MCP timeline accepts entity_id and applies as_of while retaining name compatibility', async () => {
  await document('timeline')
  const v = await version('timeline', 1, 'Aurora timeline')
  await chunk('timeline', v, 'timeline-chunk', 'Aurora timeline')
  await entity('timeline-entity', 'Aurora')
  await fact('historical', 'timeline-entity', null, 'timeline-chunk', 'timeline', 'superseded', '2023-01-01', '2025-01-01')
  await fact('current', 'timeline-entity', null, 'timeline-chunk', 'timeline', 'active', '2025-01-01')
  await fact('disputed', 'timeline-entity', null, 'timeline-chunk', 'timeline', 'disputed')
  const historical = await mcp('kb_entity_timeline', { entity_id: 'timeline-entity', as_of: '2024-06-01' })
  assert.deepEqual(historical.timeline.map((row: { id: string }) => row.id), ['historical'])
  assert.equal(historical.timeline[0].valid_from, '2023-01-01')
  assert.equal(historical.timeline[0].valid_to, '2025-01-01')
  const all = await mcp('kb_entity_timeline', { name: 'Aurora' })
  assert.deepEqual(all.timeline.map((row: { id: string }) => row.id), ['historical', 'current'])
})

test('MCP rejects malformed search filters and invalid historical dates', async () => {
  for (const args of [
    { query: '' },
    { query: 'Aurora', filters: { doc_ids: 'not-an-array' } },
    { query: 'Aurora', filters: { as_of: 2024 } },
    { query: 'Aurora', filters: { as_of: '2024-02-30' } },
  ]) {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/mcp', headers: workspace.headers,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kb_search', arguments: args } },
    })
    assert.equal(response.json().error.code, -32602)
  }
})
