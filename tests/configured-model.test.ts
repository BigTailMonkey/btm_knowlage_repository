import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertModelReady, completeStructured, harness } from '../src/adapters/harness/index.js'
import { settings } from '../src/config.js'

test('generation and extraction both use the configured route, with no alternate request after 401', async (t) => {
  Object.assign(settings, {
    model: 'configured-model',
    modelProvider: 'configured-provider',
    modelBaseUrl: 'https://configured.example/custom/v3/',
    modelApiKey: 'configured-test-key',
    modelMaxTokens: 1000,
  })
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://configured.example/custom/v3/chat/completions')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer configured-test-key')
    const body = JSON.parse(String(init.body))
    assert.equal(body.model, 'configured-model')
    if (body.messages.at(-1).content === 'authentication failure') return new Response(null, { status: 401 })
    return Response.json({ choices: [{ message: { content: String(body.max_tokens) } }] })
  })
  const answer = await harness.ask('conversation', 'answer')
  assert.equal(answer.text, '1000')
  assert.equal(answer.provider, 'configured-provider')
  assert.equal((await completeStructured('extract', 'return JSON')).text, '1000')

  const failed = await harness.complete('authentication failure')
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /HTTP 401/)
  assert.equal(request.mock.callCount(), 3)

  settings.model = ''
  assert.equal((await harness.complete('missing configuration')).ok, false)
  assert.equal(request.mock.callCount(), 3)
})

test('startup exits before initializing storage when the configured model rejects authentication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowweave-startup-test-'))
  const dataDir = join(directory, 'uninitialized')
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { settings } from './src/config.ts'
      Object.assign(settings, {
        dataDir: process.argv[1], model: 'startup-test-model',
        modelBaseUrl: 'https://startup-test.example/v1', modelApiKey: 'test-key',
      })
      globalThis.fetch = async () => new Response(null, { status: 401 })
      await import('./src/main.ts')
    `, dataDir], { cwd: settings.rootDir, encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.status, 1, child.error?.message ?? child.stderr)
    assert.match(child.stderr, /启动前模型检查.*HTTP 401/)
    assert.equal(existsSync(dataDir), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Ark DeepSeek V4.1 Flash reserves structured output for JSON and reports truncated completions', async (t) => {
  Object.assign(settings, {
    model: 'deepseek-v4.1-flash', modelProvider: 'volcengine-ark',
    modelBaseUrl: 'https://ark-test.example/v3', modelApiKey: 'test-key', modelMaxTokens: undefined,
  })
  const request = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    assert.equal(body.model, settings.model)
    const prompt = body.messages.at(-1).content
    assert.equal(Object.hasOwn(body, 'max_tokens'), prompt === 'truncated JSON')
    if (prompt === 'ordinary answer') {
      assert.equal(body.thinking, undefined)
      return Response.json({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'private reasoning' } }],
        usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } })
    }
    if (prompt === 'generic endpoint') assert.equal(body.thinking, undefined)
    else assert.deepEqual(body.thinking, { type: 'disabled' })
    if (prompt === 'truncated JSON') {
      assert.equal(body.max_tokens, 20)
      return Response.json({ choices: [{ finish_reason: 'length', message: { content: '[{"subject":' } }] })
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '[]' } }] })
  })
  const answer = await harness.ask('conversation', 'ordinary answer')
  assert.equal(answer.ok, false)
  assert.match(answer.error ?? '', /推理达到服务端输出上限/)
  assert.doesNotMatch(answer.error ?? '', /private reasoning/)
  assert.equal((await completeStructured('extraction', 'Return JSON')).text, '[]')
  settings.modelMaxTokens = 20
  const truncated = await completeStructured('truncated JSON', 'Return JSON')
  assert.equal(truncated.ok, false)
  assert.match(truncated.error ?? '', /达到20 token 输出上限/)
  settings.modelMaxTokens = undefined
  settings.modelProvider = 'openai-compatible'
  assert.equal((await completeStructured('generic endpoint', 'Return JSON')).ok, true)
  assert.equal(request.mock.callCount(), 4)
})

test('native chat drops the SDK token cap when unset and sends the configured cap verbatim', () => {
  for (const maxTokens of ['', '393216']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      const endpoint = process.env.KNOWWEAVE_MODEL_COMPLETIONS_URL
      const limit = process.env.KNOWWEAVE_MODEL_MAX_TOKENS
      const body = JSON.stringify({ model: 'configured-model', stream: true, max_tokens: 4096 })
      globalThis.fetch = async (url, init) => {
        if (url !== endpoint) assert.equal(init.body, body)
        else assert.deepEqual(JSON.parse(init.body), {
          model: 'configured-model', stream: true, ...(limit ? { max_tokens: Number(limit) } : {}),
        })
      }
      await import('./src/adapters/dsh-web/model-request.mjs')
      await fetch(endpoint, { method: 'POST', body })
      await fetch('https://other.example/api', { method: 'POST', body })
    `], {
      cwd: settings.rootDir, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, KNOWWEAVE_MODEL_COMPLETIONS_URL: 'https://native.example/chat/completions', KNOWWEAVE_MODEL_MAX_TOKENS: maxTokens },
    })
    assert.equal(child.status, 0, child.error?.message ?? child.stderr)
  }
})

test('model readiness requires a configured endpoint that returns non-empty text', async (t) => {
  Object.assign(settings, {
    model: 'startup-test-model', modelBaseUrl: 'https://startup-test.example/v1', modelApiKey: '',
  })
  let content = ' '
  const fetchStub = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content } }] }))
  await assert.rejects(assertModelReady(), /api_key/)
  assert.equal(fetchStub.mock.callCount(), 0)
  settings.modelApiKey = 'test-key'
  await assert.rejects(assertModelReady(), /空响应/)
  content = 'OK'
  await assertModelReady()
})
