import { settings } from '../config.js'
import { query, queryOne, transaction, type DbClient } from '../db/index.js'
import { newId, todayLocal } from './ids.js'
import type { ContinuationRow, DocumentRow } from './rows.js'
import { canRead, requireEditor, type Principal } from './security.js'

/**
 * 文档延续（沿革）：同一主题在时间上先后发布的文档是不同文档身份，
 * 不能用版本链表达。一条边表示“后续文档自 effective_date 起接续前序文档”，
 * 每个文档最多一个前序和一个后续，因此形成线性链。
 *
 * 检索时按结算日期只保留当时有效的那一篇：前序在其后续生效后退出默认检索，
 * 后续在生效日前也不进入默认检索；显式 doc_ids 或 as_of 可以读取历史文档。
 */

export type ContinuationRelation = 'continues' | 'continued_by'

export interface ContinuationNode {
  id: string
  title: string
  version: number
  status: string
  effective_date: string | null
  in_force: boolean
}

export interface ContinuationView {
  at_date: string
  in_force: boolean
  effective_date: string | null
  predecessor: ContinuationNode | null
  successor: ContinuationNode | null
  chain: ContinuationNode[]
}

export function normalizeEffectiveDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw Object.assign(new Error('effective_date 必须为 YYYY-MM-DD 日期'), { statusCode: 400 })
  }
  const normalized = value.trim()
  const parsed = new Date(`${normalized}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw Object.assign(new Error('effective_date 日期无效'), { statusCode: 400 })
  }
  return normalized
}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

/** 一个文档在指定日期是否处于有效状态。successorActive 表示它的后续文档是否仍可用。 */
export function inForceAt(
  document: Pick<DocumentRow, 'id' | 'status'>,
  incoming: Pick<ContinuationRow, 'successor_doc_id' | 'effective_date'> | null,
  outgoing: Pick<ContinuationRow, 'predecessor_doc_id' | 'effective_date'> | null,
  atDate: string,
  successorActive = true,
): boolean {
  if (document.status !== 'active') return false
  const start = dateOnly(incoming?.effective_date)
  if (start && start > atDate) return false
  const end = dateOnly(outgoing?.effective_date)
  if (end && end <= atDate && successorActive) return false
  return true
}

async function tenantRelations(tenantId: string): Promise<ContinuationRow[]> {
  return query<ContinuationRow>(
    'SELECT * FROM document_continuations WHERE tenant_id = $1 ORDER BY effective_date, created_at',
    [tenantId],
  )
}

function chainIds(docId: string, relations: ContinuationRow[]): string[] {
  const incoming = new Map(relations.map((relation) => [relation.successor_doc_id, relation]))
  const outgoing = new Map(relations.map((relation) => [relation.predecessor_doc_id, relation]))
  const before: string[] = []
  let cursor = docId
  const seenBack = new Set([cursor])
  while (incoming.has(cursor)) {
    cursor = incoming.get(cursor)!.predecessor_doc_id
    if (seenBack.has(cursor)) break
    seenBack.add(cursor)
    before.unshift(cursor)
  }
  const after: string[] = []
  cursor = docId
  const seenForward = new Set([cursor])
  while (outgoing.has(cursor)) {
    cursor = outgoing.get(cursor)!.successor_doc_id
    if (seenForward.has(cursor)) break
    seenForward.add(cursor)
    after.push(cursor)
  }
  return [...before, docId, ...after]
}

/** 列表徽标只需要最小信息，不返回链上其他文档标题，避免越权泄露。 */
export async function continuationSummary(document: DocumentRow): Promise<Record<string, unknown> | null> {
  const link = await queryOne<{
    predecessor_doc_id: string | null
    successor_doc_id: string | null
    incoming_effective: string | null
    outgoing_effective: string | null
    successor_status: string | null
  }>(
    `SELECT
       (SELECT c.predecessor_doc_id FROM document_continuations c
         WHERE c.tenant_id = $1 AND c.successor_doc_id = $2 LIMIT 1) AS predecessor_doc_id,
       (SELECT c.successor_doc_id FROM document_continuations c
         WHERE c.tenant_id = $1 AND c.predecessor_doc_id = $2 LIMIT 1) AS successor_doc_id,
       (SELECT c.effective_date FROM document_continuations c
         WHERE c.tenant_id = $1 AND c.successor_doc_id = $2 LIMIT 1) AS incoming_effective,
       (SELECT c.effective_date FROM document_continuations c
         WHERE c.tenant_id = $1 AND c.predecessor_doc_id = $2 LIMIT 1) AS outgoing_effective,
       (SELECT s.status FROM document_continuations c JOIN documents s ON s.id = c.successor_doc_id
         WHERE c.tenant_id = $1 AND c.predecessor_doc_id = $2 LIMIT 1) AS successor_status`,
    [document.tenant_id, document.id],
  )
  if (!link || (!link.incoming_effective && !link.outgoing_effective)) return null
  const incoming = link.incoming_effective
    ? { successor_doc_id: document.id, effective_date: link.incoming_effective }
    : null
  const outgoing = link.outgoing_effective
    ? { predecessor_doc_id: document.id, effective_date: link.outgoing_effective }
    : null
  return {
    role: link.outgoing_effective ? 'predecessor' : 'successor',
    predecessor_doc_id: link.predecessor_doc_id,
    successor_doc_id: link.successor_doc_id,
    effective_date: link.incoming_effective ?? link.outgoing_effective,
    in_force: inForceAt(document, incoming, outgoing, todayLocal(settings.timezone), link.successor_status === 'active'),
  }
}

/**
 * 文档详情的沿革视图。链上不可读的文档不返回标题和内容。
 * 前序/后续若不可读则返回 null，但当前文档自身的 in_force 仍按真实关系计算。
 */
export async function continuationView(
  principal: Principal,
  document: DocumentRow,
  atDate = todayLocal(settings.timezone),
): Promise<ContinuationView> {
  const relations = await tenantRelations(principal.tenantId)
  const incoming = new Map(relations.map((relation) => [relation.successor_doc_id, relation]))
  const outgoing = new Map(relations.map((relation) => [relation.predecessor_doc_id, relation]))
  const ids = chainIds(document.id, relations)
  const rows = ids.length
    ? await query<DocumentRow>('SELECT * FROM documents WHERE tenant_id = $1 AND id = ANY($2::text[])', [principal.tenantId, ids])
    : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const nodes: ContinuationNode[] = []
  const inForceById = new Map<string, boolean>()
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || !canRead(principal, row.acl_principals)) continue
    const incomingRelation = incoming.get(id) ?? null
    const outgoingRelation = outgoing.get(id) ?? null
    const nextActive = outgoingRelation ? byId.get(outgoingRelation.successor_doc_id)?.status === 'active' : true
    const inForce = inForceAt(row, incomingRelation, outgoingRelation, atDate, nextActive)
    const node: ContinuationNode = {
      id: row.id,
      title: row.title,
      version: row.current_version,
      status: row.status,
      effective_date: dateOnly(incomingRelation?.effective_date),
      in_force: inForce,
    }
    nodes.push(node)
    inForceById.set(id, inForce)
  }
  const nodeOf = (id: string | undefined): ContinuationNode | null => {
    if (!id) return null
    const row = byId.get(id)
    if (!row || !canRead(principal, row.acl_principals)) return null
    return nodes.find((item) => item.id === id) ?? null
  }
  const currentIncoming = incoming.get(document.id) ?? null
  const currentOutgoing = outgoing.get(document.id) ?? null
  const currentInForce = inForceById.get(document.id)
    ?? inForceAt(document, currentIncoming, currentOutgoing, atDate,
      currentOutgoing ? byId.get(currentOutgoing.successor_doc_id)?.status === 'active' : true)
  return {
    at_date: atDate,
    in_force: currentInForce,
    effective_date: dateOnly(currentIncoming?.effective_date),
    predecessor: nodeOf(currentIncoming?.predecessor_doc_id),
    successor: nodeOf(currentOutgoing?.successor_doc_id),
    chain: nodes,
  }
}

interface LinkInput {
  other_doc_id?: unknown
  relation?: unknown
  effective_date?: unknown
  note?: unknown
}

function noteText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw Object.assign(new Error('note 必须为字符串'), { statusCode: 400 })
  const text = value.trim()
  if (text.length > 500) throw Object.assign(new Error('note 最长 500 字符'), { statusCode: 400 })
  return text || null
}

export function lockContinuationChain(client: DbClient, tenantId: string) {
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`document-continuations:${tenantId}`])
}

/** 建立延续关系。目标方向已有邻接文档时，按给定日期插入所选文档，保留原后续的生效日期。 */
export async function linkContinuation(
  principal: Principal,
  docId: string,
  input: LinkInput,
): Promise<ContinuationView> {
  requireEditor(principal)
  const otherDocId = typeof input.other_doc_id === 'string' ? input.other_doc_id.trim() : ''
  if (!otherDocId) throw Object.assign(new Error('other_doc_id 不能为空'), { statusCode: 400 })
  if (input.relation !== 'continues' && input.relation !== 'continued_by') {
    throw Object.assign(new Error('relation 必须为 continues 或 continued_by'), { statusCode: 400 })
  }
  const effectiveDate = normalizeEffectiveDate(input.effective_date)
  const note = noteText(input.note)
  if (otherDocId === docId) throw Object.assign(new Error('文档不能接续自身'), { statusCode: 400 })

  const beforeCurrent = input.relation === 'continues'
  const tenantId = principal.tenantId
  const unavailable = () => Object.assign(new Error('文档不存在、在回收站或无权访问'), { statusCode: 404 })
  try {
    const current = await transaction(async (client) => {
      await lockContinuationChain(client, tenantId)
      const all = await client.query<ContinuationRow>('SELECT * FROM document_continuations WHERE tenant_id = $1', [tenantId])
      const byPredecessor = new Map(all.map((relation) => [relation.predecessor_doc_id, relation]))
      const bySuccessor = new Map(all.map((relation) => [relation.successor_doc_id, relation]))
      const existingEdge = beforeCurrent ? bySuccessor.get(docId) : byPredecessor.get(docId)
      const ids = new Set([docId, otherDocId])
      if (existingEdge) ids.add(beforeCurrent ? existingEdge.predecessor_doc_id : existingEdge.successor_doc_id)
      const documents = await client.query<DocumentRow>(
        'SELECT * FROM documents WHERE tenant_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR NO KEY UPDATE',
        [tenantId, [...ids]],
      )
      if (documents.length !== ids.size || documents.some((document) => !canRead(principal, document.acl_principals))) throw unavailable()
      const current = documents.find((document) => document.id === docId)
      const other = documents.find((document) => document.id === otherDocId)
      if (current?.status !== 'active' || other?.status !== 'active') throw unavailable()

      const otherIncoming = bySuccessor.get(otherDocId)
      const otherOutgoing = byPredecessor.get(otherDocId)
      if (existingEdge && (otherIncoming || otherOutgoing)) {
        throw Object.assign(new Error('所选文档已登记沿革，无法插入当前沿革'), { statusCode: 409 })
      }
      if (beforeCurrent ? otherOutgoing : otherIncoming) {
        throw Object.assign(new Error('所选文档在该方向已有延续关系'), { statusCode: 409 })
      }

      const predecessorId = beforeCurrent ? (existingEdge?.predecessor_doc_id ?? otherDocId) : docId
      const successorId = beforeCurrent && !existingEdge ? docId : otherDocId
      const previous = bySuccessor.get(predecessorId)
      if (previous && previous.effective_date >= effectiveDate) {
        throw Object.assign(new Error('延续生效日期必须晚于前序文档自身的生效日期'), { statusCode: 409 })
      }
      const next = existingEdge ?? byPredecessor.get(successorId)
      if (next && next.effective_date <= effectiveDate) {
        throw Object.assign(new Error('延续生效日期必须早于后续文档自身的生效日期'), { statusCode: 409 })
      }
      let cursor: string | undefined = successorId
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor)) {
        if (cursor === predecessorId) throw Object.assign(new Error('延续关系不能形成环'), { statusCode: 409 })
        seen.add(cursor)
        cursor = byPredecessor.get(cursor)?.successor_doc_id
      }

      if (existingEdge) {
        // 保留原后续文档的生效日期、备注与登记信息，只更新它的直接前序。
        await client.query('UPDATE document_continuations SET predecessor_doc_id = $1 WHERE id = $2', [otherDocId, existingEdge.id])
      }
      await client.query(
        `INSERT INTO document_continuations
           (id, tenant_id, predecessor_doc_id, successor_doc_id, effective_date, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('cont'), tenantId, predecessorId, successorId, effectiveDate, note, principal.userId],
      )
      return current
    })
    return continuationView(principal, current)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw Object.assign(new Error('该文档已有延续关系，请刷新后重试'), { statusCode: 409 })
    }
    throw error
  }
}

