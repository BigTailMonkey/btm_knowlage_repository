import { FastifyInstance } from 'fastify'

import { runEvaluation, type EvaluationCase } from '../../core/evaluation.js'
import { settings } from '../../config.js'
import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { harness } from '../../adapters/harness/index.js'
import { retrieve } from '../../core/retrieval.js'
import { newId, todayLocal } from '../../core/ids.js'
import { requireAdmin } from '../../core/security.js'
import { tokenPrice } from '../../core/tracing.js'
import { ENTITY_HAS_DISPLAYABLE_FACT } from '../../core/fact-visibility.js'
import type { TraceRow } from '../../core/rows.js'

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const tenant = principal.tenantId
    const counts = async (sql: string, params: unknown[]): Promise<number> => {
      const row = await queryOne<{ count: string }>(sql, params)
      return Number(row?.count ?? 0)
    }
    const documents = await counts(`SELECT count(*)::text AS count FROM documents WHERE tenant_id = $1 AND status = 'active'`, [tenant])
    const trashed = await counts(`SELECT count(*)::text AS count FROM documents WHERE tenant_id = $1 AND status = 'tombstoned'`, [tenant])
    const chunks = await counts(`SELECT count(*)::text AS count FROM chunks WHERE tenant_id = $1 AND is_parent = false`, [tenant])
    const entities = await counts(
      `SELECT count(*)::text AS count FROM entities e
       WHERE e.tenant_id = $1 AND e.status = 'active' AND ${ENTITY_HAS_DISPLAYABLE_FACT}`,
      [tenant],
    )
    const activeFacts = await counts(`SELECT count(*)::text AS count FROM facts WHERE tenant_id = $1 AND status = 'active'`, [tenant])
    const disputedFacts = await counts(`SELECT count(*)::text AS count FROM facts WHERE tenant_id = $1 AND status = 'disputed'`, [tenant])
    const openReviews = await counts(`SELECT count(*)::text AS count FROM review_queue WHERE tenant_id = $1 AND status = 'open'`, [tenant])
    const openGaps = await counts(`SELECT count(*)::text AS count FROM gaps WHERE tenant_id = $1 AND status = 'open'`, [tenant])
    const askTraces = await query<TraceRow>(
      `SELECT * FROM traces WHERE tenant_id = $1 AND feature = 'ask' AND created_at >= now() - interval '7 days'`,
      [tenant],
    )
    const refused = askTraces.filter((trace) => trace.status === 'refused').length
    const spendRow = await queryOne<{ total: string }>(
      `SELECT coalesce(sum(amount), 0)::text AS total FROM usage_ledger WHERE tenant_id = $1`,
      [tenant],
    )
    const budget = await queryOne<{ limit_amount: number; alert_at: number }>(
      `SELECT limit_amount, alert_at FROM budgets WHERE tenant_id = $1 AND scope = 'tenant'`,
      [tenant],
    )
    const recentDocs = await query<{ id: string; title: string; source_type: string; updated_at: string }>(
      `SELECT id, title, source_type, updated_at FROM documents WHERE tenant_id = $1 AND status = 'active'
       ORDER BY updated_at DESC LIMIT 5`,
      [tenant],
    )
    const recentTraces = await query<TraceRow>(
      `SELECT * FROM traces WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 6`,
      [tenant],
    )
    const spend = Number(spendRow?.total ?? 0)
    return {
      documents,
      documents_trashed: trashed,
      chunks,
      entities,
      facts_active: activeFacts,
      facts_disputed: disputedFacts,
      reviews_open: openReviews,
      gaps_open: openGaps,
      asks_7d: askTraces.length,
      refusal_rate_7d: askTraces.length ? Number((refused / askTraces.length).toFixed(3)) : 0,
      spend_cny: Number(spend.toFixed(4)),
      budget: {
        limit: budget?.limit_amount ?? 0,
        used: Number(spend.toFixed(4)),
        alert_at: budget?.alert_at ?? 0.8,
      },
      recent_documents: recentDocs.map((document) => ({
        id: document.id,
        title: document.title,
        source_type: document.source_type,
        updated_at: document.updated_at,
      })),
      recent_traces: recentTraces.map((trace) => ({
        id: trace.id,
        feature: trace.feature,
        question: trace.question.slice(0, 80),
        status: trace.status,
        latency_ms: trace.latency_ms,
        created_at: trace.created_at,
      })),
    }
  })

  app.get('/traces', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const params = request.query as Record<string, string | undefined>
    const limit = Math.min(200, Math.max(1, Number(params.limit ?? 40)))
    const where = ['tenant_id = $1']
    const values: unknown[] = [principal.tenantId]
    if (params.feature) {
      values.push(params.feature)
      where.push(`feature = $${values.length}`)
    }
    if (params.status) {
      values.push(params.status)
      where.push(`status = $${values.length}`)
    }
    const traces = await query<TraceRow>(
      `SELECT * FROM traces WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`,
      values,
    )
    return {
      items: traces.map((trace) => ({
        id: trace.id,
        feature: trace.feature,
        question: trace.question.slice(0, 120),
        answer: trace.answer.slice(0, 180),
        status: trace.status,
        latency_ms: trace.latency_ms,
        user_id: trace.user_id,
        meta: trace.meta,
        created_at: trace.created_at,
      })),
    }
  })

  app.get('/traces/:trace_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { trace_id: traceId } = request.params as { trace_id: string }
    const trace = await queryOne<TraceRow>('SELECT * FROM traces WHERE id = $1', [traceId])
    if (!trace || trace.tenant_id !== principal.tenantId) throw Object.assign(new Error('轨迹不存在'), { statusCode: 404 })
    const spans = await query<{
      id: string
      stage: string
      params: Record<string, unknown>
      output: Record<string, unknown>
      latency_ms: number
      status: string
      occurred_at: string
    }>(
      `SELECT id, stage, params, output, latency_ms, status, occurred_at FROM trace_spans
       WHERE trace_id = $1 ORDER BY occurred_at`,
      [traceId],
    )
    const usage = await query<{
      model: string
      provider: string
      tokens_in: number
      tokens_out: number
      amount: number
      price_snapshot: Record<string, unknown>
    }>(
      `SELECT model, provider, tokens_in, tokens_out, amount, price_snapshot FROM usage_ledger WHERE trace_id = $1`,
      [traceId],
    )
    const replays = await query<{
      id: string
      target_stage: string
      overrides: Record<string, unknown>
      diff: Record<string, unknown>
      created_at: string
    }>(`SELECT id, target_stage, overrides, diff, created_at FROM replay_runs WHERE trace_id = $1`, [traceId])
    return {
      trace: {
        id: trace.id,
        feature: trace.feature,
        question: trace.question,
        answer: trace.answer,
        status: trace.status,
        latency_ms: trace.latency_ms,
        meta: trace.meta,
        created_at: trace.created_at,
      },
      spans,
      usage: usage.map((row) => ({
        model: row.model,
        provider: row.provider,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        amount: row.amount,
        price: row.price_snapshot,
      })),
      replays,
    }
  })

  app.post('/traces/:trace_id/replay', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const { trace_id: traceId } = request.params as { trace_id: string }
    const payload = request.body as { target_stage?: string; top_k?: number; as_of?: string }
    const trace = await queryOne<TraceRow>('SELECT * FROM traces WHERE id = $1', [traceId])
    if (!trace || trace.tenant_id !== principal.tenantId) throw Object.assign(new Error('轨迹不存在'), { statusCode: 404 })
    if ((payload.target_stage ?? 'retrieve') !== 'retrieve') {
      throw Object.assign(new Error('当前仅支持检索阶段回放'), { statusCode: 400 })
    }
    const previous = (trace.meta?.evidence_ids as string[]) ?? []
    const result = await retrieve(principal, trace.question, {
      topK: payload.top_k ?? 8,
      asOf: payload.as_of ?? null,
      mode: (trace.meta?.mode as string) ?? 'quick',
    })
    const current = result.hits.map((hit) => hit.chunk.id)
    const diff = {
      previous,
      current,
      added: current.filter((id) => !previous.includes(id)),
      removed: previous.filter((id) => !current.includes(id)),
      top_score: result.stats.top_score,
    }
    const replayId = newId('rep')
    await query(
      `INSERT INTO replay_runs (id, trace_id, tenant_id, target_stage, overrides, diff, status)
       VALUES ($1, $2, $3, 'retrieve', $4::jsonb, $5::jsonb, 'done')`,
      [replayId, trace.id, principal.tenantId, JSON.stringify(payload), JSON.stringify(diff)],
    )
    return { replay_id: replayId, diff, hits: result.hits.map((hit) => hit.toDict()), stats: result.stats }
  })

  app.get('/costs/summary', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const days = Math.min(365, Math.max(1, Number((request.query as { days?: string }).days ?? 30)))
    const rows = await query<{
      feature: string
      provider: string
      model: string
      tokens_in: number
      tokens_out: number
      amount: number
      occurred_at: string
    }>(
      `SELECT feature, provider, model, tokens_in, tokens_out, amount, occurred_at FROM usage_ledger
       WHERE tenant_id = $1 AND occurred_at >= now() - interval '${days} days'`,
      [principal.tenantId],
    )
    const byFeature = new Map<string, { amount: number; calls: number; tokens: number }>()
    const byDay = new Map<string, number>()
    const byModel = new Map<string, { amount: number; calls: number }>()
    for (const row of rows) {
      const feature = byFeature.get(row.feature) ?? { amount: 0, calls: 0, tokens: 0 }
      feature.amount += row.amount
      feature.calls += 1
      feature.tokens += row.tokens_in + row.tokens_out
      byFeature.set(row.feature, feature)
      const day = new Date(row.occurred_at).toISOString().slice(0, 10)
      byDay.set(day, (byDay.get(day) ?? 0) + row.amount)
      const model = byModel.get(`${row.provider}/${row.model}`) ?? { amount: 0, calls: 0 }
      model.amount += row.amount
      model.calls += 1
      byModel.set(`${row.provider}/${row.model}`, model)
    }
    return {
      days,
      total_amount: Number(rows.reduce((sum, row) => sum + row.amount, 0).toFixed(6)),
      total_tokens: rows.reduce((sum, row) => sum + row.tokens_in + row.tokens_out, 0),
      by_feature: Object.fromEntries(
        [...byFeature].map(([key, value]) => [key, { amount: Number(value.amount.toFixed(6)), calls: value.calls, tokens: value.tokens }]),
      ),
      by_day: [...byDay].sort().map(([date, amount]) => ({ date, amount: Number(amount.toFixed(6)) })),
      by_model: Object.fromEntries([...byModel].map(([key, value]) => [key, { amount: Number(value.amount.toFixed(6)), calls: value.calls }])),
    }
  })

  app.get('/prices', { preHandler: authenticate }, async () => {
    const prices = await query<{
      id: string
      provider: string
      model: string
      input_per_1m: number
      output_per_1m: number
      currency: string
      effective_from: string
      effective_to: string | null
    }>(
      `SELECT id, provider, model, input_per_1m, output_per_1m, currency, effective_from, effective_to
       FROM model_prices ORDER BY effective_from DESC`,
    )
    return {
      items: prices.map((price) => ({
        id: price.id,
        provider: price.provider,
        model: price.model,
        input_per_1m: price.input_per_1m,
        output_per_1m: price.output_per_1m,
        currency: price.currency,
        effective_from: price.effective_from,
        effective_to: price.effective_to,
      })),
      current_runtime: {
        model: settings.model,
        provider: settings.modelProvider,
        price: tokenPrice(settings.modelProvider, settings.model),
      },
    }
  })

  app.post('/prices', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    const payload = request.body as {
      provider: string
      model: string
      input_per_1m?: number
      output_per_1m?: number
      currency?: string
      effective_from?: string
    }
    const id = newId('price')
    await query(
      `INSERT INTO model_prices (id, provider, model, input_per_1m, output_per_1m, currency, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        payload.provider,
        payload.model,
        payload.input_per_1m ?? 0,
        payload.output_per_1m ?? 0,
        payload.currency ?? 'CNY',
        payload.effective_from || todayLocal(settings.timezone),
      ],
    )
    return { id, status: 'created' }
  })

  app.get('/harness/health', { preHandler: authenticate }, async () => harness.health())

  app.get('/evals/cases', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const cases = await query<{
      id: string
      question: string
      expected_docs: string[]
      expected_keywords: string[]
      should_refuse: boolean
      source: string
    }>(
      `SELECT id, question, expected_docs, expected_keywords, should_refuse, source FROM eval_cases WHERE tenant_id = $1`,
      [principal.tenantId],
    )
    return {
      total: cases.length,
      items: cases.map((item) => ({
        id: item.id,
        question: item.question,
        expected_docs: item.expected_docs,
        expected_keywords: item.expected_keywords,
        should_refuse: item.should_refuse,
        source: item.source,
      })),
    }
  })

  app.post('/evals/cases', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    const items = (request.body as { cases?: unknown })?.cases
    if (!Array.isArray(items) || items.length > 200) throw Object.assign(new Error('cases必须是最多200条的数组'), { statusCode: 400 })
    for (const item of items) {
      if (!item || typeof item.question !== 'string' || !item.question.trim() || typeof item.should_refuse !== 'boolean'
        || !Array.isArray(item.expected_docs) || !item.expected_docs.every((v: unknown) => typeof v === 'string')
        || !Array.isArray(item.expected_keywords) || !item.expected_keywords.every((v: unknown) => typeof v === 'string')) {
        throw Object.assign(new Error('评测用例字段无效'), { statusCode: 400 })
      }
    }
    for (const item of items as EvaluationCase[]) await query(
      `INSERT INTO eval_cases(id,tenant_id,question,expected_docs,expected_keywords,should_refuse,source)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,'imported')`,
      [newId('ec'), principal.tenantId, item.question.trim(), JSON.stringify(item.expected_docs), JSON.stringify(item.expected_keywords), item.should_refuse])
    return { imported: items.length }
  })

  app.post('/evals/cases/:case_id/approve', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    const rows = await query(`UPDATE eval_cases SET source='golden-reviewed' WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [(request.params as { case_id: string }).case_id,principal.tenantId])
    if (!rows.length) throw Object.assign(new Error('用例不存在'),{statusCode:404})
    return { status:'approved' }
  })

  app.patch('/evals/cases/:case_id', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    const item = request.body as EvaluationCase
    if (!item || !Array.isArray(item.expected_docs) || !item.expected_docs.every(value=>typeof value==='string')
      || !Array.isArray(item.expected_keywords) || !item.expected_keywords.every(value=>typeof value==='string') || typeof item.should_refuse!=='boolean') {
      throw Object.assign(new Error('预期文档、关键词和拒答标记格式无效'), {statusCode:400})
    }
    const rows=await query(`UPDATE eval_cases SET expected_docs=$1::jsonb,expected_keywords=$2::jsonb,should_refuse=$3
      WHERE id=$4 AND tenant_id=$5 RETURNING id`, [JSON.stringify(item.expected_docs),JSON.stringify(item.expected_keywords),item.should_refuse,(request.params as {case_id:string}).case_id,principal.tenantId])
    if(!rows.length)throw Object.assign(new Error('用例不存在'),{statusCode:404})
    return {status:'updated'}
  })

  app.get('/evals/failures', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    const items = await query<{ case_id: string; question: string; error: string }>(
      `SELECT c.id AS case_id,c.question,latest.error FROM eval_cases c JOIN (
         SELECT DISTINCT ON (item->>'case_id') item->>'case_id' AS case_id,item->>'error' AS error
         FROM eval_runs r CROSS JOIN LATERAL jsonb_array_elements(r.metrics->'results') item
         WHERE r.tenant_id=$1 AND r.metrics->>'mode'='answer' AND item ? 'case_id'
         ORDER BY item->>'case_id',r.created_at DESC,r.id DESC
       ) latest ON latest.case_id=c.id
       WHERE c.tenant_id=$1 AND latest.error IS NOT NULL AND c.source NOT LIKE 'failure-candidate:%'
       ORDER BY c.question,c.id`,
      [principal.tenantId],
    )
    return { items }
  })

  app.post('/evals/run', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    requireAdmin(principal)
    const body = request.body as { mode?: string; case_ids?: unknown } | undefined
    const ids = body?.case_ids
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id))) {
      throw Object.assign(new Error('case_ids 必须为非空评测用例 ID 列表'), { statusCode: 400 })
    }
    const cases = await query<{
      id: string
      question: string
      expected_docs: string[]
      expected_keywords: string[]
      should_refuse: boolean
    }>(
      `SELECT id, question, expected_docs, expected_keywords, should_refuse FROM eval_cases
       WHERE tenant_id = $1 AND source NOT LIKE 'failure-candidate:%' AND ($2::text[] IS NULL OR id=ANY($2::text[]))`,
      [principal.tenantId, ids ?? null],
    )
    if (!cases.length) throw Object.assign(new Error('尚无评测用例，请先导入黄金集'), { statusCode: 422 })
    const mode = body?.mode ?? 'answer'
    if (!['answer','retrieval'].includes(mode)) throw Object.assign(new Error('评测mode必须为answer或retrieval'), { statusCode: 400 })
    return runEvaluation(principal, cases, mode as 'answer' | 'retrieval')
  })
}
