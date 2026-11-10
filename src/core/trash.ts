import { embedder, type Embedding } from '../adapters/embeddings/index.js'
import { settings } from '../config.js'
import { query, queryOne, transaction, type DbClient } from '../db/index.js'
import { chunkBlocks, type ParsedBlock } from './chunking.js'
import { removeContinuationLinks } from './continuation.js'
import { enqueueEnrichment } from './enrichment-queue.js'
import { newId } from './ids.js'
import { insertChunkRows } from './ingestion.js'
import { notifyReviewQueueChanged } from './review-events.js'
import type { BlockRow, DocumentRow, VersionRow } from './rows.js'
import { canRead, Principal } from './security.js'
import { documentDict } from './serializers.js'

/**
 * 回收站语义：移入回收站只保留文档本体（documents、document_versions、blocks、原始文件），
 * 派生内容（检索单元与向量、事实证据、事实状态、摘要）当场清理；
 * 恢复时重新切分、重新向量化、重新抽取事实与实体。
 */

async function trashedDocument(principal: Principal, docId: string): Promise<DocumentRow> {
  const document = await queryOne<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId])
  if (!document || document.tenant_id !== principal.tenantId || !canRead(principal, document.acl_principals)) {
    throw Object.assign(new Error('文档不存在或无权访问'), { statusCode: 404 })
  }
  return document
}

/** 关闭与该文档相关的待审项，避免文档移入回收站后队列里留下永远无法处理的死项。 */
async function closeReviewsForDocument(
  client: DbClient,
  tenantId: string,
  docId: string,
  factIds: string[],
  action: Record<string, unknown>,
): Promise<number> {
  const closed = await client.query<{ id: string }>(
    `UPDATE review_queue SET status = 'resolved', resolution = $1::jsonb, resolved_at = now()
     WHERE tenant_id = $2 AND status = 'open'
       AND (payload->>'document_id' = $3
            OR payload->>'doc_id' = $3
            OR payload->>'new_fact_id' = ANY($4::text[])
            OR payload->'old_fact_ids' ?| $4::text[]
            OR payload->>'job_id' IN (SELECT id FROM jobs WHERE tenant_id = $2 AND payload->>'doc_id' = $3))
     RETURNING id`,
    [JSON.stringify(action), tenantId, docId, factIds],
  )
  return closed.length
}

export async function trashDocument(principal: Principal, docId: string): Promise<Record<string, unknown>> {
  const document = await trashedDocument(principal, docId)
  if (document.status === 'tombstoned') throw Object.assign(new Error('文档已在回收站'), { statusCode: 409 })
  const affectedFacts = new Set<string>()
  let removedChunks = 0
  let closedReviews = 0
  await transaction(async (client) => {
    const locked = await client.query<DocumentRow>(
      "SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND status = 'active' FOR UPDATE",
      [docId, principal.tenantId],
    )
    if (!locked.length) throw Object.assign(new Error('文档已不在知识库中，无法移入回收站'), { statusCode: 409 })
    // 摘要与检索单元都是派生内容，不随文档留在回收站。
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id = $1', [principal.tenantId])
    await client.query(
      `UPDATE jobs SET status = 'done', error = '文档已移入回收站', updated_at = now()
       WHERE tenant_id = $1 AND type = 'enrich' AND status IN ('pending','running')
         AND payload->>'document_id' = $2`,
      [principal.tenantId, docId],
    )
    const facts = await client.query<{ id: string }>(
      `SELECT id FROM facts WHERE tenant_id = $1 AND
         (source_doc_id = $2 OR id IN (SELECT fact_id FROM fact_evidence WHERE doc_id = $2))`,
      [principal.tenantId, docId],
    )
    for (const fact of facts) affectedFacts.add(fact.id)
    await client.query('DELETE FROM fact_evidence WHERE doc_id = $1', [docId])
    for (const factId of affectedFacts) {
      const remaining = (await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM fact_evidence WHERE fact_id = $1',
        [factId],
      ))[0]
      if (!remaining || Number(remaining.count) === 0) {
        await client.query(`UPDATE facts SET status = 'retracted' WHERE id = $1`, [factId])
      }
    }
    const chunks = await client.query<{ id: string }>(
      'DELETE FROM chunks WHERE tenant_id = $1 AND doc_id = $2 RETURNING id',
      [principal.tenantId, docId],
    )
    removedChunks = chunks.length
    closedReviews = await closeReviewsForDocument(client, principal.tenantId, docId, [...affectedFacts], {
      action: 'document_trashed',
      by: principal.userId,
      document_id: docId,
    })
    await client.query(
      `UPDATE documents SET status = 'tombstoned', deleted_at = now(), deleted_by = $2, updated_at = now()
       WHERE id = $1`,
      [docId, principal.userId],
    )
  })
  await query(
    `INSERT INTO jobs (id, tenant_id, type, status, payload)
     VALUES ($1, $2, 'trash', 'done', $3::jsonb)`,
    [newId('job'), principal.tenantId, JSON.stringify({
      doc_id: docId, by: principal.userId, affected_facts: [...affectedFacts], removed_chunks: removedChunks, closed_reviews: closedReviews,
    })],
  )
  if (closedReviews) notifyReviewQueueChanged(principal.tenantId)
  return {
    document_id: docId,
    status: 'tombstoned',
    affected_facts: affectedFacts.size,
    removed_chunks: removedChunks,
    closed_reviews: closedReviews,
  }
}

