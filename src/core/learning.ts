import { query, queryOne } from '../db/index.js'
import { harness } from '../adapters/harness/index.js'
import { estimateTokens } from './chunking.js'
import { newId, todayLocal } from './ids.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from './rows.js'
import { Principal, canRead } from './security.js'
import { settings } from '../config.js'
import { evidenceWeight } from './source-policy.js'
import { resolveSemanticEntity } from './entity-resolution.js'
import { consolidateKnowledge } from './consolidation.js'

const EXTRACT_SYSTEM = `你是 KnoWeave 的事实抽取器。只抽取原文明确陈述、可被引用验证的断言。
输出一个 JSON 数组，不要输出任何解释或 Markdown。每项字段：
subject, subject_type(product|org|person|concept|event), predicate, object,
object_type, object_literal, valid_from(YYYY-MM-DD 或 null), valid_to(YYYY-MM-DD 或 null),
confidence(0-1), quote(必须逐字来自原文，不超过120字)。
规则：谓词用简短中文动词短语；不要抽取常识、推测、代词指代；最多 12 条；
数字、日期、版本必须保留；主语与宾语保留引文中的写法；没有明确主语时不要抽取。`

const DATE_RE = /(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})?/

interface Candidate {
  subject: string
  subjectType: string
  predicate: string
  objectName: string
  objectType: string
  objectLiteral: string
  validFrom: string | null
  validTo: string | null
  confidence: number
  quote: string
  chunkId: string | null
}

export function normalizeName(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/[\s\u3000·•\-_/]+/g, '')
}

export function parseDate(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  const text = String(value).trim()
  if (!text || ['null', 'none', '无'].includes(text.toLowerCase())) return null
  const match = DATE_RE.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3] ?? 1)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function parseJsonArray(text: string): Array<Record<string, unknown>> {
  let body = text.trim()
  if (!body) return []
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(body)
  if (fence) body = fence[1]!.trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const payload = JSON.parse(body.slice(start, end + 1)) as unknown
    return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : []
  } catch {
    return []
  }
}

export async function getOrCreateEntity(
  tenantId: string,
  name: string,
  entityType = 'concept',
  acl?: string[] | null,
): Promise<EntityRow> {
  const normalized = normalizeName(name)
  const existing = await queryOne<EntityRow>(
    `SELECT * FROM entities WHERE tenant_id = $1 AND normalized_name = $2 AND status = 'active' LIMIT 1`,
    [tenantId, normalized],
  )
  if (existing) return existing
  const alias = await queryOne<{ entity_id: string }>(
    `SELECT a.entity_id FROM entity_aliases a JOIN entities e ON a.entity_id = e.id
     WHERE e.tenant_id = $1 AND a.normalized_alias = $2 LIMIT 1`,
    [tenantId, normalized],
  )
  if (alias) {
    const aliased = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [alias.entity_id])
    if (aliased) return aliased
  }
  const semantic = await resolveSemanticEntity(tenantId, name, entityType, acl?.length ? acl : ['tenant:public'])
  if (semantic) {
    await query(`INSERT INTO entity_aliases (id,entity_id,alias,normalized_alias,source) VALUES ($1,$2,$3,$4,'semantic-confirmed')`, [newId('ali'), semantic.id, name.trim(), normalized])
    return semantic
  }
  const id = newId('ent')
  await query(
    `INSERT INTO entities (id, tenant_id, type, canonical_name, normalized_name, description, status, acl_principals)
     VALUES ($1, $2, $3, $4, $5, '', 'active', $6::jsonb)`,
    [id, tenantId, entityType || 'concept', name.trim(), normalized, JSON.stringify(acl?.length ? acl : ['tenant:public'])],
  )
  await query(
    `INSERT INTO entity_aliases (id, entity_id, alias, normalized_alias, source)
     VALUES ($1, $2, $3, $4, 'extraction')`,
    [newId('ali'), id, name.trim(), normalized],
  )
  return (await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [id]))!
}

const EXTRACTION_BATCH_CHARS = 7000
const MIN_FACT_CONFIDENCE = 0.7
const EXTRACTION_OVERLAP = 180

function quotedChunk(chunks: ChunkRow[], quote: string): ChunkRow | null {
  if (!quote.trim()) return null
  return chunks.find((chunk) => chunk.text.includes(quote)) ?? null
}

