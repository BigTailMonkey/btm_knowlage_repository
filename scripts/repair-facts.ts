/**
 * 修复已有知识库里的四类数据问题（确定性规则，不调用模型）：
 *
 * 1. 值型实体：数值、比例、期限、日期、公式被抽成了实体，事实的宾语指向它。
 *    把这类事实改成 object_literal（保留原文），宾语不再是节点。
 *    另一类是「一次性长从句」：只被某一条事实当作宾语、从未当过主语，名字又是并列清单或
 *    长句（≥2 个顿号且 ≥14 字，或 ≥40 字）。它们不可能被复用，同样改成字面值。
 *    判断刻意保守：只要当过主语（说明被复用）就保留为实体。
 * 2. 值当主语：主语本身是值，这类事实是「公式等于公式」之类的垃圾，直接删除。
 * 3. 自指事实：主语和宾语是同一个事物，删除。
 * 4. 同一断言重复：同一主语、同一宾语、同一关系槽位（见 relation-types.relationSlot），
 *    只保留置信度最高的一条，其余连同证据删除；随后清掉没有事实引用的孤立实体。
 *
 * 默认只打印将要发生的改动（dry-run）；加 --apply 才写库。
 *
 *   node --import tsx scripts/repair-facts.ts            # 预演
 *   node --import tsx scripts/repair-facts.ts --apply    # 执行
 */
import { settings } from '../src/config.js'
import { sameAssertion } from '../src/core/relation-types.js'
import { isValueLike } from '../src/core/value-shapes.js'
import { closePool, query, transaction } from '../src/db/index.js'

interface EntityLite {
  id: string
  canonical_name: string
}

interface FactLite {
  id: string
  tenant_id: string
  subject_id: string
  subject: string
  predicate: string
  object_id: string | null
  object: string | null
  object_literal: string | null
  status: string
  confidence: number
  recorded_at: Date | string
}

const apply = process.argv.includes('--apply')
const tenantFilter = process.argv.find((arg) => arg.startsWith('--tenant='))?.slice('--tenant='.length)
  ?? settings.defaultTenantId

async function loadFacts(): Promise<FactLite[]> {
  return query<FactLite>(
    `SELECT f.id, f.tenant_id, f.subject_id, s.canonical_name AS subject, f.predicate,
            f.object_id, o.canonical_name AS object, f.object_literal, f.status, f.confidence, f.recorded_at
       FROM facts f
       JOIN entities s ON s.id = f.subject_id
       LEFT JOIN entities o ON o.id = f.object_id
      WHERE f.tenant_id = $1 AND f.status IN ('active', 'disputed', 'superseded')
      ORDER BY f.recorded_at, f.id`,
    [tenantFilter],
  )
}

function targetOf(fact: FactLite): string {
  return fact.object_id ? `entity:${fact.object_id}` : `literal:${(fact.object_literal ?? '').trim()}`
}

function describe(fact: FactLite): string {
  return `${fact.subject} — ${fact.predicate} → ${fact.object ?? fact.object_literal ?? ''}`
}