/** 回收站列表：只保留文档本体，因此列表里不会出现检索单元与事实。 */
export async function trashDocuments(principal: Principal): Promise<Array<Record<string, unknown>>> {
  const documents = await query<DocumentRow>(
    `SELECT * FROM documents WHERE tenant_id = $1 AND status = 'tombstoned'
     ORDER BY deleted_at DESC NULLS LAST, updated_at DESC`,
    [principal.tenantId],
  )
  const retention = settings.trashRetentionDays
  return Promise.all(documents.filter((document) => canRead(principal, document.acl_principals)).map(async (document) => ({
    ...await documentDict(document),
    deleted_at: document.deleted_at ?? null,
    deleted_by: document.deleted_by ?? null,
    // 0 表示不自动清除
    expires_at: retention > 0 && document.deleted_at
      ? new Date(new Date(document.deleted_at).getTime() + retention * 86_400_000).toISOString()
      : null,
  })))
}

/**
 * 恢复：用已存的结构块重新切分 → 重新向量化 → 恢复为 active 并发起事实与实体重新抽取。
 * 向量生成失败不改变回收站状态，避免出现“已恢复但没有索引”的半套文档。
 */
export async function restoreDocument(principal: Principal, docId: string): Promise<Record<string, unknown>> {
  const document = await trashedDocument(principal, docId)
  if (document.status !== 'tombstoned') throw Object.assign(new Error('文档不在回收站'), { statusCode: 409 })
  const version = await queryOne<VersionRow>(
    'SELECT * FROM document_versions WHERE doc_id = $1 AND version = $2',
    [document.id, document.current_version],
  )
  if (!version) throw Object.assign(new Error('当前版本已不存在，无法恢复'), { statusCode: 409 })
  const blocks = await query<BlockRow>(
    'SELECT * FROM blocks WHERE version_id = $1 ORDER BY order_index, id',
    [version.id],
  )
  const parsedBlocks: ParsedBlock[] = blocks.map((block) => ({
    type: block.type,
    text: block.text,
    headingPath: block.heading_path ?? [],
    page: block.page,
    bbox: block.bbox,
    order: block.order_index,
  }))
  if (!parsedBlocks.length) throw Object.assign(new Error('文档缺少可重建的结构块，无法恢复'), { statusCode: 409 })

  const chunks = chunkBlocks(parsedBlocks)
  const embeddingInputs = chunks.filter((chunk) => !chunk.isParent).map((chunk) => ({
    id: chunk.id,
    text: `标题：${document.title}｜章节：${chunk.headingPath.join(' / ')}\n${chunk.text}`,
  }))
  const vectors = await embedder.embedMany(embeddingInputs.map((item) => item.text))
  if (vectors.length !== embeddingInputs.length || vectors.some((vector) => !vector?.dense.length)) {
    throw new Error('向量服务返回数量或内容不完整，文档未恢复')
  }
  const embeddings = new Map<string, Embedding>()
  embeddingInputs.forEach((item, index) => embeddings.set(item.id, vectors[index]!))

  let stale = false
  await transaction(async (client) => {
    const locked = await client.query<DocumentRow>(
      "SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND status = 'tombstoned' FOR UPDATE",
      [docId, principal.tenantId],
    )
    if (!locked[0] || locked[0].current_version !== document.current_version) {
      stale = true
      return
    }
    const current = locked[0]
    await client.query('DELETE FROM chunks WHERE tenant_id = $1 AND doc_id = $2', [principal.tenantId, docId])
    await insertChunkRows(client, {
      tenantId: principal.tenantId,
      docId,
      versionId: version.id,
      chunks,
      embeddings,
      acl: current.acl_principals,
      aclVersion: current.acl_version,
    })
    // 引用高亮依赖 chunk_spans 与检索单元 ID 的对应关系；重新切分后必须同步刷新。
    await client.query(
      'UPDATE document_versions SET meta = meta || $2::jsonb WHERE id = $1',
      [version.id, JSON.stringify({ chunk_spans: Object.fromEntries(chunks.map((chunk) => [chunk.id, chunk.sourceSpans])) })],
    )
    await client.query(
      `UPDATE documents SET status = 'active', deleted_at = NULL, deleted_by = NULL,
         enrichment_status = 'pending', enrichment_error = NULL, updated_at = now()
       WHERE id = $1`,
      [docId],
    )
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id = $1', [principal.tenantId])
    await enqueueEnrichment(client, principal, docId, current.current_version)
    await client.query(
      `INSERT INTO jobs (id, tenant_id, type, status, payload)
       VALUES ($1, $2, 'restore', 'done', $3::jsonb)`,
      [newId('job'), principal.tenantId, JSON.stringify({ doc_id: docId, by: principal.userId, chunks: chunks.length, version: version.version })],
    )
  })
  if (stale) throw Object.assign(new Error('文档状态已变化，请刷新后重试'), { statusCode: 409 })
  return {
    document_id: docId,
    status: 'active',
    version: version.version,
    chunks: chunks.length,
    enrichment: 'queued',
    message: '文档已恢复，检索索引与事实抽取已重新排队',
  }
}

