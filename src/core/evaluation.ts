import { ask } from './answering.js'
import { retrieve } from './retrieval.js'
import type { Principal } from './security.js'
import { query, queryOne } from '../db/index.js'
import { newId } from './ids.js'
import { settings } from '../config.js'

export interface EvaluationCase { id: string; question: string; expected_docs: string[]; expected_keywords: string[]; should_refuse: boolean }

export async function runEvaluation(principal: Principal, cases: EvaluationCase[], mode: 'answer' | 'retrieval' = 'answer', onProgress?: (completed: number, total: number) => void) {
  const results = []
  const latencies: number[] = []
  let recall = 0, precision = 0, refusal = 0, citationsCorrect = 0, citationsTotal = 0, coverage = 0
  for (const item of cases) {
    const started = Date.now()
    let output
    let retrieved
    try {
      output = mode === 'answer' ? await ask(principal, { question: item.question, evaluation: true, topK: 10 }) : null
      retrieved = output ? null : await retrieve(principal, item.question, { topK: 10 })
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
      const elapsed = Date.now() - started
      latencies.push(elapsed)
      results.push({
        case_id: item.id, question: item.question, expected_docs: item.expected_docs,
        matched_docs: [], matched_keywords: [], error, refused: false, strategy: null,
        model_called: mode === 'answer', model_succeeded: false, doc_recall: 0, context_precision: null,
        citation_accuracy: null, rule_groundedness: null, latency_ms: elapsed, top_score: 0, pass: false,
      })
      onProgress?.(results.length, cases.length)
      continue
    }
    const evidence = output ? output.evidence as Array<{ doc_id: string; doc_title: string; text: string; chunk_id: string }> : retrieved!.hits.map((hit) => ({ doc_id: hit.document.id, doc_title: hit.document.title, text: hit.chunk.text, chunk_id: hit.chunk.id }))
    const matched = item.expected_docs.filter((expected) => evidence.some((hit) => hit.doc_id === expected || hit.doc_title.includes(expected)))
    const relevant = evidence.filter((hit) => item.expected_docs.some((expected) => hit.doc_id === expected || hit.doc_title.includes(expected)))
    const docRecall = item.expected_docs.length ? matched.length / item.expected_docs.length : item.should_refuse ? Number(!evidence.length) : 1
    const contextPrecision = item.expected_docs.length ? relevant.length / Math.max(1, evidence.length) : item.should_refuse ? Number(!evidence.length) : null
    const answer = output ? String(output.answer) : evidence.map((hit) => hit.text).join('\n')
    const matchedKeywords = item.expected_keywords.filter((word) => answer.includes(word))
    const refused = output ? Boolean(output.refused) : !evidence.length || Number(retrieved!.stats.top_score ?? 0) < settings.rerankThreshold
    const citationRows = output?.citations as Array<{ chunk_id: string; quote: string }> | undefined ?? []
    let correct = 0
    for (const citation of citationRows) {
      const chunk = await queryOne<{ text: string }>('SELECT text FROM chunks WHERE id=$1', [citation.chunk_id])
      if (chunk?.text.includes(citation.quote)) correct += 1
    }
    const grounded = Number((output?.grounding as { citation_coverage?: number } | undefined)?.citation_coverage ?? 0)
    const strategy = (output?.grounding as { strategy?: string } | undefined)?.strategy ?? null
    const generation = output?.trace_id ? await queryOne<{ output: { ok?: boolean } }>(
      "SELECT output FROM trace_spans WHERE trace_id=$1 AND stage='answer.generate' ORDER BY occurred_at LIMIT 1", [output.trace_id]) : null
    const elapsed = Date.now() - started
    latencies.push(elapsed); recall += docRecall; precision += contextPrecision ?? 0; refusal += Number(refused === item.should_refuse)
    citationsCorrect += correct; citationsTotal += citationRows.length; coverage += refused ? 0 : grounded
    results.push({ case_id: item.id, error: null, question: item.question, expected_docs: item.expected_docs, matched_docs: matched,
      matched_keywords: matchedKeywords, answer: output?.answer, refused, strategy, model_called: !!generation, model_succeeded: generation?.output.ok === true, doc_recall: docRecall, context_precision: contextPrecision,
      citation_accuracy: citationRows.length ? correct / citationRows.length : null, rule_groundedness: mode === 'answer' ? grounded : null,
      latency_ms: elapsed, trace_id: output?.trace_id, top_score: Number((output?.stats as Record<string,unknown> | undefined)?.top_score ?? retrieved?.stats.top_score ?? 0),
      pass: (item.should_refuse || matched.length === item.expected_docs.length) && matchedKeywords.length === item.expected_keywords.length
        && refused === item.should_refuse && (mode !== 'answer' || refused || grounded === 1 && citationRows.length > 0 && correct === citationRows.length) })
    onProgress?.(results.length,cases.length)
  }
  latencies.sort((a, b) => a - b)
  const n = Math.max(1, cases.length)
  const metrics = { cases: cases.length, mode, recall_at_10: recall / n, doc_recall: recall / n,
    context_precision: precision / Math.max(1, results.filter((row) => row.context_precision !== null).length),
    citation_accuracy: citationsTotal ? citationsCorrect / citationsTotal : null,
    rule_groundedness: mode === 'answer' ? coverage / Math.max(1, results.filter((row) => !row.error && !row.refused).length) : null, refusal_accuracy: refusal / n,
    keyword_recall: results.filter((row, index) => !row.error && row.matched_keywords.length === cases[index]!.expected_keywords.length).length / n,
    pass_rate: results.filter((row) => row.pass).length / n, p95_latency_ms: latencies[Math.max(0, Math.ceil(cases.length * 0.95) - 1)] ?? 0,
    model_calls: results.filter(row=>row.model_called).length, model_successes: results.filter(row=>row.model_succeeded).length,
    generated_answers: results.filter(row=>!row.refused && row.strategy==='generated').length,
    failed_cases: results.filter(row=>row.error).length,
    refusals: results.filter(row=>row.refused).length }
  const id = newId('er')
  await query('INSERT INTO eval_runs(id,tenant_id,metrics,model_version) VALUES($1,$2,$3::jsonb,$4)', [id, principal.tenantId, JSON.stringify({ ...metrics, results }), settings.model])
  return { run_id: id, metrics, results }
}
