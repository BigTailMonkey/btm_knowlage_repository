import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { chunkBlocks, MAX_TOKENS, type ParsedBlock } from '../src/core/chunking.js'
import { ingestParsed, listIngestJobs, submitIngest, tombstoneDocument } from '../src/core/ingestion.js'
import { parseHtml, parseMarkdown, parseText, parseTextContent } from '../src/adapters/parsing/index.js'
import { embedder } from '../src/adapters/embeddings/index.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
before(async () => { workspace = await testWorkspace() })
beforeEach(async () => { await clearKnowledge() })
after(async () => { await workspace.close() })

function sourceBlock(text: string, type = 'paragraph', page: number | null = 1, order = 0, headingPath = ['章节']): ParsedBlock {
  return { text, type, page, order, headingPath, bbox: page === null ? null : [10, 20, 100, 120] }
}

test('large tables, code and formula stay atomic and never overlap neighboring prose', () => {
  for (const type of ['table', 'code', 'formula']) {
    const atomic = type === 'code' ? `    ${'const value = 1;\n'.repeat(200)}` : '结构内容'.repeat(800)
    const chunks = chunkBlocks([sourceBlock('前文'), sourceBlock(atomic, type, 1, 1), sourceBlock('后文', 'paragraph', 1, 2)])
      .filter((chunk) => !chunk.isParent)
    assert.deepEqual(chunks.map((chunk) => chunk.text), ['前文', atomic, '后文'])
    assert.equal(chunks[1]!.blockType, type)
    assert.ok(chunks[1]!.tokenCount > MAX_TOKENS)
  }
})

test('paragraph windows obey the estimated token budget, overlap and preserve UTF-16 spans', () => {
  const text = '知识🙂能够追溯。'.repeat(400)
  const chunks = chunkBlocks([sourceBlock(text)]).filter((chunk) => !chunk.isParent)
  assert.ok(chunks.length > 1)
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(chunk.tokenCount <= MAX_TOKENS)
    assert.equal(chunk.sourceSpans.length, 1)
    const span = chunk.sourceSpans[0]!
    assert.equal(text.slice(span.start, span.end), chunk.text)
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text))
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text))
    if (index > 0) assert.ok(span.start < chunks[index - 1]!.sourceSpans[0]!.end)
  }
})

test('a section spanning pages emits page-correct children and normalized source offsets', () => {
  const blocks = [sourceBlock('第1页🙂内容', 'paragraph', 1), sourceBlock('第2页内容', 'paragraph', 2, 1)]
  const text = blocks.map((block) => block.text).join('\n\n')
  const all = chunkBlocks(blocks)
  assert.equal(all[0]!.page, null)
  const children = all.filter((chunk) => !chunk.isParent)
  assert.deepEqual(children.map((chunk) => chunk.page), [1, 2])
  for (const child of children) {
    assert.equal(child.text, child.sourceSpans.map((span) => text.slice(span.start, span.end)).join('\n\n'))
    assert.deepEqual(child.bbox, [10, 20, 100, 120])
  }
})

test('repeated heading paths separated by another section are not reordered', () => {
  const chunks = chunkBlocks([
    sourceBlock('第一次A', 'paragraph', 1, 0, ['A']),
    sourceBlock('中间B', 'paragraph', 1, 1, ['B']),
    sourceBlock('第二次A', 'paragraph', 1, 2, ['A']),
  ])
  assert.deepEqual(chunks.filter((chunk) => chunk.isParent).map((chunk) => chunk.text), ['第一次A', '中间B', '第二次A'])
})

test('Markdown preserves adjacent structures, code indentation and section identity', () => {
  const parsed = parseMarkdown('# A\n正文\n列一 | 列二\n--- | ---\n值1 | 值2\n\n~~~js\n    const value = 1;\n~~~\n\n$$\na+b=c\n$$\n\n# B\n| 新列 |\n| --- |\n| 新值 |', '结构')
  assert.deepEqual(parsed.blocks.map((block) => block.type), ['paragraph', 'table', 'code', 'formula', 'table'])
  assert.equal(parsed.blocks[2]!.text, '    const value = 1;')
  assert.deepEqual(parsed.blocks[4]!.headingPath, ['B'])
  assert.equal(parsed.blocks[1]!.text, '列一 | 列二\n--- | ---\n值1 | 值2')
})

test('HTML tables retain cells and preformatted code keeps line breaks', () => {
  const parsed = parseHtml('<h1>章节</h1><p>前文</p><table><tr><th>名称</th><th>数值</th></tr><tr><td>甲</td><td>12</td></tr></table><pre>    one\n      two &lt; 3</pre>', '网页')
  assert.equal(parsed.blocks[1]!.text, '名称 | 数值\n甲 | 12')
  assert.equal(parsed.blocks[2]!.text, '    one\n      two < 3')
  assert.equal(parsed.blocks[2]!.type, 'code')
})