interface PurgeResult {
  document_id: string
  status: 'purged'
  removed_facts: number
  removed_versions: number
  removed_jobs: number
  removed_entities: number
}

/** 彻底删除：文档本体、版本、结构块、原始文件、派生内容与孤立实体一并物理清除。 */
async function purgeTrashedDocument(tenantId: string, docId: string, by: string): Promise<PurgeResult> {
  let removedFacts: string[] = []
  let removedVersions = 0
  let removedJobs = 0
  let removedEntities = 0
  await transaction(async (client) => {
    const document = await client.query<DocumentRow>(
      "SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND status = 'tombstoned' FOR UPDATE",
      [docId, tenantId],
    )
    if (!document.length) throw Object.assign(new Error('文档不在回收站'), { statusCode: 409 })
    const facts = await client.query<{ id: string }>(
      `SELECT id FROM facts WHERE tenant_id = $1 AND
         (source_doc_id = $2 OR id IN (SELECT fact_id FROM fact_evidence WHERE doc_id = $2))`,
      [tenantId, docId],
    )
    await client.query('DELETE FROM fact_evidence WHERE doc_id = $1', [docId])
    for (const fact of facts) {
      const remaining = (await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM fact_evidence WHERE fact_id = $1',
        [fact.id],
      ))[0]
      if (remaining && Number(remaining.count) === 0) removedFacts.push(fact.id)
    }
    if (removedFacts.length) {
      await client.query('DELETE FROM facts WHERE id = ANY($1::text[])', [removedFacts])
      await client.query('DELETE FROM citations WHERE fact_id = ANY($1::text[])', [removedFacts])
      await client.query('UPDATE memory_items SET promoted_fact_id = NULL WHERE promoted_fact_id = ANY($1::text[])', [removedFacts])
    }
    await client.query('DELETE FROM blocks WHERE doc_id = $1', [docId])
    await client.query('DELETE FROM chunks WHERE tenant_id = $1 AND doc_id = $2', [tenantId, docId])
    const versions = await client.query<{ id: string }>(
      'DELETE FROM document_versions WHERE doc_id = $1 RETURNING id',
      [docId],
    )
    removedVersions = versions.length
    await client.query('DELETE FROM citations WHERE doc_id = $1', [docId])
    await removeContinuationLinks(client, tenantId, docId)
    await client.query('DELETE FROM documents WHERE id = $1', [docId])
    // 原始文件字节、抽取任务与审计记录都在 jobs 里，一并清除。
    const jobs = await client.query<{ id: string }>(
      `DELETE FROM jobs WHERE tenant_id = $1 AND (payload->>'doc_id' = $2 OR payload->>'document_id' = $2
         OR id LIKE 'enrich:' || $2 || ':%') RETURNING id`,
      [tenantId, docId],
    )
    removedJobs = jobs.length
    await client.query(
      `DELETE FROM review_queue WHERE tenant_id = $1 AND (payload->>'document_id' = $2 OR payload->>'doc_id' = $2
         OR payload->>'new_fact_id' = ANY($3::text[]) OR payload->'old_fact_ids' ?| $3::text[])`,
      [tenantId, docId, removedFacts],
    )
    await client.query(
      `UPDATE eval_cases SET expected_docs = COALESCE((
         SELECT jsonb_agg(value) FROM jsonb_array_elements(expected_docs) WHERE value <> to_jsonb($2::text)
       ), '[]'::jsonb)
       WHERE tenant_id = $1 AND expected_docs ? $2`,
      [tenantId, docId],
    )
    // 只被这篇文档引入、如今没有任何事实引用的实体属于残留。
    const orphans = await client.query<{ id: string }>(
      `SELECT e.id FROM entities e WHERE e.tenant_id = $1 AND e.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.tenant_id = e.tenant_id
           AND (f.subject_id = e.id OR f.object_id = e.id))`,
      [tenantId],
    )
    if (orphans.length) {
      const ids = orphans.map((row) => row.id)
      await client.query('DELETE FROM entity_aliases WHERE entity_id = ANY($1::text[])', [ids])
      await client.query('DELETE FROM entities WHERE id = ANY($1::text[])', [ids])
      removedEntities = ids.length
    }
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id = $1', [tenantId])
    await client.query(
      `INSERT INTO jobs (id, tenant_id, type, status, payload)
       VALUES ($1, $2, 'purge', 'done', $3::jsonb)`,
      [newId('job'), tenantId, JSON.stringify({
        doc_id: docId, by, facts: removedFacts.length, versions: removedVersions, jobs: removedJobs, entities: removedEntities,
      })],
    )
  })
  return {
    document_id: docId,
    status: 'purged',
    removed_facts: removedFacts.length,
    removed_versions: removedVersions,
    removed_jobs: removedJobs,
    removed_entities: removedEntities,
  }
}

