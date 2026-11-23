// Core audit regressions. Historical probes remain in tests/audit/bugs.test.ts.
// Role permissions and review/gap visibility are deferred at the user's request.
// A6 supplies the trusted as_of context used by ask(); wording is independently verified in live mode.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { settings } from '../src/config.js'
import { createServer } from '../src/app/server.js'
import { sparseVector, tokenize } from '../src/adapters/embeddings/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { validateGrounding, checkSemanticGrounding } from '../src/core/grounding.js'
import { retrieve, linkEntities } from '../src/core/retrieval.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { reindexDocument } from '../src/core/reindexing.js'
import { trashDocument, purgeDocument } from '../src/core/trash.js'
import { linkContinuation } from '../src/core/continuation.js'
import { extractFactsForDocument } from '../src/core/learning.js'
import { ask } from '../src/core/answering.js'
import { parseTextContent } from '../src/adapters/parsing/index.js'
import type { Principal } from '../src/core/security.js'

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

test('A6 ISO 日期不应被拆成 -06/-01 这种带符号碎片去核对（线上 as_of 问答已复现）', () => {
  const check = validateGrounding('该标准在2024-06-01这一时间切片内有效[1]。', [{ text: '2024年，基本公共卫生服务经费人均财政补助标准为94元。' }], { asOf: '2024-06-01', checkWording: false })
  assert.equal(check.valid, true, `ISO 日期被拆碎误拒：${JSON.stringify(check.issues)}`)
})

test('A7 康熙部首变体字（PDF 常见）应归一为正常汉字再分词', async () => {
  const { tokenize } = await import('../src/adapters/embeddings/index.js')
  const tokens = tokenize('⼈均财政补助标准')
  assert.ok(tokens.includes('人') && tokens.includes('人均'), `部首字⼈被分词丢弃：${JSON.stringify(tokens)}`)
})

