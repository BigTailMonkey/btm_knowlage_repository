/**
 * 高强度验证探针（不属于常规 npm test glob）。
 * 每个用例断言“正确行为”；失败 = 实证 BUG。
 * 运行：node --import tsx --test --test-concurrency=1 tests/audit/high-intensity.test.ts
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from '../helpers.js'
import { query, queryOne } from '../../src/db/index.js'
import { settings } from '../../src/config.js'
import { createServer } from '../../src/app/server.js'
import { harness } from '../../src/adapters/harness/index.js'
import { validateGrounding } from '../../src/core/grounding.js'
import { retrieve } from '../../src/core/retrieval.js'
import { ingestParsed } from '../../src/core/ingestion.js'
import { parseTextContent } from '../../src/adapters/parsing/index.js'
import { trashDocument } from '../../src/core/trash.js'
import { linkContinuation, continuationView } from '../../src/core/continuation.js'
import { getOrCreateEntity } from '../../src/core/learning.js'
import { queryStructuredFacts } from '../../src/core/knowledge-query.js'
import type { Principal } from '../../src/core/security.js'
import type { DocumentRow } from '../../src/core/rows.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>

before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
beforeEach(async () => {
  await clearKnowledge()
  harness.ask = async () => ({ text: '', tokensIn: 0, tokensOut: 0, model: 'test', provider: 'test', latencyMs: 0, error: 'offline', ok: false })
  harness.complete = async () => ({ text: '', tokensIn: 0, tokensOut: 0, model: 'test', provider: 'test', latencyMs: 0, error: 'offline', ok: false })
})
after(async () => { await app?.close(); await workspace?.close() })

const H = { authorization: 'Bearer owner-token' }
async function makeUser(id: string, role: string, groups: string[], token: string) {
  await query(
    `INSERT INTO users (id, tenant_id, name, role, groups, token, status) VALUES ($1,$2,$1,$3,$4::jsonb,$5,'active')
     ON CONFLICT (id) DO UPDATE SET role=$3, groups=$4::jsonb, token=$5, status='active'`,
    [id, settings.defaultTenantId, role, JSON.stringify(groups), token],
  )
}
async function sqlDocument(id: string, title: string, acl = '["tenant:public"]') {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals, quality_score)
     VALUES ($1,$2,$3,$1,'text',1,$4::jsonb,1)`,
    [id, settings.defaultTenantId, title, acl],
  )
}
async function sqlVersionChunk(docId: string, text: string, chunkId = `${docId}-chunk`) {
  const versionId = `${docId}-v1`
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ($1,$2,$3,1,$1,'test',$4)`,
    [versionId, docId, settings.defaultTenantId, text],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse, is_parent)
     VALUES ($1,$2,$3,$4,0,$5,'["tenant:public"]',ARRAY[1.0,0.0],'{}'::jsonb,false)`,
    [chunkId, versionId, docId, settings.defaultTenantId, text],
  )
  return { versionId, chunkId }
}
const linker: Principal = {
  userId: 'u_linker', tenantId: settings.defaultTenantId, name: 'Linker', role: 'editor',
  groups: ['everyone'], token: 'linker-token',
}

/* ---------- A. 输入类型校验 / 500 ---------- */

test('HI-01 MCP method 非字符串应返回协议错误而非 500', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/mcp', headers: { ...H, 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method: 123 },
  })
  assert.ok(res.statusCode < 500, `非字符串 method 触发 ${res.statusCode}：${res.body}`)
  const body = res.json() as { error?: { code?: number } }
  assert.equal(body.error?.code, -32600, `应返回 Invalid Request：-32600，实际 ${res.body}`)
})

test('HI-02 /search query 传对象应返回 400 而非 500', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: H, payload: { query: { text: '报销' } } })
  assert.equal(res.statusCode, 400, `query 类型混淆触发 ${res.statusCode}：${res.body}`)
})

test('HI-03 /ask question 传数字应返回 400 而非 500', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: H, payload: { question: 123 } })
  assert.equal(res.statusCode, 400, `question 类型混淆触发 ${res.statusCode}：${res.body}`)
})

