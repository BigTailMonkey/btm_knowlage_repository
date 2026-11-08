import { settings } from '../config.js'
import { query } from '../db/index.js'
import { cosine, embedder } from '../adapters/embeddings/index.js'
import { completeStructured, modelUnavailable, requireModelText } from '../adapters/harness/index.js'
import type { EntityRow } from './rows.js'

/** Semantic candidates are proposals only; an explicit model decision is required to merge. */
export async function resolveSemanticEntity(tenant: string, name: string, type: string, acl: string[]): Promise<EntityRow | null> {
  if (!settings.semanticEntities) return null
  const candidates = await query<EntityRow>(`SELECT * FROM entities WHERE tenant_id=$1 AND type=$2 AND status='active'
    AND acl_principals @> $3::jsonb AND acl_principals <@ $3::jsonb ORDER BY updated_at DESC LIMIT 100`, [tenant, type, JSON.stringify(acl)])
  if (!candidates.length) return null
  const vectors = await embedder.embedMany([name, ...candidates.map((entity) => entity.canonical_name)])
  const ranked = candidates.map((entity, index) => ({ entity, score: cosine(vectors[0]!.dense, vectors[index + 1]!.dense) }))
    .filter((item) => item.score >= 0.8).sort((a, b) => b.score - a.score).slice(0, 5)
  if (!ranked.length) return null
  const result = await completeStructured(JSON.stringify({ name, type, candidates: ranked.map(({ entity }) => ({ id: entity.id, name: entity.canonical_name })) }),
    '判定名称是否指同一实体，而不是相关实体。只返回JSON {"same_entity":boolean,"entity_id":string|null,"confidence":number}。不确定时same_entity=false。')
  const text = requireModelText(result, '实体语义判定')
  let decision: { same_entity?: unknown; confidence?: unknown; entity_id?: unknown } | null
  try {
    decision = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? 'null')
  } catch {
    throw modelUnavailable('实体语义判定', '模型返回了无效 JSON')
  }
  if (typeof decision?.same_entity !== 'boolean' ||
      (decision.same_entity && (typeof decision.entity_id !== 'string' || typeof decision.confidence !== 'number'))) {
    throw modelUnavailable('实体语义判定', '模型未返回有效的判定结果')
  }
  return decision.same_entity && Number(decision.confidence) >= 0.9
    ? ranked.find(({ entity }) => entity.id === decision.entity_id)?.entity ?? null : null
}
