/**
 * 高强度验证探针（第二批）。断言“正确行为”；失败 = 实证 BUG。
 * 运行：node --import tsx --test --test-concurrency=1 tests/audit/high-intensity-2.test.ts
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from '../helpers.js'
import { query, queryOne } from '../../src/db/index.js'
import { settings } from '../../src/config.js'
import { createServer } from '../../src/app/server.js'
import { harness } from '../../src/adapters/harness/index.js'
import { ask } from '../../src/core/answering.js'
import { ingestParsed } from '../../src/core/ingestion.js'
import { parseTextContent } from '../../src/adapters/parsing/index.js'
import { getOrCreateEntity } from '../../src/core/learning.js'
import { queryOne as q1 } from '../../src/db/index.js'
import { todayLocal } from '../../src/core/ids.js'

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

const H = { authorization: 'Bearer owner-token', 'content-type': 'application/json' }
const ok = (text: string) => ({ text, tokensIn: 10, tokensOut: 10, model: 'test', provider: 'test', latencyMs: 1, error: '', ok: true })

async function mcpTool(name: string, args: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/v1/mcp', headers: H,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
}

/* ---------- E. 历史版本 / 时间线语义 ---------- */

test('HI-15 kb_get_document 指定历史版本时不应按“今天”过滤掉当时有效的事实', async () => {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals, quality_score)
     VALUES ('hist-doc', $1, '历史政策', 'h', 'text', 2, '["tenant:public"]'::jsonb, 1)`,
    [settings.defaultTenantId],
  )
  for (const version of ['hist-doc-v1', 'hist-doc-v2']) {
    await query(
      `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
       VALUES ($1, 'hist-doc', $2, $3, $1, 'test', $4)`,
      [version, settings.defaultTenantId, version === 'hist-doc-v1' ? 1 : 2, '历史补贴为89元。'],
    )
  }
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse, is_parent)
     VALUES ('hist-chunk-v1', 'hist-doc-v1', 'hist-doc', $1, 0, '历史补贴为89元。', '["tenant:public"]'::jsonb, ARRAY[1.0,0.0], '{}'::jsonb, false)`,
    [settings.defaultTenantId],
  )
  const entity = await getOrCreateEntity(settings.defaultTenantId, '历史政策主体')
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, valid_from, valid_to, status, acl_principals)
     VALUES ('f_hist', $1, $2, '补贴标准', '89元', '2023-01-01', '2024-01-01', 'active', '["tenant:public"]'::jsonb)`,
    [settings.defaultTenantId, entity.id],
  )
  await query(
    `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote) VALUES ('e_hist', 'f_hist', 'hist-chunk-v1', 'hist-doc', '历史补贴为89元。')`,
  )
  const res = await mcpTool('kb_get_document', { doc_id: 'hist-doc', version_id: 'hist-doc-v1' })
  const body = res.json() as { result?: { content?: Array<{ text: string }> }; error?: unknown }
  const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { facts?: unknown[] }
  assert.ok((payload.facts?.length ?? 0) > 0, `读历史版本时事实被今天的有效期过滤掉：${res.body.slice(0, 300)}`)
})

test('HI-16 时间线默认保留历史，当前时间切片应排除过期事实', async () => {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals, quality_score)
     VALUES ('tl-doc', $1, '时间线文档', 't', 'text', 1, '["tenant:public"]'::jsonb, 1)`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ('tl-doc-v1', 'tl-doc', $1, 1, 'tl-doc-v1', 'test', '旧标准为89元。')`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse, is_parent)
     VALUES ('tl-chunk', 'tl-doc-v1', 'tl-doc', $1, 0, '旧标准为89元。', '["tenant:public"]'::jsonb, ARRAY[1.0,0.0], '{}'::jsonb, false)`,
    [settings.defaultTenantId],
  )
  const entity = await getOrCreateEntity(settings.defaultTenantId, '时间线主体')
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, valid_to, status, acl_principals)
     VALUES ('f_expired', $1, $2, '补贴标准', '89元', '2024-01-01', 'active', '["tenant:public"]'::jsonb)`,
    [settings.defaultTenantId, entity.id],
  )
  await query(
    `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote) VALUES ('e_expired', 'f_expired', 'tl-chunk', 'tl-doc', '旧标准为89元。')`,
  )
  const res = await mcpTool('kb_entity_timeline', { name: '时间线主体' })
  const body = res.json() as { result?: { content?: Array<{ text: string }> } }
  const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { timeline: Array<{ id: string }> }
  assert.ok(payload.timeline.some(fact => fact.id === 'f_expired'), '无时间切片的历史时间线应保留旧记录')
  const current = await mcpTool('kb_entity_timeline', { name: '时间线主体', as_of: todayLocal(settings.timezone) })
  assert.equal(current.json().error, undefined)
  const currentTimeline = JSON.parse(current.json().result.content[0].text).timeline as Array<{ id: string }>
  assert.ok(!currentTimeline.some(fact => fact.id === 'f_expired'), '当前时间切片不得返回已过期事实')
})

/* ---------- F. 拒答与置信度 ---------- */

test('HI-17 先否定某项再给出有据结论，不应被拒答前缀正则误判为拒答', async () => {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals, quality_score)
     VALUES ('ref-doc', $1, '拒答文档', 'r', 'text', 1, '["tenant:public"]'::jsonb, 1)`,
    [settings.defaultTenantId],
  )
  const text = '现有信息没有提到例外情况，但标准明确为89元。'
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ('ref-v1', 'ref-doc', $1, 1, 'ref-v1', 'test', $2)`,
    [settings.defaultTenantId, text],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse, is_parent)
     VALUES ('ref-chunk', 'ref-v1', 'ref-doc', $1, 0, $2, '["tenant:public"]'::jsonb, ARRAY[1.0,0.0], '{}'::jsonb, false)`,
    [settings.defaultTenantId, text],
  )
  harness.ask = async () => ok(`${text}[1]`)
  const result = await ask(workspace.principal, { question: '标准是什么', mode: 'quick', evaluation: true })
  assert.equal(result.refused, false, `合法回答被拒答前缀误判：failure=${JSON.stringify(result.failure)} answer=${result.answer}`)
})

