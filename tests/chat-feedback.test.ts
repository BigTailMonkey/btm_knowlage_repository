import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { clearKnowledge, testWorkspace } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { createServer } from '../src/app/server.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>
before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
after(async () => { await app?.close(); await workspace?.close() })
beforeEach(async () => {
  await clearKnowledge()
  await query("DELETE FROM chat_feedback")
  await query("DELETE FROM users WHERE id = 'u_other'")
  await query("DELETE FROM tenants WHERE id = 'tn_other'")
})

const post = (payload: Record<string, unknown>, headers: Record<string, string> = workspace.headers) =>
  app.inject({ method: 'POST', url: '/api/v1/chat-feedback', headers, payload })

test('native chat feedback is recorded locally with comment and context', async () => {
  const response = await post({
    session_id: 'dsh-session-1', message_id: 'msg-1', value: -1,
    comment: '引用与原文不符', context: '问：上限是多少？答：30MB。',
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().value, -1)
  const row = await queryOne<{ value: number; comment: string; context: string; user_id: string }>(
    'SELECT value, comment, context, user_id FROM chat_feedback WHERE session_id = $1', ['dsh-session-1'])
  assert.equal(row?.value, -1)
  assert.equal(row?.comment, '引用与原文不符')
  assert.equal(row?.context, '问：上限是多少？答：30MB。')
  assert.equal(row?.user_id, workspace.principal.userId)
})

test('changing the rating updates the same record instead of adding another', async () => {
  await post({ session_id: 's', message_id: 'm', value: -1, comment: '不对' })
  const first = await queryOne<{ id: string; created_at: string }>('SELECT id, created_at FROM chat_feedback')
  const again = await post({ session_id: 's', message_id: 'm', value: 1 })
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().id, first?.id)
  const rows = await query<{ value: number; comment: string | null }>('SELECT value, comment FROM chat_feedback')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.value, 1)
  assert.equal(rows[0]?.comment, null)
  // 不同消息各自记录。
  await post({ session_id: 's', message_id: 'm2', value: 1 })
  assert.equal((await query('SELECT id FROM chat_feedback')).length, 2)
})

test('feedback payloads are validated and long text is truncated', async () => {
  assert.equal((await post({ message_id: 'm', value: 1 })).statusCode, 400)
  assert.equal((await post({ session_id: 's', value: 1 })).statusCode, 400)
  assert.equal((await post({ session_id: 's', message_id: 'm', value: 0 })).statusCode, 400)
  assert.equal((await post({ session_id: 's', message_id: 'm', value: 1 }, {})).statusCode, 401)
  const response = await post({
    session_id: 's', message_id: 'm', value: -1,
    comment: 'x'.repeat(3000), context: 'y'.repeat(6000),
  })
  assert.equal(response.statusCode, 200)
  const row = await queryOne<{ comment: string; context: string }>('SELECT comment, context FROM chat_feedback')
  assert.equal(row?.comment.length, 2000)
  assert.equal(row?.context.length, 4000)
})

test('feedback list is tenant-scoped and newest first', async () => {
  await query("INSERT INTO tenants (id, name) VALUES ('tn_other', 'Other')")
  await query(`INSERT INTO users (id, tenant_id, name, role, token) VALUES ('u_other', 'tn_other', 'Other', 'editor', 'other-token')`)
  await post({ session_id: 's1', message_id: 'm1', value: 1 })
  await post({ session_id: 's2', message_id: 'm2', value: -1, comment: '有问题' })
  await post({ session_id: 's3', message_id: 'm3', value: -1 }, { authorization: 'Bearer other-token' })

  const mine = await app.inject({ method: 'GET', url: '/api/v1/chat-feedback', headers: workspace.headers })
  assert.equal(mine.statusCode, 200)
  assert.deepEqual(mine.json().items.map((item: { session_id: string }) => item.session_id), ['s2', 's1'])
  const other = await app.inject({ method: 'GET', url: '/api/v1/chat-feedback', headers: { authorization: 'Bearer other-token' } })
  assert.deepEqual(other.json().items.map((item: { session_id: string }) => item.session_id), ['s3'])
})
