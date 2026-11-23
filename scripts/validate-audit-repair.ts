/** Real-library audit follow-up. Uses only the existing configured providers. */
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { settings } from '../src/config.js'
import { query, closePool } from '../src/db/index.js'
import { reindexDocument } from '../src/core/reindexing.js'
import { documentEmbeddingInput } from '../src/core/embedding-input.js'
import { sparseVector, tokenize } from '../src/adapters/embeddings/index.js'
import { ask } from '../src/core/answering.js'
import { defaultPrincipal } from '../src/core/security.js'
import { harness } from '../src/adapters/harness/index.js'
import { withRequestMeter } from '../src/util/request-meter.js'
import type { ChunkRow } from '../src/core/rows.js'
import { newId } from '../src/core/ids.js'

const phase = process.argv[2] ?? 'inspect'
if (!['inspect', 'reindex', 'questions', 'memory', 'api', 'integrity'].includes(phase)) throw new Error('phase 必须为 inspect、reindex、questions、memory、api 或 integrity')
const outputDir = join(settings.dataDir, 'audit-2026-11-23')
await mkdir(outputDir, { recursive: true, mode: 0o700 })
await chmod(outputDir, 0o700)
const save = (name: string, value: unknown, exclusive = false) => writeFile(join(outputDir, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: exclusive ? 'wx' : 'w' })
const tenant = settings.defaultTenantId
const documentIds = [
  'doc_8a9676fa4a9bf6b0d180', 'doc_482f548ba7dee6d26466', 'doc_e6bb17f7f679cf367628', 'doc_86706d28f81e4af72a5a',
  'doc_ac995afa14ea0d44eb2d', 'doc_020c76cfa860c317b230', 'doc_d2955ef73597965fa816', 'doc_1485194ee3b70d26549a',
]

async function inventory() {
  return query(`SELECT d.id,d.title,d.current_version,d.created_by,count(c.id)::int AS chunks,
    count(*) FILTER(WHERE (SELECT count(*) FROM jsonb_object_keys(c.sparse))=96)::int AS old_sparse,
    count(*) FILTER(WHERE c.text ~ $2)::int AS radical_chunks
    FROM documents d JOIN chunks c ON c.doc_id=d.id AND c.is_parent=false
    JOIN document_versions v ON v.id=c.version_id AND v.version=d.current_version
    WHERE d.tenant_id=$1 AND d.status='active' GROUP BY d.id ORDER BY d.title`, [tenant, '[\u2e80-\u2fdf]'])
}

async function identities() {
  const [row] = await query<{ state: Record<string, unknown> }>(`SELECT jsonb_build_object(
    'documents', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(id||':'||current_version||':'||status||':'||content_hash,',' ORDER BY id),''))) FROM documents WHERE tenant_id=$1),
    'versions', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(id||':'||hash,',' ORDER BY id),''))) FROM document_versions WHERE tenant_id=$1),
    'chunks', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(id||':'||version_id||':'||md5(text)||':'||acl_principals::text,',' ORDER BY id),''))) FROM chunks WHERE tenant_id=$1),
    'facts', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(id,',' ORDER BY id),''))) FROM facts WHERE tenant_id=$1),
    'entities', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(id,',' ORDER BY id),''))) FROM entities WHERE tenant_id=$1),
    'evidence', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(e.id||':'||e.chunk_id||':'||e.doc_id,',' ORDER BY e.id),''))) FROM fact_evidence e JOIN facts f ON f.id=e.fact_id WHERE f.tenant_id=$1),
    'continuations', (SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(id||':'||predecessor_doc_id||':'||successor_doc_id||':'||effective_date,',' ORDER BY id),''))) FROM document_continuations WHERE tenant_id=$1)
    ) AS state`, [tenant])
  return row!.state
}

