import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

import { settings } from '../../config.js'

export interface HarnessResult {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  model: string
  provider: string
  error: string | null
  ok: boolean
}

export interface LlmHarness {
  complete(prompt: string, system?: string, maxTokens?: number): Promise<HarnessResult>
  stream(prompt: string, system?: string): AsyncGenerator<string>
  health(): Promise<Record<string, unknown>>
  ask(sessionId: string, prompt: string, system?: string): Promise<HarnessResult>
  close(): Promise<void>
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function failure(error: unknown, model: string, provider: string, started: number): HarnessResult {
  return {
    text: '',
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: Date.now() - started,
    model,
    provider,
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  }
}

/**
 * 完整智能体运行时：TypeScript SDK + `sdk` profile，第三方说明见项目声明文件。
 * SDK 托管完整 runtime（会话持久化、工具、Plan/Goal、权限审批、插件），
 * 一次启动后复用，不再按请求拉起 headless 一次性进程。
 */
export class DshHarness {
  readonly provider = settings.modelProvider
  readonly model = settings.model
  private harness: DeepSeekHarness | null = null
  private starting: Promise<DeepSeekHarness> | null = null
  lastError: string | null = null

  private async instance(): Promise<DeepSeekHarness> {
    if (this.harness) return this.harness
    if (!this.starting) {
      mkdirSync(settings.dshHome, { recursive: true })
      mkdirSync(settings.dshRuntimeCwd, { recursive: true })
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DSH_HOME: settings.dshHome,
        DEEPSEEK_BASE_URL: settings.modelBaseUrl,
        ...(settings.modelApiKey ? { DEEPSEEK_API_KEY: settings.modelApiKey } : {}),
      }
      const harness = new DeepSeekHarness({
        dshHome: settings.dshHome,
        profile: settings.dshProfile,
        cwd: settings.dshRuntimeCwd,
        provider: 'deepseek-official',
        model: this.model,
        maxTokens: settings.modelMaxTokens,
        env,
        initializeTimeoutMs: 30_000,
        requestTimeoutMs: 300_000,
        onUserQuestion: async () => ({ cancelled: true }),
      })
      this.starting = harness.start().then(() => {
        this.harness = harness
        return harness
      }).catch((error) => {
        this.starting = null
        throw error
      })
    }
    return this.starting
  }

  available(): boolean {
    return settings.harnessEnabled
  }

  async ask(sessionId: string, prompt: string, system?: string): Promise<HarnessResult> {
    const started = Date.now()
    if (!this.available()) {
      this.lastError = 'DSH 未启用'
      return failure(new Error(this.lastError), this.model, this.provider, started)
    }
    try {
      const harness = await this.instance()
      const input = system ? `${system.trim()}\n\n${prompt}` : prompt
      const result = await harness.run(input, { sessionId })
      this.lastError = null
      const text = result.finalResponse.trim()
      if (!text) {
        return failure(
          new Error(`DSH 返回空响应（finishReason=${result.finishReason ?? 'none'}）`),
          this.model,
          this.provider,
          started,
        )
      }
      return {
        text,
        tokensIn: estimateTokens(input),
        tokensOut: estimateTokens(text),
        latencyMs: Date.now() - started,
        model: this.model,
        provider: this.provider,
        error: null,
        ok: true,
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return failure(error, this.model, this.provider, started)
    }
  }

  async complete(prompt: string, system?: string, _maxTokens?: number): Promise<HarnessResult> {
    // Extraction and verification are stateless calls; do not inherit earlier answers.
    return this.ask(`completion-${randomUUID()}`, prompt, system)
  }

  async *stream(prompt: string, system?: string): AsyncGenerator<string> {
    const result = await this.complete(prompt, system)
    if (result.ok) yield result.text
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      adapter: 'deepseek-harness-sdk',
      enabled: settings.harnessEnabled,
      available: this.available(),
      started: this.harness !== null,
      profile: settings.dshProfile,
      dshHome: settings.dshHome,
      workspace: settings.dshRuntimeCwd,
      provider: this.provider,
      model: this.model,
      mode: 'sdk/sdk-profile',
      lastError: this.lastError,
    }
  }

  async close(): Promise<void> {
    if (this.harness) {
      await this.harness.close()
      this.harness = null
      this.starting = null
    }
  }
}

/** 兼容 OpenAI 协议的直连兜底，仅在 DSH 不可用时使用。 */
class DirectApiHarness {
  readonly provider = 'deepseek-official'
  readonly model = settings.fallbackModel

  available(): boolean {
    return Boolean(settings.modelApiKey)
  }

  async complete(prompt: string, system?: string, maxTokens = 2048): Promise<HarnessResult> {
    const started = Date.now()
    const messages: Array<{ role: string; content: string }> = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })
    try {
      const response = await fetch(`${settings.modelBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.modelApiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = payload.choices[0]?.message.content ?? ''
      return {
        text,
        tokensIn: payload.usage?.prompt_tokens ?? estimateTokens(prompt),
        tokensOut: payload.usage?.completion_tokens ?? estimateTokens(text),
        latencyMs: Date.now() - started,
        model: this.model,
        provider: this.provider,
        error: null,
        ok: Boolean(text.trim()),
      }
    } catch (error) {
      return failure(error, this.model, this.provider, started)
    }
  }

  async ask(_sessionId: string, prompt: string, system?: string): Promise<HarnessResult> {
    return this.complete(prompt, system)
  }

  async *stream(prompt: string, system?: string): AsyncGenerator<string> {
    const result = await this.complete(prompt, system)
    if (result.ok) yield result.text
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      adapter: 'deepseek-api',
      enabled: true,
      available: this.available(),
      model: this.model,
      mode: 'http',
    }
  }

  async close(): Promise<void> {}
}

class CompositeHarness implements LlmHarness {
  private dsh = new DshHarness()
  private api = new DirectApiHarness()
  lastUsed = 'none'

  private async run(
    sessionId: string,
    prompt: string,
    system?: string,
    maxTokens?: number,
  ): Promise<HarnessResult> {
    const errors: string[] = []
    if (this.dsh.available()) {
      const result = await this.dsh.ask(sessionId, prompt, system)
      if (result.ok) {
        this.lastUsed = result.provider
        return result
      }
      errors.push(result.error ?? 'unknown')
    }
    if (this.api.available()) {
      const result = await this.api.complete(prompt, system, maxTokens)
      if (result.ok) {
        this.lastUsed = result.provider
        return result
      }
      errors.push(result.error ?? 'unknown')
    }
    this.lastUsed = 'none'
    return {
      text: '',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      model: settings.model,
      provider: 'none',
      error: errors.join('; ') || '没有可用的模型适配器',
      ok: false,
    }
  }

  async ask(sessionId: string, prompt: string, system?: string): Promise<HarnessResult> {
    return this.run(sessionId, prompt, system)
  }

  async complete(prompt: string, system?: string, maxTokens?: number): Promise<HarnessResult> {
    return this.run(`default-${settings.defaultTenantId}`, prompt, system, maxTokens)
  }

  async askForSession(sessionId: string, prompt: string, system?: string): Promise<HarnessResult> {
    return this.run(sessionId, prompt, system)
  }

  async *stream(prompt: string, system?: string): AsyncGenerator<string> {
    const result = await this.complete(prompt, system)
    if (result.ok) yield result.text
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      adapter: 'composite',
      lastUsed: this.lastUsed,
      primary: await this.dsh.health(),
      fallback: await this.api.health(),
    }
  }

  async close(): Promise<void> {
    await this.dsh.close()
  }
}

export const harness = new CompositeHarness()
