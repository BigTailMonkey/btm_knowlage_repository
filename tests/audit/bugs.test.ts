/**
 * 对抗性审计探针（不属于常规回归套件，npm test 的 tests/*.test.ts 不会拾取本目录）。
 * 每个测试断言「正确行为」；测试失败 = 实证了一个 BUG。
 * 运行：node --import tsx --test --test-concurrency=1 tests/audit/bugs.test.ts
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from '../helpers.js'
import { query, queryOne } from '../../src/db/index.js'
import { settings } from '../../src/config.js'
import { createServer } from '../../src/app/server.js'
import { sparseVector, tokenize } from '../../src/adapters/embeddings/index.js'
import { harness } from '../../src/adapters/harness/index.js'
import { validateGrounding } from '../../src/core/grounding.js'
import { retrieve } from '../../src/core/retrieval.js'
import { ingestParsed } from '../../src/core/ingestion.js'
import { reindexDocument } from '../../src/core/reindexing.js'
import { trashDocument } from '../../src/core/trash.js'
import { linkContinuation } from '../../src/core/continuation.js'
import { extractFactsForDocument } from '../../src/core/learning.js'
import { ask } from '../../src/core/answering.js'
import { parseTextContent } from '../../src/adapters/parsing/index.js'
import type { Principal } from '../../src/core/security.js'

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

const ok = (text: string) => ({ text, tokensIn: 10, tokensOut: 10, model: 'test', provider: 'test', latencyMs: 1, error: '', ok: true })

async function sqlDocument(id: string, title: string, acl = '["tenant:public"]') {
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, source_type, current_version, acl_principals, quality_score)
     VALUES ($1, $2, $3, $1, 'text', 1, $4::jsonb, 1)`,
    [id, settings.defaultTenantId, title, acl],
  )
}
async function sqlVersionChunk(docId: string, text: string, chunkId = `${docId}-chunk`) {
  const versionId = `${docId}-v1`
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ($1, $2, $3, 1, $1, 'test', $4)`,
    [versionId, docId, settings.defaultTenantId, text],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, seq, text, acl_principals, dense, sparse, is_parent)
     VALUES ($1, $2, $3, $4, 0, $5, '["tenant:public"]', ARRAY[1.0,0.0], $6::jsonb, false)`,
    [chunkId, versionId, docId, settings.defaultTenantId, text, JSON.stringify(sparseVector(tokenize(text)))],
  )
  return { versionId, chunkId }
}
async function link(docId: string, payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: `/api/v1/documents/${docId}/continuation`, headers: workspace.headers, payload })
  assert.equal(response.statusCode, 200, response.body)
}
async function makeUser(id: string, role: string, groups: string[], token: string) {
  await query(
    `INSERT INTO users (id, tenant_id, name, role, groups, token, status) VALUES ($1,$2,$1,$3,$4::jsonb,$5,'active')`,
    [id, settings.defaultTenantId, role, JSON.stringify(groups), token],
  )
}
const otherPrincipal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: 'u_other', tenantId: settings.defaultTenantId, name: 'Other', role: 'editor',
  groups: ['everyone'], token: 'other-token', ...overrides,
})

/* ---------------- A. 引用核验（grounding） ---------------- */

test('A1 数字子串误配：证据写 15%，回答声称 5% 不应通过核验', () => {
  const check = validateGrounding('增长率为5%[1]。', [{ text: '增长率达到15%。' }])
  assert.equal(check.valid, false, `错误数字被放行：${JSON.stringify(check)}`)
})

test('A2 数字子串误配：证据写 1000 元，回答声称 100 元不应通过核验', () => {
  const check = validateGrounding('总额为100元[1]。', [{ text: '总额为1000元。' }])
  assert.equal(check.valid, false, `错误数字被放行：${JSON.stringify(check)}`)
})

test('A3 千分位写法：1,000 元与 1000 元是同一个数，不应误拒', () => {
  const check = validateGrounding('总额为1,000元[1]。', [{ text: '总额为1000元。' }])
  assert.equal(check.valid, true, `同值数字被误拒：${JSON.stringify(check.issues)}`)
})

