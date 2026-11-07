import { createHash } from 'node:crypto'
import { query, transaction } from '../db/index.js'
import { newId } from './ids.js'
import { tokenize } from '../adapters/embeddings/index.js'
import { settings } from '../config.js'
import { todayLocal } from './ids.js'

interface SupportedFact { id: string; subject_id: string; object_id: string | null; subject: string; predicate: string; object: string; acl_principals: string[]; chunk_ids: string[]; quotes: string[] }

/** Extractive summaries keep provenance and never mix ACL partitions or unverified facts. */
export async function consolidateKnowledge(tenant: string): Promise<Record<string, number>> {
  const facts = await query<SupportedFact>(`SELECT f.id,f.subject_id,f.object_id,s.canonical_name AS subject,f.predicate,
    coalesce(o.canonical_name,f.object_literal,'') AS object,f.acl_principals,
    jsonb_agg(DISTINCT e.chunk_id) AS chunk_ids,jsonb_agg(DISTINCT e.quote) AS quotes
    FROM facts f JOIN entities s ON s.id=f.subject_id LEFT JOIN entities o ON o.id=f.object_id
    JOIN fact_evidence e ON e.fact_id=f.id JOIN chunks c ON c.id=e.chunk_id
    JOIN documents d ON d.id=c.doc_id JOIN document_versions v ON v.id=c.version_id
    WHERE f.tenant_id=$1 AND f.status='active' AND d.status='active' AND v.version=d.current_version
      AND (f.valid_from IS NULL OR f.valid_from<=$2::date) AND (f.valid_to IS NULL OR f.valid_to>$2::date)
    GROUP BY f.id,s.canonical_name,o.canonical_name ORDER BY f.id`, [tenant,todayLocal(settings.timezone)])
  const partitions = new Map<string, SupportedFact[]>()
  for (const fact of facts) {
    const key = JSON.stringify([...fact.acl_principals].sort())
    partitions.set(key, [...partitions.get(key) ?? [], fact])
  }
  const summaries: Array<{ kind: string; subject: string | null; acl: string; facts: SupportedFact[] }> = []
  for (const [acl, partition] of partitions) {
    const subjects = new Set(partition.map((fact) => fact.subject_id))
    for (const subject of subjects) summaries.push({ kind: 'entity', subject, acl, facts: partition.filter((fact) => fact.subject_id === subject) })
    const unvisited = new Set(partition.map((fact) => fact.id))
    while (unvisited.size) {
      const first = partition.find((fact) => unvisited.has(fact.id))!
      const component: SupportedFact[] = []
      const nodes = new Set([first.subject_id, ...(first.object_id ? [first.object_id] : [])])
      let expanded = true
      while (expanded) {
        expanded = false
        for (const fact of partition) if (unvisited.has(fact.id) && (nodes.has(fact.subject_id) || (fact.object_id && nodes.has(fact.object_id)))) {
          component.push(fact); unvisited.delete(fact.id); nodes.add(fact.subject_id)
          if (fact.object_id) nodes.add(fact.object_id)
          expanded = true
        }
      }
      summaries.push({ kind: 'community', subject: null, acl, facts: component })
    }
  }
  await transaction(async (client) => {
    await client.query('DELETE FROM knowledge_summaries WHERE tenant_id=$1', [tenant])
    for (const summary of summaries) {
      const body = summary.facts.map((fact) => `${fact.subject} · ${fact.predicate} · ${fact.object}\n原文：${fact.quotes.join('；')}`).join('\n\n')
      const ids = [...new Set(summary.facts.flatMap((fact) => fact.chunk_ids))]
      await client.query(`INSERT INTO knowledge_summaries(id,tenant_id,kind,subject_id,acl_principals,text,evidence_ids,input_hash)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`, [newId('sum'), tenant, summary.kind, summary.subject, summary.acl, body, JSON.stringify(ids), createHash('sha256').update(body).digest('hex')])
    }
  })
  const orphaned = await query(`UPDATE facts SET status='retracted' WHERE tenant_id=$1 AND status='active'
    AND NOT EXISTS(SELECT 1 FROM fact_evidence e JOIN chunks c ON c.id=e.chunk_id JOIN documents d ON d.id=c.doc_id
      JOIN document_versions v ON v.id=c.version_id WHERE e.fact_id=facts.id AND d.status='active' AND v.version=d.current_version) RETURNING id`, [tenant])
  const decayed = await query(`UPDATE fact_evidence SET weight=greatest(0.1,weight*0.95),last_decay_at=now()
    WHERE fact_id IN(SELECT id FROM facts WHERE tenant_id=$1) AND last_used_at<now()-interval '30 days'
      AND (last_decay_at IS NULL OR last_decay_at<now()-interval '30 days') RETURNING id`, [tenant])
  const gaps = await query<{ id: string; question: string; count: number }>("SELECT id,question,count FROM gaps WHERE tenant_id=$1 AND status='open' ORDER BY count DESC,id", [tenant])
  let clustered = 0
  const removed = new Set<string>()
  for (const gap of gaps) {
    if (removed.has(gap.id)) continue
    const words = new Set(tokenize(gap.question))
    const group = gaps.filter((other) => {
      if (other.id === gap.id || removed.has(other.id)) return false
      const tokens = new Set(tokenize(other.question))
      const common = [...words].filter((word) => tokens.has(word)).length
      return common / Math.max(1, new Set([...words, ...tokens]).size) >= 0.7
    })
    if (!group.length) continue
    await transaction(async (client) => {
      await client.query('UPDATE gaps SET count=count+$1,suggested_sources=$2::jsonb,updated_at=now() WHERE id=$3', [group.reduce((sum, row) => sum + row.count, 0), JSON.stringify(group.map((row) => `相似问题：${row.question}`)), gap.id])
      for (const other of group) { await client.query("UPDATE gaps SET status='clustered',updated_at=now() WHERE id=$1", [other.id]); removed.add(other.id); clustered += 1 }
    })
  }
  return { entity_summaries: summaries.filter((row) => row.kind === 'entity').length, community_summaries: summaries.filter((row) => row.kind === 'community').length, orphaned_facts: orphaned.length, decayed_evidence: decayed.length, clustered_gaps: clustered }
}
