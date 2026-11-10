import { query, transaction, type DbClient } from '../db/index.js'
import { extractFactsForDocument } from './learning.js'
import { extractionProgress } from './extraction-progress.js'
import { enrichJobId } from './ids.js'
import { notifyReviewQueueChanged } from './review-events.js'
import { canRead, principalByUserId, principalSet, type Principal } from './security.js'

interface Promotion {
  review_id: string
  memory_id: string
  action: string
  note: string
}

interface EnrichmentJob {
  id: string
  tenant_id: string
  attempts: number
  payload: { document_id: string; version: number; user_id: string; promotion?: Promotion }
}

function jobId(docId: string, version: number): string {
  return enrichJobId(docId, version)
}

export async function enqueueEnrichment(
  client: DbClient, principal: Principal, docId: string, version: number, promotion?: Promotion,
): Promise<boolean> {
  const queued = await client.query<{ status: string }>(
    `INSERT INTO jobs (id, tenant_id, type, status, payload)
     VALUES ($1, $2, 'enrich', 'pending', $3::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'pending' END,
       error=NULL, payload=jobs.payload || EXCLUDED.payload, updated_at=now()
     WHERE jobs.status NOT IN ('pending','running') OR EXCLUDED.payload ? 'promotion'
     RETURNING status`,
    [jobId(docId, version), principal.tenantId, JSON.stringify({ document_id: docId, version, user_id: principal.userId, promotion })],
  )
  if (queued[0]?.status === 'pending') {
    await client.query(
      "UPDATE documents SET enrichment_status='pending', enrichment_error=NULL WHERE id=$1 AND current_version=$2",
      [docId, version],
    )
  }
  return queued.length > 0
}

/** 强制重抽：丢掉检查点后重新入队，下一轮从第一批开始。正在运行的任务不会被改动。 */
async function resetCheckpoint(client: DbClient, principal: Principal, docId: string, version: number): Promise<void> {
  await client.query(
    `UPDATE jobs SET payload = payload - 'checkpoint', updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status <> 'running'`,
    [enrichJobId(docId, version), principal.tenantId],
  )
}

export async function requestEnrichment(
  principal: Principal, docId: string, requiredState?: 'failed' | 'deferred', promotion?: Promotion,
  options: { reset?: boolean } = {},
): Promise<boolean> {
  return transaction(async (client) => {
    const [doc] = await client.query<{ current_version: number; enrichment_status: string; acl_principals: string[] }>(
      "SELECT current_version,enrichment_status,acl_principals FROM documents WHERE id=$1 AND tenant_id=$2 AND status='active' FOR UPDATE",
      [docId, principal.tenantId],
    )
    if (!doc || !canRead(principal, doc.acl_principals)) {
      if (requiredState) return false
      throw Object.assign(new Error('文档不存在或无权访问'), { statusCode: 404 })
    }
    if (requiredState && doc.enrichment_status !== requiredState) return false
    if (options.reset) await resetCheckpoint(client, principal, docId, doc.current_version)
    return enqueueEnrichment(client, principal, docId, doc.current_version, promotion)
  })
}

export async function enrichmentTasks(principal: Principal) {
  const rows = await query<{ id: string; title: string; status: string; error: string | null; version: number }>(
    `SELECT d.id,d.title,CASE WHEN j.status IN ('pending','running') THEN j.status ELSE d.enrichment_status END AS status,
       COALESCE(d.enrichment_error,j.error,previous.error) AS error,d.current_version AS version
     FROM documents d LEFT JOIN jobs j ON j.id='enrich:' || d.id || ':' || d.current_version::text
     LEFT JOIN LATERAL (
       SELECT i.error FROM jobs i WHERE i.tenant_id=d.tenant_id AND i.type='ingest' AND i.status='done'
         AND i.payload->>'doc_id'=d.id AND i.payload->>'version'=d.current_version::text AND i.error IS NOT NULL
       ORDER BY i.updated_at DESC LIMIT 1
     ) previous ON d.enrichment_status='failed' AND d.enrichment_error IS NULL AND j.error IS NULL
     WHERE d.tenant_id=$1 AND d.status='active' AND d.acl_principals ?| $2::text[]
       AND (d.enrichment_status='failed' OR j.status IN ('pending','running'))
     ORDER BY d.updated_at DESC, d.id`,
    [principal.tenantId, [...principalSet(principal)]],
  )
  // 运行中的任务补上实时进度：批次是底数，实际请求数是进度。
  return rows.map((row) => ({ ...row, progress: extractionProgress(row.id, row.version) }))
}

let worker: Promise<void> | null = null
let stopping = false
let workRequested = false

