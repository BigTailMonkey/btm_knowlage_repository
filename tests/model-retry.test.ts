import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeStructured, harness } from '../src/adapters/harness/index.js'
import { settings } from '../src/config.js'

const KEYS = [
  'model', 'modelBaseUrl', 'modelApiKey', 'modelMaxTokens',
  'modelRetryMaxRetries', 'modelRetryBaseMs', 'modelRetryMaxMs', 'modelRetryJitter',
] as const

async function withModel<T>(overrides: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(KEYS.map(key => [key, settings[key]]))
  Object.assign(settings, {
    model: 'retry-test-model', modelBaseUrl: 'http://model-fixture/v3', modelApiKey: 'retry-test-key',
    modelMaxTokens: undefined, modelRetryJitter: false,
  }, overrides)
  try {
    return await run()
  } finally {
    Object.assign(settings, previous)
  }
}

function stubFetch(t: { mock: { method: Function } }, handler: () => Promise<Response> | Response): { count: () => number } {
  const stub = t.mock.method(globalThis, 'fetch', async () => handler())
  return { count: () => stub.mock.callCount() }
}

test('429 触发退避重试，成功后返回正文', async (t) => {
  await withModel({ modelRetryMaxRetries: 3, modelRetryBaseMs: 1, modelRetryMaxMs: 5 }, async () => {
    let calls = 0
    const request = stubFetch(t, () => {
      calls += 1
      if (calls < 3) return new Response('rate limited', { status: 429 })
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '[]' } }] })
    })
    const result = await completeStructured('extract', 'return JSON')
    assert.equal(result.ok, true)
    assert.equal(result.text, '[]')
    assert.equal(request.count(), 3, '两次 429 后第三次成功')
  })
})

test('重试耗尽后保留原始状态并标注尝试次数', async (t) => {
  await withModel({ modelRetryMaxRetries: 2, modelRetryBaseMs: 1, modelRetryMaxMs: 5 }, async () => {
    const request = stubFetch(t, () => new Response('too many requests', { status: 429 }))
    const result = await harness.complete('extract')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /模型接口返回 HTTP 429：too many requests（含首次共尝试 3 次）/)
    assert.equal(request.count(), 3, '首次 1 次 + 重试 2 次')
  })
})

test('401 等参数类错误不重试', async (t) => {
  await withModel({ modelRetryMaxRetries: 5, modelRetryBaseMs: 1, modelRetryMaxMs: 5 }, async () => {
    const request = stubFetch(t, () => new Response(null, { status: 401 }))
    const result = await harness.complete('extract')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /HTTP 401$/)
    assert.doesNotMatch(result.error ?? '', /尝试/)
    assert.equal(request.count(), 1)
  })
})

test('5xx 与网络故障按退避重试', async (t) => {
  await withModel({ modelRetryMaxRetries: 4, modelRetryBaseMs: 1, modelRetryMaxMs: 5 }, async () => {
    let calls = 0
    const request = stubFetch(t, () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      if (calls === 2) return new Response('bad gateway', { status: 502 })
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] })
    })
    const result = await harness.complete('answer')
    assert.equal(result.ok, true)
    assert.equal(result.text, 'OK')
    assert.equal(request.count(), 3)
  })
})

test('Retry-After 优先于退避间隔', async (t) => {
  await withModel({ modelRetryMaxRetries: 2, modelRetryBaseMs: 1, modelRetryMaxMs: 1000 }, async () => {
    let calls = 0
    stubFetch(t, () => {
      calls += 1
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.2' } })
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] })
    })
    const started = Date.now()
    const result = await harness.complete('answer')
    assert.equal(result.ok, true)
    assert.ok(Date.now() - started >= 180, '应等待服务给出的 Retry-After')
  })
})

test('流式对话在首个 token 之前同样重试 429', async (t) => {
  await withModel({ modelRetryMaxRetries: 2, modelRetryBaseMs: 1, modelRetryMaxMs: 5 }, async () => {
    let calls = 0
    stubFetch(t, () => {
      calls += 1
      if (calls === 1) return new Response('rate limited', { status: 429 })
      return new Response('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    let answer = ''
    for await (const chunk of harness.streamChat('question')) answer += chunk.text ?? ''
    assert.equal(answer, '你好')
    assert.equal(calls, 2)
  })
})

test('429 的响应体与限流头写进错误，重试时打到日志', async (t) => {
  await withModel({ modelRetryMaxRetries: 1, modelRetryBaseMs: 1, modelRetryMaxMs: 5 }, async () => {
    const warn = t.mock.method(console, 'warn', () => undefined)
    const request = stubFetch(t, () => new Response(
      '{"error":{"code":"RateLimitExceeded","message":"TPM limit exceeded for model"}}',
      { status: 429, headers: { 'retry-after': '7', 'x-ratelimit-limit-tokens': '60000', 'x-ratelimit-remaining-tokens': '0' } },
    ))
    const result = await harness.complete('extract')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /HTTP 429/)
    assert.match(result.error ?? '', /TPM limit exceeded/, '响应体要留下来才能判断撞的是哪种限额')
    assert.match(result.error ?? '', /retry-after=7/)
    assert.match(result.error ?? '', /ratelimit-remaining-tokens=0/)
    assert.match(result.error ?? '', /含首次共尝试 2 次/)
    assert.equal(request.count(), 2)
    assert.equal(warn.mock.callCount(), 1, '每次重试都要在日志里留一行')
    assert.match(String((warn.mock.calls[0]!.arguments[0])), /\[model\] 第 1\/1 次重试前等待 0s：模型接口返回 HTTP 429：.*TPM limit exceeded/)
    assert.ok(String(result.error).length <= 300, '错误会被任务表按 300 字截断，不能超过')
  })
})

test('默认策略：4 次重试，间隔从 2s 等比铺开到 30s', () => {
  assert.equal(settings.modelRetryMaxRetries, 4)
  assert.equal(settings.modelRetryBaseMs, 2_000)
  assert.equal(settings.modelRetryMaxMs, 30_000)
  assert.equal(settings.modelRetryJitter, false)
})