/* ---------- G. 类型校验 / 数据污染 ---------- */

test('HI-18 acl 传字符串不应让后台摄入任务永久失败（应 400）', async () => {
  let error: Error | null = null
  try {
    await ingestParsed(workspace.principal, parseTextContent('类型混淆内容', 'ACL 类型文档'), {
      sourceType: 'text', uri: 'audit:acl-type', acl: 'tenant:public' as unknown as string[],
    })
  } catch (e) { error = e as Error }
  assert.ok(error, 'acl 字符串应被拒绝')
  assert.equal((error as Error & { statusCode?: number }).statusCode, 400,
    `应返回 400 参数错误，实际 ${error?.message}`)
})

test('HI-19 /meta 未认证不应暴露内部模型与阈值配置', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/meta' })
  assert.ok([401, 403].includes(res.statusCode) || !/deepseek|volcengine|rerank_threshold/i.test(res.body),
    `未认证 /meta 暴露内部配置：${res.statusCode} ${res.body.slice(0, 300)}`)
})

test('HI-20 POST /memory 传对象 text 应返回 400 而非污染数据库', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/memory', headers: H,
    payload: { text: { nested: 'value' } },
  })
  assert.equal(res.statusCode, 400, `对象类型 text 被接受：${res.statusCode} ${res.body}`)
})

test('HI-21 kb_report_gap 超长问题应被截断或拒绝', async () => {
  const question = '超长缺口'.repeat(50000)
  const res = await mcpTool('kb_report_gap', { question })
  assert.ok(res.statusCode >= 400 || res.body.includes('-32602'), `超长缺口问题被接受：${res.statusCode}`)
  const row = await q1<{ length: number }>('SELECT length(question) AS length FROM gaps ORDER BY created_at DESC LIMIT 1')
  assert.ok((row?.length ?? 0) <= 500, `gaps 表写入 ${row?.length} 字符，未做长度限制`)
})

test('HI-22 /feedback target_type 任意值应被拒绝', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/feedback', headers: H,
    payload: { target_type: 'anything', target_id: 'x', value: 1, comment: 'test' },
  })
  assert.equal(res.statusCode, 400, `任意 target_type 被接受：${res.statusCode} ${res.body}`)
})

test('HI-29 kb_entity_timeline：后续不可读时，可读前序的事实不应消失', async () => {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals, quality_score)
     VALUES ('tl-old', $1, '公开前序', 'o', 'text', 1, '["tenant:public"]'::jsonb, 1),
            ('tl-new', $1, '受限后续', 'n', 'text', 1, '["user:u_linker"]'::jsonb, 1)`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ('tl-old-v1', 'tl-old', $1, 1, 'tl-old-v1', 'test', '旧时间线规则'),
            ('tl-new-v1', 'tl-new', $1, 1, 'tl-new-v1', 'test', '新时间线规则')`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse, is_parent)
     VALUES ('tl-old-chunk', 'tl-old-v1', 'tl-old', $1, 0, '旧时间线规则', '["tenant:public"]'::jsonb, ARRAY[1.0,0.0], '{}'::jsonb, false)`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO users (id, tenant_id, name, role, groups, token, status)
     VALUES ('u_linker', $1, 'Linker', 'editor', '["everyone"]'::jsonb, 'linker-token', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO document_continuations (id, tenant_id, predecessor_doc_id, successor_doc_id, effective_date, created_by)
     VALUES ('cont_hi29', $1, 'tl-old', 'tl-new', '2026-01-01', 'u_linker')`,
    [settings.defaultTenantId],
  )
  const entity = await getOrCreateEntity(settings.defaultTenantId, '时间线沿革主体')
  await query(
    `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, status, acl_principals)
     VALUES ('f_tl_old', $1, $2, '适用规则', '旧规则', 'active', '["tenant:public"]'::jsonb)`,
    [settings.defaultTenantId, entity.id],
  )
  await query(
    `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote) VALUES ('e_tl_old', 'f_tl_old', 'tl-old-chunk', 'tl-old', '旧时间线规则')`,
  )
  const res = await mcpTool('kb_entity_timeline', { name: '时间线沿革主体' })
  const body = res.json() as { result?: { content?: Array<{ text: string }> } }
  const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as { timeline?: Array<{ id: string }> }
  assert.ok((payload.timeline ?? []).some((fact) => fact.id === 'f_tl_old'),
    `前序可读、后续不可读时时间线为空：${res.body.slice(0, 300)}`)
})