test('HI-04 /ops/costs/summary?days=abc 应返回 400 而非 500', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/costs/summary?days=abc', headers: H })
  assert.equal(res.statusCode, 400, `days 非数字触发 ${res.statusCode}：${res.body}`)
})

test('HI-05 500 响应不应回显数据库原始错误消息（信息泄露）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/costs/summary?days=abc', headers: H })
  assert.ok(!/invalid input syntax|interval|TypeError|undefined is not a function/i.test(res.body),
    `500 响应回显内部错误：${res.body.slice(0, 300)}`)
})

test('HI-06 审阅咨询 history 类型混淆应返回 400 而非 500', async () => {
  await makeUser('u_consult', 'editor', ['everyone'], 'consult-token')
  await query(
    `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
     VALUES ('rev_hi', $1, 'fact_conflict', '测试审阅项', '{"subject":"测试实体","predicate":"测试谓词","quote":"测试原文"}'::jsonb, 'open')`,
    [settings.defaultTenantId],
  )
  const res = await app.inject({
    method: 'POST', url: '/api/v1/review/rev_hi/consult',
    headers: { ...H, 'content-type': 'application/json' }, payload: { history: 'abc' },
  })
  assert.equal(res.statusCode, 400, `history 类型错误应返回 400，实际 ${res.statusCode}：${res.body}`)
})

/* ---------- B. 跨用户数据隔离 ---------- */

test('HI-07 原生对话反馈列表不应泄露其他用户的反馈正文', async () => {
  await makeUser('u_viewer', 'viewer', ['everyone'], 'viewer-token')
  const secret = '私密反馈-AJ5s8-身份证片段'
  const write = await app.inject({
    method: 'POST', url: '/api/v1/chat-feedback', headers: { ...H, 'content-type': 'application/json' },
    payload: { session_id: 's1', message_id: 'm1', value: 1, comment: secret, context: '原文片段' },
  })
  assert.equal(write.statusCode, 200, write.body)
  const read = await app.inject({
    method: 'GET', url: '/api/v1/chat-feedback',
    headers: { authorization: 'Bearer viewer-token' },
  })
  const items = (read.json() as { items: Array<{ user_id: string; comment: string | null }> }).items
  assert.ok(!items.some((item) => item.user_id === 'u_owner' && item.comment === secret),
    `viewer 看到了他人反馈：${JSON.stringify(items)}`)
})

test('HI-08 viewer 不应读取全租户问答轨迹（含他人问题与答案）', async () => {
  await makeUser('u_viewer2', 'viewer', ['everyone'], 'viewer-token2')
  await query(
    `INSERT INTO traces (id, tenant_id, user_id, feature, question, answer, status)
     VALUES ('tr_secret', $1, 'u_owner', 'ask', '我的私密问题-工资明细', '私密回答内容', 'ok')`,
    [settings.defaultTenantId],
  )
  const res = await app.inject({ method: 'GET', url: '/api/v1/traces', headers: { authorization: 'Bearer viewer-token2' } })
  assert.ok([403, 404].includes(res.statusCode) || !(res.body.includes('我的私密问题-工资明细')),
    `viewer 读到他人轨迹：${res.statusCode} ${res.body.slice(0, 300)}`)
})

