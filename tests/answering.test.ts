import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { clearKnowledge, testWorkspace } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'
import { ask, comparisonHits, type AnswerFailure } from '../src/core/answering.js'
import { Hit, retrieve } from '../src/core/retrieval.js'
import { claimSentences, validateGrounding } from '../src/core/grounding.js'
import { createServer } from '../src/app/server.js'
import { settings } from '../src/config.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>
const text = '知织支持本地文档检索，单个文件大小上限为30MB。知织的回答附带原文引用。'
const generated = (answer: string) => ({ text: answer, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', ok: true, error: null })
before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
after(async () => { await app?.close(); await workspace?.close() })
beforeEach(async () => {
  await clearKnowledge()
  harness.ask = async () => generated('知织的回答附带原文引用。[1]')
  harness.complete = async () => generated('')
  await ingestParsed(workspace.principal, parseText(text, '知织文档'), { sourceType: 'text', uri: 'fixture:knowledge' })
})

test('grounding rejects missing/invalid references, invented numbers, units and reversed polarity', () => {
  const evidence = [{ text: '知织支持本地文档检索，大小上限为30MB。' }]
  assert.equal(validateGrounding('知织支持本地文档检索。[1]', evidence).valid, true)
  assert.equal(validateGrounding('知织支持本地文档检索。[1]它会自动删除所有原文。', evidence).valid, false)
  assert.equal(validateGrounding('知织支持本地文档检索。[9]', evidence).valid, false)
  assert.equal(validateGrounding('知织支持本地文档检索，大小上限为60MB。[1]', evidence).valid, false)
  assert.equal(validateGrounding('知织支持本地文档检索，大小上限为30GB。[1]', evidence).valid, false)
  assert.equal(validateGrounding('知织不支持本地文档检索。[1]', evidence).valid, false)
  assert.equal(validateGrounding('2025年知织支持本地文档检索。[1]', evidence).valid, false)
  assert.equal(validateGrounding('const timeout = 30_000; [1]', [{ text: 'const timeout = 30_000;' }]).valid, true)
})

test('emphasis around a complete sentence retains its trailing citation without exempting uncited claims', () => {
  const evidence = [{ text: '2024年人均财政补助标准为94元。' }]
  for (const answer of ['**结论：2024年人均财政补助标准为94元。** [1]', '__2024年人均财政补助标准为94元。__ [1]', '**2024年人均财政补助标准为94元。[1]**']) {
    assert.equal(validateGrounding(answer, evidence).valid, true, answer)
  }
  assert.equal(validateGrounding('**2024年人均财政补助标准为99元。** [1]', evidence).valid, false)
  assert.equal(validateGrounding('**2024年人均财政补助标准为94元。** 无出处的结论。 [1]', evidence).valid, false)
  assert.equal(claimSentences('**没有引用的结论。**').length, 1)
})

test('ISO and Chinese time-slice labels are trusted only for the exact requested snapshot date', () => {
  const sources = [{ text: '2024年补贴标准为89元。' }]
  const options = { asOf: '2024-06-01', checkWording: false }
  for (const date of ['2024-06-01', '2024年6月1日', '２０２４年６月１日']) {
    assert.equal(validateGrounding(`截至${date}时间切片，补贴标准为89元。[1]`, sources, options).valid, true)
  }
  for (const claim of ['截至2024年6月2日时间切片，补贴标准为89元。[1]', '补贴标准从2024年6月1日生效，为89元。[1]', '2024-06-01发生了补贴变更，标准为89元。[1]']) {
    assert.equal(validateGrounding(claim, sources, options).valid, false, claim)
  }
})

test('a refusal-like opening with a citation is verified, while REFUSE and invented values still fail', async () => {
  await clearKnowledge()
  const source = '现有信息没有提到例外情况，但标准明确为89元。'
  await ingestParsed(workspace.principal, parseText(source, '标准原文'), { sourceType: 'text' })
  harness.ask = async () => generated(`${source}[1]`)
  assert.equal((await ask(workspace.principal, { question: '标准是什么？', evaluation: true })).refused, false)
  harness.ask = async () => generated('现有信息没有提到例外情况，但标准明确为999元。[1]')
  const invented = await ask(workspace.principal, { question: '标准是什么？', evaluation: true })
  assert.equal((invented.failure as AnswerFailure).stage, 'grounding')
  assert.deepEqual(invented.citations, [])
  harness.ask = async () => generated('REFUSE: 现有原文没有说明例外情况。[1]')
  const explicit = await ask(workspace.principal, { question: '例外情况是什么？', evaluation: true })
  assert.equal((explicit.failure as AnswerFailure).stage, 'model_refusal')
})

test('repeated valid references preserve citation coverage in the confidence score', async () => {
  const scores: number[] = []
  for (const count of [1, 3]) {
    harness.ask = async () => generated('知织的回答附带原文引用。[1]'.repeat(count))
    const result = await ask(workspace.principal, { question: '知织的回答有什么？', evaluation: true })
    assert.equal(result.refused, false)
    scores.push(Number(result.confidence))
  }
  assert.equal(scores[0], scores[1])
})

test('graph navigation does not advertise inferred validity dates as quotable evidence', async () => {
  await query(`INSERT INTO entities (id, tenant_id, canonical_name, normalized_name, acl_principals)
    VALUES ('kw', $1, '知织', '知织', '["tenant:public"]')`, [workspace.principal.tenantId])
  await query(`INSERT INTO facts (id, tenant_id, subject_id, predicate, object_literal, valid_from, valid_to, acl_principals)
    VALUES ('f', $1, 'kw', '支持', '本地文档检索', '2024-01-01', '2025-01-01', '["tenant:public"]')`, [workspace.principal.tenantId])
  await query(`INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote)
    SELECT 'fe', 'f', id, doc_id, text FROM chunks WHERE is_parent=false LIMIT 1`)
  harness.ask = async (_id, prompt, system) => {
    assert.match(prompt, /图谱导航/)
    assert.doesNotMatch(prompt, /2024-01-01|2025-01-01|有效期 2024/)
    assert.match(system ?? '', /不得把检索时间切片或图谱抽取元数据/)
    return generated('知织的回答附带原文引用。[1]')
  }
  const result = await ask(workspace.principal, { question: '2024年知织的回答有什么？', evaluation: true })
  assert.equal(result.refused, false)
  assert.equal((result.facts as unknown[]).length, 1)
  assert.equal(validateGrounding('有效期为2024-01-01至2025-01-01。[1]', [{ text }]).valid, false)
})

test('comparison budgets preserve a lower-scoring branch, including a one-hit requested budget', async () => {
  const result = await retrieve(workspace.principal, '知织')
  const sample = result.hits[0]!
  const hit = (id: string, score: number) => new Hit({ ...sample.chunk, id }, sample.document, 1, 1, 1, score, 1, 'chunk')
  const national = Array.from({ length: 8 }, (_, i) => hit(`national-${i}`, 0.9 - i / 100))
  const local = [hit('local-target', 0.59), hit('local-context', 0.55)]
  const combined = { ...result, hits: [...national, ...local] }
  const branches = [combined, { ...result, hits: national }, { ...result, hits: local }]
  const selected = comparisonHits(branches, 6)
  assert.equal(selected.length, 6)
  assert.ok(selected.some(hit => hit.chunk.id === 'local-target'))
  assert.ok(selected.some(hit => hit.chunk.id === 'local-context'))
  assert.deepEqual(comparisonHits(branches, 1).map(hit => hit.chunk.id), ['national-0', 'local-target'])
})

test('annual comparison queries retain their full shared topic and generation requires cited table rows', async () => {
  harness.ask = async (_id, prompt, system) => {
    assert.match(system ?? '', /结论和关键依据均放在表格行内/)
    assert.match(system ?? '', /必须同时引用每一侧的原文/)
    assert.match(system ?? '', /不得计算或补写原文未明示的差额/)
    assert.match(prompt, /只输出Markdown对比表格/)
    return generated('| 项目 | 依据 |\n|---|---|\n| 回答方式 | 知织的回答附带原文引用。[1] |')
  }
  const result = await ask(workspace.principal, { question: '对比2024年和2026年基本公共卫生服务人均财政补助标准的高低', mode: 'compare', evaluation: true })
  assert.equal(result.refused, false)
  const queries = (result.stats as { subqueries: string[] }).subqueries
  assert.ok(queries.includes('2024年基本公共卫生服务人均财政补助标准的高低'))
  assert.ok(queries.includes('2026年基本公共卫生服务人均财政补助标准的高低'))
})

test('personal memory answers cite a private snapshot, survive reopening and do not enter public facts', async () => {
  await clearKnowledge()
  await ask(workspace.principal, { question: '记住：我的办公室在3楼302室' })
  harness.ask = async (_id, prompt) => {
    assert.match(prompt, /\[1\] 个人记忆/)
    return generated('根据你的个人记忆，我的办公室在3楼302室。[1]')
  }
  const result = await ask(workspace.principal, { question: '我的办公室在哪里？' })
  assert.equal(result.refused, false)
  assert.equal((result.grounding as { strategy: string }).strategy, 'personal_memory')
  const citations = result.citations as Array<{ source: string; doc_id: null; quote: string }>
  assert.equal(citations[0]!.source, 'memory')
  assert.equal(citations[0]!.doc_id, null)
  assert.match(citations[0]!.quote, /302室/)
  assert.equal((await query('SELECT id FROM facts')).length, 0)
  const reopened = await app.inject({ method: 'GET', url: `/api/v1/conversations/${result.conversation_id}`, headers: workspace.headers })
  assert.equal(reopened.json().messages.at(-1).citations[0].source, 'memory')
  const other = { ...workspace.principal, userId: 'someone-else' }
  const hidden = await ask(other, { question: '我的办公室在哪里？' })
  assert.equal(hidden.refused, true)
  assert.deepEqual(hidden.citations, [])
  const publicQuestion = await ask(workspace.principal, { question: '2025年山东省补助标准是多少？' })
  assert.equal(publicQuestion.refused, true)
  assert.deepEqual(publicQuestion.evidence, [])
})

test('a follow-up replaces the historical year instead of mixing both generations', async () => {
  await clearKnowledge()
  const old = await ingestParsed(workspace.principal, parseText('2024年补助标准为94元。', '2024年通知'), { sourceType: 'text' })
  const current = await ingestParsed(workspace.principal, parseText('2026年补助标准为99元。', '2026年通知'), { sourceType: 'text' })
  await query(`INSERT INTO document_continuations (id, tenant_id, predecessor_doc_id, successor_doc_id, effective_date, created_by)
    VALUES ('annual', $1, $2, $3, '2026-01-01', $4)`, [workspace.principal.tenantId, old.document_id, current.document_id, workspace.principal.userId])
  let calls = 0
  harness.ask = async (_id, prompt) => {
    calls++
    const evidence = prompt.slice(prompt.indexOf('证据：'))
    if (calls === 1) {
      assert.doesNotMatch(evidence, /2026年补助/)
      return generated('2024年补助标准为94元。[1]')
    }
    assert.doesNotMatch(evidence, /2024年补助/)
    return generated('2026年补助标准为99元。[1]')
  }
  const first = await ask(workspace.principal, { question: '2024年补助标准是多少？' })
  assert.equal(first.refused, false)
  const followUp = await ask(workspace.principal, { question: '那2026年呢？', conversationId: String(first.conversation_id) })
  assert.equal(followUp.refused, false)
  assert.match(String(followUp.answer), /99元/)
  const [history] = await query<{ output: { retrieval_question: string } }>(
    "SELECT output FROM trace_spans WHERE trace_id=$1 AND stage='context.history'", [followUp.trace_id])
  assert.match(history!.output.retrieval_question, /补助标准/)
  assert.doesNotMatch(history!.output.retrieval_question, /2024年/)
})

test('valid generated claims keep actual references and expose sentence coverage', async () => {
  const result = await ask(workspace.principal, { question: '知织的回答有什么？' })
  assert.equal(result.refused, false)
  assert.equal(result.answer, '知织的回答附带原文引用。[1]')
  const citations = result.citations as Array<{ quote: string; version_id: string }>
  assert.equal(citations.length, 1)
  assert.equal(citations[0]!.quote, '知织的回答附带原文引用。')
  assert.ok(citations[0]!.version_id)
  assert.equal((result.grounding as { citation_coverage: number }).citation_coverage, 1)
})

test('the configured semantic verifier judges cited paraphrases after citation and number checks', async () => {
  const question = '知织的回答有什么？'
  const paraphrase = '作答时会注明资料的出处。[1]'
  assert.equal(validateGrounding(paraphrase, [{ text }]).valid, false)

  const original = settings.groundingVerifier
  settings.groundingVerifier = true
  let checks = 0
  let supported = true
  harness.ask = async () => generated(paraphrase)
  harness.complete = async (prompt) => {
    checks += 1
    const request = JSON.parse(prompt)
    assert.equal(request.answer, paraphrase)
    assert.match(request.evidence[0].text, /回答附带原文引用/)
    return generated(JSON.stringify({ supported, unsupported_sentences: supported ? [] : [paraphrase] }))
  }
  try {
    const accepted = await ask(workspace.principal, { question, evaluation: true })
    assert.equal(accepted.refused, false)
    assert.equal(accepted.answer, paraphrase)
    assert.equal((accepted.citations as unknown[]).length, 1)
    supported = false
    const rejected = await ask(workspace.principal, { question, evaluation: true })
    assert.equal(rejected.refused, true)
    assert.equal((rejected.failure as AnswerFailure).verification.semantic_rejected, true)
    assert.equal(checks, 2)

    for (const invalid of ['作答时会注明资料的出处。', '文件容量上限为999GB。[1]']) {
      harness.ask = async () => generated(invalid)
      const invalidResult = await ask(workspace.principal, { question, evaluation: true })
      assert.equal(invalidResult.refused, true)
      assert.equal((invalidResult.failure as AnswerFailure).verification.supported, 0)
    }
    assert.equal(checks, 2)
  } finally {
    settings.groundingVerifier = original
  }
})

test('unsupported generated answers are rejected without substituting excerpts', async () => {
  harness.ask = async () => generated('知织文件上限为999GB。[1]知织会公开所有上传内容。')
  await ingestParsed(workspace.principal, parseText('其他仓库支持按标签分类。', '其他仓库'), { sourceType: 'text', uri: 'fixture:other' })
  const result = await ask(workspace.principal, { question: '知织文件大小上限是多少？', topK: 1 })
  assert.equal(result.refused, true)
  assert.match(String(result.answer), /未通过核验/)
  assert.deepEqual(result.citations, [])
  assert.doesNotMatch(String(result.answer), /999GB/)

  const failure = result.failure as AnswerFailure
  assert.equal(failure.stage, 'grounding')
  assert.ok(failure.top_score >= failure.threshold)
  assert.equal(failure.selected[0]!.doc_title, '知织文档')
  assert.match(failure.selected[0]!.quote, /30MB/)
  assert.equal(failure.excluded_count, 1)
  assert.equal(failure.query_limit_count, 1)
  assert.equal(failure.excluded[0]!.doc_title, '其他仓库')
  assert.equal(failure.excluded[0]!.reason, 'query_limit')
  assert.equal(failure.verification.sentences, 2)
  assert.equal(failure.verification.supported, 0)
  assert.deepEqual(failure.verification.issues[0]!.evidence_indices, [1])
  assert.match(failure.verification.issues[0]!.reasons.join(' '), /未找到数字或单位.*999GB/)
  assert.match(failure.verification.issues[1]!.reasons[0]!, /没有引用/)

  const conversation = () => app.inject({ method: 'GET', url: `/api/v1/conversations/${result.conversation_id}`, headers: workspace.headers })
  const message = (await conversation()).json().messages.at(-1)
  assert.equal(message.refused, true)
  assert.deepEqual(message.failure, failure)
  await query('UPDATE documents SET acl_principals = $1::jsonb WHERE id = $2', ['["user:someone-else"]', failure.selected[0]!.doc_id])
  const hidden = (await conversation()).json().messages.at(-1).failure
  assert.deepEqual(hidden.selected, [])
  assert.deepEqual(hidden.verification.issues, [])
  assert.equal(hidden.excluded[0].doc_title, '其他仓库')
})

test('reports whether generation was skipped at the threshold or the model identified a gap', async () => {
  const question = '知织的回答有什么？'
  harness.ask = async () => generated('REFUSE: 片段只有回答格式，缺少所问规则。')
  const declined = await ask(workspace.principal, { question })
  const modelFailure = declined.failure as AnswerFailure
  assert.equal(modelFailure.stage, 'model_refusal')
  assert.equal(modelFailure.model_reason, '片段只有回答格式，缺少所问规则。')
  const original = embedder.embedQuery
  embedder.embedQuery = async () => ({ dense: [0.1, 1], sparse: {}, model: 'test', dim: 2 })
  harness.ask = async () => { throw new Error('should not generate at this score') }
  try {
    const blocked = await ask(workspace.principal, { question: '完全无关' })
    const blockedFailure = blocked.failure as AnswerFailure
    assert.equal(blockedFailure.stage, 'below_threshold')
    assert.equal(blockedFailure.selected[0]!.doc_title, '知织文档')
    assert.ok(blockedFailure.top_score < blockedFailure.threshold)
  } finally { embedder.embedQuery = original }
})

test('model outage returns 503 without writing an answer or evidence gap', async () => {
  harness.ask = async () => ({ ...generated(''), ok: false, error: 'offline' })
  const response = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: workspace.headers, payload: { question: '知织支持什么？' } })
  assert.equal(response.statusCode, 503)
  assert.match(response.json().detail, /offline/)
  assert.equal((await query('SELECT id FROM messages')).length, 0)
  assert.equal((await query('SELECT id FROM gaps')).length, 0)
  assert.equal((await queryOne<{ status: string }>("SELECT status FROM traces WHERE feature='ask'"))?.status, 'error')
})