test('A4 分号复句：句尾引用覆盖整个复句，前半句不应被判为无引用', () => {
  const check = validateGrounding('系统支持甲；支持乙[1]。', [{ text: '系统支持甲；支持乙。' }])
  assert.equal(check.valid, true, `复句被误拒：${JSON.stringify(check.issues)}`)
})

test('A5 中文数字：证据写 3 天，回答写三天，不应误拒', () => {
  const check = validateGrounding('期限为三天[1]。', [{ text: '期限为3天。' }])
  assert.equal(check.valid, true, `中文数字被误拒：${JSON.stringify(check.issues)}`)
})

// 补齐真实 ask() 链路的可信 as_of 上下文；措辞交由独立语义核验，事件日期仍须逐字有据。
test('A6 ISO 日期不应被拆成 -06/-01 这种带符号碎片去核对（线上 as_of 问答已复现）', () => {
  const check = validateGrounding('该标准在2024-06-01这一时间切片内有效[1]。', [{ text: '2024年，基本公共卫生服务经费人均财政补助标准为94元。' }], { asOf: '2024-06-01', checkWording: false })
  assert.equal(check.valid, true, `ISO 日期被拆碎误拒：${JSON.stringify(check.issues)}`)
})

test('A7 康熙部首变体字（PDF 常见）应归一为正常汉字再分词', async () => {
  const { tokenize } = await import('../../src/adapters/embeddings/index.js')
  const tokens = tokenize('⼈均财政补助标准')
  assert.ok(tokens.includes('人') && tokens.includes('人均'), `部首字⼈被分词丢弃：${JSON.stringify(tokens)}`)
})

test('A8 部首变体字实体名不应与正常写法分裂成两个实体', async () => {
  const { getOrCreateEntity, normalizeName } = await import('../../src/core/learning.js')
  assert.equal(normalizeName('⼈均补助'), normalizeName('人均补助'), '归一化未覆盖部首变体字')
  const a = await getOrCreateEntity(settings.defaultTenantId, '人均补助')
  const b = await getOrCreateEntity(settings.defaultTenantId, '⼈均补助')
  assert.equal(a.id, b.id, '同一名称的部首变体被建为两个实体')
})

/* ---------------- B. 重建索引与摄入的向量输入不一致 ---------------- */

test('B1 重建检索索引后，标题/章节词不应从稀疏向量中丢失', async () => {
  const parsed = parseTextContent('本协议规定了 Aurora 系统的基本运行规则与限制条件。', 'Zephyr 运行手册')
  const result = await ingestParsed(workspace.principal, parsed, { sourceType: 'text', uri: 'audit:b1' })
  const docId = String(result.document_id)
  const before = await queryOne<{ sparse: Record<string, number> }>('SELECT sparse FROM chunks WHERE doc_id=$1 AND is_parent=false', [docId])
  assert.ok(before!.sparse['zephyr'], '摄入时标题词应进入稀疏向量')
  await reindexDocument(settings.defaultTenantId, docId)
  const after = await queryOne<{ sparse: Record<string, number> }>('SELECT sparse FROM chunks WHERE doc_id=$1 AND is_parent=false', [docId])
  assert.ok(after!.sparse['zephyr'], `重建索引后标题词丢失，稀疏向量变为 ${JSON.stringify(after!.sparse)}`)
})

/* ---------------- C. 上传 URI 撞名：跨用户覆盖 / 拒绝 ---------------- */

test('C1 他人同名文件上传不应改写我的公开文档（upload:文件名 跨用户撞名）', async () => {
  const mine = await ingestParsed(workspace.principal, parseTextContent('我的原始内容甲。', '共享报告'), { sourceType: 'text', uri: 'upload:report.pdf', duplicatePolicy: 'ask' })
  const myDocId = String(mine.document_id)
  const theirs = await ingestParsed(otherPrincipal(), parseTextContent('完全不同的内容乙。', '另一份报告'), { sourceType: 'text', uri: 'upload:report.pdf', duplicatePolicy: 'ask' })
  assert.notEqual(String(theirs.document_id), myDocId, `他人上传同名文件变成了我的文档的新版本 v${theirs.version}`)
  const myDoc = await queryOne<{ current_version: number }>('SELECT current_version FROM documents WHERE id=$1', [myDocId])
  assert.equal(myDoc!.current_version, 1, '我的文档被他人上传覆盖')
})