test('pasted Markdown is recognized when a heading appears after an introduction', () => {
  const parsed = parseTextContent('介绍\n\n# 第二节\n内容', '粘贴')
  assert.equal(parsed.parser, 'markdown')
  assert.deepEqual(parsed.blocks[1]!.headingPath, ['第二节'])
})

test('one source creates sequential immutable versions, skips repeats and permits reverting', async () => {
  const principal = workspace.principal
  const first = await ingestParsed(principal, parseText('原始内容A', '测试'), { sourceType: 'txt', uri: 'upload:same.txt' })
  const second = await ingestParsed(principal, parseText('修改内容B', '测试'), { sourceType: 'txt', uri: 'upload:same.txt' })
  const duplicate = await ingestParsed(principal, parseText('修改内容B', '测试'), { sourceType: 'txt', uri: 'upload:same.txt' })
  const reverted = await ingestParsed(principal, parseText('原始内容A', '测试'), { sourceType: 'txt', uri: 'upload:same.txt' })
  assert.equal(first.document_id, second.document_id)
  assert.equal(second.version, 2)
  assert.equal(duplicate.duplicate, true)
  assert.equal(reverted.version, 3)
  assert.equal(reverted.document_id, first.document_id)
  const versions = await query<{ version: number; text: string }>('SELECT version,text FROM document_versions WHERE doc_id=$1 ORDER BY version', [first.document_id])
  assert.deepEqual(versions, [{ version: 1, text: '原始内容A' }, { version: 2, text: '修改内容B' }, { version: 3, text: '原始内容A' }])
})

test('legacy hashed upload URIs are reused without dropping old content', async () => {
  const first = await ingestParsed(workspace.principal, parseText('旧文件正文', '测试'), { sourceType: 'txt', uri: 'upload:legacy.txt:0123456789abcdef' })
  const second = await ingestParsed(workspace.principal, parseText('新版文件正文', '测试'), { sourceType: 'txt', uri: 'upload:legacy.txt' })
  assert.equal(first.document_id, second.document_id)
  assert.equal(second.version, 2)
  const document = await queryOne<{ uri: string }>('SELECT uri FROM documents WHERE id=$1', [first.document_id])
  assert.equal(document!.uri, 'upload:legacy.txt')
  assert.equal((await query('SELECT id FROM document_versions WHERE doc_id=$1', [first.document_id])).length, 2)
})

test('equal content in distinct sources keeps independent identities for future updates', async () => {
  const first = await ingestParsed(workspace.principal, parseText('相同初始内容', '文件甲'), { sourceType: 'txt', uri: 'upload:alpha.txt' })
  const second = await ingestParsed(workspace.principal, parseText('相同初始内容', '文件乙'), { sourceType: 'txt', uri: 'upload:beta.txt' })
  assert.notEqual(first.document_id, second.document_id)
  const updated = await ingestParsed(workspace.principal, parseText('文件乙的新内容', '文件乙'), { sourceType: 'txt', uri: 'upload:beta.txt' })
  assert.equal(updated.document_id, second.document_id)
  assert.equal(updated.version, 2)
  const untouched = await queryOne<{ current_version: number }>('SELECT current_version FROM documents WHERE id=$1', [first.document_id])
  assert.equal(untouched!.current_version, 1)
})

test('explicit document identity wins over a renamed filename and content deduplication', async () => {
  const first = await ingestParsed(workspace.principal, parseText('第一份内容', '第一份'), { sourceType: 'txt', uri: 'upload:first.txt' })
  await ingestParsed(workspace.principal, parseText('另一份内容', '其他'), { sourceType: 'txt', uri: 'upload:other.txt' })
  const updated = await ingestParsed(workspace.principal, parseText('另一份内容', '重命名'), { sourceType: 'txt', uri: 'upload:renamed.txt', documentId: String(first.document_id) })
  assert.equal(updated.document_id, first.document_id)
  assert.equal(updated.version, 2)
  assert.equal(updated.duplicate, false)
  await assert.rejects(ingestParsed(workspace.principal, parseText('拒绝新建', '无效'), { sourceType: 'text', documentId: 'missing-document' }), /目标文档不存在/)
})

test('embedding failure cannot publish a partial document version', async () => {
  const first = await ingestParsed(workspace.principal, parseText('可用版本', '稳定'), { sourceType: 'txt', uri: 'upload:stable.txt' })
  const original = embedder.embedMany
  embedder.embedMany = async () => { throw new Error('offline vector failure') }
  try {
    await assert.rejects(ingestParsed(workspace.principal, parseText('不应发布的新内容', '稳定'), { sourceType: 'txt', uri: 'upload:stable.txt' }), /offline vector failure/)
    const document = await queryOne<{ current_version: number }>('SELECT current_version FROM documents WHERE id=$1', [first.document_id])
    assert.equal(document!.current_version, 1)
    assert.equal((await query('SELECT id FROM document_versions WHERE doc_id=$1', [first.document_id])).length, 1)
  } finally { embedder.embedMany = original }
})

