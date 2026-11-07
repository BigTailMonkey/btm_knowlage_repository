import { queryOne } from '../db/index.js'

/** Trust is an explicit editorial value, independent of parser quality. */
export function evidenceWeight(document: { source_trust?: number; quality_score: number }): number {
  return Math.max(0.05, Math.min(1, (document.source_trust ?? 0.5) * Math.max(0, document.quality_score)))
}

export async function shouldEnrich(docId: string): Promise<boolean> {
  const row = await queryOne<{ is_core: boolean; source_trust: number; uses: number }>(
    `SELECT d.is_core,d.source_trust,(SELECT count(DISTINCT message_id)::int FROM citations WHERE doc_id=d.id) AS uses
     FROM documents d WHERE d.id=$1 AND d.status='active'`, [docId])
  return !!row && (row.is_core || row.source_trust >= 0.8 || row.uses >= 3)
}