test('successful generation persists citations for reopened conversations', async () => {
  const result = await ask(workspace.principal, { question: '知织支持什么？' })
  assert.equal(result.refused, false)
  assert.ok((result.citations as unknown[]).length)
  const response = await app.inject({ method: 'GET', url: `/api/v1/conversations/${result.conversation_id}`, headers: workspace.headers })
  const messages = response.json().messages
  assert.ok(messages.at(-1).citations[0].version_id)
})

test('compare refuses when the model returns an unsupported conclusion', async () => {
  harness.ask = async () => generated('没有引用的对比结论。')
  const result = await ask(workspace.principal, { question: '比较知织和本地文档检索', mode: 'compare' })
  assert.equal(result.refused, true)
  assert.match(String(result.answer), /未通过核验/)
  assert.deepEqual(result.citations, [])
})

test('remember commands write one personal memory and can be used in later questions', async () => {
  let calls = 0
  harness.ask = async () => { calls += 1; return generated('') }
  const result = await ask(workspace.principal, { question: '记住这个：我偏好简短回答' })
  await ask(workspace.principal, { question: '记住这个：我偏好简短回答' })
  assert.equal(calls, 0)
  assert.equal(result.refused, false)
  const notes = await query<{ text: string; scope: string; user_id: string }>('SELECT text, scope, user_id FROM memory_items')
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0], { text: '我偏好简短回答', scope: 'personal', user_id: workspace.principal.userId })
})