test('C2 他人私有文档的同名文件不应挡住我的正常上传', async () => {
  await ingestParsed(workspace.principal, parseTextContent('私有内容甲。', '私有报告'), { sourceType: 'text', uri: 'upload:secret.pdf', acl: ['user:u_owner'], duplicatePolicy: 'ask' })
  let error: Error | null = null
  try {
    await ingestParsed(otherPrincipal(), parseTextContent('我的内容乙。', '我的报告'), { sourceType: 'text', uri: 'upload:secret.pdf', duplicatePolicy: 'ask' })
  } catch (e) { error = e as Error }
  assert.equal(error, null, `同名私有文档导致他人上传被拒：${error?.message}`)
})

test('C3 无 URI 文本摄入的内容去重不应跨越 ACL 边界', async () => {
  const text = '完全相同的一段机密内容，用于去重测试。'
  const mine = await ingestParsed(workspace.principal, parseTextContent(text, '机密件'), { sourceType: 'text', acl: ['user:u_owner'] })
  const theirs = await ingestParsed(otherPrincipal(), parseTextContent(text, '我的副本'), { sourceType: 'text' })
  assert.notEqual(String(theirs.document_id), String(mine.document_id),
    `他人摄入相同内容被静默去重到我的私有文档 ${theirs.document_id}（duplicate=${theirs.duplicate}）`)
})

/* ---------------- D. 沿革（continuation）与回收站/ACL 的交互 ---------------- */

test('D1 中间文档进回收站后，不应同时有新旧两代政策生效', async () => {
  await sqlDocument('gen-a', '政策A')
  await sqlDocument('gen-b', '政策B')
  await sqlDocument('gen-c', '政策C')
  await sqlVersionChunk('gen-a', 'Aurora policy generation A rule')
  await sqlVersionChunk('gen-b', 'Aurora policy generation B rule')
  await sqlVersionChunk('gen-c', 'Aurora policy generation C rule')
  await link('gen-b', { other_doc_id: 'gen-a', relation: 'continues', effective_date: '2025-01-01' })
  await link('gen-c', { other_doc_id: 'gen-b', relation: 'continues', effective_date: '2026-01-01' })
  await trashDocument(workspace.principal, 'gen-b')
  const result = await retrieve(workspace.principal, 'Aurora policy rule')
  const docs = [...new Set(result.hits.map((hit) => hit.document.id))].sort()
  assert.deepEqual(docs, ['gen-c'], `回收站中间代后同时召回了 ${docs.join('、')}（应只剩现行代）`)
})

test('D2 后续文档不可读时，可读的前序文档不应从检索中整体消失', async () => {
  await sqlDocument('pub-old', '公开旧政策')
  await sqlDocument('priv-new', '受限新政策', '["user:u_linker"]')
  await sqlVersionChunk('pub-old', 'Aurora public old policy rule')
  await sqlVersionChunk('priv-new', 'Aurora restricted new policy rule')
  const linker: Principal = {
    userId: 'u_linker', tenantId: settings.defaultTenantId, name: 'Linker', role: 'editor',
    groups: ['everyone'], token: 'linker-token',
  }
  const response = await linkContinuation(linker, 'priv-new', { other_doc_id: 'pub-old', relation: 'continues', effective_date: '2026-01-01' })
  assert.ok(response)
  const result = await retrieve(workspace.principal, 'Aurora policy rule')
  assert.ok(result.hits.length > 0, '前序可读、后续不可读时检索结果为空（用户失去全部政策内容）')
})

/* ---------------- E. 事实合并：ACL 交集与有效期扩张 ---------------- */

function stubExtraction(candidatesByTitle: Record<string, unknown[]>) {
  harness.complete = async (prompt: string) => {
    if (prompt.startsWith('候选事实：')) {
      const count = prompt.split('\n').filter((line) => /^\d+\./.test(line)).length
      return ok(JSON.stringify(Array.from({ length: count }, (_, i) => ({ index: i + 1, keep: true, reason: 'ok' }))))
    }
    if (prompt.includes('原文：')) {
      const title = /文档标题：(.*)/.exec(prompt)?.[1]?.trim() ?? ''
      return ok(JSON.stringify(candidatesByTitle[title] ?? []))
    }
    if (prompt.includes('"statements"')) return ok(JSON.stringify({ verdict: 'different', confidence: 0 }))
    return ok('[]')
  }
}
const powerCandidate = (from: string | null, to: string | null) => ({
  subject: '产品X', subject_type: 'product', predicate: '额定功率为', object: '', object_type: 'literal',
  object_literal: '100瓦', valid_from: from, valid_to: to, confidence: 0.9, quote: '产品X的额定功率为100瓦',
})

