import { query, queryOne, transaction } from '../db/index.js'
import { completeStructured, modelUnavailable, requireModelText } from '../adapters/harness/index.js'
import { estimateTokens } from './chunking.js'
import { newId, todayLocal } from './ids.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from './rows.js'
import { Principal, canRead } from './security.js'
import { settings } from '../config.js'
import { evidenceWeight } from './source-policy.js'
import { resolveSemanticEntity } from './entity-resolution.js'
import { consolidateKnowledge } from './consolidation.js'
import { MIN_FACT_CONFIDENCE } from './fact-visibility.js'
import { notifyReviewQueueChanged } from './review-events.js'

const EXTRACT_SYSTEM = `你是 KnoWeave 的事实抽取器。只抽取原文明确陈述、可被引用验证的断言。
输出一个 JSON 数组，不要输出任何解释或 Markdown。每项字段：
subject, subject_type(product|org|person|concept|event), predicate, object,
object_type, object_literal, valid_from(YYYY-MM-DD 或 null), valid_to(YYYY-MM-DD 或 null),
confidence(0-1), quote(必须逐字来自原文，不超过120字)。
规则：最多 8 条，优先抽取有明确主体和对象的重要关系。谓词用简短动词短语。
主语和实体型宾语必须是可独立指代的完整名称或名词短语，保留引文中的写法。排除动作片段、连词结尾的残句、代词、跨句拼接。
没有明确主语时跳过，例如“收集和提供风险信息”不产生事实。数字、日期、版本必须保留。没有符合条件的事实时返回 []。`

const CHECK_SYSTEM = `你是 KnoWeave 的事实校验器。输入是若干条候选事实，逐条判断它能否作为一条独立、可读的断言进入知识库。
输出一个 JSON 数组，不要输出任何解释或 Markdown。每项字段：index(候选编号), keep(true 或 false), reason(不超过 40 字的简短理由)。
必须对每个候选编号都给出判断，不要遗漏。
以下情形 keep=false：
- 宾语只是把整条引文（或主语、谓语一起）复述一遍，不是一个能独立指代的名词短语；
- 宾语或谓语内部又重复出现主语或谓语，导致同一句话读了两次；
- 主语和宾语指向同一个事物；
- 谓语与宾语语义重复，宾语里已经含了谓语的动词含义；
- 主语或宾语是动作片段、残句、代词，而不是完整名称或名词短语；
- 引文是跨句拼接，或读起来不像原文在陈述主谓宾关系。
判断从严：只要拼出来的句子像病句或语义重复，就不要保留。`

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

/** 把主谓宾拼成一句能直接读的话，去掉中文与数字之间因分词留下的空格。 */
export function factSentence(subject: string, predicate: string, object?: string | null): string {
  const tidy = (value: unknown): string => String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '')
    .replace(/(?<=\d)\s+(?=[\u4e00-\u9fa5])/g, '')
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=\d)/g, '')
    .trim()
  const glue = (left: string, right: string): string => {
    if (!left) return right
    if (!right) return left
    return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : `${left}${right}`
  }
  return glue(glue(tidy(subject), tidy(predicate)), tidy(object))
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

