import { settings } from '../../config.js'

const CJK = /[\u3400-\u9fff\uf900-\ufaff]+/g
const WORD = /[A-Za-z][A-Za-z0-9_-]+|\d+(?:\.\d+)?/g
const STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '是', '在', '对', '也', '就', '都', '而', '被',
  '把', '让', '从', '到', '这', '那', '有', '为', '以', '等', '或', '并', '一个',
  '我们', '你们', '他们', '什么', '如何', '怎么', '为什么',
])

export interface Embedding {
  dense: number[]
  sparse: Record<string, number>
  model: string
  dim: number
}

export class EmbeddingError extends Error {}

export function tokenize(text: string): string[] {
  const source = (text ?? '').toLowerCase()
  const tokens: string[] = []
  for (const run of source.match(CJK) ?? []) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) tokens.push(run)
      continue
    }
    for (const ch of run) if (!STOPWORDS.has(ch)) tokens.push(ch)
    for (let i = 0; i < run.length - 1; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) tokens.push(gram)
    }
  }
  for (const word of source.match(WORD) ?? []) {
    if (word.length > 1 && !STOPWORDS.has(word)) tokens.push(word)
  }
  return tokens
}

export function sparseVector(tokens: string[], limit = 96): Record<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return Object.fromEntries(
    [...counts.entries()]
      .map(([token, count]) => [token, Number((1 + Math.log(count)).toFixed(4))] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  )
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    normA += x * x
    normB += y * y
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function sparseDot(a: Record<string, number>, b: Record<string, number>): number {
  if (!a || !b) return 0
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a]
  let sum = 0
  for (const [token, value] of Object.entries(small)) sum += value * (large[token] ?? 0)
  return sum
}

export function keywordOverlap(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0
  const query = new Set(queryTokens)
  const document = new Set(tokenize(text))
  if (!query.size) return 0
  let hit = 0
  for (const token of query) if (document.has(token)) hit += 1
  return hit / query.size
}

interface RetryHint {
  retryable?: boolean
  retryAfterMs?: number
}

function fail(message: string, hint: RetryHint = {}): EmbeddingError {
  return Object.assign(new EmbeddingError(message), hint)
}

/** 限流与瞬时故障可重试；4xx 参数类错误重试无意义。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError'
}

/**
 * 退避间隔：把 retry_max_retries 次重试的间隔在「retry_base_ms → retry_max_ms」之间按等比均匀铺开，
 * 第 1 次重试等 base（默认 5s），最后一次等 max（默认 3 分钟），中间等比递增。
 * 服务给出 Retry-After 时取两者较大值，仍受 max 封顶。
 */