test('E1 不同 ACL 文档印证同一事实，事实 ACL 不应变成空集（对所有人消失）', async () => {
  await ingestParsed(workspace.principal, parseTextContent('产品X的额定功率为100瓦', '财务文档'), { sourceType: 'text', uri: 'audit:e1a', acl: ['group:finance'] })
  await ingestParsed(workspace.principal, parseTextContent('产品X的额定功率为100瓦', '工程文档'), { sourceType: 'text', uri: 'audit:e1b', acl: ['group:engineering'] })
  stubExtraction({ '财务文档': [powerCandidate(null, null)], '工程文档': [powerCandidate(null, null)] })
  const docs = await query<{ id: string; title: string }>('SELECT id,title FROM documents ORDER BY title')
  for (const doc of docs) await extractFactsForDocument(workspace.principal, doc.id)
  const fact = await queryOne<{ acl_principals: string[]; status: string }>('SELECT acl_principals,status FROM facts LIMIT 1')
  assert.ok(fact, '应抽出一条事实')
  assert.ok(fact!.acl_principals.length > 0, `两篇不同 ACL 文档印证后事实 ACL=${JSON.stringify(fact!.acl_principals)}，对所有人不可见`)
})

test('E2 无日期候选印证有有效期事实，不应把有效期扩张为无限（复活已过期事实）', async () => {
  await ingestParsed(workspace.principal, parseTextContent('产品X的额定功率为100瓦', '旧文档'), { sourceType: 'text', uri: 'audit:e2a' })
  await ingestParsed(workspace.principal, parseTextContent('产品X的额定功率为100瓦', '新文档'), { sourceType: 'text', uri: 'audit:e2b' })
  stubExtraction({ '旧文档': [powerCandidate('2024-01-01', '2025-01-01')], '新文档': [powerCandidate(null, null)] })
  const docs = await query<{ id: string; title: string }>('SELECT id,title FROM documents ORDER BY title')
  for (const doc of docs) await extractFactsForDocument(workspace.principal, doc.id)
  const fact = await queryOne<{ valid_from: string | null; valid_to: string | null }>('SELECT valid_from::text,valid_to::text FROM facts LIMIT 1')
  assert.equal(fact!.valid_to, '2025-01-01', `有效期被无日期候选扩张：valid_from=${fact!.valid_from} valid_to=${fact!.valid_to}`)
})

/* ---------------- F. 问答入口的语义劫持与上下文污染 ---------------- */

test('F1 以「记住」开头的疑问句不应被当成记忆指令吞掉', async () => {
  const result = await ask(workspace.principal, { question: '记住密码的规则是什么' })
  const memories = await query<{ id: string }>('SELECT id FROM memory_items')
  assert.equal(memories.length, 0, `疑问句被写入记忆：${JSON.stringify(result.answer)}（strategy=${(result.grounding as { strategy: string }).strategy}）`)
})

test('F2 同一会话里不相关的短问题不应拼上上一轮问题去检索', async () => {
  const first = await ask(workspace.principal, { question: '年假有几天' })
  const conversationId = String(first.conversation_id)
  const second = await ask(workspace.principal, { question: '报销流程', conversationId })
  const subqueries = (second.stats as { subqueries: string[] }).subqueries
  assert.ok(subqueries.includes('报销流程'), `检索词被污染为 ${JSON.stringify(subqueries)}`)
})

test('F3 compare 模式不应把「和平协议」拆成「平协议」这类残句去检索', async () => {
  const result = await ask(workspace.principal, { question: '和平协议的内容是什么', mode: 'compare', evaluation: true })
  const subqueries = (result.stats as { subqueries: string[] }).subqueries
  assert.ok(!subqueries.includes('平协议的内容是什么'), `产生了残句子查询 ${JSON.stringify(subqueries)}`)
})

/* ---------------- G. 审阅队列的越权与泄露 ---------------- */