function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  let body = text.trim()
  if (!body) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(body)
  if (fence) body = fence[1]!.trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end < start) return null
  try {
    const payload = JSON.parse(body.slice(start, end + 1)) as unknown
    return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : null
  } catch {
    return null
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
     WHERE e.tenant_id = $1 AND a.normalized_alias = $2 AND e.status = 'active' LIMIT 1`,
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

/**
 * 删除实体：以它为主语的事实连同证据一并物理删除；仅把它当宾语的事实保留，
 * 宾语降级为文本；相关待审项关闭，汇总缓存失效以便重新生成。
 */
export async function deleteEntity(principal: Principal, entityId: string): Promise<Record<string, unknown>> {
  const entity = await queryOne<EntityRow>('SELECT * FROM entities WHERE id = $1', [entityId])
  if (!entity || entity.tenant_id !== principal.tenantId || entity.status === 'retracted'
    || !canRead(principal, entity.acl_principals)) {
    throw Object.assign(new Error('实体不存在或无权删除'), { statusCode: 404 })
  }
  let factsRemoved = 0
  let factsUnlinked = 0
  let reviewsClosed = 0
  await transaction(async (client) => {
    const subjectFacts = await client.query<{ id: string }>(
      'SELECT id FROM facts WHERE tenant_id = $1 AND subject_id = $2',
      [principal.tenantId, entity.id],
    )
    const removedIds = subjectFacts.map((row) => row.id)
    factsRemoved = removedIds.length
    if (removedIds.length) {
      await client.query('DELETE FROM fact_evidence WHERE fact_id = ANY($1::text[])', [removedIds])
      await client.query('DELETE FROM facts WHERE id = ANY($1::text[])', [removedIds])
    }
    const unlinked = await client.query<{ id: string }>(
      `UPDATE facts SET object_id = NULL, object_literal = COALESCE(object_literal, $1)
       WHERE tenant_id = $2 AND object_id = $3 RETURNING id`,
      [entity.canonical_name, principal.tenantId, entity.id],
    )
    factsUnlinked = unlinked.length
    const closed = await client.query<{ id: string }>(
      `UPDATE review_queue SET status = 'resolved', resolution = $1::jsonb, resolved_at = now()
       WHERE tenant_id = $2 AND status = 'open'
         AND (payload->>'new_fact_id' = ANY($3::text[])
              OR payload->>'subject' = $4
              OR payload->'old_fact_ids' ?| $3::text[])
       RETURNING id`,
      [
        JSON.stringify({ action: 'entity_deleted', by: principal.userId, entity: entity.canonical_name }),
        principal.tenantId,
        removedIds,
        entity.canonical_name,
      ],
    )
    reviewsClosed = closed.length
    await client.query('DELETE FROM entity_aliases WHERE entity_id = $1', [entity.id])
    await client.query('DELETE FROM entities WHERE id = $1', [entity.id])
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id = $1', [principal.tenantId])
  })
  if (reviewsClosed) notifyReviewQueueChanged(principal.tenantId)
  return {
    id: entity.id,
    name: entity.canonical_name,
    facts_removed: factsRemoved,
    facts_unlinked: factsUnlinked,
    reviews_closed: reviewsClosed,
    status: 'deleted',
  }
}

const EXTRACTION_BATCH_CHARS = 7000
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

const entityWords = new Intl.Segmenter('zh', { granularity: 'word' })
const incompleteEntityWords = new Set(['和', '与', '及', '以及', '或', '或者', '并', '、'])

export function isEntityName(name: string): boolean {
  if (!name || ['它', '他', '她', '该系统', '本系统', '这'].includes(name)) return false
  const words = [...entityWords.segment(name)]
  return !incompleteEntityWords.has(words.at(-1)?.segment ?? '')
}

async function extractCandidates(document: DocumentRow): Promise<{ candidates: Candidate[]; discarded: number }> {
  const chunks = await query<ChunkRow>(
    `SELECT c.* FROM chunks c JOIN document_versions v ON c.version_id = v.id
     WHERE c.doc_id = $1 AND c.is_parent = false AND v.version = $2 ORDER BY c.seq`,
    [document.id, document.current_version],
  )
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  let discarded = 0
  for (const [index, batch] of extractionBatches(chunks).entries()) {
    const prompt = `文档标题：${document.title}\n来源类型：${document.source_type}\n分批：${index + 1}\n\n原文：\n${batch.text}\n\n请输出 JSON 数组。`
    const result = await completeStructured(prompt, EXTRACT_SYSTEM)
    const operation = `第 ${index + 1} 批抽取`
    const items = parseJsonArray(requireModelText(result, operation))
    if (items === null) throw modelUnavailable(operation, '模型未返回完整的 JSON 数组')
    const fresh: Candidate[] = []
    for (const item of items) {
      const subject = String(item.subject ?? '').trim()
      const predicate = String(item.predicate ?? '').trim()
      const object = String(item.object ?? '').trim()
      const literal = String(item.object_literal ?? '').trim()
      const quote = String(item.quote ?? '').trim()
      if (!isEntityName(subject) || !predicate || !(object || literal) || !quote) continue
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
      if (!literalTarget && !isEntityName(object)) continue
      const candidate: Candidate = {
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
      }
      const key = [normalizeName(candidate.subject), candidate.predicate, normalizeName(candidate.objectName || candidate.objectLiteral), candidate.validFrom, candidate.validTo, candidate.chunkId].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(candidate)
    }
    // 结构是否成立（是否只是把引文复述一遍、主语谓语重复、宾语与谓语同义）
    // 不做规则猜测，交给模型逐条判断；通不过的直接丢弃，不进入知识库也不进审阅队列。
    const keep = await checkCandidates(fresh)
    fresh.forEach((candidate, position) => {
      if (keep[position]) candidates.push(candidate)
      else discarded += 1
    })
  }
  return { candidates, discarded }
}

/** 让模型复核候选事实的结构；未给出判断的一律不保留。 */
async function checkCandidates(candidates: Candidate[]): Promise<boolean[]> {
  if (!candidates.length) return []
  const list = candidates.map((candidate, index) =>
    `${index + 1}. 主语=${candidate.subject} | 谓语=${candidate.predicate} | 宾语=${candidate.objectName || candidate.objectLiteral} | 引文=${candidate.quote}`,
  ).join('\n')
  const operation = '事实校验'
  const items = parseJsonArray(requireModelText(
    await completeStructured(`候选事实：\n${list}\n\n请输出 JSON 数组。`, CHECK_SYSTEM),
    operation,
  ))
  if (items === null) throw modelUnavailable(operation, '模型未返回完整的 JSON 数组')
  const keep = candidates.map(() => false)
  for (const item of items) {
    const position = Number(item.index)
    if (!Number.isInteger(position) || position < 1 || position > keep.length) continue
    keep[position - 1] = item.keep === true || item.keep === 'true'
  }
  return keep
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

/** 只有与知识库已有事实冲突时才需要人工裁决，其他候选事实直接生效。 */
async function queueFactReview(
  principal: Principal, subject: EntityRow, fact: FactRow, candidate: Candidate,
  document: DocumentRow, conflicting: FactRow[],
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
    quote: candidate.quote, doc_id: document.id,
    reason: '同一件事在文档里有不同说法，请判断以哪一条为准。',
  })
  const kind = 'fact_conflict'
  const title = factSentence(subject.canonical_name, candidate.predicate, candidate.objectName || candidate.objectLiteral)
  if (existing) {
    await query('UPDATE review_queue SET payload = $1::jsonb, kind = $2, title = $3 WHERE id = $4', [payload, kind, title, existing.id])
    return
  }
  await query(
    `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
    [newId('rev'), principal.tenantId, kind, title, payload],
  )
  notifyReviewQueueChanged(principal.tenantId)
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
  // 审阅策略：只有与已有事实冲突且无法按来源票自动取代时才进入审阅队列。
  // 知识库中没有的新事实、单源事实、低置信事实都直接生效，不再因为缺少印证而等待人工确认。
  if (wasActive || !conflicting.length || (supported && canSupersede)) {
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
    notifyReviewQueueChanged(principal.tenantId)
    return canSupersede ? 'superseded' : sameObject ? 'merged' : 'created'
  }
  await queueFactReview(principal, subject, fact, candidate, document, conflicting)
  return 'disputed'
}

