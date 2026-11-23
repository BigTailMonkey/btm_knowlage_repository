import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createServer } from '../src/app/server.js'
import { query } from '../src/db/index.js'
import { TraceRecorder } from '../src/core/tracing.js'
import { submitIngest, stopIngestWorker } from '../src/core/ingestion.js'
import { clearKnowledge, testWorkspace } from './helpers.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>
before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
beforeEach(clearKnowledge)
after(async () => { await stopIngestWorker(); await app?.close(); await workspace?.close() })
const post = (path: string, payload?: unknown) => app.inject({
  method: 'POST', url: `/api/v1${path}`, headers: workspace.headers,
  payload: payload as Record<string, unknown> | undefined,
})

test('replay accepts an omitted body and validates provided retrieval limits', async () => {
  const trace = new TraceRecorder(workspace.principal.tenantId, workspace.principal.userId, 'ask', '测试问题')
  await trace.finish('测试答案', 'ok')
  assert.equal((await post(`/traces/${trace.traceId}/replay`)).statusCode, 200)
  assert.equal((await post(`/traces/${trace.traceId}/replay`, {})).statusCode, 200)
  assert.equal((await post(`/traces/${trace.traceId}/replay`, { top_k: 0 })).statusCode, 400)
})

test('invalid model prices are rejected before SQL and valid prices retain exact values', async () => {
  const base = { provider: 'audit-provider', model: 'audit-model' }
  const initial = (await query('SELECT id FROM model_prices')).length
  for (const payload of [undefined, {}, { model: 'x', input_per_million: -5 },
    { ...base, input_per_1m: -1 }, { ...base, output_per_1m: '1' },
    { ...base, provider: '  ' }, { ...base, model: 123 },
    { ...base, input_per_million: 5 }, { ...base, effective_from: '2024-02-30' },
    { ...base, effective_from: 1 }, { ...base, currency: 'cny' }]) {
    const response = await post('/prices', payload)
    assert.equal(response.statusCode, 400, response.body)
    assert.doesNotMatch(response.body, /null value|column|constraint|INSERT INTO/)
  }
  assert.equal((await query('SELECT id FROM model_prices')).length, initial)
  const response = await post('/prices', { ...base, input_per_1m: 1.5, output_per_1m: 3, currency: 'CNY', effective_from: '2024-02-29' })
  assert.equal(response.statusCode, 200)
  assert.equal((await query<{ input_per_1m: number }>('SELECT input_per_1m FROM model_prices WHERE id=$1', [response.json().id]))[0]!.input_per_1m, 1.5)
})

test('malformed, empty, unknown and uploader-excluding ACLs never enter the ingest queue', async () => {
  for (const acl of [[123], [], [' '], 'tenant:public', ['unknown'], ['group:ghost-group'], ['user:ghost-user'], ['user:u_viewer']]) {
    const response = await post('/documents/text', { text: '这是一份用于检验文档授权边界的完整文本。', acl })
    assert.equal(response.statusCode, 400, JSON.stringify({ acl, response: response.body }))
  }
  assert.equal((await query('SELECT id FROM jobs')).length, 0)
  assert.equal((await query('SELECT id FROM documents')).length, 0)
  await assert.rejects(submitIngest(workspace.principal, 'text', { text: '有效文本', acl: [] }), /acl/)
})

test('blank or mistyped text, overlong titles, and non-multipart uploads fail synchronously', async () => {
  for (const text of [' ', '\n\t', 123, [], null]) {
    assert.equal((await post('/documents/text', { text })).statusCode, 400)
    assert.equal((await post('/memory', { text })).statusCode, 400)
  }
  assert.equal((await post('/documents/text', { text: '有效文本', title: '长'.repeat(501) })).statusCode, 400)
  assert.equal((await post('/documents/text', { text: '有效文本', title: 123 })).statusCode, 400)
  assert.equal((await post('/documents/upload', {})).statusCode, 415)
  assert.equal((await query('SELECT id FROM jobs')).length, 0)
  assert.equal((await query('SELECT id FROM memory_items')).length, 0)
})

test('non-public URL forms fail before creating jobs', async () => {
  for (const url of ['http://127.0.0.1', 'http://2130706433', 'http://127.1', 'http://[::1]',
    'http://0.0.0.0', 'http://10.0.0.1', 'http://169.254.169.254', 'file:///etc/passwd', 'http://user:pass@example.com']) {
    const response = await post('/documents/url', { url })
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`)
  }
  assert.equal((await query('SELECT id FROM jobs')).length, 0)
})

test('integer range errors consistently return 400 and legal endpoints remain accepted', async () => {
  for (const path of ['/documents?limit=0', '/documents?limit=201', '/traces?limit=0', '/traces?limit=201', '/documents?limit=-1', '/documents?limit=1.5']) {
    const response = await app.inject({ method: 'GET', url: `/api/v1${path}`, headers: workspace.headers })
    assert.equal(response.statusCode, 400, `${path}: ${response.body}`)
  }
  for (const limit of [1, 200]) assert.equal((await app.inject({ method: 'GET', url: `/api/v1/documents?limit=${limit}`, headers: workspace.headers })).statusCode, 200)
})

test('missing and foreign conversations both return 404 on reads and asks', async () => {
  await query('INSERT INTO conversations (id, tenant_id, user_id, title) VALUES ($1,$2,$3,$4)',
    ['foreign', workspace.principal.tenantId, 'other', 'secret'])
  for (const id of ['foreign', 'nonexistent']) {
    assert.equal((await post('/ask', { question: '测试问题', conversation_id: id })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: workspace.headers })).statusCode, 404)
  }
})