function extractionBatches(chunks: ChunkRow[]): Array<{ text: string; chunks: ChunkRow[] }> {
  const batches: Array<{ text: string; chunks: ChunkRow[] }> = []
  let parts: string[] = []
  let included: ChunkRow[] = []
  let size = 0
  const flush = () => {
    if (parts.length) batches.push({ text: parts.join('\n\n'), chunks: included })
    parts = []
    included = []
    size = 0
  }
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.text.length;) {
      const part = chunk.text.slice(offset, offset + EXTRACTION_BATCH_CHARS)
      if (size + part.length + (parts.length ? 2 : 0) > EXTRACTION_BATCH_CHARS) flush()
      parts.push(part)
      if (!included.some((item) => item.id === chunk.id)) included.push(chunk)
      size += part.length + (parts.length > 1 ? 2 : 0)
      if (offset + part.length >= chunk.text.length) break
      offset += part.length - EXTRACTION_OVERLAP
      flush()
    }
  }
  flush()
  return batches
}

function isLiteralTarget(value: string, type: string): boolean {
  return ['literal', 'number', 'date', 'string'].includes(type)
    || /^[+-]?\d+(?:\.\d+)?\s*[^\d]*$/.test(value)
}

function quoteContains(quote: string, term: string): boolean {
  const compact = (text: string) => text.toLowerCase().replace(/\s+/g, '')
  const text = compact(quote)
  const target = compact(term)
  if (!/^[+-]?\d/.test(target)) return text.includes(target)
  for (let index = text.indexOf(target); index >= 0; index = text.indexOf(target, index + 1)) {
    const before = text[index - 1] ?? ''
    const after = text[index + target.length] ?? ''
    if (/[+\-\d.]/.test(before)) continue
    if (/\d$/.test(target) && /[\d.]/.test(after)) continue
    return true
  }
  return false
}

async function extractCandidates(document: DocumentRow): Promise<Candidate[]> {
  const chunks = await query<ChunkRow>(
    `SELECT c.* FROM chunks c JOIN document_versions v ON c.version_id = v.id
     WHERE c.doc_id = $1 AND c.is_parent = false AND v.version = $2 ORDER BY c.seq`,
    [document.id, document.current_version],
  )
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const [index, batch] of extractionBatches(chunks).entries()) {
    const prompt = `文档标题：${document.title}\n来源类型：${document.source_type}\n分批：${index + 1}\n\n原文：\n${batch.text}\n\n请输出 JSON 数组。`
    const result = await harness.complete(prompt, EXTRACT_SYSTEM, 1600)
    const extracted: Candidate[] = []
    for (const item of parseJsonArray(result.text)) {
      const subject = String(item.subject ?? '').trim()
      const predicate = String(item.predicate ?? '').trim()
      const object = String(item.object ?? '').trim()
      const literal = String(item.object_literal ?? '').trim()
      const quote = String(item.quote ?? '').trim()
      if (!subject || !predicate || !(object || literal) || !quote) continue
      if (['它', '他', '她', '该系统', '本系统', '这'].includes(subject)) continue
      const chunk = quotedChunk(batch.chunks, quote)
      // A nearby sentence, fuzzy token overlap or matching quote prefix is not
      // evidence for an extracted assertion. Keep the entire verbatim quote.
      if (!chunk || !batch.text.includes(quote)) continue
      if (!quoteContains(quote, subject)) continue
      if (!quoteContains(quote, object || literal)) continue
      const validFrom = parseDate(item.valid_from)
      const validTo = parseDate(item.valid_to)
      if (validFrom && validTo && validFrom >= validTo) continue
      const confidence = Number(item.confidence ?? 0.7)
      const objectType = String(item.object_type ?? 'concept').slice(0, 24)
      const literalTarget = !object || isLiteralTarget(object, objectType)
      extracted.push({
        subject: subject.slice(0, 120),
        subjectType: String(item.subject_type ?? 'concept').slice(0, 24),
        predicate: predicate.slice(0, 120),
        objectName: literalTarget ? '' : object.slice(0, 120),
        objectType,
        objectLiteral: (literalTarget ? literal || object : literal).slice(0, 200),
        validFrom,
        validTo,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(0.99, confidence)) : 0.7,
        quote,
        chunkId: chunk.id,
      })
    }
    for (const candidate of extracted.length ? extracted : ruleExtractCandidates(batch.text, batch.chunks)) {
      const key = [normalizeName(candidate.subject), candidate.predicate, normalizeName(candidate.objectName || candidate.objectLiteral), candidate.validFrom, candidate.validTo, candidate.chunkId].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
    }
  }
  return candidates
}