test('A8 部首变体字实体名不应与正常写法分裂成两个实体', async () => {
  const { getOrCreateEntity, normalizeName } = await import('../src/core/learning.js')
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




/* ---------------- H. 列表分页 ---------------- */

test('H1 文档列表 total 应是过滤后的总数，而不是当前页条数', async () => {
  for (let i = 0; i < 25; i += 1) await sqlDocument(`bulk-${i}`, `批量文档${i}`)
  const response = await app.inject({ method: 'GET', url: '/api/v1/documents?limit=10', headers: workspace.headers })
  const body = response.json()
  assert.equal(body.total, 25, `total=${body.total}（实际共 25 篇，分页信息错误）`)
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


test('grounding enforces numeric boundaries even for a bare value or sign change', () => {
  for (const [answer, source] of [['5%[1]', '15%'], ['100元[1]', '-100元'], ['100元[1]', '1000元']]) {
    assert.equal(validateGrounding(answer!, [{text:source!}], {checkWording:false}).valid, false)
  }
})

test('grounding accepts complete ISO dates and rejects invented event dates even with as_of', () => {
  assert.equal(validateGrounding('于2024-06-01发布[1]。', [{text:'于2024年6月1日发布。'}]).valid, true)
  assert.equal(validateGrounding('于2024-06-01发布[1]。', [{text:'2024年发布。',context:'检索时间切片：2024-06-01'}], {asOf:'2024-06-01',checkWording:false}).valid, false)
  assert.equal(validateGrounding('在2024-06-02这一时间切片内有效[1]。', [{text:'2024年标准为94元。'}], {asOf:'2024-06-01',checkWording:false}).valid, false)
})

test('fenced excerpts accept prefix citations but reject mutations, embedded citation data and unclosed fences', () => {
  const source = 'const VERSION = "[1]"\nconst MAX = 512'
  assert.equal(validateGrounding('包含 `MAX` 的原文如下[1]：\n```ts\nconst MAX = 512\n```', [{text:source}]).valid, true)
  for (const answer of ['```ts\nconst MAX = 513\n```\n[1]', '```ts\nconst VERSION = "[1]"\n```', '```ts\nconst MAX = 512\n[1]']) {
    assert.equal(validateGrounding(answer, [{text:source}]).valid, false)
  }
})

test('source metadata supports document and chapter claims without becoming citation quote text', () => {
  const check = validateGrounding('该片段位于 Aurora 章节[1]。', [{text:'const MAX = 512',context:'该片段位于 Aurora 章节。'}])
  assert.equal(check.valid,true)
  assert.equal(check.quotes[1],'const MAX = 512')
})

test('model JSON parsing handles quoted braces and a fenced object, and rejects ambiguous multiple objects', async () => {
  harness.complete = async () => ok('```json\n{"supported":true,"unsupported_sentences":[],"note":"a } brace"}\n```')
  assert.equal((await checkSemanticGrounding('test[1]',[{text:'test'}])).supported,true)
  harness.complete = async () => ok('{"supported":true,"unsupported_sentences":[]} {"supported":false,"unsupported_sentences":[]}')
  await assert.rejects(checkSemanticGrounding('test[1]',[{text:'test'}]), /JSON/)
})

test('all list routes reject invalid limits and entity detail rejects invalid as_of', async () => {
  for (const route of ['documents','conversations','facts','entities','graph','traces','chat-feedback']) {
    const response=await app.inject({method:'GET',url:`/api/v1/${route}?limit=abc`,headers:workspace.headers})
    assert.equal(response.statusCode,400,`${route}: ${response.body}`)
  }
  const response=await app.inject({method:'GET',url:'/api/v1/entities/missing?as_of=2024-02-30',headers:workspace.headers})
  assert.equal(response.statusCode,400)
})

test('empty document status defaults to active and pagination counts every visible page', async () => {
  for (const id of ['page-active','page-trashed']) await sqlDocument(id,id)
  await query("UPDATE documents SET status='tombstoned' WHERE id='page-trashed'")
  const response=await app.inject({method:'GET',url:'/api/v1/documents?status=&limit=1',headers:workspace.headers})
  assert.equal(response.json().total,1)
  assert.equal(response.json().items[0].id,'page-active')
})

test('missing target years overlap a dated target but two explicit years stay independent', async () => {
  const {relationSlotsOverlap}=await import('../src/core/relation-types.js')
  assert.equal(relationSlotsOverlap('2030年目标为','目标为'),true)
  assert.equal(relationSlotsOverlap('2030年目标为','2025年目标为'),false)
})

test('short entity substrings do not link unrelated names and ties are deterministic', async () => {
  const {getOrCreateEntity}=await import('../src/core/learning.js')
  await getOrCreateEntity(settings.defaultTenantId,'Aurora')
  assert.equal((await linkEntities(workspace.principal,'ora')).length,0)
  for (const name of ['Orchid','Zephyr']) await getOrCreateEntity(settings.defaultTenantId,name)
  const first=await linkEntities(workspace.principal,'Aurora Orchid Zephyr')
  assert.deepEqual(first.map(row=>row.id),(await linkEntities(workspace.principal,'Aurora Orchid Zephyr')).map(row=>row.id))
})

test('sparse indexing retains a rare discriminating word after frequent common terms', () => {
  const words=Array.from({length:110},(_,index)=>`common${index}`)
  const vector=sparseVector([...words,...words,'discriminating'])
  assert.ok(vector.discriminating)
})

test('purging one document preserves unrelated orphan entities and continuation continuity', async () => {
  for (const id of ['purge-a','purge-b','purge-c']) { await sqlDocument(id,id); await sqlVersionChunk(id,'Aurora policy rule') }
  await link('purge-b',{other_doc_id:'purge-a',relation:'continues',effective_date:'2025-01-01'})
  await link('purge-c',{other_doc_id:'purge-b',relation:'continues',effective_date:'2026-01-01'})
  const {getOrCreateEntity}=await import('../src/core/learning.js')
  const unrelated=await getOrCreateEntity(settings.defaultTenantId,'new standalone entity')
  await trashDocument(workspace.principal,'purge-b')
  await purgeDocument(workspace.principal,'purge-b')
  assert.ok(await queryOne('SELECT id FROM entities WHERE id=$1',[unrelated.id]))
  assert.deepEqual([...new Set((await retrieve(workspace.principal,'Aurora policy rule')).hits.map(hit=>hit.document.id))],['purge-c'])
})

test('enrichment processes the queued document after the initiating identity loses access, and repairs historical identity failures', async () => {
  const {enqueueEnrichment,processEnrichmentQueue}=await import('../src/core/enrichment-queue.js')
  const result=await ingestParsed(workspace.principal,parseTextContent('产品X的额定功率为100瓦','worker source'),{sourceType:'text'})
  const id=String(result.document_id)
  await enqueueEnrichment({query},otherPrincipal(),id,1)
  await query("UPDATE documents SET acl_principals='[\"user:nobody\"]',enrichment_status='failed',enrichment_error='任务主体无法访问当前文档' WHERE id=$1",[id])
  await query("UPDATE jobs SET status='failed',error='任务主体无法访问当前文档' WHERE type='enrich' AND payload->>'document_id'=$1",[id])
  stubExtraction({'worker source':[powerCandidate(null,null)]})
  await processEnrichmentQueue()
  assert.equal((await queryOne<{enrichment_status:string}>('SELECT enrichment_status FROM documents WHERE id=$1',[id]))?.enrichment_status,'done')
  const fact=await queryOne<{acl_principals:string[]}>('SELECT acl_principals FROM facts WHERE source_doc_id=$1',[id])
  assert.deepEqual(fact?.acl_principals,['user:nobody'])
})


test('compare still splits actual conjunctions while preserving compound names', async () => {
  const result=await ask(workspace.principal,{question:'北京和上海的补贴标准有什么区别',mode:'compare',evaluation:true})
  const queries=(result.stats as {subqueries:string[]}).subqueries
  assert.ok(queries.includes('北京'))
  assert.ok(queries.some(query=>query.startsWith('上海')))
})


test('parser normalizes PDF radicals without rewriting code or mathematical symbols', () => {
  assert.equal(parseTextContent('⼈均标准①与 x²','PDF').blocks[0]!.text,'人均标准①与 x²')
})

test('Ark applies configured Query instructions only to query embeddings', async (t) => {
  const {createEmbedder}=await import('../src/adapters/embeddings/index.js')
  const previous={embeddingBaseUrl:settings.embeddingBaseUrl,embeddingDim:settings.embeddingDim,embeddingInstructions:settings.embeddingInstructions}
  Object.assign(settings,{embeddingBaseUrl:'http://embedding-fixture',embeddingDim:2,embeddingInstructions:'Query:'})
  const inputs:Record<string,unknown>[]=[]
  t.mock.method(globalThis,'fetch',async (_url:unknown,options:RequestInit)=>{
    inputs.push(JSON.parse(String(options.body)))
    return Response.json({data:{embedding:[1,0]}})
  })
  try {
    const adapter=createEmbedder('ark')
    await adapter.embed('document')
    await adapter.embedQuery('question')
    assert.equal(Object.hasOwn(inputs[0]!,'instructions'),false)
    assert.equal(inputs[1]!.instructions,'Query:')
  } finally { Object.assign(settings,previous) }
})

test('one failed tenant does not skip later tenants during daily maintenance', async () => {
  const {runDailyReflection}=await import('../src/core/scheduling.js')
  const previous=settings.reflectionRunAt
  settings.reflectionRunAt='00:00'
  await query("INSERT INTO tenants(id,name) VALUES('aaa-broken','Broken tenant')")
  await query(`CREATE FUNCTION audit_reject_reflection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.tenant_id='aaa-broken' THEN RAISE EXCEPTION 'injected tenant failure'; END IF; RETURN NEW; END $$`)
  await query('CREATE TRIGGER audit_reflection_failure BEFORE INSERT ON reflection_runs FOR EACH ROW EXECUTE FUNCTION audit_reject_reflection()')
  try {
    await assert.rejects(runDailyReflection(new Date('2026-11-18T12:00:00Z')),AggregateError)
    assert.equal((await queryOne<{status:string}>("SELECT status FROM jobs WHERE type='reflection_schedule' AND tenant_id='aaa-broken'"))?.status,'failed')
    assert.equal((await queryOne<{status:string}>("SELECT status FROM jobs WHERE type='reflection_schedule' AND tenant_id=$1",[settings.defaultTenantId]))?.status,'done')
  } finally {
    settings.reflectionRunAt=previous
    await query('DROP TRIGGER audit_reflection_failure ON reflection_runs')
    await query('DROP FUNCTION audit_reject_reflection()')
    await query("DELETE FROM jobs WHERE tenant_id='aaa-broken'")
    await query("DELETE FROM tenants WHERE id='aaa-broken'")
  }
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
    const { submitIngest } = await import('../src/core/ingestion.js')
    await assert.rejects(submitIngest(workspace.principal, 'url', { url: `http://127.0.0.1:${port}/internal-secret` }),
      (error: unknown) => (error as { statusCode: number }).statusCode === 400 && /不允许/.test(String(error)))
    assert.equal((await query('SELECT id FROM jobs')).length, 0)
    assert.equal((await query('SELECT id FROM documents')).length, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})


test('an exact metadata label above a cited excerpt is allowed, but invented labels and uncited labels are rejected', () => {
  const evidence=[{text:'const MAX = 512',context:'文档：source.ts；章节：source.ts / MAX'}]
  assert.equal(validateGrounding('章节：source.ts / MAX\n```ts\nconst MAX = 512\n```\n[1]',evidence).valid,true)
  assert.equal(validateGrounding('章节：invented.ts / MAX\n```ts\nconst MAX = 512\n```\n[1]',evidence).valid,false)
  assert.equal(validateGrounding('章节：source.ts / MAX',evidence).valid,false)
})

test('a dated and undated contradictory target creates a conflict review', async () => {
  const candidates=[
    {title:'target old',predicate:'2030年目标为',value:'100瓦',quote:'产品X2030年目标为100瓦'},
    {title:'target new',predicate:'目标为',value:'200瓦',quote:'产品X目标为200瓦'},
  ]
  stubExtraction(Object.fromEntries(candidates.map(candidate=>[candidate.title,[{...powerCandidate(null,null),predicate:candidate.predicate,object_literal:candidate.value,quote:candidate.quote}]])))
  for (const candidate of candidates) {
    const doc=await ingestParsed(workspace.principal,parseTextContent(candidate.quote,candidate.title),{sourceType:'text'})
    await extractFactsForDocument(workspace.principal,String(doc.document_id))
  }
  assert.equal((await query("SELECT id FROM review_queue WHERE kind='fact_conflict' AND status='open'")).length,1)
})

test('accepting an undated assertion preserves the old explicit expiry instead of using today', async () => {
  await sqlDocument('expiry-doc','expiry source')
  const {chunkId}=await sqlVersionChunk('expiry-doc','产品Y的额定功率为200瓦')
  await query(`INSERT INTO entities (id,tenant_id,canonical_name,normalized_name,acl_principals) VALUES ('expiry-entity',$1,'产品Y','产品y','["tenant:public"]')`,[settings.defaultTenantId])
  await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,status,valid_from,valid_to,acl_principals,source_doc_id)
    VALUES('expiry-old',$1,'expiry-entity','额定功率为','100瓦','active','2020-01-01','2025-01-01','["tenant:public"]','expiry-doc'),
          ('expiry-new',$1,'expiry-entity','额定功率为','200瓦','disputed',NULL,NULL,'["tenant:public"]','expiry-doc')`,[settings.defaultTenantId])
  await query("INSERT INTO fact_evidence(id,fact_id,doc_id,chunk_id,quote) VALUES('expiry-evidence','expiry-new','expiry-doc',$1,'产品Y的额定功率为200瓦')",[chunkId])
  await query(`INSERT INTO review_queue(id,tenant_id,kind,payload) VALUES('expiry-review',$1,'fact_conflict','{"new_fact_id":"expiry-new","old_fact_ids":["expiry-old"]}')`,[settings.defaultTenantId])
  const response=await app.inject({method:'POST',url:'/api/v1/review/expiry-review/resolve',headers:workspace.headers,payload:{action:'accept_new'}})
  assert.equal(response.statusCode,200,response.body)
  assert.equal((await queryOne<{valid_to:string}>('SELECT valid_to::text FROM facts WHERE id=$1',['expiry-old']))?.valid_to,'2025-01-01')
})


test('an unfenced verbatim code excerpt uses its trailing citation as one unit', () => {
  const source='export function test() {\n  const value = 42\n'
  assert.equal(validateGrounding(source+'\n[1]',[{text:source}]).valid,true)
  assert.equal(validateGrounding(source+'}\n[1]',[{text:source}]).valid,false)
  assert.equal(validateGrounding('const value = "[1]"',[{text:'const value = "[1]"'}]).valid,false)
})

test('answers cannot cite uncited parent context under a child evidence number', async () => {
  const text='Orchid quota is 10MB.\n'+('background explanation '.repeat(700))+'\nPARENT_ONLY_MARKER'
  const doc=await ingestParsed(workspace.principal,parseTextContent(text,'Orchid policy'),{sourceType:'text'})
  const selected=await retrieve(workspace.principal,'Orchid quota',{topK:1,docIds:[String(doc.document_id)]})
  assert.ok(selected.hits[0]!.parentText.includes('PARENT_ONLY_MARKER'))
  assert.ok(!selected.hits[0]!.chunk.text.includes('PARENT_ONLY_MARKER'))
  harness.ask=async (_id,prompt) => {
    assert.ok(!prompt.includes('PARENT_ONLY_MARKER'),'a child citation must not lend its ID to the larger parent context')
    return ok('Orchid quota is 10MB.[1]')
  }
  assert.equal((await ask(workspace.principal,{question:'Orchid quota',topK:1,docIds:[String(doc.document_id)],evaluation:true})).refused,false)
})


test('organization splitting supports other domains and preserves names containing conjunction characters', async () => {
  const candidates=[
    {title:'named organization',subject:'华东协和集团',quote:'每个华东协和集团均配备100台设备'},
    {title:'distributed organizations',subject:'Alpha实验室和Beta工坊',quote:'每个Alpha实验室和Beta工坊均配备100台设备'},
  ]
  stubExtraction(Object.fromEntries(candidates.map(candidate=>[candidate.title,[{...powerCandidate(null,null),subject:candidate.subject,subject_type:'org',predicate:'配备',object_literal:'100台设备',quote:candidate.quote}]])))
  for (const candidate of candidates) {
    const doc=await ingestParsed(workspace.principal,parseTextContent(candidate.quote,candidate.title),{sourceType:'text'})
    await extractFactsForDocument(workspace.principal,String(doc.document_id))
  }
  const names=(await query<{canonical_name:string}>('SELECT canonical_name FROM entities')).map(row=>row.canonical_name).sort()
  assert.deepEqual(names,['Alpha实验室','Beta工坊','华东协和集团'].sort())
})


test('literal code is proved by exact text; paraphrased prose still requires independent semantics', async () => {
  const source='export function partial() {\n  return 42'
  const excerpt='《source.ts》中，包含 `partial` 的原文如下：\n```ts\n'+source+'\n```\n[1]'
  const literal=validateGrounding(excerpt,[{text:source}])
  assert.equal(literal.valid,true)
  assert.equal(literal.semanticRequired,false)
  assert.equal(validateGrounding('函数返回42[1]。',[{text:source}],{checkWording:false}).semanticRequired,true)
  const doc=await ingestParsed(workspace.principal,parseTextContent(source,'source.ts'),{sourceType:'text'})
  const previous=settings.groundingVerifier
  settings.groundingVerifier=true
  harness.ask=async()=>ok(excerpt)
  harness.complete=async()=>{throw new Error('exact excerpts do not require a model entailment guess')}
  try {
    assert.equal((await ask(workspace.principal,{question:'《source.ts》 partial',docIds:[String(doc.document_id)],evaluation:true})).refused,false)
  } finally {settings.groundingVerifier=previous}
})


test('numeric brackets inside quoted code do not create extra citation rows', async () => {
  const source=await ingestParsed(workspace.principal,parseTextContent('const values = [2]','Code values'),{sourceType:'text'})
  await ingestParsed(workspace.principal,parseTextContent('Other values documented here.','Other values'),{sourceType:'text'})
  harness.ask=async()=>ok('```ts\nconst values = [2]\n```\n[1]')
  const result=await ask(workspace.principal,{question:'const values',topK:2,evaluation:true})
  assert.equal(result.refused,false)
  assert.deepEqual((result.citations as Array<{doc_id:string}>).map(row=>row.doc_id),[String(source.document_id)])
})
