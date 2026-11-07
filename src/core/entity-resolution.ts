import { settings } from '../config.js'
import { query } from '../db/index.js'
import { cosine, embedder } from '../adapters/embeddings/index.js'
import { harness } from '../adapters/harness/index.js'
import type { EntityRow } from './rows.js'

/** Semantic candidates are proposals only; an explicit model decision is required to merge. */
export async function resolveSemanticEntity(tenant: string, name: string, type: string, acl: string[]): Promise<EntityRow | null> {
  if (!settings.semanticEntities) return null
  const candidates = await query<EntityRow>(`SELECT * FROM entities WHERE tenant_id=$1 AND type=$2 AND status='active'
    AND acl_principals @> $3::jsonb AND acl_principals <@ $3::jsonb ORDER BY updated_at DESC LIMIT 100`, [tenant, type, JSON.stringify(acl)])
  if (!candidates.length) return null
  try {
    const vectors = await embedder.embedMany([name, ...candidates.map((entity) => entity.canonical_name)])
    const ranked = candidates.map((entity, index) => ({ entity, score: cosine(vectors[0]!.dense, vectors[index + 1]!.dense) }))
      .filter((item) => item.score >= 0.8).sort((a, b) => b.score - a.score).slice(0, 5)
    if (!ranked.length) return null
    const result = await harness.complete(JSON.stringify({ name, type, candidates: ranked.map(({ entity }) => ({ id: entity.id, name: entity.canonical_name })) }),
      '判定名称是否指同一实体，而不是相关实体。只返回JSON {"same_entity":boolean,"entity_id":string|null,"confidence":number}。不确定时same_entity=false。', 400)
    const json = /\{[\s\S]*\}/.exec(result.text)?.[0]
    if (!result.ok || !json) return null
    const decision = JSON.parse(json)
    return decision.same_entity === true && Number(decision.confidence) >= 0.9
      ? ranked.find(({ entity }) => entity.id === decision.entity_id)?.entity ?? null : null
  } catch { return null }
}
