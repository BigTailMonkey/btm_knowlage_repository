import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { query, queryOne } from '../src/db/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { extractFactsForDocument, parseDate, resolveReview } from '../src/core/learning.js'
import { trashDocument } from '../src/core/trash.js'
import { clearKnowledge, testWorkspace } from './helpers.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let serial = 0
const quote = 'Orchid uses Aurora for its primary storage.'

function candidate(options: Record<string, unknown> = {}) {
  return {
    subject: 'Orchid', subject_type: 'product', predicate: 'uses', object: 'Aurora',
    object_type: 'product', object_literal: '', confidence: 0.9, quote,
    valid_from: null, valid_to: null, ...options,
  }
}

function modelResult(items: unknown[]) {
  return { text: JSON.stringify(items), tokensIn: 0, tokensOut: 0, latencyMs: 0,
    model: 'test-model', provider: 'test', error: null, ok: true }
}

const KEEP_ALL = () => modelResult(Array.from({ length: 40 }, (_, index) => ({ index: index + 1, keep: true, reason: '' })))

/** 抽取调用返回给定候选；结构校验调用按 verdict 统一给出结论。 */
function extractionStub(items: unknown[], verdict: 'keep' | 'reject' = 'keep') {
  return async (_prompt: string, system?: string) => {
    if (system?.includes('事实校验器')) return verdict === 'keep' ? KEEP_ALL() : modelResult([])
    return modelResult(items)
  }
}