export async function purgeDocument(principal: Principal, docId: string): Promise<PurgeResult> {
  const document = await trashedDocument(principal, docId)
  if (document.status !== 'tombstoned') throw Object.assign(new Error('文档不在回收站，请先移入回收站'), { statusCode: 409 })
  return purgeTrashedDocument(principal.tenantId, docId, principal.userId)
}

/** 每日维护用：按保留天数清理回收站，0 表示不自动清除。 */
export async function purgeExpiredTrash(tenantId: string, retentionDays = settings.trashRetentionDays): Promise<number> {
  if (retentionDays <= 0) return 0
  const expired = await query<{ id: string }>(
    `SELECT id FROM documents WHERE tenant_id = $1 AND status = 'tombstoned'
       AND deleted_at IS NOT NULL AND deleted_at < now() - ($2::text || ' days')::interval
     ORDER BY deleted_at, id`,
    [tenantId, String(retentionDays)],
  )
  let purged = 0
  for (const document of expired) {
    try {
      await purgeTrashedDocument(tenantId, document.id, 'maintenance')
      purged += 1
    } catch (error) {
      // 单个文档失败不影响其余回收站清理，失败原因由调用方记录。
      if ((error as { statusCode?: number }).statusCode === 409) continue
      throw error
    }
  }
  return purged
}
