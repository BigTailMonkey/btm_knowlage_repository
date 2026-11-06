import { query, queryOne } from '../db/index.js'
import { tokenize } from '../adapters/embeddings/index.js'
import { harness } from '../adapters/harness/index.js'
import { estimateTokens } from './chunking.js'
import { newId, todayLocal } from './ids.js'
import type { ChunkRow, DocumentRow, EntityRow, FactRow, VersionRow } from './rows.js'
import { Principal, canRead } from './security.js'
import { settings } from '../config.js'

const EXTRACT_SYSTEM = `你是 KnoWeave 的事实抽取器。只抽取原文明确陈述、可被引用验证的断言。
输出一个 JSON 数组，不要输出任何解释或 Markdown。每项字段：
subject, subject_type(product|org|person|concept|event), predicate, object,
object_type, object_literal, valid_from(YYYY-MM-DD 或 null), valid_to(YYYY-MM-DD 或 null),
confidence(0-1), quote(必须逐字来自原文，不超过120字)。
规则：谓词用简短中文动词短语；不要抽取常识、推测、代词指代；最多 12 条；
数字、日期、版本必须保留；没有明确主语时不要抽取。`

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
  const text = String(value).trim()
  if (!text || ['null', 'none', '无'].includes(text.toLowerCase())) return null
  const match = DATE_RE.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3] ?? 1)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
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

async function findChunkForQuote(docId: string, quote: string): Promise<ChunkRow | null> {
  const chunks = await query<ChunkRow>(
    `SELECT c.* FROM chunks c
     JOIN document_versions v ON c.version_id = v.id
     JOIN documents d ON c.doc_id = d.id
     WHERE c.doc_id = $1 AND c.is_parent = false AND v.version = d.current_version`,
    [docId],
  )
  const clean = quote.replace(/\s+/g, ' ').trim()
  const quoteTokens = new Set(tokenize(clean))
  let best: ChunkRow | null = null
  let bestScore = 0
  for (const chunk of chunks) {
    const text = chunk.text.replace(/\s+/g, ' ')
    if (clean && text.includes(clean.slice(0, 40))) return chunk
    if (!quoteTokens.size) continue
    let hit = 0
    const tokens = new Set(tokenize(text))
    for (const token of quoteTokens) if (tokens.has(token)) hit += 1
    const score = hit / quoteTokens.size
    if (score > bestScore) {
      bestScore = score
      best = chunk
    }
  }
  return bestScore >= 0.45 ? best : null
}

async function extractCandidates(document: DocumentRow): Promise<Candidate[]> {
  const chunks = await query<ChunkRow>(
    `SELECT c.* FROM chunks c JOIN document_versions v ON c.version_id = v.id
     WHERE c.doc_id = $1 AND c.is_parent = false AND v.version = $2 ORDER BY c.seq`,
    [document.id, document.current_version],
  )
  if (!chunks.length) return []
  const parts: string[] = []
  let total = 0
  for (const chunk of chunks) {
    if (total > 7000) break
    parts.push(chunk.text)
    total += chunk.text.length
  }
  const text = parts.join('\n\n')
  const prompt = `文档标题：${document.title}\n来源类型：${document.source_type}\n\n原文：\n${text}\n\n请输出 JSON 数组。`
  const result = await harness.complete(prompt, EXTRACT_SYSTEM, 1600)
  const candidates: Candidate[] = []
  for (const item of parseJsonArray(result.text)) {
    const subject = String(item.subject ?? '').trim()
    const predicate = String(item.predicate ?? '').trim()
    const object = String(item.object ?? '').trim()
    const literal = String(item.object_literal ?? '').trim()
    const quote = String(item.quote ?? '').trim()
    if (!subject || !predicate || !(object || literal) || !quote) continue
    if (['它', '他', '她', '该系统', '本系统', '这'].includes(subject)) continue
    const chunk = await findChunkForQuote(document.id, quote)
    candidates.push({
      subject: subject.slice(0, 120),
      subjectType: String(item.subject_type ?? 'concept').slice(0, 24),
      predicate: predicate.slice(0, 120),
      objectName: object.slice(0, 120),
      objectType: String(item.object_type ?? 'concept').slice(0, 24),
      objectLiteral: literal.slice(0, 200),
      validFrom: parseDate(item.valid_from),
      validTo: parseDate(item.valid_to),
      confidence: Math.max(0.2, Math.min(0.99, Number(item.confidence ?? 0.7) || 0.7)),
      quote: quote.slice(0, 300),
      chunkId: chunk?.id ?? null,
    })
  }
  return candidates.length ? candidates : ruleExtractCandidates(text, chunks)
}

