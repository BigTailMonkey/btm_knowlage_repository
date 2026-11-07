import { settings } from '../config.js'
import { query, queryOne } from '../db/index.js'
import { tokenize } from '../adapters/embeddings/index.js'
import { harness } from '../adapters/harness/index.js'
import { newId } from './ids.js'
import type { ChunkRow, DocumentRow, EntityRow } from './rows.js'
import { retrieve, RetrievalResult, Hit, normalizeAsOf } from './retrieval.js'
import { Principal } from './security.js'
import { TraceRecorder } from './tracing.js'
import { validateGrounding, verifySemanticGrounding, type GroundingCheck } from './grounding.js'

const CITATION = /\[(\d+)\]/g
const REFUSAL_PREFIX = /^(?:REFUSE\b|(?:抱歉[，,。]?\s*)?(?:(?:现有|当前|所提供的?|已有)?(?:资料|信息|证据|片段|内容)(?:不足|不够|未包含|没有)|我(?:无法|不能)|无法(?:可靠|准确)?回答|没有足够(?:资料|证据|信息)|不足以回答))/i
const FOLLOW_UP = /(它|他|她|这|那|该|此|其|上面|刚才|之前|上述|前面|还有|继续|再|那么)/

export const ANSWER_SYSTEM = `你是 KnoWeave（知织）知识库的问答引擎。规则：
1. 只能使用给定的「证据」回答，不得使用训练知识补全，不得编造。
2. 每个事实性句子末尾用 [编号] 标注引用，编号必须是证据编号；一句话可引用多条。
3. 若证据不足以支撑结论，只输出一行：REFUSE: <缺失原因>。
4. 回答使用中文，先给结论，再给 2-4 句关键依据；不要复述整段原文。
5. 区分「资料明确支持」与「推测」；推测必须标注「（推测）」。
6. 涉及时间时按事实有效期判断，不要混用已经失效的旧结论。
7. 多轮对话中的历史消息仅用于理解指代，不得作为证据；引用编号只对应本轮证据。`

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  mode: string
  created_at: string
}

interface MemoryRow {
  id: string
  text: string
}

interface ConversationRow {
  id: string
  tenant_id: string
  user_id: string
  title: string
}

function formatEvidence(hits: Hit[], facts: Array<Record<string, unknown>>, memories: MemoryRow[], summaries: Array<{ text: string }> = []): string {
  const blocks: string[] = []
  hits.forEach((hit, index) => {
    const heading = hit.chunk.heading_path?.join(' / ') || '正文'
    const page = hit.chunk.page ? `第 ${hit.chunk.page} 页 | ` : ''
    blocks.push(
      `[${index + 1}] 《${hit.document.title}》 | ${page}章节：${heading}\n${hit.chunk.text}\n${hit.parentText && hit.parentText !== hit.chunk.text ? `补充上下文：${hit.parentText.slice(0, 1600)}` : ''}`,
    )
  })
  if (facts.length) {
    blocks.push('\n图谱事实（来自事实层，需与证据交叉验证）：')
    for (const fact of facts.slice(0, 12)) {
      const from = fact.valid_from as string | null
      const to = fact.valid_to as string | null
      const period = from || to ? `（有效期 ${from ?? '?'} → ${to ?? '至今'}）` : ''
      blocks.push(
        `- ${fact.subject} ${fact.predicate} ${fact.object ?? ''}${period}，状态 ${fact.status}，置信度 ${Number(fact.confidence).toFixed(2)}`,
      )
    }
  }
  if (memories.length) {
    blocks.push('\n用户记忆（仅用于理解偏好，不作为事实引用）：')
    for (const memory of memories.slice(0, 5)) blocks.push(`- ${memory.text}`)
  }
  if (summaries.length) blocks.push(`主题摘要（只作导航，回答仍须引用上方原文编号）：\n${summaries.map((row) => row.text.slice(0, 2000)).join('\n\n')}`)
  return blocks.join('\n\n')
}