async function reindex() {
  const selected = await query<{ id: string; title: string }>(
    "SELECT id,title FROM documents WHERE tenant_id=$1 AND id=ANY($2::text[]) AND status='active' ORDER BY title", [tenant, documentIds])
  assert.equal(selected.length, 8, '授权的 8 份文档必须全部存在且处于活跃状态')
  const before = await identities()
  const vectors = await query<Pick<ChunkRow, 'id' | 'doc_id' | 'dense' | 'sparse' | 'embedding_model' | 'embedding_dim'>>(
    'SELECT id,doc_id,dense,sparse,embedding_model,embedding_dim FROM chunks WHERE tenant_id=$1 AND doc_id=ANY($2::text[]) AND is_parent=false ORDER BY id', [tenant, documentIds])
  assert.ok(vectors.some(row => Object.keys(row.sparse).length === 96), '没有找到待修复的旧索引，拒绝重复重建')
  await save('pre-reindex-vectors.json', { created_at: new Date().toISOString(), tenant_id: tenant, documents: selected, identities: before, vectors }, true)
  const counters = { model: 0, embedding: 0 }
  const results: unknown[] = []
  const timer = setInterval(() => console.log(JSON.stringify({ phase: 'reindex', ...counters })), 20_000)
  try {
    for (const document of selected) {
      const started = Date.now()
      const result = await withRequestMeter(counters, () => reindexDocument(tenant, document.id))
      const row = { title: document.title, ...result, latency_ms: Date.now() - started }
      results.push(row)
      await save('reindex-progress.json', { results, counters })
      console.log(JSON.stringify(row))
    }
  } finally { clearInterval(timer) }
  const chunks = await query<ChunkRow & { title: string }>(
    'SELECT c.*,d.title FROM chunks c JOIN documents d ON d.id=c.doc_id WHERE c.tenant_id=$1 AND c.doc_id=ANY($2::text[]) AND c.is_parent=false', [tenant, documentIds])
  for (const chunk of chunks) {
    const expected = sparseVector(tokenize(documentEmbeddingInput(chunk.title, chunk.heading_path, chunk.text)))
    assert.deepEqual(chunk.sparse, expected, `稀疏词元不完整：${chunk.id}`)
    assert.equal(chunk.dense.length, chunk.embedding_dim)
    assert.ok(chunk.dense.every(Number.isFinite))
  }
  const after = await identities()
  assert.deepEqual(after, before, '重建不得改变文档、原文、版本、切块、事实、实体、证据或沿革身份')
  const report = { results, counters, checked_chunks: chunks.length, unchanged_identities: true, before, after, inventory: await inventory() }
  await save('reindex-results.json', report)
  console.log(JSON.stringify({ phase: 'reindex.done', checked_chunks: chunks.length, unchanged_identities: true, counters }))
}

interface Case {
  question: string
  required?: string[]
  docs?: string[]
  mode?: string
  asOf?: string
  refuse?: boolean
}
const cases: Case[] = [
  { question: '2023年基本公共卫生服务人均财政补助标准是多少？', required: ['89'], docs: ['2023'] },
  { question: '2024年基本公共卫生服务人均财政补助标准是多少？', required: ['94'], docs: ['2024'] },
  { question: '2025年基本公共卫生服务人均财政补助标准是多少？', required: ['99'], docs: ['2025'] },
  { question: '2026年基本公共卫生服务人均财政补助标准是多少？', required: ['99'], docs: ['2026'] },
  { question: '基本公共卫生服务人均财政补助标准是多少？', asOf: '2024-06-01', mode: 'timeline', required: ['94'], docs: ['2024'] },
  { question: '对比2024年和2026年基本公共卫生服务人均财政补助标准的高低', mode: 'compare', required: ['94', '99'], docs: ['2024', '2026'] },
  { question: '对比国家规划和山东省规划中2030年人均预期寿命目标的差异', mode: 'compare', required: ['80', '81.7'], docs: ['国民健康', '山东省卫生健康'] },
  { question: '2027年广东省基本公共卫生服务人均财政补助标准是多少？', refuse: true },
  { question: '火星常住人口有多少？', refuse: true },
  { question: '2025年山东省基本公共卫生服务人均财政补助标准是多少？', refuse: true },
]