function ruleExtractCandidates(text: string, chunks: ChunkRow[]): Candidate[] {
  const pattern = /([\u4e00-\u9fffA-Za-z0-9·\-]{2,24})(采用|使用|基于|依赖|支持|提供|发布|推出|属于|位于|成立于|由)([^，。；：\n]{2,40})/g
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const sentence of text.split(/[。！？!?；;\n]/)) {
    const body = sentence.trim()
    if (body.length < 10) continue
    for (const match of body.matchAll(pattern)) {
      const subject = match[1]!.trim()
      const predicate = match[2]!.trim()
      const object = match[3]!.trim()
      if (['我们', '本系统', '该系统', '它'].includes(subject) || object.length < 2) continue
      const key = `${normalizeName(subject)}|${predicate}|${normalizeName(object)}`
      if (seen.has(key)) continue
      seen.add(key)
      let chunk: ChunkRow | null = null
      let bestScore = 0
      for (const candidateChunk of chunks) {
        if (candidateChunk.text.includes(match[0])) {
          chunk = candidateChunk
          break
        }
        let hit = 0
        const sentenceTokens = new Set(tokenize(body))
        const chunkTokens = new Set(tokenize(candidateChunk.text))
        for (const token of sentenceTokens) if (chunkTokens.has(token)) hit += 1
        if (hit > bestScore) {
          bestScore = hit
          chunk = candidateChunk
        }
      }
      candidates.push({
        subject: subject.slice(0, 120),
        subjectType: /[A-Za-z]/.test(subject) ? 'product' : 'concept',
        predicate,
        objectName: object.slice(0, 120),
        objectType: /[A-Za-z]/.test(object) ? 'product' : 'concept',
        objectLiteral: object.slice(0, 200),
        validFrom: null,
        validTo: null,
        confidence: 0.52,
        quote: body.slice(0, 180),
        chunkId: chunk?.id ?? null,
      })
      if (candidates.length >= 8) return candidates
    }
  }
  return candidates
}

function periodsOverlap(a: FactRow, b: FactRow): boolean {
  const aStart = a.valid_from ? String(a.valid_from).slice(0, 10) : '0000-01-01'
  const aEnd = a.valid_to ? String(a.valid_to).slice(0, 10) : '9999-12-31'
  const bStart = b.valid_from ? String(b.valid_from).slice(0, 10) : '0000-01-01'
  const bEnd = b.valid_to ? String(b.valid_to).slice(0, 10) : '9999-12-31'
  return aStart <= bEnd && bStart <= aEnd
}