const extractionTasks = new Map<string, Promise<Record<string, unknown>>>()

export async function extractFactsForDocument(principal: Principal, docId: string, expectedVersion?: number): Promise<Record<string, unknown>> {
  const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
  if (!document || document.tenant_id !== principal.tenantId || document.status !== 'active') return { error: '文档不存在' }
  if (expectedVersion !== undefined && document.current_version !== expectedVersion) return { status: 'stale' }
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
  const startedVersion = await query(
    `UPDATE documents SET enrichment_status = 'running', enrichment_error = NULL WHERE id = $1 AND current_version = $2 AND status = 'active' RETURNING id`,
    [docId, document.current_version],
  )
  if (!startedVersion.length) return { status: 'stale' }
  const started = Date.now()
  try {
    const { candidates, discarded } = await extractCandidates(document)
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
      discarded,
      outcomes: counts,
      elapsed_ms: Date.now() - started,
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    await query(`UPDATE documents SET enrichment_status = 'failed', enrichment_error = $3 WHERE id = $1 AND current_version = $2 AND status = 'active'`, [docId, document.current_version, message])
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
  notifyReviewQueueChanged(principal.tenantId)
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
          const objectName = async (fact: FactRow): Promise<string | null> => fact.object_id
            ? ((await queryOne<EntityRow>('SELECT canonical_name FROM entities WHERE id = $1', [fact.object_id]))?.canonical_name ?? null)
            : fact.object_literal
          const subjectName = subject?.canonical_name ?? subjectId!
          const rightObject = await objectName(right)
          const leftObject = await objectName(left)
          await query(
            `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
             VALUES ($1, $2, 'fact_conflict', $3, $4::jsonb, 'open')`,
            [
              newId('rev'),
              tenantId,
              factSentence(subjectName, predicate!, rightObject),
              JSON.stringify({
                subject: subjectName,
                predicate,
                new_object: rightObject,
                old_objects: [leftObject],
                new_fact_id: right.id,
                old_fact_ids: [left.id],
                reason: '知识库里同一件事存在两个互相矛盾的说法，请判断以哪一条为准。',
              }),
            ],
          )
          notifyReviewQueueChanged(tenantId)
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