test('message feedback updates cited chunks once and changing the vote reverses its effect', async () => {
  const result = await ask(workspace.principal, { question: '知织的回答有什么？' })
  const id = (result.citations as Array<{ chunk_id: string }>)[0]!.chunk_id
  const vote = (value: number) => app.inject({ method: 'POST', url: '/api/v1/feedback', headers: workspace.headers, payload: { target_type: 'message', target_id: result.message_id, value } })
  assert.equal((await vote(-1)).statusCode, 200)
  assert.equal((await vote(-1)).statusCode, 200)
  assert.equal((await queryOne<{ weight: number }>('SELECT weight FROM chunks WHERE id=$1', [id]))!.weight, 0.88)
  await vote(1)
  assert.equal((await queryOne<{ weight: number }>('SELECT weight FROM chunks WHERE id=$1', [id]))!.weight, 1.12)
  assert.equal((await query('SELECT id FROM feedback')).length, 1)
})

test('deep mode retries distinct queries at most three retrieval rounds and records every query', async () => {
  let count = 0
  const original = embedder.embedQuery
  embedder.embedQuery = async () => { count += 1; return { dense: [0, 1], sparse: {}, model: 'test', dim: 2 } }
  harness.complete = async () => generated(JSON.stringify({ queries: [`missing clue ${count}`] }))
  try {
    const result = await ask(workspace.principal, { question: '完全缺失的问题', mode: 'deep' })
    assert.equal(result.refused, true)
    assert.equal((result.failure as AnswerFailure).stage, 'no_hits')
    assert.equal((result.stats as { retrieval_rounds: number }).retrieval_rounds, 3)
    const spans = await query<{ stage: string }>('SELECT stage FROM trace_spans WHERE trace_id=$1', [result.trace_id])
    assert.equal(spans.filter(span => span.stage === 'recall.dense').length, count)
  } finally { embedder.embedQuery = original }
})

