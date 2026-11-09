import { settings } from '../../config.js'

export interface HarnessResult {
  text: string
  tokensIn: number
  tokensOut: number
  model: string
  provider: string
  error: string | null
  ok: boolean
  latencyMs: number
}

interface CompletionOptions {
  structured?: boolean
}

export interface LlmHarness {
  complete(prompt: string, system?: string, options?: CompletionOptions): Promise<HarnessResult>
  stream(prompt: string, system?: string): AsyncGenerator<string>
  streamChat(prompt: string, system?: string): AsyncGenerator<HarnessChunk>
  health(): Promise<Record<string, unknown>>
  ask(sessionId: string, prompt: string, system?: string): Promise<HarnessResult>
  close(): Promise<void>
}

/** 流式增量：reasoning 是模型思考过程，text 是正文。 */
export interface HarnessChunk {
  reasoning?: string
  text?: string
}

export function modelUnavailable(operation: string, reason: string): Error {
  const model = settings.model ? `（${settings.model}）` : ''
  return Object.assign(new Error(`${operation}失败${model}：${reason}`), { statusCode: 503 })
}

export function requireModelText(result: HarnessResult, operation: string): string {
  if (!result.ok || !result.text.trim()) {
    throw modelUnavailable(operation, result.error || '模型返回空响应')
  }
  return result.text.trim()
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

class ConfiguredModel implements LlmHarness {
  private lastError: string | null = null
  private lastUsed = 'none'

  private available(): boolean {
    return Boolean(settings.model && settings.modelBaseUrl && settings.modelApiKey)
  }

  async complete(prompt: string, system?: string, options?: CompletionOptions): Promise<HarnessResult> {
    const started = Date.now()
    const { model, modelProvider: provider, modelBaseUrl, modelApiKey, modelMaxTokens } = settings
    try {
      if (!this.available()) throw new Error('请配置 [model] 的 model、base_url 和 api_key')
      const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ]
      // On Ark, DeepSeek V4.1 Flash counts thinking and the answer against the
      // same budget. Reserve it for JSON on bounded extraction/validation calls.
      const disableThinking = options?.structured && provider === 'volcengine-ark'
        && /^deepseek-v4[.-]1-flash(?:-|$)/i.test(model)
      const response = await fetch(`${modelBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${modelApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: modelMaxTokens,
          temperature: 0.1,
          ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`)
      const payload = (await response.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
      }
      const choice = payload.choices?.[0]
      const text = choice?.message?.content ?? ''
      if (choice?.finish_reason === 'length' && (options?.structured || !text.trim())) {
        const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens
        const reasoningOnly = !text.trim() && (choice.message?.reasoning_content?.trim() || (reasoningTokens ?? 0) > 0)
        const limit = modelMaxTokens === undefined ? '服务端输出上限' : `${modelMaxTokens} token 输出上限`
        throw new Error(reasoningOnly
          ? `模型推理达到${limit}，未生成正文`
          : `模型达到${limit}，结果被截断`)
      }
      if (!text.trim()) throw new Error('模型返回空响应')
      this.lastError = null
      this.lastUsed = provider
      return {
        text,
        tokensIn: payload.usage?.prompt_tokens ?? estimateTokens(messages.map((message) => message.content).join('\n')),
        tokensOut: payload.usage?.completion_tokens ?? estimateTokens(text),
        latencyMs: Date.now() - started,
        model, provider, error: null, ok: true,
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.lastUsed = 'none'
      return {
        text: '', tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started,
        model, provider, error: this.lastError, ok: false,
      }
    }
  }

  async ask(_sessionId: string, prompt: string, system?: string): Promise<HarnessResult> {
    // The caller supplies conversation history with the current evidence.
    return this.complete(prompt, system)
  }

  async *stream(prompt: string, system?: string): AsyncGenerator<string> {
    yield requireModelText(await this.complete(prompt, system), '模型生成')
  }

  async *streamChat(prompt: string, system?: string): AsyncGenerator<HarnessChunk> {
    const { model, modelProvider: provider, modelBaseUrl, modelApiKey, modelMaxTokens } = settings
    if (!this.available()) throw new Error('请配置 [model] 的 model、base_url 和 api_key')
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ]
    const response = await fetch(`${modelBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${modelApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: modelMaxTokens,
        temperature: 0.1,
        stream: true,
      }),
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    })
    if (!response.ok || !response.body) {
      this.lastError = `模型接口返回 HTTP ${response.status}`
      this.lastUsed = 'none'
      throw new Error(this.lastError)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            if (raw && raw !== '[DONE]') {
              try {
                const payload = JSON.parse(raw) as {
                  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }>
                }
                const delta = payload.choices?.[0]?.delta
                const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? ''
                if (reasoning) yield { reasoning }
                if (delta?.content) {
                  answer += delta.content
                  yield { text: delta.content }
                }
              } catch {
                // 心跳或非 JSON 行直接跳过
              }
            }
          }
          index = buffer.indexOf('\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
    this.lastError = null
    this.lastUsed = provider
    if (!answer.trim()) throw new Error('模型返回空响应')
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      adapter: 'openai-compatible',
      available: this.available() && this.lastError === null,
      model: settings.model,
      provider: settings.modelProvider,
      mode: 'http',
      lastUsed: this.lastUsed,
      lastError: this.lastError,
    }
  }

  async close(): Promise<void> {}
}

export const harness = new ConfiguredModel()

export function completeStructured(prompt: string, system: string): Promise<HarnessResult> {
  return harness.complete(prompt, system, { structured: true })
}

export async function assertModelReady(): Promise<void> {
  const result = await harness.complete('Reply with OK.')
  requireModelText(result, '启动前模型检查')
}