test('chunk provenance is persisted against the exact normalized version text', async () => {
  const parsed = parseMarkdown('# 资料\n段落🙂\n\n| 列 |\n| --- |\n| 值 |', '定位')
  const result = await ingestParsed(workspace.principal, parsed, { sourceType: 'md', uri: 'upload:source.md' })
  const version = await queryOne<{ text: string; meta: { coordinate_system: string; chunk_spans: Record<string, Array<{ start: number; end: number }>> } }>('SELECT text,meta FROM document_versions WHERE id=$1', [result.version_id])
  assert.equal(version!.meta.coordinate_system, 'normalized-text-utf16')
  const chunks = await query<{ id: string; text: string }>('SELECT id,text FROM chunks WHERE version_id=$1 AND is_parent=false', [result.version_id])
  for (const chunk of chunks) {
    const spans = version!.meta.chunk_spans[chunk.id]!
    assert.equal(spans.map((span) => version!.text.slice(span.start, span.end)).join('\n\n'), chunk.text)
  }
})

test('simultaneous updates to the same source are serialized into a version chain', async () => {
  const results = await Promise.all(['甲版本', '乙版本', '丙版本'].map((text) => ingestParsed(workspace.principal, parseText(text, '并发'), { sourceType: 'txt', uri: 'upload:concurrent.txt' })))
  assert.equal(new Set(results.map((result) => result.document_id)).size, 1)
  assert.deepEqual(results.map((result) => result.version), [1, 2, 3])
})

test('simultaneous ingestion of different sources commits complete independent versions', async () => {
  const results = await Promise.all(['文档甲独立正文', '文档乙独立正文', '文档丙独立正文'].map((text, index) =>
    ingestParsed(workspace.principal, parseText(text, `独立文档${index}`), { sourceType: 'txt', uri: `upload:independent-${index}.txt` }),
  ))
  assert.equal(new Set(results.map((result) => result.document_id)).size, 3)
  for (const [index, result] of results.entries()) {
    assert.equal(result.version, 1)
    const versions = await query<{ id: string; text: string }>('SELECT id,text FROM document_versions WHERE doc_id=$1', [result.document_id])
    assert.equal(versions.length, 1)
    assert.equal(versions[0]!.id, result.version_id)
    const chunks = await query<{ version_id: string; text: string; is_parent: boolean }>('SELECT version_id,text,is_parent FROM chunks WHERE doc_id=$1', [result.document_id])
    assert.equal(chunks.length, 2)
    assert.ok(chunks.every((chunk) => chunk.version_id === result.version_id && chunk.text === ['文档甲独立正文', '文档乙独立正文', '文档丙独立正文'][index]))
    assert.equal(chunks.filter((chunk) => !chunk.is_parent).length, 1)
  }
})

test('deleting a source retracts legacy evidence-free facts but preserves shared evidence', async () => {
  const first = await ingestParsed(workspace.principal, parseText('第一份来源', '来源一'), { sourceType: 'txt', uri: 'upload:one.txt' })
  const second = await ingestParsed(workspace.principal, parseText('另一份来源', '来源二'), { sourceType: 'txt', uri: 'upload:two.txt' })
  await query("INSERT INTO entities(id,tenant_id,canonical_name,normalized_name) VALUES('entity-audit',$1,'实体','实体')", [workspace.principal.tenantId])
  for (const id of ['legacy-fact', 'shared-fact']) {
    await query("INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,source_doc_id) VALUES($1,$2,'entity-audit','属性','值',$3)", [id, workspace.principal.tenantId, first.document_id])
  }
  await query("INSERT INTO fact_evidence(id,fact_id,doc_id,quote) VALUES('shared-evidence','shared-fact',$1,'另一份来源')", [second.document_id])
  const deleted = await tombstoneDocument(workspace.principal, String(first.document_id))
  assert.equal(deleted.affected_facts, 2)
  const facts = await query<{ id: string; status: string }>('SELECT id,status FROM facts ORDER BY id')
  assert.deepEqual(facts, [{ id: 'legacy-fact', status: 'retracted' }, { id: 'shared-fact', status: 'active' }])
})

test('the upload job uses a stable source URI for successive same-named files', async () => {
  const upload = async (text: string) => {
    const job = submitIngest(workspace.principal, 'file', { filename: 'job-version.txt', data: Buffer.from(text) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = listIngestJobs(workspace.principal, false).find((item) => item.job_id === job.job_id)!
      if (current.status === 'failed') assert.fail(String(current.error))
      if (current.status === 'done') {
        const document = await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents WHERE id=$1', [current.doc_id])
        if (document && ['done', 'empty', 'failed'].includes(document.enrichment_status)) return current
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('upload job did not complete')
  }
  const first = await upload('上传版本甲')
  const second = await upload('上传版本乙')
  assert.equal(first.doc_id, second.doc_id)
  assert.equal(second.version, 2)
})