export function backoffDelayMs(retry: number, retryAfterMs?: number): number {
  const base = Math.max(1, settings.embeddingRetryBaseMs)
  const cap = Math.max(base, settings.embeddingRetryMaxMs)
  const total = Math.max(1, Math.trunc(settings.embeddingRetryMaxRetries))
  const step = total <= 1 ? 0 : Math.min(1, (Math.max(1, retry) - 1) / (total - 1))
  let delay = Math.round(base * (cap / base) ** step)
  if (retryAfterMs !== undefined) delay = Math.max(delay, retryAfterMs)
  delay = Math.min(cap, delay)
  if (settings.embeddingRetryJitter) delay = Math.round(delay * (0.5 + Math.random() * 0.5))
  return delay
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postOnce(url: string, payload: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.embeddingApiKey) headers.authorization = `Bearer ${settings.embeddingApiKey}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(settings.embeddingTimeoutSeconds * 1000),
    })
  } catch (error) {
    throw fail(
      `向量服务不可用: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: isTransientFetchError(error) },
    )
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw fail(`向量服务返回 ${response.status}: ${detail}`, {
      retryable: RETRYABLE_STATUS.has(response.status),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    })
  }
  try {
    return (await response.json()) as Record<string, unknown>
  } catch (error) {
    throw fail(`向量服务响应不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function postJson(url: string, payload: unknown): Promise<Record<string, unknown>> {
  const maxAttempts = Math.max(1, Math.trunc(settings.embeddingRetryMaxRetries)) + 1
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postOnce(url, payload)
    } catch (error) {
      const hint = error as RetryHint
      const exhausted = attempt >= maxAttempts
      if (error instanceof EmbeddingError && hint.retryable && !exhausted) {
        await sleep(backoffDelayMs(attempt, hint.retryAfterMs))
        continue
      }
      if (error instanceof EmbeddingError && attempt > 1) {
        error.message = `${error.message}（含首次共尝试 ${attempt} 次）`
      }
      throw error instanceof EmbeddingError
        ? error
        : fail(`向量服务不可用: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

interface Embedder {
  model: string
  dim: number
  embed(text: string): Promise<Embedding>
  embedMany(texts: string[]): Promise<Embedding[]>
  embedQuery(text: string): Promise<Embedding>
}

export function createEmbedder(kind: 'ark' | 'openai' | 'hybrid'): Embedder {
  let dim = settings.embeddingDim
  const url = `${settings.embeddingBaseUrl.replace(/\/$/, '')}${settings.embeddingPath}`

  async function request(text: string): Promise<number[]> {
    if (!settings.embeddingBaseUrl) throw new EmbeddingError('未配置 embedding.base_url，无法调用向量服务')
    if (!settings.embeddingModel) throw new EmbeddingError('未配置 embedding.model')
    const payload: Record<string, unknown> = {
      model: settings.embeddingModel,
      encoding_format: 'float',
      input: kind === 'ark' ? [{ type: 'text', text }] : [text],
    }
    if (kind === 'ark') {
      if (dim) payload.dimensions = dim
      if (settings.embeddingInstructions) payload.instructions = settings.embeddingInstructions
    }
    const body = await postJson(url, payload)
    const data = kind === 'ark'
      ? (Array.isArray(body.data) ? (body.data as unknown[])[0] : body.data)
      : (body.data as unknown[] | undefined)
    const vector = kind === 'ark'
      ? (data as { embedding?: number[] } | undefined)?.embedding
      : (Array.isArray(data) ? (data[0] as { embedding?: number[] })?.embedding : undefined)
    if (!Array.isArray(vector) || !vector.length) {
      throw new EmbeddingError(`向量服务未返回 vectors: ${JSON.stringify(body).slice(0, 200)}`)
    }
    return vector.map(Number)
  }

  async function embedMany(texts: string[]): Promise<Embedding[]> {
    if (!texts.length) return []
    const vectors: number[][] = []
    const learnedSparse: Record<string,number>[] = []
    if (kind === 'ark') {
      for (const text of texts) vectors.push(await request(text))
    } else {
      const size = Math.max(1, settings.embeddingBatchSize)
      for (let start = 0; start < texts.length; start += size) {
        const batch = texts.slice(start, start + size)
        const body = await postJson(url, {
          model: settings.embeddingModel,
          input: batch,
          encoding_format: 'float',
        })
        const data = body.data as Array<{ index?: number; embedding?: number[]; sparse_embedding?: Record<string,number> }> | undefined
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new EmbeddingError(`请求 ${batch.length} 条，返回 ${data?.length ?? 0} 条`)
        }
        // Service order is not guaranteed; index must cover the whole batch once.
        const ordered=data.slice().sort((a,b)=>(a.index ?? 0)-(b.index ?? 0))
        if (ordered.some((item,index)=>item.index !== undefined && item.index !== index)) throw new EmbeddingError('向量服务返回重复或缺失索引')
        vectors.push(...ordered.map((item) => (item.embedding ?? []).map(Number)))
        if (kind === 'hybrid') {
          for (const item of ordered) {
            if (!item.sparse_embedding || Object.values(item.sparse_embedding).some(x=>!Number.isFinite(x)||x<0)) throw new EmbeddingError('混合向量服务缺少合法 learned sparse')
            learnedSparse.push(item.sparse_embedding)
          }
        }
      }
    }
    const width = vectors[0]!.length
    if (!width || vectors.some(vector=>vector.length!==width || vector.some(x=>!Number.isFinite(x)))) throw new EmbeddingError('向量服务返回空值、非有限数值或不一致维度')
    if (dim && width !== dim) throw new EmbeddingError(`向量维度不一致：embedding.dim=${dim}，模型返回 ${width}`)
    dim = width
    return texts.map((text, index) => ({
      dense: vectors[index]!,
      sparse: kind === 'hybrid' ? learnedSparse[index]! : sparseVector(tokenize(text)),
      model: settings.embeddingModel,
      dim: vectors[index]!.length,
    }))
  }

  return {
    get model() {
      return settings.embeddingModel
    },
    get dim() {
      return dim
    },
    embed: async (text) => (await embedMany([text]))[0]!,
    embedMany,
    embedQuery: async (text) => (await embedMany([text]))[0]!,
  }
}

export const embedder =
  createEmbedder(settings.embeddingProvider.trim().toLowerCase() === 'hybrid' ? 'hybrid' : settings.embeddingProvider.trim().toLowerCase() === 'openai' ? 'openai' : 'ark')