async function main(): Promise<void> {
  console.log(`巡检租户 ${tenantFilter}${apply ? '（写入模式）' : '（预演，加 --apply 才写库）'}`)
  const facts = await loadFacts()
  console.log(`事实总数 ${facts.length}`)

  // 1) 值型宾语 → 字面值
  const objectRefs = new Map<string, number>()
  const subjectRefs = new Map<string, number>()
  for (const fact of facts) {
    if (fact.object_id) objectRefs.set(fact.object_id, (objectRefs.get(fact.object_id) ?? 0) + 1)
    subjectRefs.set(fact.subject_id, (subjectRefs.get(fact.subject_id) ?? 0) + 1)
  }
  const oneOffClause = (fact: FactLite): boolean => {
    if (!fact.object_id) return false
    const name = fact.object ?? ''
    if (subjectRefs.get(fact.object_id)) return false            // 当过主语 = 会被复用
    if ((objectRefs.get(fact.object_id) ?? 0) !== 1) return false // 被多处引用 = 有共享身份
    return ((name.match(/、/g) ?? []).length >= 2 && name.length >= 14) || name.length >= 40
  }
  const valueAsObject = facts.filter((fact) => fact.object_id
    && (isValueLike(fact.object ?? '') || oneOffClause(fact)))
  // 2) 值型主语 → 整条事实是垃圾
  const valueAsSubject = facts.filter((fact) => isValueLike(fact.subject))
  const valueSubjectIds = new Set(valueAsSubject.map((fact) => fact.id))
  // 3) 自指
  const selfReferential = facts.filter((fact) => fact.object_id === fact.subject_id && !valueSubjectIds.has(fact.id))
  const selfIds = new Set(selfReferential.map((fact) => fact.id))

  const deleted = new Set([...valueSubjectIds, ...selfIds])

  // 4) 同一槽位重复
  const survivors = facts.filter((fact) => !deleted.has(fact.id)).map((fact) => ({
    ...fact,
    // 值型宾语下一步会变成字面值，去重要按转换后的目标算，否则转换后又会冒出重复
    target: fact.object_id && (isValueLike(fact.object ?? '') || oneOffClause(fact))
      ? `literal:${(fact.object ?? '').trim()}` : targetOf(fact),
  }))
  // 同一主语 + 同一宾语（按转换后的目标算），再按「是不是同一条断言」聚成一簇
  const pairs = new Map<string, typeof survivors>()
  for (const fact of survivors) {
    const key = `${fact.subject_id}|${fact.target}`
    const list = pairs.get(key) ?? []
    list.push(fact)
    pairs.set(key, list)
  }
  const duplicates: typeof survivors = []
  const keepers: typeof survivors = []
  for (const list of pairs.values()) {
    if (list.length < 2) continue
    const ordered = [...list].sort((a, b) => b.confidence - a.confidence
      || String(a.recorded_at).localeCompare(String(b.recorded_at)) || a.id.localeCompare(b.id))
    const kept: typeof survivors = []
    for (const fact of ordered) {
      const twin = kept.find((other) => sameAssertion(other.predicate, fact.predicate))
      if (twin) duplicates.push(fact)
      else kept.push(fact)
    }
    keepers.push(...kept)
  }
  const duplicateIds = new Set(duplicates.map((fact) => fact.id))

  // 报告
  const section = (title: string, list: FactLite[]) => {
    console.log(`\n${title}：${list.length} 条`)
    list.slice(0, 40).forEach((fact) => console.log(`  - ${describe(fact)}`))
    if (list.length > 40) console.log(`  … 其余 ${list.length - 40} 条省略`)
  }
  section('值/一次性从句被当成宾语（改写字面值，不再建实体）', valueAsObject)
  section('值被当成主语（删除）', valueAsSubject)
  section('主语与宾语同指（删除）', selfReferential)
  section('同一断言的重复措辞（保留置信度最高的一条）', duplicates as FactLite[])

  if (!apply) {
    console.log('\n预演结束，未写入任何数据。')
    return
  }

  const doomed = [...valueSubjectIds, ...selfIds, ...duplicateIds]
  await transaction(async (client) => {
    for (const fact of valueAsObject) {
      if (deleted.has(fact.id) || duplicateIds.has(fact.id)) continue
      await client.query('UPDATE facts SET object_id = NULL, object_literal = $1 WHERE id = $2', [fact.object ?? '', fact.id])
    }
    if (doomed.length) {
      await client.query('DELETE FROM fact_evidence WHERE fact_id = ANY($1::text[])', [doomed])
      await client.query(
        `UPDATE review_queue SET status = 'resolved', resolution = $1::jsonb, resolved_at = now()
          WHERE status = 'open' AND payload->>'new_fact_id' = ANY($2::text[])`,
        [JSON.stringify({ action: 'deduplicated', by: 'repair' }), doomed],
      )
      await client.query('DELETE FROM facts WHERE id = ANY($1::text[])', [doomed])
    }
    // 孤立实体：既没有事实引用，也不是活着的实体。先清别名，再删实体（别名表有外键）
    await client.query(
      `DELETE FROM entity_aliases a
        WHERE a.entity_id IN (
          SELECT e.id FROM entities e
           WHERE e.tenant_id = $1
             AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.subject_id = e.id OR f.object_id = e.id)
        )`,
      [tenantFilter],
    )
    await client.query(
      `DELETE FROM entities e
        WHERE e.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.subject_id = e.id OR f.object_id = e.id)`,
      [tenantFilter],
    )
  })

  const after = await loadFacts()
  const orphans = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM entities e WHERE e.tenant_id = $1
       AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.subject_id = e.id OR f.object_id = e.id)`,
    [tenantFilter],
  )
  const entities = await query<{ count: string }>('SELECT count(*)::text AS count FROM entities WHERE tenant_id = $1', [tenantFilter])
  console.log(`\n已修复：事实 ${facts.length} → ${after.length}，实体 ${entities[0]?.count ?? 0}，孤立实体 ${orphans[0]?.count ?? 0}`)
}

await main()
await closePool()