async function mergeOrArbitrate(
  principal: Principal,
  document: DocumentRow,
  candidate: Candidate,
): Promise<string> {
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
  const sameObject = existingFacts.find((fact) =>
    objectEntity ? fact.object_id === objectEntity.id : fact.object_literal === candidate.objectLiteral,
  )
  if (sameObject) {
    await query('UPDATE facts SET confidence = $1, acl_principals = $2::jsonb WHERE id = $3', [
      Math.max(sameObject.confidence, candidate.confidence),
      JSON.stringify([...new Set(sameObject.acl_principals ?? [])].filter((item) => acl.includes(item))),
      sameObject.id,
    ])
    if (candidate.chunkId) {
      const duplicate = await queryOne<{ id: string }>(
        `SELECT id FROM fact_evidence WHERE fact_id = $1 AND chunk_id = $2 AND quote = $3 LIMIT 1`,
        [sameObject.id, candidate.chunkId, candidate.quote],
      )
      if (!duplicate) {
        await query(
          `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote, weight)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [newId('ev'), sameObject.id, candidate.chunkId, document.id, candidate.quote, Math.max(0.5, document.quality_score)],
        )
      }
    }
    return 'merged'
  }

  const factId = newId('f')
  await query(
    `INSERT INTO facts
       (id, tenant_id, subject_id, predicate, object_id, object_literal, valid_from, valid_to,
        recorded_at, confidence, status, acl_principals, source_doc_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, 'active', $10::jsonb, $11)`,
    [
      factId,
      principal.tenantId,
      subject.id,
      candidate.predicate,
      objectEntity?.id ?? null,
      objectEntity ? null : candidate.objectLiteral,
      candidate.validFrom,
      candidate.validTo,
      candidate.confidence,
      JSON.stringify(acl),
      document.id,
    ],
  )
  if (candidate.chunkId) {
    await query(
      `INSERT INTO fact_evidence (id, fact_id, chunk_id, doc_id, quote, weight)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId('ev'), factId, candidate.chunkId, document.id, candidate.quote, Math.max(0.5, document.quality_score)],
    )
  }

  const conflicting: FactRow[] = []
  for (const old of existingFacts) {
    let oldTarget = old.object_literal
    if (old.object_id) {
      const oldObject = await queryOne<EntityRow>('SELECT canonical_name FROM entities WHERE id = $1', [old.object_id])
      oldTarget = oldObject?.canonical_name ?? old.object_literal
    }
    if (oldTarget === candidate.objectName && candidate.objectName) continue
    if (!periodsOverlap(old, await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [factId]) as FactRow)) continue
    conflicting.push(old)
  }
  if (!conflicting.length) return 'created'

  const newest = conflicting.reduce((a, b) => (new Date(a.recorded_at) > new Date(b.recorded_at) ? a : b))
  const canSupersede =
    candidate.validFrom !== null &&
    newest.valid_from !== null &&
    candidate.validFrom > String(newest.valid_from).slice(0, 10) &&
    candidate.confidence >= 0.7
  if (canSupersede) {
    for (const old of conflicting) {
      await query(
        `UPDATE facts SET status = 'superseded', valid_to = $1, superseded_by = $2 WHERE id = $3`,
        [candidate.validFrom, factId, old.id],
      )
    }
    return 'superseded'
  }

  await query(`UPDATE facts SET status = 'disputed' WHERE id = $1`, [factId])
  for (const old of conflicting) await query(`UPDATE facts SET status = 'disputed' WHERE id = $1`, [old.id])
  const oldObjects: unknown[] = []
  for (const old of conflicting) {
    oldObjects.push(
      old.object_id
        ? (await queryOne<EntityRow>('SELECT canonical_name FROM entities WHERE id = $1', [old.object_id]))?.canonical_name
        : old.object_literal,
    )
  }
  await query(
    `INSERT INTO review_queue (id, tenant_id, kind, title, payload, status)
     VALUES ($1, $2, 'fact_conflict', $3, $4::jsonb, 'open')`,
    [
      newId('rev'),
      principal.tenantId,
      `${subject.canonical_name} · ${candidate.predicate}`,
      JSON.stringify({
        subject: subject.canonical_name,
        predicate: candidate.predicate,
        new_fact_id: factId,
        new_object: candidate.objectName || candidate.objectLiteral,
        old_fact_ids: conflicting.map((fact) => fact.id),
        old_objects: oldObjects,
        quote: candidate.quote,
        doc_id: document.id,
        reason: '同一主语与谓词出现不同宾语，且有效期重叠；按保守策略进入人工审阅。',
      }),
    ],
  )
  return 'disputed'
}

export async function extractFactsForDocument(principal: Principal, docId: string): Promise<Record<string, unknown>> {
  const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
  if (!document || document.tenant_id !== principal.tenantId) return { error: '文档不存在' }
  const version = await queryOne<VersionRow>(
    'SELECT * FROM document_versions WHERE doc_id = $1 AND version = $2',
    [docId, document.current_version],
  )
  if (!version) return { error: '版本不存在' }
  await query(`UPDATE documents SET enrichment_status = 'running' WHERE id = $1`, [docId])
  const started = Date.now()
  const candidates = await extractCandidates(document)
  const counts: Record<string, number> = { created: 0, merged: 0, superseded: 0, disputed: 0 }
  for (const candidate of candidates) {
    const outcome = await mergeOrArbitrate(principal, document, candidate)
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  await query(`UPDATE documents SET enrichment_status = $1 WHERE id = $2`, [candidates.length ? 'done' : 'empty', docId])
  return {
    document_id: docId,
    candidates: candidates.length,
    outcomes: counts,
    elapsed_ms: Date.now() - started,
  }
}

export async function resolveReview(
  principal: Principal,
  reviewId: string,
  action: string,
  note = '',
): Promise<Record<string, unknown>> {
  const review = await queryOne<{ id: string; tenant_id: string; status: string; payload: Record<string, unknown> }>(
    'SELECT id, tenant_id, status, payload FROM review_queue WHERE id = $1',
    [reviewId],
  )
  if (!review || review.tenant_id !== principal.tenantId) throw new Error('审阅项不存在')
  if (review.status !== 'open') throw new Error('审阅项已处理')
  const payload = review.payload ?? {}
  const newFact = payload.new_fact_id
    ? await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [String(payload.new_fact_id)])
    : null
  const oldFactIds = Array.isArray(payload.old_fact_ids) ? payload.old_fact_ids : []
  const oldFacts: FactRow[] = []
  for (const factId of oldFactIds) {
    const fact = await queryOne<FactRow>('SELECT * FROM facts WHERE id = $1', [String(factId)])
    if (fact) oldFacts.push(fact)
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
