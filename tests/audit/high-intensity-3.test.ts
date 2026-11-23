/**
 * 高频/边界稳定性探针。断言正确行为；失败 = 实证问题。
 * 运行：node --import tsx --test --test-concurrency=1 tests/audit/high-intensity-3.test.ts
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { testWorkspace, clearKnowledge } from '../helpers.js'
import { query } from '../../src/db/index.js'
import { settings } from '../../src/config.js'
import { createServer } from '../../src/app/server.js'
import { harness } from '../../src/adapters/harness/index.js'
import { ingestParsed } from '../../src/core/ingestion.js'
import { parseTextContent } from '../../src/adapters/parsing/index.js'
import { ask } from '../../src/core/answering.js'
import type { Principal } from '../../src/core/security.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>

before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
beforeEach(async () => {
  await clearKnowledge()
  harness.ask = async () => ({ text: '', tokensIn: 0, tokensOut: 0, model: 'test', provider: 'test', latencyMs: 0, error: 'offline', ok: false })
  harness.complete = async () => ({ text: '', tokensIn: 0, tokensOut: 0, model: 'test', provider: 'test', latencyMs: 0, error: 'offline', ok: false })
})
after(async () => { await app?.close(); await workspace?.close() })

const H = { authorization: 'Bearer owner-token', 'content-type': 'application/json' }
const ok = (text: string) => ({ text, tokensIn: 10, tokensOut: 10, model: 'test', provider: 'test', latencyMs: 1, error: '', ok: true })

async function seedDoc(title: string, text: string) {
  return ingestParsed(workspace.principal, parseTextContent(text, title), { sourceType: 'text', uri: `stress:${title}` })
}

test('HI-23 高频并发检索（100 次）不应出现 5xx 或超时', async () => {
  await seedDoc('并发文档', '高频并发场景下的稳定性验证内容，包含关键字 Aurora 与 89元。')
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => app.inject({
    method: 'POST', url: '/api/v1/search', headers: H, payload: { query: `Aurora ${index % 7}`, top_k: 5 },
  })))
  const bad = responses.filter((response) => response.statusCode >= 500)
  assert.equal(bad.length, 0, `100 次并发检索出现 ${bad.length} 次 5xx：${bad[0]?.body.slice(0, 200) ?? ''}`)
})

test('HI-24 高频并发问答（30 次）不应出现 5xx', async () => {
  await seedDoc('问答并发文档', '并发问答的原文证据，补助标准为89元。')
  harness.ask = async () => ok('补助标准为89元[1]。')
  const responses = await Promise.all(Array.from({ length: 30 }, () => app.inject({
    method: 'POST', url: '/api/v1/ask', headers: H, payload: { question: '补助标准是多少', evaluation: true },
  })))
  const bad = responses.filter((response) => response.statusCode >= 500)
  assert.equal(bad.length, 0, `30 次并发问答出现 ${bad.length} 次 5xx：${bad[0]?.body.slice(0, 200) ?? ''}`)
})

test('HI-25 空白查询/超长查询应稳定返回 400 或正常结果，不得 500', async () => {
  const cases = ['   ', '\n\t', 'x'.repeat(200000), '\u0000\u0000', '🙂🙂🙂']
  for (const query of cases) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: H, payload: { query } })
    assert.ok(res.statusCode < 500, `查询 ${JSON.stringify(query.slice(0, 20))} 触发 ${res.statusCode}：${res.body.slice(0, 200)}`)
  }
})

test('HI-26 分页边界参数不应导致 500', async () => {
  for (const limit of ['0', '-1', '999999999999999999999', '1.5', '']) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/documents?limit=${limit}`, headers: H })
    assert.ok(res.statusCode < 500, `limit=${limit} 触发 ${res.statusCode}：${res.body.slice(0, 200)}`)
  }
})

test('HI-27 多次重复引用同一编号时置信度不应被不合理拉低', async () => {
  await seedDoc('置信度文档', '补助标准为89元。')
  harness.ask = async () => ok('补助标准为89元[1]。补助标准为89元[1]。补助标准为89元[1]。')
  const repeated = await ask(workspace.principal, { question: '补助标准', evaluation: true })
  harness.ask = async () => ok('补助标准为89元[1]。')
  const single = await ask(workspace.principal, { question: '补助标准', evaluation: true })
  assert.ok(Number(repeated.confidence) >= Number(single.confidence) - 0.001,
    `三次合法重复引用置信度 ${repeated.confidence} 反而低于单次 ${single.confidence}`)
})

test('HI-28 非法 as_of 应返回 400 且不产生 500', async () => {
  for (const asOf of ['2024-13-01', '2024-02-30', 'not-a-date', '20240101', '9999-99-99']) {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/ask', headers: H,
      payload: { question: '补助标准是多少', as_of: asOf, evaluation: true },
    })
    assert.ok(res.statusCode === 400 || res.statusCode === 200, `as_of=${asOf} 触发 ${res.statusCode}：${res.body.slice(0, 200)}`)
  }
})