test('G1 只读角色不应能裁决事实审阅项', async () => {
  await makeUser('u_viewer', 'viewer', ['everyone'], 'viewer-token')
  await query(
    `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
     VALUES ('rev-audit', $1, 'fact_conflict', '测试冲突', '{"subject":"某产品","predicate":"额定功率为","new_object":"100瓦","old_objects":["200瓦"],"quote":"机密原文"}'::jsonb, 'open')`,
    [settings.defaultTenantId],
  )
  const response = await app.inject({
    method: 'POST', url: '/api/v1/review/rev-audit/resolve',
    headers: { authorization: 'Bearer viewer-token' }, payload: { action: 'reject_new' },
  })
  assert.equal(response.statusCode, 403, `viewer 裁决审阅项返回 ${response.statusCode}：${response.body}`)
})

test('G2 审阅列表不应向无权用户泄露私有文档的原文引文', async () => {
  await makeUser('u_viewer2', 'viewer', ['everyone'], 'viewer2-token')
  await sqlDocument('priv-doc', '私有文档', '["user:u_owner"]')
  await query(
    `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
     VALUES ('rev-leak', $1, 'fact_conflict', '测试冲突', '{"subject":"某产品","predicate":"额定功率为","new_object":"100瓦","old_objects":["200瓦"],"quote":"这是私有文档里的机密原文","doc_id":"priv-doc"}'::jsonb, 'open')`,
    [settings.defaultTenantId],
  )
  const response = await app.inject({ method: 'GET', url: '/api/v1/review', headers: { authorization: 'Bearer viewer2-token' } })
  assert.equal(response.statusCode, 200)
  const items = response.json().items as Array<{ payload: { quote?: string } }>
  const leaked = items.some((item) => (item.payload?.quote ?? '').includes('机密原文'))
  assert.equal(leaked, false, '无权用户在审阅列表看到了私有文档引文')
})

test('G3 记忆晋升不应由提交者自己一键批准（自审自批）', async () => {
  await makeUser('u_editor2', 'editor', ['everyone'], 'editor2-token')
  const promote = await app.inject({
    method: 'POST', url: '/api/v1/memory', headers: { authorization: 'Bearer editor2-token' },
    payload: { text: '我自己说了算的事实' },
  })
  const memoryId = promote.json().id
  const review = await app.inject({
    method: 'POST', url: `/api/v1/memory/${memoryId}/promote`, headers: { authorization: 'Bearer editor2-token' },
  })
  const reviewId = review.json().review_id
  const resolve = await app.inject({
    method: 'POST', url: `/api/v1/review/${reviewId}/resolve`,
    headers: { authorization: 'Bearer editor2-token' }, payload: { action: 'accept_new' },
  })
  assert.notEqual(resolve.statusCode, 200, `提交者自己批准了记忆晋升：${resolve.body}`)
})

/* ---------------- H. 列表分页 ---------------- */

test('H1 文档列表 total 应是过滤后的总数，而不是当前页条数', async () => {
  for (let i = 0; i < 25; i += 1) await sqlDocument(`bulk-${i}`, `批量文档${i}`)
  const response = await app.inject({ method: 'GET', url: '/api/v1/documents?limit=10', headers: workspace.headers })
  const body = response.json()
  assert.equal(body.total, 25, `total=${body.total}（实际共 25 篇，分页信息错误）`)
})

test('H2 普通用户不应看到其他用户拒答产生的缺口问题（可能含敏感内容）', async () => {
  await makeUser('u_viewer3', 'viewer', ['everyone'], 'viewer3-token')
  await ask(workspace.principal, { question: '我的身份证号是370102199001011234吗' })
  const response = await app.inject({ method: 'GET', url: '/api/v1/gaps', headers: { authorization: 'Bearer viewer3-token' } })
  const items = response.json().items as Array<{ question: string }>
  const leaked = items.some((item) => item.question.includes('370102199001011234'))
  assert.equal(leaked, false, '其他用户的私密问题出现在缺口列表')
})

/* ---------------- J. 输入校验与 SSRF ---------------- */

test('J1 分页参数为非数字时应返回 400，而不是 500（LIMIT NaN）', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/documents?limit=abc', headers: workspace.headers })
  assert.equal(response.statusCode, 400, `limit=abc 返回 ${response.statusCode}：${response.body.slice(0, 120)}`)
})