test('HI-09 ?status=retracted 不应绕过事实展示策略', async () => {
  const entity = await getOrCreateEntity(settings.defaultTenantId, '展示策略实体')
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, status, acl_principals, confidence)
     VALUES ('f_retracted', $1, $2, '测试谓词', '已撤回值', 'retracted', '["tenant:public"]'::jsonb, 0.9)`,
    [settings.defaultTenantId, entity.id],
  )
  const res = await app.inject({ method: 'GET', url: '/api/v1/facts?status=retracted', headers: H })
  const items = (res.json() as { items: Array<{ fact_id?: string; id?: string }> }).items ?? []
  assert.ok(!items.some((item) => item.fact_id === 'f_retracted' || item.id === 'f_retracted'),
    `任意 status 值绕过展示策略，返回了已撤回事实：${JSON.stringify(items)}`)
})

/* ---------- C. ACL fail-open / 沿革一致性 ---------- */

test('HI-10 显式空 ACL 摄入不应被放大为全员可见', async () => {
  await assert.rejects(ingestParsed(workspace.principal, parseTextContent('空 ACL 测试内容', '空 ACL 文档'), {
    sourceType: 'text', uri: 'audit:empty-acl', acl: [],
  }), (error: unknown) => (error as { statusCode?: number }).statusCode === 400)
  assert.equal((await query('SELECT id FROM documents')).length, 0, '空 ACL 被拒绝后不得写入文档')
})

test('HI-11 沿革中间代进回收站后，不应有两代同时显示“生效”', async () => {
  await sqlDocument('chain-a', '政策A')
  await sqlDocument('chain-b', '政策B')
  await sqlDocument('chain-c', '政策C')
  for (const id of ['chain-a', 'chain-b', 'chain-c']) await sqlVersionChunk(id, `Aurora 沿革规则 ${id}`)
  await linkContinuation(workspace.principal, 'chain-b', { other_doc_id: 'chain-a', relation: 'continues', effective_date: '2025-01-01' })
  await linkContinuation(workspace.principal, 'chain-c', { other_doc_id: 'chain-b', relation: 'continues', effective_date: '2026-01-01' })
  await trashDocument(workspace.principal, 'chain-b')
  const docA = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id=$1', ['chain-a'])
  const view = await continuationView(workspace.principal, docA!)
  const inForce = view.chain.filter((node) => node.in_force).map((node) => node.id)
  assert.deepEqual(inForce, ['chain-c'], `沿革视图同时显示生效代：${JSON.stringify(inForce)}`)
  assert.deepEqual((await retrieve(workspace.principal, 'Aurora 沿革规则')).hits.map(hit => hit.document.id), ['chain-c'])
  const detail = await app.inject({ method: 'GET', url: '/api/v1/documents/chain-a', headers: H })
  assert.equal(detail.statusCode, 200)
  assert.equal(detail.json().document.continuation.in_force, false, '列表徽标也应与检索、详情沿革一致')
})

test('HI-12 结构化事实查询：后续不可读时，可读前序事实不应整体消失', async () => {
  await sqlDocument('hq-old', '公开旧政策')
  await sqlDocument('hq-new', '受限新政策', '["user:u_linker"]')
  await sqlVersionChunk('hq-old', 'Aurora 结构化事实 旧规则')
  const { chunkId } = await sqlVersionChunk('hq-new', 'Aurora 结构化事实 新规则')
  await makeUser('u_linker', 'editor', ['everyone'], 'linker-token')
  await linkContinuation(linker, 'hq-new', { other_doc_id: 'hq-old', relation: 'continues', effective_date: '2026-01-01' })
  const entity = await getOrCreateEntity(settings.defaultTenantId, 'HQ政策主体')
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, status, acl_principals)
     VALUES ('f_hq_old', $1, $2, '适用标准', '旧标准', 'active', '["tenant:public"]'::jsonb)`,
    [settings.defaultTenantId, entity.id],
  )
  await query(
    `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote) VALUES ('e_hq_old', 'f_hq_old', $1, 'hq-old', '旧规则')`,
    ['hq-old-chunk'],
  )
  const result = await queryStructuredFacts(workspace.principal, { operation: 'list' }) as { rows: Array<{ fact_id: string }>; total: number }
  assert.equal(result.total, 1)
  assert.deepEqual(result.rows.map(fact => fact.fact_id), ['f_hq_old'], '只返回可读前序所支持的事实')
})

/* ---------- D. 检索 / 问答正确性 ---------- */

test('HI-13 as_of 中文日期写法不应被数字核验误拒', () => {
  const check = validateGrounding(
    '截至2024年6月1日时间切片，补贴为89元[1]。',
    [{ text: '2024年，基本公共卫生服务经费人均财政补助标准为89元。' }],
    { asOf: '2024-06-01', checkWording: false },
  )
  assert.equal(check.valid, true, `中文日期写法的可信时间切片被误拒：${JSON.stringify(check.issues)}`)
})

test('HI-14 top_k=0 不应被静默改写为默认值 8', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/mcp', headers: { ...H, 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'kb_search', arguments: { query: '测试', top_k: 0 } } },
  })
  const body = res.json() as { error?: { code: number } }
  assert.equal(body.error?.code, -32602, `top_k=0 应被参数校验拒绝，实际返回：${res.body.slice(0, 200)}`)
})