async function document(text = quote): Promise<string> {
  const id = `learning-doc-${++serial}`
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, acl_principals, quality_score)
     VALUES ($1, $2, $3, $1, '["tenant:public"]'::jsonb, 0.9)`,
    [id, workspace.principal.tenantId, `Fixture ${serial}`],
  )
  await query(
    `INSERT INTO document_versions (id, doc_id, tenant_id, version, hash, parser, text)
     VALUES ($1, $2, $3, 1, $1, 'test', $4)`,
    [`${id}-v1`, id, workspace.principal.tenantId, text],
  )
  await query(
    `INSERT INTO chunks (id, version_id, doc_id, tenant_id, text, acl_principals)
     VALUES ($1, $2, $3, $4, $5, '["tenant:public"]'::jsonb)`,
    [`${id}-c1`, `${id}-v1`, id, workspace.principal.tenantId, text],
  )
  return id
}

before(async () => { workspace = await testWorkspace() })
after(async () => { await workspace.close() })
beforeEach(async () => {
  await clearKnowledge()
  harness.complete = extractionStub([candidate()])
})

test('requires the entire verbatim quote and assertion terms, not prefix or token similarity', async () => {
  const doc = await document(`${quote} The published reference is unchanged.`)
  harness.complete = extractionStub([
    candidate({ quote: `${quote} An invented extension follows.` }),
    candidate({ object: 'Fabricated database', quote }),
  ])
  await extractFactsForDocument(workspace.principal, doc)
  assert.equal((await query('SELECT id FROM facts')).length, 0)
  assert.equal((await query('SELECT id FROM fact_evidence')).length, 0)
})

test('an empty or failed model result never produces facts from verb fragments', async () => {
  const doc = await document('收集和提供风险信息。')
  harness.complete = async () => modelResult([])
  assert.equal((await extractFactsForDocument(workspace.principal, doc)).candidates, 0)
  assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents'))?.enrichment_status, 'empty')

  harness.complete = async () => ({ ...modelResult([]), text: '', ok: false, error: '模型接口返回 HTTP 401' })
  await assert.rejects(extractFactsForDocument(workspace.principal, doc), /HTTP 401/)
  harness.complete = async () => ({ ...modelResult([]), text: '[{"subject":"收集和"' })
  await assert.rejects(extractFactsForDocument(workspace.principal, doc), /完整的 JSON 数组/)
  assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents'))?.enrichment_status, 'failed')
  assert.equal((await query('SELECT id FROM entities')).length, 0)
})

test('a model-proposed conjunction fragment is rejected while an intact organization name is kept', async () => {
  const doc = await document('收集和提供风险信息。协和医院提供随访服务。')
  harness.complete = extractionStub([
    candidate({ subject: '收集和', predicate: '提供', object: '风险信息', quote: '收集和提供风险信息' }),
    candidate({ subject: '协和医院', predicate: '提供', object: '随访服务', quote: '协和医院提供随访服务' }),
  ])
  assert.equal((await extractFactsForDocument(workspace.principal, doc)).candidates, 1)
  assert.deepEqual((await query<{ canonical_name: string }>('SELECT canonical_name FROM entities ORDER BY canonical_name'))
    .map((row) => row.canonical_name), ['协和医院', '随访服务'])
})

test('a structural check failure discards the candidate instead of filing it for review', async () => {
  const sentence = '高质量规划建设中新济南未来产业城'
  const doc = await document(`${sentence}，发挥机制作用。`)
  harness.complete = extractionStub([
    candidate({ subject: '中新济南未来产业城', predicate: '规划建设', object: sentence, object_type: 'org', quote: sentence }),
  ], 'reject')
  const result = await extractFactsForDocument(workspace.principal, doc)
  assert.equal(result.candidates, 0)
  assert.equal(result.discarded, 1)
  assert.equal((await query('SELECT id FROM facts')).length, 0)
  assert.equal((await query('SELECT id FROM entities')).length, 0)
  assert.equal((await query('SELECT id FROM review_queue')).length, 0)
})

test('a model that cannot answer the structural check never accepts candidates silently', async () => {
  const doc = await document()
  harness.complete = async (_prompt: string, system?: string) => system?.includes('事实校验器')
    ? { ...modelResult([]), text: '[{"index":1,"keep":' }
    : modelResult([candidate()])
  await assert.rejects(extractFactsForDocument(workspace.principal, doc), /事实校验/)
  assert.equal((await query('SELECT id FROM facts')).length, 0)
  assert.equal((await query('SELECT id FROM entities')).length, 0)
  assert.equal((await query('SELECT id FROM review_queue')).length, 0)
  assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents'))?.enrichment_status, 'failed')
})

test('single-source and low-confidence candidates enter the knowledge base without review', async () => {
  const doc = await document(`Intro. ${quote} Closing.`)
  harness.complete = extractionStub([candidate({ confidence: 0.2 })])
  await extractFactsForDocument(workspace.principal, doc)
  const fact = await queryOne<{ id: string; status: string; confidence: number }>('SELECT id, status, confidence FROM facts')
  assert.equal(fact?.status, 'active')
  assert.equal(fact?.confidence, 0.2)
  assert.equal((await query("SELECT id FROM review_queue WHERE status = 'open'")).length, 0)
  const evidence = await queryOne<{ quote: string; span: { start: number; end: number } }>('SELECT quote, span FROM fact_evidence')
  assert.equal(evidence?.quote, quote)
  assert.deepEqual(evidence?.span, { start: 7, end: 7 + quote.length })
})

test('a high-confidence single source activates directly; repeated extraction is idempotent', async () => {
  const doc = await document()
  await extractFactsForDocument(workspace.principal, doc)
  await extractFactsForDocument(workspace.principal, doc)
  assert.equal((await query('SELECT id FROM facts')).length, 1)
  assert.equal((await query('SELECT id FROM fact_evidence')).length, 1)
  assert.equal((await query("SELECT id FROM review_queue WHERE status = 'open'")).length, 0)
  assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts'))?.status, 'active')
})

test('independent corroborating documents can activate a fact without duplicating evidence', async () => {
  const first = await document()
  const second = await document()
  await extractFactsForDocument(workspace.principal, first)
  harness.complete = extractionStub([candidate({ confidence: 0.8 })])
  await extractFactsForDocument(workspace.principal, second)
  const fact = await queryOne<{ status: string; confidence: number }>('SELECT status, confidence FROM facts')
  assert.equal(fact?.status, 'active')
  assert.ok(Math.abs(fact!.confidence - 0.85) < 1e-8)
  assert.equal((await query('SELECT id FROM facts')).length, 1)
  assert.equal((await query('SELECT id FROM fact_evidence')).length, 2)
  assert.equal((await query("SELECT id FROM review_queue WHERE status = 'open'")).length, 0)
  await extractFactsForDocument(workspace.principal, first)
  assert.equal((await query('SELECT id FROM fact_evidence')).length, 2)
  assert.equal((await queryOne<{ confidence: number }>('SELECT confidence FROM facts'))?.confidence, fact?.confidence)
})

test('non-contiguous validity periods remain separate historical assertions', async () => {
  const first = await document()
  const second = await document()
  harness.complete = extractionStub([candidate({ valid_from: '2020-01-01', valid_to: '2021-01-01' })])
  await extractFactsForDocument(workspace.principal, first)
  harness.complete = extractionStub([candidate({ valid_from: '2022-01-01', valid_to: '2023-01-01' })])
  await extractFactsForDocument(workspace.principal, second)
  const periods = await query<{ valid_from: Date | string; valid_to: Date | string }>('SELECT valid_from, valid_to FROM facts ORDER BY valid_from')
  assert.equal(periods.length, 2)
  assert.equal(new Date(periods[0]!.valid_to).toISOString().slice(0, 10), '2021-01-01')
  assert.equal(new Date(periods[1]!.valid_from).toISOString().slice(0, 10), '2022-01-01')
})

test('valid_to is exclusive, so adjacent periods do not create false conflicts', async () => {
  const first = await document()
  const secondQuote = 'Orchid uses Borealis for its primary storage.'
  const second = await document(secondQuote)
  harness.complete = extractionStub([candidate({ valid_from: '2020-01-01', valid_to: '2021-01-01' })])
  await extractFactsForDocument(workspace.principal, first)
  harness.complete = extractionStub([candidate({ object: 'Borealis', quote: secondQuote, valid_from: '2021-01-01', valid_to: '2022-01-01' })])
  await extractFactsForDocument(workspace.principal, second)
  assert.equal((await query("SELECT id FROM review_queue WHERE kind = 'fact_conflict'")).length, 0)
})

test('corroborated dated updates supersede older facts and preserve their end boundary', async () => {
  const first = await document()
  harness.complete = extractionStub([candidate({ valid_from: '2020-01-01' })])
  await extractFactsForDocument(workspace.principal, first)
  assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts'))?.status, 'active')
  const nextQuote = 'Orchid uses Borealis for its primary storage.'
  const second = await document(nextQuote)
  const third = await document(nextQuote)
  harness.complete = extractionStub([candidate({ object: 'Borealis', quote: nextQuote, valid_from: '2022-01-01' })])
  await extractFactsForDocument(workspace.principal, second)
  await extractFactsForDocument(workspace.principal, third)
  const facts = await query<{ status: string; valid_to: string | Date | null }>('SELECT status, valid_to FROM facts ORDER BY recorded_at')
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.status, 'superseded')
  assert.equal(new Date(facts[0]!.valid_to!).toISOString().slice(0, 10), '2022-01-01')
  assert.equal(facts[1]?.status, 'active')
})

test('numeric literal comparison preserves signs', async () => {
  const negativeQuote = 'Orchid records a balance of -1 units.'
  const positiveQuote = 'Orchid records a balance of 1 units.'
  const first = await document(negativeQuote)
  const second = await document(positiveQuote)
  harness.complete = extractionStub([candidate({ predicate: 'balance', object: '', object_literal: '-1 units', quote: negativeQuote })])
  await extractFactsForDocument(workspace.principal, first)
  harness.complete = extractionStub([candidate({ predicate: 'balance', object: '', object_literal: '1 units', quote: positiveQuote })])
  await extractFactsForDocument(workspace.principal, second)
  assert.equal((await query('SELECT id FROM facts')).length, 2)
  assert.equal((await query("SELECT id FROM review_queue WHERE kind = 'fact_conflict'")).length, 1)
})

test('resolving a conflict review promotes the chosen fact and supersedes the other', async () => {
  const first = await document()
  await extractFactsForDocument(workspace.principal, first)
  const secondQuote = 'Orchid uses Borealis for its primary storage.'
  const second = await document(secondQuote)
  harness.complete = extractionStub([candidate({ object: 'Borealis', quote: secondQuote })])
  await extractFactsForDocument(workspace.principal, second)
  const review = await queryOne<{ id: string; kind: string; payload: { old_objects: string[]; new_object: string; reason: string } }>(
    "SELECT id, kind, payload FROM review_queue WHERE status = 'open'",
  )
  assert.equal(review?.kind, 'fact_conflict')
  assert.match(review!.payload.reason, /不同说法/)
  assert.deepEqual(review!.payload.old_objects, ['Aurora'])
  assert.equal(review!.payload.new_object, 'Borealis')
  await resolveReview(workspace.principal, review!.id, 'accept_new')
  const facts = await query<{ status: string }>(
    'SELECT f.status FROM facts f JOIN entities o ON o.id = f.object_id ORDER BY o.canonical_name',
  )
  assert.deepEqual(facts.map((row) => row.status), ['superseded', 'active'])
})

test('extracts facts beyond the first 7000 characters of an oversized chunk', async () => {
  const doc = await document(`${'Background paragraph. '.repeat(420)}\n${quote}`)
  let calls = 0
  harness.complete = async (prompt, system) => {
    if (system?.includes('事实校验器')) return KEEP_ALL()
    calls += 1
    return modelResult(prompt.includes(quote) ? [candidate()] : [])
  }
  await extractFactsForDocument(workspace.principal, doc)
  assert.ok(calls >= 2)
  assert.equal((await query('SELECT id FROM facts')).length, 1)
  assert.equal((await queryOne<{ quote: string }>('SELECT quote FROM fact_evidence'))?.quote, quote)
})

test('discards model output when the document version changes during extraction', async () => {
  const doc = await document()
  harness.complete = async (_prompt, system) => {
    if (system?.includes('事实校验器')) return KEEP_ALL()
    await query("UPDATE documents SET current_version = 2, enrichment_status = 'pending' WHERE id = $1", [doc])
    return modelResult([candidate()])
  }
  const result = await extractFactsForDocument(workspace.principal, doc)
  assert.equal(result.status, 'stale')
  assert.equal((await query('SELECT id FROM facts')).length, 0)
  assert.equal((await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents WHERE id = $1', [doc]))?.enrichment_status, 'pending')
})

test('single-source facts activate directly and retract with deleted evidence', async () => {
  const doc = await document()
  await extractFactsForDocument(workspace.principal, doc)
  assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts'))?.status, 'active')
  await trashDocument(workspace.principal, doc)
  assert.equal((await queryOne<{ status: string }>('SELECT status FROM facts'))?.status, 'retracted')
  assert.equal((await query('SELECT id FROM fact_evidence')).length, 0)
})

test('a conflict review cannot accept a fact whose evidence was deleted', async () => {
  const first = await document()
  await extractFactsForDocument(workspace.principal, first)
  const secondQuote = 'Orchid uses Borealis for its primary storage.'
  const second = await document(secondQuote)
  harness.complete = extractionStub([candidate({ object: 'Borealis', quote: secondQuote })])
  await extractFactsForDocument(workspace.principal, second)
  const review = await queryOne<{ id: string }>("SELECT id FROM review_queue WHERE status = 'open'")
  await trashDocument(workspace.principal, second)
  await query("UPDATE review_queue SET status = 'open', resolved_at = NULL WHERE id = $1", [review!.id])
  await assert.rejects(resolveReview(workspace.principal, review!.id, 'accept_new'), /出处/)
})

test('rejects impossible calendar dates and inverted validity intervals', async () => {
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(parseDate('2024-02-29'), '2024-02-29')
  const doc = await document()
  harness.complete = extractionStub([candidate({ valid_from: '2026-03-01', valid_to: '2026-02-01' })])
  await extractFactsForDocument(workspace.principal, doc)
  assert.equal((await query('SELECT id FROM facts')).length, 0)
})