function ruleExtractCandidates(text: string, chunks: ChunkRow[]): Candidate[] {
  const pattern = /([\u4e00-\u9fffA-Za-z0-9·\-]{2,24})(采用|使用|基于|依赖|支持|提供|发布|推出|属于|位于|成立于|由)([^，。；：\n]{2,40})/g
  const candidates: Candidate[] = []
  for (const sentence of text.split(/[。！？!?；;\n]/)) {
    const body = sentence.trim()
    if (body.length < 6) continue
    for (const match of body.matchAll(pattern)) {
      const subject = match[1]!.trim()
      const predicate = match[2]!.trim()
      const object = match[3]!.trim()
      if (['我们', '本系统', '该系统', '它'].includes(subject) || object.length < 2) continue
      const quote = match[0]
      const chunk = quotedChunk(chunks, quote)
      if (!chunk) continue
      candidates.push({
        subject: subject.slice(0, 120),
        subjectType: /[A-Za-z]/.test(subject) ? 'product' : 'concept',
        predicate,
        objectName: isLiteralTarget(object, '') ? '' : object.slice(0, 120),
        objectType: /[A-Za-z]/.test(object) ? 'product' : 'concept',
        objectLiteral: object.slice(0, 200),
        validFrom: null,
        validTo: null,
        confidence: 0.52,
        quote,
        chunkId: chunk.id,
      })
    }
  }
  return candidates
}

type Period = Pick<FactRow, 'valid_from' | 'valid_to'>

function dateOnly(value: unknown): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function periodsOverlap(a: Period, b: Period): boolean {
  const aStart = dateOnly(a.valid_from) ?? '0000-01-01'
  const aEnd = dateOnly(a.valid_to) ?? '9999-12-31'
  const bStart = dateOnly(b.valid_from) ?? '0000-01-01'
  const bEnd = dateOnly(b.valid_to) ?? '9999-12-31'
  // valid_to is exclusive, matching timeline retrieval's date filtering.
  return aStart < bEnd && bStart < aEnd
}

function equalLiteral(left: string | null, right: string, predicate: string): boolean {
  if ((left ?? '').trim().toLowerCase() === right.trim().toLowerCase()) return true
  if (/版本|version|编号|标识/i.test(predicate)) return false
  const numeric = /^([+-]?\d+(?:\.\d+)?)\s*([^\d]*)$/
  const a = numeric.exec(left ?? '')
  const b = numeric.exec(right)
  if (!a || !b || a[2]!.trim() !== b[2]!.trim()) return false
  const x = Number(a[1])
  const y = Number(b[1])
  // Only tolerate decimal representation noise; do not silently round
  // measurements, prices, dates or version identifiers into the same fact.
  return Math.abs(x - y) <= Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(y))
}