async function questions() {
  const principal = await defaultPrincipal(tenant)
  assert.ok(principal)
  const results: unknown[] = []
  const counters = { model: 0, embedding: 0 }
  let passed = 0
  for (const item of cases) {
    try {
      const result = await withRequestMeter(counters, () => ask(principal, { ...item, evaluation: true }))
      const citations = result.citations as Array<{ doc_title: string; chunk_id: string; quote: string }>
      const invalidQuotes: string[] = []
      for (const citation of citations) {
        const [chunk] = await query<{ text: string }>('SELECT text FROM chunks WHERE id=$1', [citation.chunk_id])
        if (!citation.quote || !chunk?.text.includes(citation.quote)) invalidQuotes.push(citation.chunk_id)
      }
      const pass = item.refuse ? Boolean(result.refused) : !result.refused && item.required!.every(value => String(result.answer).includes(value))
        && item.docs!.every(value => citations.some(citation => citation.doc_title.includes(value))) && citations.length > 0 && invalidQuotes.length === 0
      if (pass) passed++
      results.push({ case: item, pass, ...result, invalid_quotes: invalidQuotes })
      console.log(JSON.stringify({ pass, question: item.question, answer: result.answer, failure: (result.failure as { stage?: string } | null)?.stage, latency_ms: result.latency_ms, trace_id: result.trace_id }))
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error))
      results.push({ case: item, pass: false, error: message })
      console.log(JSON.stringify({ pass: false, question: item.question, error: message }))
    }
    await save('business-questions.json', { cases: cases.length, passed, results, counters })
  }
  console.log(JSON.stringify({ phase: 'questions.done', cases: cases.length, passed, counters }))
  if (passed !== cases.length) process.exitCode = 1
}

async function memory() {
  const principal = await defaultPrincipal(tenant)
  assert.ok(principal)
  const memoryId = newId('mem')
  const conversationId = newId('conv')
  const label = newId('audit')
  const question = `我的${label}验证办公室在哪里？`
  const text = `我的${label}验证办公室在3楼302室。`
  const before = await identities()
  let result: Record<string, unknown> | undefined
  try {
    await query(`INSERT INTO memory_items(id,tenant_id,user_id,scope,kind,text,confidence,expires_at)
      VALUES($1,$2,$3,'personal','conversation_note',$4,0.7,now()+interval '1 hour')`, [memoryId, tenant, principal.userId, text])
    await query('INSERT INTO conversations(id,tenant_id,user_id,title) VALUES($1,$2,$3,$4)', [conversationId, tenant, principal.userId, label])
    result = await ask(principal, { question, conversationId })
    const citations = result.citations as Array<{ source: string; doc_id: string | null; quote: string }>
    const pass = !result.refused && String(result.answer).includes('302')
      && citations.some(citation => citation.source === 'memory' && citation.doc_id === null && text.includes(citation.quote))
    await save('personal-memory.json', { pass, ...result })
    console.log(JSON.stringify({ phase: 'memory', pass, answer: result.answer, trace_id: result.trace_id }))
    assert.ok(pass, '真实模型的个人记忆回答未通过')
  } finally {
    await query('DELETE FROM citations WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=$1)', [conversationId])
    const traces = await query<{ id: string }>('SELECT id FROM traces WHERE tenant_id=$1 AND user_id=$2 AND question=$3', [tenant, principal.userId, question])
    for (const trace of traces) {
      await query("DELETE FROM eval_cases WHERE tenant_id=$1 AND source=$2", [tenant, `failure-candidate:${trace.id}`])
      await query("UPDATE traces SET feature='eval' WHERE id=$1", [trace.id])
    }
    await query('DELETE FROM messages WHERE conversation_id=$1', [conversationId])
    await query('DELETE FROM conversations WHERE id=$1 AND tenant_id=$2', [conversationId, tenant])
    await query('DELETE FROM memory_items WHERE id=$1 AND tenant_id=$2', [memoryId, tenant])
    await query('DELETE FROM gaps WHERE tenant_id=$1 AND question=$2', [tenant, question.toLowerCase()])
    assert.deepEqual(await identities(), before, '记忆验证不得改变业务知识身份')
    await save('personal-memory-cleanup.json', { memory_id: memoryId, conversation_id: conversationId, cleaned: true, unchanged_knowledge: true })
  }
}