test('J2 会话列表 limit=abc 同样不应 500', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/conversations?limit=abc', headers: workspace.headers })
  assert.equal(response.statusCode, 400, `limit=abc 返回 ${response.statusCode}`)
})

test('J3 URL 摄入不应允许抓取本机/内网服务（SSRF）', async () => {
  const http = await import('node:http')
  const secret = '内部服务机密内容。'.repeat(60)
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html><body><p>${secret}</p></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const { submitIngest, processIngestQueue, stopIngestWorker } = await import('../../src/core/ingestion.js')
    const job = await submitIngest(workspace.principal, 'url', { url: `http://127.0.0.1:${port}/internal-secret` })
    await processIngestQueue()
    await stopIngestWorker()
    const saved = await queryOne<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [String(job.job_id)])
    const docs = await query<{ title: string }>('SELECT title FROM documents')
    assert.ok(saved!.status === 'failed' || docs.length === 0,
      `内网 URL 被成功抓取入库：job=${saved!.status} docs=${JSON.stringify(docs)}（服务端可被用来探测内网）`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/* ---------------- K. 代码摘录类回答被核验器绞杀（线上评测 45/50 拒答的根因） ---------------- */

test('K1 带引用的原文代码摘录不应被逐行当作无引用事实句拒掉', () => {
  const source = 'export const MAX_TOKENS = 512\nconst OVERLAP_TOKENS = 64'
  const answer = '原文摘录：\n```\nexport const MAX_TOKENS = 512\n```\n[1]'
  const check = validateGrounding(answer, [{ text: source }])
  assert.equal(check.valid, true, `代码摘录被误拒：${JSON.stringify(check.issues)}`)
})

test('K2 结论句已正确引用时，引导语（“如下：”）不应导致整条回答被拒', () => {
  const check = validateGrounding('包含该符号的原文如下：\nMAX_TOKENS 为 512[1]。', [{ text: 'export const MAX_TOKENS = 512' }])
  assert.equal(check.valid, true, `引导语导致整条回答被拒：${JSON.stringify(check.issues)}`)
})

/* ---------------- I. 审阅 merge 动作丢失证据定位 ---------------- */

test('I1 审阅 merge 复制证据时不应丢失 span 定位', async () => {
  await sqlDocument('merge-doc', '合并文档')
  const { chunkId } = await sqlVersionChunk('merge-doc', '产品Y的额定功率为200瓦')
  await query(`INSERT INTO entities (id,tenant_id,canonical_name,normalized_name,acl_principals) VALUES ('ent-y',$1,'产品Y','产品y','["tenant:public"]')`, [settings.defaultTenantId])
  await query(
    `INSERT INTO facts (id,tenant_id,subject_id,predicate,object_literal,status,confidence,acl_principals,source_doc_id)
     VALUES ('f-old',$1,'ent-y','额定功率为','200瓦','active',0.9,'["tenant:public"]','merge-doc'),
            ('f-new',$1,'ent-y','额定功率为','300瓦','disputed',0.9,'["tenant:public"]','merge-doc')`,
    [settings.defaultTenantId],
  )
  await query(
    `INSERT INTO fact_evidence (id,fact_id,chunk_id,doc_id,quote,span,weight)
     VALUES ('ev-new','f-new',$1,'merge-doc','产品Y的额定功率为200瓦','{"start":0,"end":14}'::jsonb,1)`,
    [chunkId],
  )
  await query(
    `INSERT INTO review_queue (id,tenant_id,kind,title,payload,status)
     VALUES ('rev-merge',$1,'fact_conflict','合并测试','{"new_fact_id":"f-new","old_fact_ids":["f-old"]}'::jsonb,'open')`,
    [settings.defaultTenantId],
  )
  const response = await app.inject({
    method: 'POST', url: '/api/v1/review/rev-merge/resolve', headers: workspace.headers, payload: { action: 'merge' },
  })
  assert.equal(response.statusCode, 200, response.body)
  const copied = await queryOne<{ span: unknown }>('SELECT span FROM fact_evidence WHERE fact_id=$1', ['f-old'])
  assert.ok(copied!.span, 'merge 复制的证据 span 为空，引用高亮定位丢失')
})
