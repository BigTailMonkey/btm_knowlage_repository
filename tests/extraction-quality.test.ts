import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { harness } from '../src/adapters/harness/index.js'
import { extractFactsForDocument, runReflection } from '../src/core/learning.js'
import { relationOf } from '../src/core/relation-types.js'
import { isValueLike, predicateStem, yearsIn } from '../src/core/value-shapes.js'
import { query, queryOne } from '../src/db/index.js'
import { clearKnowledge, testWorkspace } from './helpers.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let serial = 0

const QUOTE = '高血压患者规范管理率等于按照规范要求进行高血压患者管理的人数/年内已管理的高血压患者人数×100％。'

function candidate(options: Record<string, unknown> = {}) {
  return {
    subject: '高血压患者规范管理率', subject_type: 'concept', predicate: '等于', object: '',
    object_type: 'concept', object_literal: '按照规范要求进行高血压患者管理的人数/年内已管理的高血压患者人数×100％',
    confidence: 0.9, quote: QUOTE, valid_from: null, valid_to: null, ...options,
  }
}

function modelResult(items: unknown) {
  return { text: JSON.stringify(items), tokensIn: 0, tokensOut: 0, latencyMs: 0,
    model: 'test-model', provider: 'test', error: null, ok: true }
}

const KEEP_ALL = () => modelResult(Array.from({ length: 40 }, (_, index) => ({ index: index + 1, keep: true, reason: '' })))

function extractionStub(items: unknown[]) {
  return async (_prompt: string, system?: string) => (system?.includes('事实校验器') ? KEEP_ALL() : modelResult(items))
}