async function appendEvidence(factId: string, document: DocumentRow, candidate: Candidate): Promise<boolean> {
  if (!candidate.chunkId) return false
  const chunk = await queryOne<ChunkRow>(
    `SELECT c.* FROM chunks c JOIN document_versions v ON c.version_id = v.id
     JOIN documents d ON c.doc_id = d.id
     WHERE c.id = $1 AND c.doc_id = $2 AND c.is_parent = false
       AND v.version = $3 AND d.current_version = $3 AND d.status = 'active'`,
    [candidate.chunkId, document.id, document.current_version],
  )
  if (!chunk || !chunk.text.includes(candidate.quote)) return false
  const duplicate = await queryOne<{ id: string }>(
    'SELECT id FROM fact_evidence WHERE fact_id = $1 AND chunk_id = $2 AND quote = $3 LIMIT 1',
    [factId, candidate.chunkId, candidate.quote],
  )
  if (duplicate) return true
  const start = chunk.text.indexOf(candidate.quote)
  await query(
    `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote, span, weight)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [newId('ev'), factId, chunk.id, document.id, candidate.quote, JSON.stringify({ start, end: start + candidate.quote.length }), evidenceWeight(document)],
  )
  return true
}

async function factSources(factId: string): Promise<Array<{ doc_id: string; weight: number }>> {
  return query<{ doc_id: string; weight: number }>(
    `SELECT e.doc_id, max(e.weight) AS weight FROM fact_evidence e
     JOIN chunks c ON c.id = e.chunk_id JOIN document_versions v ON v.id = c.version_id
     JOIN documents d ON d.id = e.doc_id
     WHERE e.fact_id = $1 AND d.status = 'active' AND v.version = d.current_version
     GROUP BY e.doc_id`,
    [factId],
  )
}

async function queueFactReview(
  principal: Principal, subject: EntityRow, fact: FactRow, candidate: Candidate,
  document: DocumentRow, conflicting: FactRow[], reason: string,
): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM review_queue WHERE tenant_id = $1 AND status = 'open'
       AND payload->>'new_fact_id' = $2 LIMIT 1`,
    [principal.tenantId, fact.id],
  )
  const oldObjects: unknown[] = []
  for (const old of conflicting) {
    oldObjects.push(old.object_id
      ? (await queryOne<EntityRow>('SELECT canonical_name FROM entities WHERE id = $1', [old.object_id]))?.canonical_name
      : old.object_literal)
  }
  const payload = JSON.stringify({
    subject: subject.canonical_name, predicate: fact.predicate,
    new_fact_id: fact.id, new_object: candidate.objectName || candidate.objectLiteral,
    old_fact_ids: conflicting.map((old) => old.id), old_objects: oldObjects,
    quote: candidate.quote, doc_id: document.id, reason,
  })
  if (existing) {
    await query('UPDATE review_queue SET payload = $1::jsonb, kind = $2 WHERE id = $3', [payload, conflicting.length ? 'fact_conflict' : 'fact_validation', existing.id])
    return
  }
  await query(
    `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
    [newId('rev'), principal.tenantId, conflicting.length ? 'fact_conflict' : 'fact_validation', `${subject.canonical_name} · ${candidate.predicate}`, payload],
  )
}

async function mergeOrArbitrate(principal: Principal, document: DocumentRow, candidate: Candidate): Promise<string> {
  await query('DELETE FROM knowledge_summaries WHERE tenant_id=$1', [principal.tenantId])
  if (!candidate.chunkId) return 'rejected'
  const chunk = await queryOne<ChunkRow>(
    `SELECT c.* FROM chunks c JOIN document_versions v ON c.version_id = v.id
     JOIN documents d ON c.doc_id = d.id
     WHERE c.id = $1 AND c.doc_id = $2 AND c.is_parent = false AND v.version = $3
       AND d.current_version = $3 AND d.status = 'active'`,
    [candidate.chunkId, document.id, document.current_version],
  )
  if (!chunk || !chunk.text.includes(candidate.quote)) return 'rejected'
  const acl = document.acl_principals?.length ? document.acl_principals : ['tenant:public']
  const subject = await getOrCreateEntity(principal.tenantId, candidate.subject, candidate.subjectType, acl)
  const objectEntity = candidate.objectName
    ? await getOrCreateEntity(principal.tenantId, candidate.objectName, candidate.objectType, acl)
    : null
  const existingFacts = await query<FactRow>(
    `SELECT * FROM facts WHERE tenant_id = $1 AND subject_id = $2 AND predicate = $3
       AND status IN ('active', 'disputed')`,
    [principal.tenantId, subject.id, candidate.predicate],
  )
  const sameTarget = (fact: FactRow) => objectEntity
    ? fact.object_id === objectEntity.id
    : fact.object_id === null && equalLiteral(fact.object_literal, candidate.objectLiteral, candidate.predicate)
  const candidatePeriod = { valid_from: candidate.validFrom, valid_to: candidate.validTo }
  const sameObject = existingFacts.find((fact) => sameTarget(fact) && periodsOverlap(fact, candidatePeriod))
  let fact: FactRow
  const wasActive = sameObject?.status === 'active'
  if (sameObject) {
    const priorSources = await factSources(sameObject.id)
    const priorWeight = priorSources.reduce((sum, source) => sum + source.weight, 0)
    const independent = !priorSources.some((source) => source.doc_id === document.id)
    const addedWeight = evidenceWeight(document)
    const confidence = independent && priorWeight
      ? (sameObject.confidence * priorWeight + candidate.confidence * addedWeight) / (priorWeight + addedWeight)
      : sameObject.confidence
    const starts = [sameObject.valid_from, candidate.validFrom].map(dateOnly)
    const ends = [sameObject.valid_to, candidate.validTo].map(dateOnly)
    await query('UPDATE facts SET confidence = $1, acl_principals = $2::jsonb, valid_from = $3, valid_to = $4 WHERE id = $5', [
      confidence,
      JSON.stringify([...new Set(sameObject.acl_principals ?? [])].filter((item) => acl.includes(item))),
      starts.includes(null) ? null : starts.slice().sort()[0],
      ends.includes(null) ? null : ends.slice().sort().at(-1),
      sameObject.id,
    ])
    fact = (await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [sameObject.id]))!
  } else {
    const factId = newId('f')
    await query(
      `INSERT INTO facts
         (id, tenant_id, subject_id, predicate, object_id, object_literal, valid_from, valid_to,
          recorded_at, confidence, status, acl_principals, source_doc_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, 'disputed', $10::jsonb, $11)`,
      [factId, principal.tenantId, subject.id, candidate.predicate, objectEntity?.id ?? null,
        objectEntity ? null : candidate.objectLiteral, candidate.validFrom, candidate.validTo,
        candidate.confidence, JSON.stringify(acl), document.id],
    )
    fact = (await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [factId]))!
  }
  if (!(await appendEvidence(fact.id, document, candidate))) {
    if (!sameObject) await query(`UPDATE facts SET status = 'retracted' WHERE id = $1`, [fact.id])
    return 'rejected'
  }
  const sources = await factSources(fact.id)
  const conflicting = existingFacts.filter((old) => old.id !== fact.id && !sameTarget(old) && periodsOverlap(old, fact))
  const supported = sources.length >= 2 && fact.confidence >= MIN_FACT_CONFIDENCE && candidate.confidence >= MIN_FACT_CONFIDENCE
  const sourceVote = sources.reduce((sum, source) => sum + Number(source.weight), 0)
  const conflictingVotes = await Promise.all(conflicting.map(async old => (await factSources(old.id)).reduce((sum, source) => sum + Number(source.weight), 0)))
  const winsSourceVote = conflictingVotes.every(vote => sourceVote > vote)
  const canSupersede = supported && winsSourceVote && fact.valid_from !== null && conflicting.length > 0 && conflicting.every((old) =>
    old.valid_from !== null && dateOnly(fact.valid_from)! > dateOnly(old.valid_from)!,
  )
  if (wasActive || (supported && (!conflicting.length || canSupersede))) {
    await query(`UPDATE facts SET status = 'active' WHERE id = $1`, [fact.id])
    if (canSupersede) {
      for (const old of conflicting) {
        await query(`UPDATE facts SET status = 'superseded', valid_to = $1, superseded_by = $2 WHERE id = $3`, [fact.valid_from, fact.id, old.id])
      }
    }
    await query(
      `UPDATE review_queue SET status = 'resolved', resolution = $1::jsonb, resolved_at = now()
       WHERE tenant_id = $2 AND status = 'open' AND payload->>'new_fact_id' = $3`,
      [JSON.stringify({ action: 'corroborated', by: 'system', sources: sources.length }), principal.tenantId, fact.id],
    )
    return canSupersede ? 'superseded' : sameObject ? 'merged' : 'created'
  }
  const reason = conflicting.length
    ? '同一主语与谓词出现不同宾语，且有效期重叠；进入人工审阅。'
    : fact.confidence < MIN_FACT_CONFIDENCE
      ? '候选置信度低于0.7；需人工验证后生效。'
      : '当前只有单份文档支持；需独立来源佐证或人工审阅后生效。'
  await queueFactReview(principal, subject, fact, candidate, document, conflicting, reason)
  return 'disputed'
}

const extractionTasks = new Map<string, Promise<Record<string, unknown>>>()

export async function extractFactsForDocument(principal: Principal, docId: string): Promise<Record<string, unknown>> {
  const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
  if (!document || document.tenant_id !== principal.tenantId || document.status !== 'active') return { error: '文档不存在' }
  const key = `${principal.tenantId}:${docId}:${document.current_version}`
  const existing = extractionTasks.get(key)
  if (existing) return existing
  const task = extractDocument(principal, document).finally(() => extractionTasks.delete(key))
  extractionTasks.set(key, task)
  return task
}

async function extractDocument(principal: Principal, document: DocumentRow): Promise<Record<string, unknown>> {
  const docId = document.id
  const version = await queryOne<VersionRow>(
    'SELECT * FROM document_versions WHERE doc_id = $1 AND version = $2',
    [docId, document.current_version],
  )
  if (!version) return { error: '版本不存在' }
  await query(`UPDATE documents SET enrichment_status = 'running' WHERE id = $1`, [docId])
  const started = Date.now()
  try {
    const candidates = await extractCandidates(document)
    const current = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
    if (!current || current.status !== 'active' || current.current_version !== document.current_version) {
      return { document_id: docId, status: 'stale', candidates: 0, message: '抽取期间文档已更新，本次旧版本结果已丢弃' }
    }
    const counts: Record<string, number> = { created: 0, merged: 0, superseded: 0, disputed: 0, rejected: 0 }
    for (const candidate of candidates) {
      const outcome = await mergeOrArbitrate(principal, document, candidate)
      counts[outcome] = (counts[outcome] ?? 0) + 1
    }
    await query(`UPDATE documents SET enrichment_status = $1 WHERE id = $2 AND current_version = $3 AND status = 'active'`, [candidates.length ? 'done' : 'empty', docId, document.current_version])
    await consolidateKnowledge(principal.tenantId)
    return {
      document_id: docId,
      candidates: candidates.length,
      outcomes: counts,
      elapsed_ms: Date.now() - started,
    }
  } catch (error) {
    await query(`UPDATE documents SET enrichment_status = 'failed' WHERE id = $1 AND current_version = $2 AND status = 'active'`, [docId, document.current_version])
    throw error
  }
}

export async function resolveReview(
  principal: Principal,
  reviewId: string,
  action: string,
  note = '',
): Promise<Record<string, unknown>> {
  const review = await queryOne<{ id: string; tenant_id: string; status: string; kind: string; payload: Record<string, unknown> }>(
    'SELECT id, tenant_id, status, kind, payload FROM review_queue WHERE id = $1',
    [reviewId],
  )
  if (!review || review.tenant_id !== principal.tenantId) throw new Error('审阅项不存在')
  if (review.status !== 'open') throw new Error('审阅项已处理')
  if (review.kind === 'parse_failure') throw Object.assign(new Error('解析失败项请通过任务重试或人工修正文处理'), { statusCode: 409 })
  const payload = review.payload ?? {}
  const newFact = payload.new_fact_id
    ? await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [String(payload.new_fact_id)])
    : null
  if (newFact?.source_doc_id && ['accept_new', 'supersede', 'merge'].includes(action)) {
    if (newFact.status === 'retracted' || !(await factSources(newFact.id)).length) {
      throw new Error('事实出处已删除或更新，请重新抽取后审阅')
    }
  }
  const oldFactIds = Array.isArray(payload.old_fact_ids) ? payload.old_fact_ids : []
  const oldFacts: FactRow[] = []
  for (const factId of oldFactIds) {
    const fact = await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [String(factId)])
    if (fact && fact.status !== 'retracted') oldFacts.push(fact)
  }

  if (action === 'accept_new' || action === 'supersede') {
    for (const old of oldFacts) {
      await query('UPDATE facts SET status = $1, valid_to = $2, superseded_by = $3 WHERE id = $4', [
        'superseded',
        newFact?.valid_from ?? todayLocal(settings.timezone),
        newFact?.id ?? null,
        old.id,
      ])
    }
    if (newFact) await query(`UPDATE facts SET status = 'active' WHERE id = $1`, [newFact.id])
  } else if (action === 'reject_new') {
    if (newFact) await query(`UPDATE facts SET status = 'retracted' WHERE id = $1`, [newFact.id])
    for (const old of oldFacts) await query(`UPDATE facts SET status = 'active' WHERE id = $1`, [old.id])
  } else if (action === 'merge') {
    if (newFact && oldFacts.length) {
      for (const old of oldFacts) {
        await query('UPDATE facts SET confidence = $1, status = $2 WHERE id = $3', [
          Math.max(old.confidence, newFact.confidence),
          'active',
          old.id,
        ])
        const evidence = await query<{ chunk_id: string | null; doc_id: string; quote: string; weight: number }>(
          'SELECT chunk_id, doc_id, quote, weight FROM fact_evidence WHERE fact_id = $1',
          [newFact.id],
        )
        for (const row of evidence) {
          await query(
            `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote, weight)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [newId('ev'), old.id, row.chunk_id, row.doc_id, row.quote, row.weight],
          )
        }
      }
      await query(`UPDATE facts SET status = 'retracted' WHERE id = $1`, [newFact.id])
    }
  } else if (action === 'dispute') {
    for (const fact of oldFacts) await query(`UPDATE facts SET status = 'disputed' WHERE id = $1`, [fact.id])
    if (newFact) await query(`UPDATE facts SET status = 'disputed' WHERE id = $1`, [newFact.id])
  } else {
    throw new Error('未知处理动作')
  }

  await query(
    `UPDATE review_queue SET status = 'resolved', resolution = $1::jsonb, resolved_at = now() WHERE id = $2`,
    [JSON.stringify({ action, note, by: principal.userId }), reviewId],
  )
  await consolidateKnowledge(principal.tenantId)
  return { review_id: reviewId, action, status: 'resolved' }
}