async function api() {
  const principal = await defaultPrincipal(tenant)
  assert.ok(principal)
  const base = `http://127.0.0.1:${settings.serverPort}/api/v1`
  const results: unknown[] = []
  const check = async (name: string, method: string, path: string, expected: number, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${principal.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json() as Record<string, unknown>
    const row = { name, status: response.status, expected, pass: response.status === expected, result }
    results.push(row)
    await save('api-probes.json', results)
    console.log(JSON.stringify({ name, status: response.status, expected, pass: row.pass }))
    assert.equal(response.status, expected, name)
    return result
  }
  // A read-only rejection confirms the running process loaded the new route.
  await check('B12 非 multipart 上传', 'POST', '/documents/upload', 415, {})
  await check('B2 缺少 provider', 'POST', '/prices', 400, { model: 'audit', input_per_million: -5 })
  await check('B2 负价格', 'POST', '/prices', 400, { provider: 'audit', model: 'audit', input_per_1m: -5 })
  for (const [name, acl] of [['B3 元素类型', [123]], ['B4 空 ACL', []], ['B5 幽灵组', ['group:audit_nonexistent_20261123']]] as const) {
    await check(name, 'POST', '/documents/text', 400, { text: '本次审计的授权边界验证文本。', title: 'audit_20261123', acl })
  }
  await check('B6 空白正文', 'POST', '/documents/text', 400, { text: ' \n\t ' })
  await check('B7 空白记忆', 'POST', '/memory', 400, { text: ' \n ' })
  for (const path of ['/documents?limit=0', '/documents?limit=201', '/graph?hops=0', '/graph?hops=11', '/graph?limit=9']) {
    await check(`B8 ${path}`, 'GET', path, 400)
  }
  await check('B9 不存在会话', 'POST', '/ask', 404, { question: '审计会话存在性检查', conversation_id: 'audit_nonexistent_20261123' })
  await check('B10 超长标题', 'POST', '/documents/text', 400, { text: '本次审计的标题长度验证文本。', title: '长'.repeat(501) })
  await check('B11 内网 URL', 'POST', '/documents/url', 400, { url: 'http://127.0.0.1/internal-audit' })
  const [trace] = await query<{ id: string }>("SELECT id FROM traces WHERE tenant_id=$1 AND user_id=$2 AND feature='eval' ORDER BY created_at DESC LIMIT 1", [tenant, principal.userId])
  assert.ok(trace)
  const replay = await check('B1 无 body 回放', 'POST', `/traces/${trace.id}/replay`, 200)
  if (typeof replay.replay_id === 'string') await query('DELETE FROM replay_runs WHERE id=$1 AND tenant_id=$2', [replay.replay_id, tenant])
  console.log(JSON.stringify({ phase: 'api.done', passed: results.length }))
}

async function integrity() {
  const rows = await query<{ check: string; errors: number }>(`
    SELECT '01 chunks_document' AS "check",count(*)::int AS errors FROM chunks c LEFT JOIN documents d ON d.id=c.doc_id AND d.tenant_id=c.tenant_id WHERE d.id IS NULL
    UNION ALL SELECT '02 chunks_version',count(*)::int FROM chunks c LEFT JOIN document_versions v ON v.id=c.version_id AND v.doc_id=c.doc_id AND v.tenant_id=c.tenant_id WHERE v.id IS NULL
    UNION ALL SELECT '03 versions_document',count(*)::int FROM document_versions v LEFT JOIN documents d ON d.id=v.doc_id AND d.tenant_id=v.tenant_id WHERE d.id IS NULL
    UNION ALL SELECT '04 blocks_version',count(*)::int FROM blocks b LEFT JOIN document_versions v ON v.id=b.version_id AND v.doc_id=b.doc_id WHERE v.id IS NULL
    UNION ALL SELECT '05 blocks_document',count(*)::int FROM blocks b LEFT JOIN documents d ON d.id=b.doc_id WHERE d.id IS NULL
    UNION ALL SELECT '06 facts_subject',count(*)::int FROM facts f LEFT JOIN entities e ON e.id=f.subject_id AND e.tenant_id=f.tenant_id WHERE e.id IS NULL
    UNION ALL SELECT '07 facts_object',count(*)::int FROM facts f LEFT JOIN entities e ON e.id=f.object_id AND e.tenant_id=f.tenant_id WHERE f.object_id IS NOT NULL AND e.id IS NULL
    UNION ALL SELECT '08 evidence_fact',count(*)::int FROM fact_evidence e LEFT JOIN facts f ON f.id=e.fact_id WHERE f.id IS NULL
    UNION ALL SELECT '09 evidence_chunk',count(*)::int FROM fact_evidence e LEFT JOIN chunks c ON c.id=e.chunk_id AND c.doc_id=e.doc_id WHERE c.id IS NULL
    UNION ALL SELECT '10 evidence_document',count(*)::int FROM fact_evidence e LEFT JOIN documents d ON d.id=e.doc_id WHERE d.id IS NULL
    UNION ALL SELECT '11 citations_message',count(*)::int FROM citations c LEFT JOIN messages m ON m.id=c.message_id WHERE m.id IS NULL
    UNION ALL SELECT '12 citations_document',count(*)::int FROM citations c LEFT JOIN documents d ON d.id=c.doc_id WHERE c.doc_id IS NOT NULL AND d.id IS NULL
    UNION ALL SELECT '13 citations_chunk',count(*)::int FROM citations c LEFT JOIN chunks k ON k.id=c.chunk_id AND k.doc_id=c.doc_id WHERE c.chunk_id IS NOT NULL AND k.id IS NULL
    UNION ALL SELECT '14 messages_conversation',count(*)::int FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE c.id IS NULL
    UNION ALL SELECT '15 continuation_endpoints',count(*)::int FROM document_continuations c LEFT JOIN documents p ON p.id=c.predecessor_doc_id AND p.tenant_id=c.tenant_id LEFT JOIN documents s ON s.id=c.successor_doc_id AND s.tenant_id=c.tenant_id WHERE p.id IS NULL OR s.id IS NULL
    UNION ALL SELECT '16 current_chunk_acl',count(*)::int FROM chunks c JOIN documents d ON d.id=c.doc_id JOIN document_versions v ON v.id=c.version_id AND v.version=d.current_version WHERE c.acl_principals<>d.acl_principals OR c.acl_version<>d.acl_version
    UNION ALL SELECT '17 embedding_dimensions',count(*)::int FROM chunks WHERE is_parent=false AND (cardinality(dense)<>embedding_dim OR embedding_dim<=0)
    UNION ALL SELECT '18 fact_validity',count(*)::int FROM facts WHERE valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to<valid_from
    UNION ALL SELECT '19 parent_chunks',count(*)::int FROM chunks c LEFT JOIN chunks p ON p.id=c.parent_id AND p.doc_id=c.doc_id AND p.version_id=c.version_id AND p.is_parent=true WHERE c.parent_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT '20 current_versions',count(*)::int FROM documents d LEFT JOIN document_versions v ON v.doc_id=d.id AND v.tenant_id=d.tenant_id AND v.version=d.current_version WHERE d.status='active' AND v.id IS NULL
    UNION ALL SELECT '21 malformed_acl',count(*)::int FROM documents WHERE status='active' AND (jsonb_typeof(acl_principals)<>'array' OR acl_principals='[]'::jsonb)
    ORDER BY 1`)
  const report = { checks: rows.length, errors: rows.reduce((sum, row) => sum + row.errors, 0), results: rows, identities: await identities() }
  await save('integrity.json', report)
  console.log(JSON.stringify(report, null, 2))
  assert.equal(report.checks, 21)
  assert.equal(report.errors, 0, '数据完整性检查发现异常')
}

function redact(message: string): string {
  for (const key of [settings.modelApiKey, settings.embeddingApiKey, settings.rerankApiKey]) if (key) message = message.replaceAll(key, '[redacted]')
  return message
}

try {
  if (phase === 'inspect') {
    const report = { inventory: await inventory(), identities: await identities() }
    await save('inspection.json', report)
    console.log(JSON.stringify(report, null, 2))
  } else if (phase === 'reindex') await reindex()
  else if (phase === 'questions') await questions()
  else if (phase === 'memory') await memory()
  else if (phase === 'api') await api()
  else await integrity()
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exitCode = 1
} finally { await harness.close(); await closePool() }