async function document(text = QUOTE, title?: string): Promise<string> {
  const id = `quality-doc-${++serial}`
  await query(
    `INSERT INTO documents (id, tenant_id, title, content_hash, acl_principals, quality_score)
     VALUES ($1, $2, $3, $1, '["tenant:public"]'::jsonb, 0.9)`,
    [id, workspace.principal.tenantId, title ?? `Fixture ${serial}`],
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
beforeEach(async () => { await clearKnowledge() })

test('value-shaped names are recognised without eating real entities', () => {
  const values = ['20%', '6 个月', '每年至少 4 次', '出生后 24 小时内', '94元', '2017年6月', '12 种内容',
    '按照规范要求进行高血压患者管理的人数/年内已管理的高血压患者人数×100％',
    '收缩压＜140mmHg 和舒张压＜90mmHg(65 岁及以上患者收缩压＜150mmHg)']
  for (const value of values) assert.equal(isValueLike(value), true, value)
  const entities = ['2 型糖尿病患者', '15岁以上人群吸烟率', '山东省', '乡镇卫生院和社区卫生服务中心',
    '《母子健康手册》', '每千人口执业医师数', '3 级高血压']
  for (const entity of entities) assert.equal(isValueLike(entity), false, entity)
})

test('relation slots treat wording variants as one relation but keep different years apart', () => {
  assert.equal(relationOf('等于').singleValued, true)
  assert.equal(relationOf('举措').singleValued, false)
  assert.equal(predicateStem('应当具备资格'), '具备')
  assert.equal(predicateStem('应具备资格'), '具备')
  assert.deepEqual(yearsIn('2030年目标降至'), ['2030'])
})

test('duplicate wording of one assertion is stored once, not three times', async () => {
  const doc = await document()
  harness.complete = extractionStub([
    candidate({ predicate: '等于' }),
    candidate({ predicate: '计算方式为' }),
    candidate({ predicate: '计算为' }),
  ])
  await extractFactsForDocument(workspace.principal, doc)
  assert.equal((await query('SELECT id FROM facts')).length, 1, '同一句三种措辞只留一条')
  const fact = await queryOne<{ predicate: string; object_id: string | null; object_literal: string | null }>(
    'SELECT predicate, object_id, object_literal FROM facts',
  )
  assert.equal(fact?.predicate, '等于')
  assert.equal(fact?.object_id, null, '公式是字面值，不建实体')
  assert.equal((await query('SELECT id FROM entities')).length, 1, '只为指标本身建实体')
})

test('a value-shaped subject never becomes a fact', async () => {
  const doc = await document()
  harness.complete = extractionStub([
    candidate({ subject: '按照规范要求进行高血压患者管理的人数/年内已管理的高血压患者人数×100％', predicate: '等于', object_literal: '高血压患者规范管理率' }),
    candidate(),
  ])
  await extractFactsForDocument(workspace.principal, doc)
  const subjects = await query<{ canonical_name: string }>(
    'SELECT e.canonical_name FROM facts f JOIN entities e ON e.id = f.subject_id',
  )
  assert.deepEqual(subjects.map((row) => row.canonical_name), ['高血压患者规范管理率'], '公式不能当主语')
})

test('a self-referential candidate is dropped before it reaches the knowledge base', async () => {
  const doc = await document()
  harness.complete = extractionStub([
    candidate({ predicate: '等于', object: '高血压患者规范管理率', object_literal: '' }),
  ])
  await extractFactsForDocument(workspace.principal, doc)
  assert.equal((await query('SELECT id FROM facts')).length, 0, '主语和宾语同指时什么都不存')
})

test('different wording of a single-valued relation still conflicts instead of duplicating', async () => {
  const firstQuote = '高血压患者规范管理率等于甲口径。'
  const first = await document(firstQuote)
  harness.complete = extractionStub([candidate({ object: '甲口径', object_literal: '', quote: firstQuote })])
  await extractFactsForDocument(workspace.principal, first)
  const secondQuote = '高血压患者规范管理率计算方式为乙口径。'
  const second = await document(secondQuote)
  harness.complete = extractionStub([
    candidate({ predicate: '计算方式为', object: '乙口径', object_literal: '', quote: secondQuote }),
  ])
  await extractFactsForDocument(workspace.principal, second)
  const facts = await query<{ status: string }>('SELECT status FROM facts ORDER BY status')
  assert.deepEqual(facts.map((fact) => fact.status), ['active', 'disputed'], '换措辞是冲突并等待裁决，不是悄悄多一条')
  const review = await queryOne<{ kind: string; payload: { old_objects: string[]; new_object: string } }>(
    "SELECT kind, payload FROM review_queue WHERE status = 'open'",
  )
  assert.equal(review?.kind, 'fact_conflict')
  assert.deepEqual(review?.payload.old_objects, ['甲口径'])
  assert.equal(review?.payload.new_object, '乙口径')
})

test('only confirmed equivalent conflicts are merged and existing reviews can be closed by reflection', async () => {
  const firstQuote = '高血压患者规范管理率的计算方式为已规范管理人数除以已管理人数。'
  const secondQuote = '高血压患者规范管理率等于已规范管理人数与已管理人数之比。'
  const first = await document(firstQuote)
  const second = await document(secondQuote)
  const firstCandidate = candidate({ object_literal: '已规范管理人数除以已管理人数', quote: firstQuote })
  const secondCandidate = candidate({ object_literal: '已规范管理人数与已管理人数之比', quote: secondQuote })

  for (const initialConfidence of [99, 100]) {
    let confidence = initialConfidence
    const runExtraction = async (id: string, item: unknown) => {
      const extract = extractionStub([item])
      harness.complete = async (prompt, system) => {
        if (!system?.includes('事实等义判定器')) return extract(prompt, system)
        assert.match(prompt, /已规范管理人数除以已管理人数/)
        assert.match(prompt, /已规范管理人数与已管理人数之比/)
        return modelResult({ verdict: 'equivalent', confidence })
      }
      await extractFactsForDocument(workspace.principal, id)
    }
    await runExtraction(first, firstCandidate)
    await runExtraction(second, secondCandidate)
    const reviews = () => query<{ status: string; resolution: { action: string } }>('SELECT status,resolution FROM review_queue')
    if (initialConfidence === 99) {
      assert.equal((await reviews())[0]?.status, 'open')
      confidence = 100
      await runReflection(workspace.principal.tenantId)
      assert.equal((await reviews())[0]?.resolution.action, 'semantic_equivalent')
    } else {
      assert.equal((await reviews()).length, 0)
    }
    const evidence = await query<{ quote: string; span: unknown }>(
      `SELECT e.quote,e.span FROM fact_evidence e JOIN facts f ON f.id=e.fact_id WHERE f.status='active' ORDER BY e.doc_id`,
    )
    assert.deepEqual(evidence.map(({ quote }) => quote), [firstQuote, secondQuote])
    assert.ok(evidence.every(({ span }) => span))
    assert.equal((await query("SELECT id FROM facts WHERE status='active'")).length, 1)

    if (initialConfidence === 99) {
      // Keep the fixture documents; use fresh fact extraction for the pre-queue path.
      await query('DELETE FROM review_queue')
      await query('DELETE FROM fact_evidence')
      await query('DELETE FROM facts')
    }
  }
})

test('different years are different targets, so they do not supersede each other', async () => {
  const firstQuote = '人均预期寿命2030年目标为80岁。'
  const first = await document(firstQuote)
  harness.complete = extractionStub([
    candidate({ subject: '人均预期寿命', predicate: '2030年目标为', object: '', object_literal: '80岁', quote: firstQuote }),
  ])
  await extractFactsForDocument(workspace.principal, first)
  const secondQuote = '人均预期寿命2025年目标为78岁。'
  const second = await document(secondQuote)
  harness.complete = extractionStub([
    candidate({ subject: '人均预期寿命', predicate: '2025年目标为', object: '', object_literal: '78岁', quote: secondQuote }),
  ])
  await extractFactsForDocument(workspace.principal, second)
  const facts = await query<{ predicate: string; status: string }>('SELECT predicate, status FROM facts ORDER BY predicate')
  assert.equal(facts.length, 2)
  assert.ok(facts.every((fact) => fact.status === 'active'), '不同年份的目标并存')
})

test('equivalent formula formatting merges while preserving both sources', async () => {
  for (const unit of ['m2', 'm 2 ']) {
    const object_literal = `体重（kg）/身高的平方（${unit}）`
    const quote = `体质指数等于${object_literal}。`
    const doc = await document(quote)
    harness.complete = extractionStub([candidate({ subject: '体质指数', object_literal, quote })])
    await extractFactsForDocument(workspace.principal, doc)
  }
  assert.equal((await query('SELECT id FROM facts')).length, 1)
  assert.equal((await query('SELECT id FROM fact_evidence')).length, 2)
  assert.equal((await query('SELECT id FROM review_queue')).length, 0)
})

test('national and provincial targets coexist during extraction and reflection', async () => {
  for (const [title, object_literal] of [
    ['国民健康“十五五”规划', '80岁'],
    ['山东省卫生健康“十五五”规划', '81.7岁'],
  ]) {
    const quote = `人均预期寿命达到${object_literal}。`
    const doc = await document(quote, title)
    harness.complete = extractionStub([candidate({ subject: '人均预期寿命', predicate: '达到', object_literal, quote })])
    await extractFactsForDocument(workspace.principal, doc)
  }
  await runReflection(workspace.principal.tenantId)
  const facts = await query<{ status: string }>('SELECT status FROM facts')
  assert.deepEqual(facts.map(({ status }) => status), ['active', 'active'])
  assert.equal((await query('SELECT id FROM review_queue')).length, 0)
})
