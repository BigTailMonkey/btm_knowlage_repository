import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backoffDelayMs, createEmbedder } from '../src/adapters/embeddings/index.js'
import { settings } from '../src/config.js'

const KEYS = [
  'embeddingBaseUrl', 'embeddingApiKey', 'embeddingDim',
  'embeddingRetryMaxRetries', 'embeddingRetryBaseMs', 'embeddingRetryMaxMs', 'embeddingRetryJitter',
] as const

async function withSettings<T>(overrides: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(KEYS.map(key => [key, settings[key]]))
  Object.assign(settings, { embeddingBaseUrl: 'http://embedding-fixture', embeddingApiKey: '', embeddingDim: 2 }, overrides)
  try {
    return await run()
  } finally {
    Object.assign(settings, previous)
  }
}

test('429 触发退避重试，成功后返回向量', async () => {
  await withSettings({ embeddingRetryMaxRetries: 3, embeddingRetryBaseMs: 1, embeddingRetryMaxMs: 5 }, async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    try {
      globalThis.fetch = async () => {
        calls += 1
        if (calls === 1) return new Response('rate limited', { status: 429 })
        return Response.json({ data: [{ index: 0, embedding: [0.25, 0.75] }] })
      }
      const embedding = await createEmbedder('openai').embed('alpha')
      assert.equal(calls, 2)
      assert.deepEqual(embedding.dense, [0.25, 0.75])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('重试次数用尽后抛出原始状态并标注尝试次数', async () => {
  await withSettings({ embeddingRetryMaxRetries: 2, embeddingRetryBaseMs: 1, embeddingRetryMaxMs: 5 }, async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    try {
      globalThis.fetch = async () => {
        calls += 1
        return new Response('too many requests', { status: 429 })
      }
      await assert.rejects(createEmbedder('openai').embed('alpha'), /429.*尝试 3 次/)
      assert.equal(calls, 3, '首次 1 次 + 重试 2 次')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('4xx 参数错误不重试', async () => {
  await withSettings({ embeddingRetryMaxRetries: 10, embeddingRetryBaseMs: 1, embeddingRetryMaxMs: 5 }, async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    try {
      globalThis.fetch = async () => {
        calls += 1
        return new Response('invalid model', { status: 400 })
      }
      await assert.rejects(createEmbedder('openai').embed('alpha'), (error: Error) => {
        assert.match(error.message, /400/)
        assert.doesNotMatch(error.message, /尝试/)
        return true
      })
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('Retry-After 优先于退避间隔', async () => {
  await withSettings({ embeddingRetryMaxRetries: 1, embeddingRetryBaseMs: 1, embeddingRetryMaxMs: 1000 }, async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    try {
      globalThis.fetch = async () => {
        calls += 1
        if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.2' } })
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
      }
      const started = Date.now()
      const embedding = await createEmbedder('openai').embed('alpha')
      assert.deepEqual(embedding.dense, [1, 0])
      assert.ok(Date.now() - started >= 180, '应等待服务给出的 Retry-After')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('默认策略：10 次重试，间隔从 5s 等比铺开到 180s', async () => {
  await withSettings({ embeddingRetryMaxRetries: 10, embeddingRetryBaseMs: 5000, embeddingRetryMaxMs: 180_000, embeddingRetryJitter: false }, async () => {
    const delays = Array.from({ length: 10 }, (_, retry) => backoffDelayMs(retry + 1))
    assert.equal(delays[0], 5000, '首次重试等 5s')
    assert.equal(delays[9], 180_000, '最后一次重试等 3 分钟')
    for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i]! > delays[i - 1]!, '间隔应逐次递增')
    assert.ok(delays.every(delay => delay <= 180_000), '不得突破 3 分钟封顶')
    const ratio = (180_000 / 5000) ** (1 / 9)
    for (let i = 1; i < delays.length; i += 1) {
      const actual = delays[i]! / delays[i - 1]!
      assert.ok(Math.abs(actual - ratio) / ratio < 0.01, `第 ${i + 1} 次间隔增长倍数应约为 ${ratio.toFixed(3)}，实际 ${actual.toFixed(3)}`)
    }
    const total = delays.reduce((sum, delay) => sum + delay, 0)
    assert.ok(total > 480_000 && total < 600_000, `累计等待应约 9 分钟，实际 ${Math.round(total / 1000)}s`)
  })
})

test('Retry-After 与等比间隔取较大值，且受 3 分钟封顶', async () => {
  await withSettings({ embeddingRetryMaxRetries: 10, embeddingRetryBaseMs: 5000, embeddingRetryMaxMs: 180_000, embeddingRetryJitter: false }, async () => {
    assert.equal(backoffDelayMs(1, 30_000), 30_000, 'Retry-After 大于退避值时听服务端')
    assert.equal(backoffDelayMs(10, 10_000), 180_000, 'Retry-After 小于退避值时仍按退避')
    assert.equal(backoffDelayMs(10, 10 * 60_000), 180_000, 'Retry-After 超长时被封顶截断')
  })
  assert.equal(settings.embeddingRetryMaxRetries, 10, 'config.toml 的 retry_max_retries 应为 10')
  assert.equal(settings.embeddingRetryBaseMs, 5000)
  assert.equal(settings.embeddingRetryMaxMs, 180_000)
})
