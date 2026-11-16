import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { clearKnowledge, testWorkspace } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'
import { ask, type AnswerFailure } from '../src/core/answering.js'
import { validateGrounding } from '../src/core/grounding.js'
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