test('invalid query modes and dates fail before invoking a model', async () => {
  await assert.rejects(ask(workspace.principal, { question: '测试', mode: 'invented' }), /模式/)
  await assert.rejects(ask(workspace.principal, { question: '测试', asOf: '2024-02-30' }), /日期/)
})

test('quoted refusal text in source material is not itself a model refusal',async()=>{
  await clearKnowledge()
  const source='系统缺少证据时显示“资料不足以回答”，并提示补充来源。'
  const doc=await ingestParsed(workspace.principal,parseText(source,'拒答行为说明'),{sourceType:'text'})
  harness.ask=async()=>generated(source+'[1]')
  const answer=await ask(workspace.principal,{question:'系统缺少证据时显示什么？',docIds:[String(doc.document_id)]})
  assert.equal(answer.refused,false)
  assert.match(String(answer.answer),/资料不足以回答/)
  assert.equal((answer.citations as unknown[]).length,1)
})

test('even exact retrieval matches do not substitute for an ungrounded model answer',async()=>{
  await clearKnowledge()
  const doc=await ingestParsed(workspace.principal,parseText('src db schema index join settings rootDir。\n\nexport async function initSchema(): Promise<void> {','src/db/index.ts'),{sourceType:'text'})
  harness.ask=async()=>generated('没有有效引用的模型输出')
  const answer=await ask(workspace.principal,{question:'请摘录 `initSchema` 的已提供源码片段。',docIds:[String(doc.document_id)]})
  assert.equal(answer.refused,true)
  assert.deepEqual(answer.citations,[])
})