export async function runReflection(tenantId: string): Promise<Record<string, unknown>> {
  const started = Date.now()
  const entities = await query<EntityRow>(
    `SELECT * FROM entities WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  )
  const byName = new Map<string, EntityRow[]>()
  for (const entity of entities) {
    const group = byName.get(entity.normalized_name) ?? []
    group.push(entity)
    byName.set(entity.normalized_name, group)
  }
  let mergedEntities = 0
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const keep = group[0]!
    for (const duplicate of group.slice(1)) {
      await query('UPDATE facts SET subject_id = $1 WHERE subject_id = $2', [keep.id, duplicate.id])
      await query('UPDATE facts SET object_id = $1 WHERE object_id = $2', [keep.id, duplicate.id])
      await query('UPDATE entity_aliases SET entity_id = $1 WHERE entity_id = $2', [keep.id, duplicate.id])
      await query(`UPDATE entities SET status = 'merged' WHERE id = $1`, [duplicate.id])
      mergedEntities += 1
    }
  }

  const openReviews = await query<{ new_fact_id: string | null }>(
    `SELECT payload->>'new_fact_id' AS new_fact_id FROM review_queue WHERE tenant_id = $1 AND status = 'open'`,
    [tenantId],
  )
  const reviewed = new Set(openReviews.map((row) => row.new_fact_id).filter(Boolean))
  const activeFacts = await query<FactRow>(
    `SELECT * FROM facts WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  )
  const byKey = new Map<string, FactRow[]>()
  for (const fact of activeFacts) {
    const key = `${fact.subject_id}|${fact.predicate}`
    const group = byKey.get(key) ?? []
    group.push(fact)
    byKey.set(key, group)
  }
  let disputed = 0
  for (const [key, group] of byKey) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i]!
        const right = group[j]!
        if (left.object_id === right.object_id && left.object_literal === right.object_literal) continue
        if (!periodsOverlap(left, right)) continue
        await query(`UPDATE facts SET status = 'disputed' WHERE id = ANY($1)`, [[left.id, right.id]])
        disputed += 1
        if (!reviewed.has(right.id)) {
          const subject = await queryOne<EntityRow>('SELECT canonical_name FROM entities WHERE id = $1', [left.subject_id])
          const [subjectId, predicate] = key.split('|')
          await query(
            `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
             VALUES ($1, $2, 'fact_conflict', $3, $4::jsonb, 'open')`,
            [
              newId('rev'),
              tenantId,
              `${subject?.canonical_name ?? subjectId} · ${predicate}`,
              JSON.stringify({
                subject: subject?.canonical_name ?? subjectId,
                predicate,
                new_fact_id: right.id,
                old_fact_ids: [left.id],
                reason: '夜间反思扫描发现有效期重叠的冲突断言。',
              }),
            ],
          )
        }
      }
    }
  }

  const expired = await query<{ id: string }>(
    `SELECT id FROM memory_items WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at < now()`,
    [tenantId],
  )
  for (const memory of expired) await query('DELETE FROM memory_items WHERE id = $1', [memory.id])

  const summary = {
    ...await consolidateKnowledge(tenantId),
    entities_scanned: entities.length,
    merged_entities: mergedEntities,
    facts_scanned: activeFacts.length,
    conflicts_marked: disputed,
    expired_memories: expired.length,
    elapsed_ms: Date.now() - started,
  }
  await query(
    `INSERT INTO reflection_runs (id, tenant_id, summary) VALUES ($1, $2, $3::jsonb)`,
    [newId('ref'), tenantId, JSON.stringify(summary)],
  )
  return summary
}

export const learningHelpers = { estimateTokens, canRead }