async function memoryContext(principal: Principal, question: string): Promise<MemoryRow[]> {
  const rows = await query<MemoryRow>(
    `SELECT id, text FROM memory_items WHERE tenant_id = $1 AND user_id = $2
       AND (expires_at IS NULL OR expires_at > now())`,
    [principal.tenantId, principal.userId],
  )
  const queryTokens = new Set(tokenize(question))
  return rows
    .filter((memory) => {
      const tokens = new Set(tokenize(memory.text))
      if (!tokens.size) return false
      let hit = 0
      for (const token of tokens) if (queryTokens.has(token)) hit += 1
      return hit >= Math.max(1, Math.min(3, Math.floor(tokens.size / 3)))
    })
    .slice(0, 5)
}

async function conversationHistory(conversation: ConversationRow | null): Promise<MessageRow[]> {
  if (!conversation) return []
  const rows = await query<MessageRow>(
    `SELECT id, conversation_id, role, content, mode, created_at FROM messages
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [conversation.id],
  )
  return rows.reverse()
}

function historyContext(messages: MessageRow[]): string {
  const lines = ['对话历史（仅用于理解指代，不作为证据）：']
  for (const message of messages) {
    const role = message.role === 'user' ? '用户' : '助手'
    lines.push(`${role}：${message.content.replace(/\s+/g, ' ').slice(0, 500)}`)
  }
  return lines.join('\n')
}

function retrievalQuestion(question: string, messages: MessageRow[]): string {
  const previous = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  if (previous && (question.length <= 12 || FOLLOW_UP.test(question))) return `${previous} ${question}`
  return question
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function extractiveAnswer(question: string, hits: Hit[], mode: string): string {
  const queryTokens = new Set(tokenize(question))
  const quoted = [...question.matchAll(/`([^`\n]{1,100})`/g)].map(match=>match[1]!.toLowerCase())
  const selected: string[] = []
  const candidates = hits.map((hit,index)=>{
    const scored = splitSentences(hit.chunk.text).map((sentence) => {
      let overlap = 0
      for (const token of new Set(tokenize(sentence))) if (queryTokens.has(token)) overlap += 1
      for (const literal of quoted) if (sentence.toLowerCase().includes(literal)) overlap += 20
      return [overlap, sentence] as const
    })
    scored.sort((a, b) => b[0] - a[0])
    return {hit,index,scored}
  }).sort((a,b)=>(b.scored[0]?.[0] ?? 0)-(a.scored[0]?.[0] ?? 0))
  for (const { hit,index,scored } of candidates.slice(0,4)) {
    for (const [overlap, sentence] of scored.slice(0, 2)) {
      if (sentence.length < 8) continue
      if (overlap === 0 && selected.length) continue
      const excerpt = sentence.replace(/\[(\d+)\]/g, '［$1］')
      selected.push(mode === 'compare'
        ? `| ${hit.document.title.replace(/\|/g, '／')} | ${excerpt.replace(/\|/g, '／')} [${index + 1}] |`
        : `- ${excerpt} [${index + 1}]`)
    }
    if (selected.length >= 5) break
  }
  return selected.length
    ? mode === 'compare' ? `| 来源 | 原文依据 |\n| --- | --- |\n${selected.join('\n')}` : `根据现有资料：\n${selected.join('\n')}`
    : ''
}

function refusal(hits: Hit[]): string {
  if (!hits.length) return '现有资料不足以回答这个问题：知识库中没有检索到相关证据。建议先补充相关文档或调整关键词。'
  const clues = hits.slice(0, 3).map((hit) => `《${hit.document.title}》`).join('；')
  return `现有资料不足以可靠地回答这个问题。最接近的线索是：${clues}。这些片段没有形成一致的证据链，因此不做推测性回答。`
}

function confidence(answer: string, hits: Hit[], refused: boolean): number {
  if (refused || !hits.length) return 0.18
  const cited = [...answer.matchAll(CITATION)].map((match) => Number(match[1]))
  const valid = new Set(cited.filter((index) => index >= 1 && index <= hits.length))
  const coverage = cited.length ? valid.size / cited.length : 0
  const top = hits.slice(0, 3).reduce((sum, hit) => sum + hit.rerank, 0) / Math.min(3, hits.length)
  let base = 0.28 + 0.45 * top + 0.2 * coverage + 0.07 * Math.min(1, valid.size / 3)
  if (!cited.length) base -= 0.08
  return Number(Math.max(0.05, Math.min(0.96, base)).toFixed(3))
}

async function upsertGap(principal: Principal, question: string): Promise<void> {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ')
  const existing = await queryOne<{ id: string; count: number }>(
    'SELECT id, count FROM gaps WHERE tenant_id = $1 AND question = $2 AND status = $3',
    [principal.tenantId, normalized, 'open'],
  )
  if (existing) {
    await query('UPDATE gaps SET count = count + 1, updated_at = now() WHERE id = $1', [existing.id])
  } else {
    await query(
      `INSERT INTO gaps (id, tenant_id, question, count, suggested_sources)
       VALUES ($1, $2, $3, 1, $4::jsonb)`,
      [
        newId('gap'),
        principal.tenantId,
        normalized,
        JSON.stringify(['补充与该问题直接相关的原始文档', '检查是否缺少定义或时效信息']),
      ],
    )
  }
}

function subqueries(question: string, mode: string): string[] {
  if (!['deep', 'compare'].includes(mode)) return [question]
  const parts = question
    .split(mode === 'compare' ? /[；;？?、]|以及|并且|\bvs\b|对比|比较|与|和/ : /[；;？?]|以及|并且/)
    .map((part) => part.trim())
    .map((part) => part.replace(/(?:有什么)?(?:区别|不同|优缺点)[？?]?$/, '').trim())
    .filter((part) => part.length >= 2)
  return [...new Set([question, ...parts])].slice(0, 4)
}

async function reflectQueries(question: string, hits: Hit[], tried: Set<string>, recorder: TraceRecorder, round: number): Promise<string[]> {
  const prompt = `将知识库问题改写成最多3条用于补充证据的检索语句。不要回答问题，不要重复已检索内容。只返回JSON：{"queries":["..."]}。\n问题：${question}\n已检索：${JSON.stringify([...tried])}\n已有线索：${hits.slice(0, 3).map((hit) => `${hit.document.title}: ${hit.chunk.text.slice(0, 200)}`).join('\n')}`
  let queries: string[] = []
  try {
    const result = await harness.complete(prompt, '你是知识库检索规划器，只改写查询，不生成事实。', 600)
    const json = /\{[\s\S]*\}/.exec(result.text)?.[0]
    const parsed = json ? JSON.parse(json) as { queries?: unknown } : null
    if (Array.isArray(parsed?.queries)) queries = parsed.queries.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter((value) => value.length >= 2 && value.length <= 300)
  } catch { /* A missing planning model must not prevent source-based answers. */ }
  if (!queries.length) {
    const terms = [...new Set(tokenize(question).filter((token) => token.length >= 2))].slice(0, 10)
    if (terms.length) queries.push(terms.join(' '))
  }
  queries = [...new Set(queries)].filter((value) => !tried.has(value)).slice(0, 3)
  recorder.addSpan({ stage: 'retrieve.reflect', params: { round }, output: { queries }, inputValue: prompt })
  return queries
}

interface Citation {
  index: number
  chunk_id: string
  doc_id: string
  doc_title: string
  version_id: string
  page: number | null
  heading_path: string[]
  quote: string
  rerank: number
}

export async function ask(
  principal: Principal,
  input: {
    question: string
    mode?: string
    topK?: number
    asOf?: string | null
    conversationId?: string | null
    docIds?: string[] | null
    evaluation?: boolean
  },
): Promise<Record<string, unknown>> {
  const started = Date.now()
  const question = (input.question ?? '').trim()
  if (!question) throw Object.assign(new Error('问题不能为空'), { statusCode: 400 })
  const mode = input.mode ?? 'quick'
  if (!['quick', 'deep', 'graph', 'timeline', 'compare'].includes(mode)) throw Object.assign(new Error('不支持的问答模式'), { statusCode: 400 })
  const topK = Math.min(30, Math.max(1, Math.floor(Number(input.topK) || 6)))
  const asOf = normalizeAsOf(input.asOf ?? null)
  const recorder = new TraceRecorder(principal.tenantId, principal.userId, input.evaluation ? 'eval' : 'ask', question)
  recorder.addSpan({ stage: 'intent', params: { mode, as_of: asOf }, output: { question } })

  const conversation = input.conversationId
    ? await queryOne<ConversationRow>('SELECT id, tenant_id, user_id, title FROM conversations WHERE id = $1', [input.conversationId])
    : null
  if (conversation && (conversation.tenant_id !== principal.tenantId || conversation.user_id !== principal.userId)) {
    throw Object.assign(new Error('会话不存在'), { statusCode: 400 })
  }
  const history = await conversationHistory(conversation)
  const expandedQuestion = retrievalQuestion(question, history)
  recorder.addSpan({ stage: 'context.history', output: { messages: history.length, retrieval_question: expandedQuestion } })

  const memoryText = input.evaluation ? undefined : /^(?:(?:请)?(?:帮我)?(?:记住|记一下|记下)(?:这个|以下内容)?[：:，,\s]*|(?:纠正一下|更正一下|我的偏好)[：:]\s*)([\s\S]+)$/.exec(question)?.[1]?.trim()
  const queries = memoryText ? [] : subqueries(expandedQuestion, mode)
  const results: RetrievalResult[] = []
  const merged = new Map<string, Hit>()
  const facts: Array<Record<string, unknown>> = []
  const tried = new Set<string>()
  let threshold = settings.rerankThreshold
  if (['deep', 'compare'].includes(mode)) threshold *= 0.85
  let pendingQueries = queries
  let rounds = 0
  while (pendingQueries.length && rounds < (mode === 'deep' ? 3 : 1)) {
    rounds += 1
    pendingQueries.forEach((value) => tried.add(value))
    const batch = await Promise.all(pendingQueries.map((subquery) => retrieve(principal, subquery, {
      topK: ['deep', 'compare'].includes(mode) ? topK * 3 : topK,
      asOf,
      recorder,
      mode,
      docIds: input.docIds ?? null,
    })))
    for (const result of batch) {
    results.push(result)
    for (const hit of result.hits) {
      const existing = merged.get(hit.chunk.id)
      if (!existing || hit.rerank > existing.rerank) merged.set(hit.chunk.id, hit)
    }
    for (const fact of result.facts) {
      if (!facts.some((item) => item.fact_id === fact.fact_id)) facts.push(fact)
    }
    }
    if (mode !== 'deep' || rounds >= 3 || [...merged.values()].some((hit) => hit.rerank >= threshold)) break
    pendingQueries = await reflectQueries(expandedQuestion, [...merged.values()], tried, recorder, rounds)
  }

  const hits = [...merged.values()].sort((a, b) => b.rerank - a.rerank).slice(0, topK)
  const memories = input.evaluation ? [] : await memoryContext(principal, question)
  const topScore = hits[0]?.rerank ?? 0
  let refused = !hits.length || topScore < threshold
  let answer: string
  let citations: Citation[] = []
  let grounding: GroundingCheck = { valid: false, coverage: 0, sentences: 0, supported: 0, quotes: {}, reason: null }
  let answerStrategy = 'generated'

  if (memoryText) {
    const existing = await queryOne<{ id: string }>('SELECT id FROM memory_items WHERE tenant_id = $1 AND user_id = $2 AND text = $3 AND (expires_at IS NULL OR expires_at > now())', [principal.tenantId, principal.userId, memoryText])
    if (!existing) await query(`INSERT INTO memory_items (id, tenant_id, user_id, scope, kind, text, confidence) VALUES ($1, $2, $3, 'personal', 'conversation_note', $4, 0.7)`, [newId('mem'), principal.tenantId, principal.userId, memoryText])
    answer = '已记入个人记忆，可在记忆页查看与删除。'
    refused = false
    answerStrategy = 'memory'
  } else if (refused) {
    answer = refusal(hits)
  } else {
    const evidence = formatEvidence(hits, facts, memories, results.flatMap((result) => result.summaries ?? []))
    const historyBlock = history.length ? `${historyContext(history)}\n\n` : ''
    const prompt = `${historyBlock}证据：
${evidence}

问题：${question}
回答模式：${mode}${asOf ? `；时间切片：${asOf}` : ''}

请严格按规则回答。${mode === 'compare' ? '请使用Markdown对比表格，每一行附证据引用；不要编造缺失的对比项。' : ''}`
    const generated = await harness.ask(
      conversation?.id ?? newId('ask'),
      prompt,
      ANSWER_SYSTEM,
    )
    const span = recorder.addSpan({
      stage: 'answer.generate',
      params: { model: generated.model, provider: generated.provider, mode },
      output: {
        ok: generated.ok,
        error: generated.error,
        tokens_out: generated.tokensOut,
        text_preview: generated.text.slice(0, 400),
      },
      latencyMs: generated.latencyMs,
      status: generated.ok ? 'ok' : 'degraded',
      inputValue: prompt,
    })
    if (generated.ok) recorder.recordUsage(generated, 'ask', 'answer.generate', span.id)

    const text = generated.ok ? generated.text.trim() : ''
    const isRefusal = REFUSAL_PREFIX.test(text)
    if (isRefusal) {
      answer = refusal(hits)
      refused = true
    } else {
      grounding = validateGrounding(text, hits.map((hit) => ({ text: hit.chunk.text })))
      if (grounding.valid && settings.groundingVerifier) {
        const supported = await verifySemanticGrounding(text, hits.map((hit) => ({ text: hit.chunk.text })))
        recorder.addSpan({ stage: 'answer.verify', output: { supported }, inputValue: text })
        if (!supported) grounding = { ...grounding, valid: false, reason: '独立语义校验未确认全部事实句' }
      }
      answer = text
      if (!grounding.valid || (mode === 'compare' && !/^\s*\|.+\|\s*\n\s*\|[-\s|:]+\|/m.test(answer))) {
        answerStrategy = 'extractive_fallback'
        answer = extractiveAnswer(expandedQuestion, hits, mode)
        grounding = validateGrounding(answer, hits.map((hit) => ({ text: hit.chunk.text })))
      }
      if (!grounding.valid) {
        answer = refusal(hits)
        refused = true
      }
      const indices = new Set(
        [...answer.matchAll(CITATION)].map((match) => Number(match[1])).filter((index) => index >= 1 && index <= hits.length),
      )
      citations = refused ? [] : [...indices].sort((a, b) => a - b).map((index) => toCitation(index, hits[index - 1]!, grounding.quotes[index]))
    }
  }

  const score = memoryText ? 1 : confidence(answer, hits, refused)
  if (refused && !input.evaluation) await upsertGap(principal, question)

  let activeConversation = conversation
  const assistantId = newId('msg')
  if (!input.evaluation) {
  if (!activeConversation) {
    const id = newId('conv')
    await query(
      'INSERT INTO conversations (id, tenant_id, user_id, title) VALUES ($1, $2, $3, $4)',
      [id, principal.tenantId, principal.userId, question.slice(0, 80)],
    )
    activeConversation = { id, tenant_id: principal.tenantId, user_id: principal.userId, title: question.slice(0, 80) }
  }

  await query(
    `INSERT INTO messages (id, conversation_id, role, content, mode, latency_ms, trace_id, confidence)
     VALUES ($1, $2, 'user', $3, $4, 0, $5, 0)`,
    [newId('msg'), activeConversation.id, question, mode, recorder.traceId],
  )
  await query(
    `INSERT INTO messages (id, conversation_id, role, content, mode, latency_ms, trace_id, confidence)
     VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7)`,
    [assistantId, activeConversation.id, answer, mode, recorder.latencyMs, recorder.traceId, score],
  )
  for (const citation of citations) {
    await query('UPDATE fact_evidence SET last_used_at=now() WHERE chunk_id=$1', [citation.chunk_id])
    await query(
      `INSERT INTO citations (id, message_id, chunk_id, doc_id, quote, page, rank)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId('cit'), assistantId, citation.chunk_id, citation.doc_id, citation.quote, citation.page, citation.index],
    )
  }
  // Older documents imported under the deferred policy can still be enriched on use.
  for (const docId of new Set(citations.map(citation => citation.doc_id))) {
    const { shouldEnrich } = await import('./source-policy.js')
    const state = await queryOne<{ enrichment_status: string }>('SELECT enrichment_status FROM documents WHERE id=$1', [docId])
    if (state?.enrichment_status === 'deferred' && await shouldEnrich(docId)) {
      const { extractFactsForDocument } = await import('./learning.js')
      void extractFactsForDocument(principal,docId).catch(() => undefined)
    }
  }

  }

  recorder.meta = {
    mode,
    top_score: topScore,
    threshold,
    refused,
    evidence_count: hits.length,
    evidence_ids: hits.map((hit) => hit.chunk.id),
    retrieval: results.map((result) => result.stats),
    confidence: score,
    citations: citations.length,
    retrieval_rounds: rounds,
    answer_strategy: answerStrategy,
  }
  await recorder.finish(answer, refused ? 'refused' : 'ok')
  if (!input.evaluation && (refused || answerStrategy === 'extractive_fallback')) {
    const existingCase = await queryOne<{ id: string }>('SELECT id FROM eval_cases WHERE tenant_id=$1 AND question=$2 LIMIT 1', [principal.tenantId, question])
    if (!existingCase) await query(`INSERT INTO eval_cases(id,tenant_id,question,expected_docs,expected_keywords,should_refuse,source)
      VALUES($1,$2,$3,$4::jsonb,'[]'::jsonb,$5,$6)`, [newId('ec'), principal.tenantId, question, JSON.stringify([...new Set(hits.map(hit=>hit.document.title))]), refused, `failure-candidate:${recorder.traceId}`])
  }
  if (recorder.hasUsage) {
    await query(
      `UPDATE budgets SET used_amount = used_amount + $1, updated_at = now()
       WHERE tenant_id = $2 AND scope = 'tenant'`,
      [recorder.usageAmount, principal.tenantId],
    )
  }

  return {
    answer,
    refused,
    confidence: score,
    citations,
    evidence: hits.map((hit) => hit.toDict()),
    facts: facts.slice(0, 8),
    entities: [
      ...new Map(
        results
          .flatMap((result) => result.entities)
          .map((entity) => [entity.id, { id: entity.id, name: entity.canonical_name, type: entity.type }]),
      ).values(),
    ].slice(0, 6),
    conversation_id: activeConversation?.id ?? null,
    message_id: input.evaluation ? null : assistantId,
    trace_id: recorder.traceId,
    latency_ms: Date.now() - started,
    mode,
    as_of: asOf,
    stats: {
      top_score: Number(topScore.toFixed(4)),
      threshold: Number(threshold.toFixed(4)),
      evidence_count: hits.length,
      rejected_candidates: results.reduce((sum, result) => sum + result.rejectedCandidates, 0),
      subqueries: [...tried],
      retrieval_rounds: rounds,
    },
    grounding: {
      citation_coverage: grounding.coverage,
      sentences: grounding.sentences,
      supported_sentences: grounding.supported,
      strategy: answerStrategy,
      note: answerStrategy === 'extractive_fallback' ? '生成回答未通过证据核对，已返回带引用的原文摘录。' : '逐句核对引用编号、数字与文字证据。',
    },
  }
}

function toCitation(index: number, hit: Hit, quote?: string): Citation {
  return {
    index,
    chunk_id: hit.chunk.id,
    doc_id: hit.document.id,
    doc_title: hit.document.title,
    version_id: hit.chunk.version_id,
    page: hit.chunk.page,
    heading_path: hit.chunk.heading_path,
    quote: quote || hit.chunk.text,
    rerank: hit.rerank,
  }
}
