import { createHash } from 'node:crypto'

import { settings } from '../config.js'
import { query } from '../db/index.js'
import { newId } from './ids.js'
import type { HarnessResult } from '../adapters/harness/index.js'

interface Span {
  id: string
  stage: string
  inputHash: string | null
  params: Record<string, unknown>
  output: Record<string, unknown>
  latencyMs: number
  status: string
  occurredAt: Date
}

interface Usage {
  id: string
  spanId: string | null
  feature: string
  stage: string
  provider: string
  model: string
  tokensIn: number
  tokensOut: number
  priceSnapshot: Record<string, unknown>
  amount: number
  occurredAt: Date
}

export class TraceRecorder {
  readonly traceId = newId('tr')
  private started = Date.now()
  private spans: Span[] = []
  private usage: Usage[] = []
  meta: Record<string, unknown> = {}

  constructor(
    private tenantId: string,
    private userId: string,
    private feature: string,
    private question = '',
  ) {}

  get latencyMs(): number {
    return Date.now() - this.started
  }

  addSpan(options: {
    stage: string
    params?: Record<string, unknown>
    output?: Record<string, unknown>
    latencyMs?: number
    status?: string
    inputValue?: string
  }): Span {
    const span: Span = {
      id: newId('sp'),
      stage: options.stage,
      inputHash: options.inputValue
        ? createHash('sha256').update(options.inputValue).digest('hex').slice(0, 32)
        : null,
      params: options.params ?? {},
      output: options.output ?? {},
      latencyMs: options.latencyMs ?? 0,
      status: options.status ?? 'ok',
      occurredAt: new Date(),
    }
    this.spans.push(span)
    return span
  }

  recordUsage(result: HarnessResult, feature: string, stage: string, spanId: string | null = null): void {
    const [priceIn, priceOut, currency] = settings.prices[result.model] ?? [0, 0, 'CNY']
    const amount = (result.tokensIn * priceIn + result.tokensOut * priceOut) / 1_000_000
    this.usage.push({
      id: newId('use'),
      spanId,
      feature,
      stage,
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      priceSnapshot: { input_per_1m: priceIn, output_per_1m: priceOut, currency },
      amount: Number(amount.toFixed(8)),
      occurredAt: new Date(),
    })
  }

  get hasUsage(): boolean {
    return this.usage.length > 0
  }

  get usageAmount(): number {
    return this.usage.reduce((sum, row) => sum + row.amount, 0)
  }

  async finish(answer = '', status = 'ok'): Promise<void> {
    await query(
      `INSERT INTO traces (id, tenant_id, user_id, feature, question, answer, status, latency_ms, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        this.traceId,
        this.tenantId,
        this.userId,
        this.feature,
        this.question,
        answer,
        status,
        this.latencyMs,
        JSON.stringify(this.meta),
        new Date(),
      ],
    )
    for (const span of this.spans) {
      await query(
        `INSERT INTO trace_spans (id, trace_id, input_hash, stage, params, output, latency_ms, status, occurred_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
        [
          span.id,
          this.traceId,
          span.inputHash,
          span.stage,
          JSON.stringify(span.params),
          JSON.stringify(span.output),
          span.latencyMs,
          span.status,
          span.occurredAt,
        ],
      )
    }
    for (const row of this.usage) {
      await query(
        `INSERT INTO usage_ledger
           (id, trace_id, span_id, tenant_id, user_id, feature, stage, provider, model,
            tokens_in, tokens_out, cached_tokens, price_snapshot, amount, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12::jsonb, $13, $14)`,
        [
          row.id,
          this.traceId,
          row.spanId,
          this.tenantId,
          this.userId,
          row.feature,
          row.stage,
          row.provider,
          row.model,
          row.tokensIn,
          row.tokensOut,
          JSON.stringify(row.priceSnapshot),
          row.amount,
          row.occurredAt,
        ],
      )
    }
  }
}

export function tokenPrice(provider: string, model: string): [number, number, string] {
  return settings.prices[model] ?? [0, 0, 'CNY']
}