export async function unlinkContinuation(
  principal: Principal,
  docId: string,
  relation: unknown,
): Promise<ContinuationView> {
  requireEditor(principal)
  if (relation !== 'continues' && relation !== 'continued_by') {
    throw Object.assign(new Error('relation 必须为 continues 或 continued_by'), { statusCode: 400 })
  }
  const tenantId = principal.tenantId
  const document = await transaction(async (client) => {
    await lockContinuationChain(client, tenantId)
    const [document] = await client.query<DocumentRow>(
      'SELECT * FROM documents WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE', [tenantId, docId],
    )
    if (!document || !canRead(principal, document.acl_principals)) {
      throw Object.assign(new Error('文档不存在或无权访问'), { statusCode: 404 })
    }
    const column = relation === 'continues' ? 'successor_doc_id' : 'predecessor_doc_id'
    const removed = await client.query<{ id: string }>(
      `DELETE FROM document_continuations WHERE tenant_id = $1 AND ${column} = $2 RETURNING id`, [tenantId, docId],
    )
    if (!removed.length) throw Object.assign(new Error('没有可解除的延续关系'), { statusCode: 404 })
    return document
  })
  return continuationView(principal, document)
}

/** 移出当前文档，并按用户选择续接原前序和原后继。 */
export async function detachContinuation(
  principal: Principal,
  docId: string,
  reconnect: boolean,
  expected?: { predecessorId: string; successorId: string },
): Promise<ContinuationView> {
  requireEditor(principal)
  const tenantId = principal.tenantId
  const document = await transaction(async (client) => {
    await lockContinuationChain(client, tenantId)
    const edges = await client.query<ContinuationRow>(
      'SELECT * FROM document_continuations WHERE tenant_id = $1 AND (predecessor_doc_id = $2 OR successor_doc_id = $2)',
      [tenantId, docId],
    )
    const incoming = edges.find((edge) => edge.successor_doc_id === docId)
    const outgoing = edges.find((edge) => edge.predecessor_doc_id === docId)
    const predecessorId = incoming?.predecessor_doc_id ?? ''
    const successorId = outgoing?.successor_doc_id ?? ''
    const ids = [docId, predecessorId, successorId].filter(Boolean)
    const documents = await client.query<DocumentRow>(
      'SELECT * FROM documents WHERE tenant_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR NO KEY UPDATE',
      [tenantId, ids],
    )
    const current = documents.find((row) => row.id === docId)
    if (!current || documents.length !== ids.length || documents.some((row) => !canRead(principal, row.acl_principals))) {
      throw Object.assign(new Error('文档不存在或无权访问'), { statusCode: 404 })
    }
    if (expected && (expected.predecessorId !== predecessorId || expected.successorId !== successorId)) {
      throw Object.assign(new Error('沿革已变更，请重新打开文档后再解除'), { statusCode: 409 })
    }
    if (!edges.length) throw Object.assign(new Error('没有可解除的延续关系'), { statusCode: 404 })
    if (reconnect) {
      if (!incoming || !outgoing) {
        throw Object.assign(new Error('续接需要同时存在前序和后继文档'), { statusCode: 409 })
      }
      await client.query('DELETE FROM document_continuations WHERE id = $1', [incoming.id])
      await client.query('UPDATE document_continuations SET predecessor_doc_id = $1 WHERE id = $2', [predecessorId, outgoing.id])
    } else {
      await removeContinuationLinks(client, tenantId, docId)
    }
    return current
  })
  return continuationView(principal, document)
}

/** 清除指向当前文档的两侧沿革边。 */
export async function removeContinuationLinks(client: DbClient, tenantId: string, docId: string): Promise<void> {
  await client.query(
    'DELETE FROM document_continuations WHERE tenant_id = $1 AND (predecessor_doc_id = $2 OR successor_doc_id = $2)',
    [tenantId, docId],
  )
}