export function processEnrichmentQueue(): Promise<void> {
  workRequested = true
  if (worker) return worker
  worker = (async () => {
    do {
      workRequested = false
      await query(`UPDATE jobs SET status='pending' WHERE type='enrich' AND status='running'
        AND updated_at < now() - interval '2 minutes'`)
      while (!stopping) {
        const [job] = await query<EnrichmentJob>(`
          UPDATE jobs SET status='running', attempts=attempts+1, updated_at=now()
          WHERE id=(SELECT id FROM jobs WHERE type='enrich' AND status='pending'
            ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1) AND status='pending'
          RETURNING id,tenant_id,attempts,payload`)
        if (!job) break
        await processEnrichmentJob(job)
      }
    } while (workRequested && !stopping)
  })().finally(() => { worker = null })
  return worker
}

async function processEnrichmentJob(job: EnrichmentJob): Promise<void> {
  const { document_id: docId, version, user_id: userId } = job.payload
  const heartbeat = setInterval(() => {
    void query("UPDATE jobs SET updated_at=now() WHERE id=$1 AND attempts=$2 AND status='running'", [job.id, job.attempts]).catch(console.error)
  }, 30_000)
  heartbeat.unref()
  let status = 'done'
  let error: string | null = null
  try {
    const [doc] = await query<{ enrichment_status: string; acl_principals: string[] }>(
      "SELECT enrichment_status,acl_principals FROM documents WHERE id=$1 AND tenant_id=$2 AND current_version=$3 AND status='active'",
      [docId, job.tenant_id, version],
    )
    if (!doc) status = 'stale'
    else if (!['done', 'empty', 'failed'].includes(doc.enrichment_status)) {
      const principal = await principalByUserId(job.tenant_id, userId)
      if (!principal || !canRead(principal, doc.acl_principals)) throw new Error('任务主体无法访问当前文档')
      const result = await extractFactsForDocument(principal, docId, version)
      if (result.status === 'stale') status = 'stale'
      else if (result.error) throw new Error(String(result.error))
    } else if (doc.enrichment_status === 'failed') {
      // The previous worker may have written the document state before its job lease expired.
      status = 'failed'
    }
  } catch (cause) {
    status = 'failed'
    error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
  } finally {
    clearInterval(heartbeat)
  }
  let reviewChanged = false
  await transaction(async (client) => {
    const [current] = await client.query(
      "SELECT id FROM documents WHERE id=$1 AND current_version=$2 AND status='active' FOR UPDATE",
      [docId, version],
    )
    if (!current) status = 'stale'
    const [owned] = await client.query<{ payload: EnrichmentJob['payload'] }>(
      "UPDATE jobs SET status=$3,error=$4,updated_at=now() WHERE id=$1 AND attempts=$2 AND status='running' RETURNING payload",
      [job.id, job.attempts, status, error],
    )
    if (!owned) return
    // 抽取期间文档被移入回收站或换版：由此产生的待审项已无有效出处，直接关闭。
    if (status === 'stale') {
      const invalidated = await client.query<{ id: string }>(
        `UPDATE review_queue SET status='resolved', resolution=$3::jsonb, resolved_at=now()
         WHERE tenant_id=$1 AND status='open' AND payload->>'new_fact_id' IN (
           SELECT id FROM facts WHERE tenant_id=$1 AND source_doc_id=$2 AND status='retracted'
         ) RETURNING id`,
        [job.tenant_id, docId, JSON.stringify({ action: 'evidence_retracted', by: 'system' })],
      )
      if (invalidated.length) reviewChanged = true
    }
    if (status === 'failed') {
      await client.query(
        "UPDATE documents SET enrichment_status='failed',enrichment_error=COALESCE($3,enrichment_error) WHERE id=$1 AND current_version=$2 AND status='active'",
        [docId, version, error],
      )
    }
    const promotion = owned.payload.promotion
    if (promotion && status === 'done') {
      const closed = await client.query(
        `UPDATE review_queue SET status='resolved', resolution=$3::jsonb, resolved_at=now()
         WHERE id=$1 AND tenant_id=$2 AND kind='memory_promotion' AND status='open' RETURNING id`,
        [promotion.review_id, job.tenant_id, JSON.stringify({ action: promotion.action, note: promotion.note })],
      )
      if (closed.length) {
        reviewChanged = true
        await client.query(
          `UPDATE memory_items SET promoted_fact_id=(
             SELECT f.id FROM fact_evidence e JOIN facts f ON f.id=e.fact_id
             WHERE e.doc_id=$2 AND f.status <> 'retracted' ORDER BY f.id LIMIT 1
           ) WHERE id=$1 AND tenant_id=$3`,
          [promotion.memory_id, docId, job.tenant_id],
        )
      }
    } else if (promotion && status === 'failed') {
      await client.query(
        `UPDATE review_queue SET payload=payload || $3::jsonb WHERE id=$1 AND tenant_id=$2 AND status='open'`,
        [promotion.review_id, job.tenant_id, JSON.stringify({ model_error: error || '抽取任务失败' })],
      )
    }
  })
  if (reviewChanged) notifyReviewQueueChanged(job.tenant_id)
}

export async function stopEnrichmentWorker(): Promise<void> {
  stopping = true
  try { await worker } finally { stopping = false }
}
