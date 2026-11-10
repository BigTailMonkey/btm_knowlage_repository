/** 限流与瞬时故障可重试；4xx 参数类错误重试无意义。 */
export const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504])

/** 单次重试失败后留给调用方的线索：是否可重试、服务端要求的等待时间。 */
export interface RetryHint {
  retryable?: boolean
  retryAfterMs?: number
}

export interface BackoffPolicy {
  /** 第 1 次重试的等待时间 */
  baseMs: number
  /** 单次等待封顶 */
  maxMs: number
  /** 首次之外最多重试几次（0 表示不重试） */
  maxRetries: number
  /** 开启后等待取 50%~100% 随机，并发请求不会同时重试 */
  jitter: boolean
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError'
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 退避间隔：把 maxRetries 次重试的间隔在「baseMs → maxMs」之间按等比均匀铺开，
 * 第 1 次重试等 baseMs，最后一次等 maxMs，中间等比递增。服务给出 Retry-After 时取两者较大值，仍受 maxMs 封顶。
 */
export function backoffDelayMs(retry: number, policy: BackoffPolicy, retryAfterMs?: number): number {
  const base = Math.max(1, policy.baseMs)
  const cap = Math.max(base, policy.maxMs)
  const total = Math.max(1, Math.trunc(policy.maxRetries))
  const step = total <= 1 ? 0 : Math.min(1, (Math.max(1, retry) - 1) / (total - 1))
  let delay = Math.round(base * (cap / base) ** step)
  if (retryAfterMs !== undefined) delay = Math.max(delay, retryAfterMs)
  delay = Math.min(cap, delay)
  if (policy.jitter) delay = Math.round(delay * (0.5 + Math.random() * 0.5))
  return delay
}

/**
 * 把限流相关响应头压成一行，供 429/503 时写进任务错误，区分撞的是速率、令牌还是并发。
 * 只挑名字像限流的头，未知服务商的自定义头也能带上。
 */
export function rateLimitHint(headers: Headers, limit = 3): string {
  const parts: string[] = []
  headers.forEach((value, name) => {
    if (parts.length >= limit || !/rate.?limit|retry-after/i.test(name)) return
    parts.push(`${name.replace(/^x-/i, '').toLowerCase()}=${value.trim().slice(0, 40)}`)
  })
  return parts.join('；')
}

/** 截取失败响应体，去掉换行并在 limit 字处截断；读不出来就返回空串。 */
export async function responseSnippet(response: Response, limit = 120): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  } catch {
    return ''
  }
}

/**
 * 拼一条可落库的失败描述：状态码 + 响应体摘要 + 限流头。
 * 整体控制在 270 字内，因为任务错误在上游会按 300 字截断，不能被截掉尾巴。
 */
export async function describeHttpFailure(response: Response, label = '模型接口'): Promise<string> {
  const snippet = await responseSnippet(response)
  const hint = rateLimitHint(response.headers)
  return `${label}返回 HTTP ${response.status}${snippet ? `：${snippet}` : ''}${hint ? `（${hint}）` : ''}`
}

export interface RetryHooks {
  /** 重试耗尽后给错误消息补一句尝试次数 */
  note?: (message: string, attempts: number) => string
  /** 每次即将重试前调用，便于把 429 的现场写进日志 */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void
}

/**
 * 按退避策略执行 run：抛出的错误带 retryable=true，或不带该标记但属于超时/网络故障时重试。
 * 重试耗尽后原样抛出，并在尝试过多次时于消息尾部标注总尝试次数。
 */
export async function retryWithBackoff<T>(
  policy: BackoffPolicy,
  run: (attempt: number) => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  const note = hooks.note ?? ((message: string, attempts: number) => `${message}（含首次共尝试 ${attempts} 次）`)
  const maxAttempts = Math.max(1, Math.trunc(policy.maxRetries)) + 1
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      const hint = (error ?? {}) as RetryHint
      const retryable = typeof hint.retryable === 'boolean' ? hint.retryable : isTransientFetchError(error)
      if (retryable && attempt < maxAttempts) {
        const delayMs = backoffDelayMs(attempt, policy, hint.retryAfterMs)
        hooks.onRetry?.({ attempt, maxAttempts, delayMs, error })
        await sleep(delayMs)
        continue
      }
      if (error instanceof Error && attempt > 1) error.message = note(error.message, attempt)
      throw error
    }
  }
}