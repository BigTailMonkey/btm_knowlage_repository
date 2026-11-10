import { settings } from '../config.js'
import { query, queryOne, transaction } from '../db/index.js'
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

/**
 * 建立一条延续边。relation=continues 表示当前文档接续 other；
 * relation=continued_by 表示 other 接续当前文档。两者最终都写成 predecessor → successor。
 */
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

  const documents = await query<DocumentRow>(
    'SELECT * FROM documents WHERE tenant_id = $1 AND id = ANY($2::text[]) AND status = $3',
    [principal.tenantId, [docId, otherDocId], 'active'],
  )
  const current = documents.find((document) => document.id === docId)
  const other = documents.find((document) => document.id === otherDocId)
  const unavailable = () => Object.assign(new Error('文档不存在、在回收站或无权访问'), { statusCode: 404 })
  if (!current || !other) throw unavailable()
  if (!canRead(principal, current.acl_principals) || !canRead(principal, other.acl_principals)) throw unavailable()

  const successor = input.relation === 'continues' ? current : other
  const predecessor = input.relation === 'continues' ? other : current
  try {
    await transaction(async (client) => {
      await client.query('SELECT id FROM documents WHERE id = ANY($1::text[]) FOR UPDATE', [[predecessor.id, successor.id]])
      const outgoing = (await client.query<ContinuationRow>(
        'SELECT * FROM document_continuations WHERE tenant_id = $1 AND predecessor_doc_id = $2',
        [principal.tenantId, predecessor.id],
      ))[0]
      if (outgoing) throw Object.assign(new Error('该文档已有后续文档，请先解除原有延续关系'), { statusCode: 409 })
      const incoming = (await client.query<ContinuationRow>(
        'SELECT * FROM document_continuations WHERE tenant_id = $1 AND successor_doc_id = $2',
        [principal.tenantId, successor.id],
      ))[0]
      if (incoming) throw Object.assign(new Error('该文档已接续自其他文档，请先解除原有延续关系'), { statusCode: 409 })

      const all = await client.query<ContinuationRow>('SELECT * FROM document_continuations WHERE tenant_id = $1', [principal.tenantId])
      const byPredecessor = new Map(all.map((relation) => [relation.predecessor_doc_id, relation]))
      const bySuccessor = new Map(all.map((relation) => [relation.successor_doc_id, relation]))
      const previous = bySuccessor.get(predecessor.id)
      if (previous && previous.effective_date >= effectiveDate) {
        throw Object.assign(new Error('延续生效日期必须晚于前序文档自身的生效日期'), { statusCode: 409 })
      }
      const next = byPredecessor.get(successor.id)
      if (next && next.effective_date <= effectiveDate) {
        throw Object.assign(new Error('延续生效日期必须早于后续文档自身的生效日期'), { statusCode: 409 })
      }
      // 不允许成环：从 successor 沿后续方向走，若遇到 predecessor 则拒绝。
      let cursor: string | undefined = successor.id
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor)) {
        if (cursor === predecessor.id) throw Object.assign(new Error('延续关系不能形成环'), { statusCode: 409 })
        seen.add(cursor)
        cursor = byPredecessor.get(cursor)?.successor_doc_id
      }

      await client.query(
        `INSERT INTO document_continuations
           (id, tenant_id, predecessor_doc_id, successor_doc_id, effective_date, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('cont'), principal.tenantId, predecessor.id, successor.id, effectiveDate, note, principal.userId],
      )
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw Object.assign(new Error('该文档已有延续关系，请刷新后重试'), { statusCode: 409 })
    }
    throw error
  }
  return continuationView(principal, current)
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
  const document = await queryOne<DocumentRow>(
    'SELECT * FROM documents WHERE tenant_id = $1 AND id = $2',
    [principal.tenantId, docId],
  )
  if (!document || !canRead(principal, document.acl_principals)) {
    throw Object.assign(new Error('文档不存在或无权访问'), { statusCode: 404 })
  }
  const removed = relation === 'continues'
    ? await query<{ id: string }>(
      'DELETE FROM document_continuations WHERE tenant_id = $1 AND successor_doc_id = $2 RETURNING id',
      [principal.tenantId, docId],
    )
    : await query<{ id: string }>(
      'DELETE FROM document_continuations WHERE tenant_id = $1 AND predecessor_doc_id = $2 RETURNING id',
      [principal.tenantId, docId],
    )
  if (!removed.length) throw Object.assign(new Error('没有可解除的延续关系'), { statusCode: 404 })
  return continuationView(principal, document)
}

/** 彻底删除文档前清理相关沿革边，避免留下指向不存在文档的引用。 */
export async function removeContinuationLinks(client: { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> }, tenantId: string, docId: string): Promise<void> {
  await client.query(
    'DELETE FROM document_continuations WHERE tenant_id = $1 AND (predecessor_doc_id = $2 OR successor_doc_id = $2)',
    [tenantId, docId],
  )
}