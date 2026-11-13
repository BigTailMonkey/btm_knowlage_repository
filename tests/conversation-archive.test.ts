import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { clearKnowledge, testWorkspace } from './helpers.js'
import { query, queryOne } from '../src/db/index.js'
import { createServer } from '../src/app/server.js'
import { harness } from '../src/adapters/harness/index.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { ask } from '../src/core/answering.js'
import { archiveStaleConversations, setConversationArchived } from '../src/core/conversation-archive.js'
import { runIntervalMaintenance } from '../src/core/scheduling.js'

let workspace: Awaited<ReturnType<typeof testWorkspace>>
let app: Awaited<ReturnType<typeof createServer>>
const generated = (answer: string) => ({ text: answer, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: 'test-model', provider: 'test', ok: true, error: null })
before(async () => {
  workspace = await testWorkspace()
  app = await createServer()
  app.log.level = 'silent'
})
after(async () => { await app?.close(); await workspace?.close() })
beforeEach(async () => {
  await clearKnowledge()
  harness.ask = async () => generated('知织的回答附带原文引用。[1]')
  harness.complete = async () => generated('[]')
  await ingestParsed(workspace.principal, parseText('知织支持本地文档检索，回答附带原文引用。', '知织文档'), { sourceType: 'text', uri: 'fixture:archive' })
})

/** 直接按天数回填会话与消息时间，模拟“多久没有动静”。 */
async function seedConversation(id: string, createdDaysAgo: number, lastMessageDaysAgo: number | null, userId = workspace.principal.userId) {
  await query(
    `INSERT INTO conversations (id, tenant_id, user_id, title, created_at)
     VALUES ($1, $2, $3, $4, now() - ($5::text || ' days')::interval)`,
    [id, workspace.principal.tenantId, userId, `会话 ${id}`, String(createdDaysAgo)],
  )
  if (lastMessageDaysAgo !== null) {
    await query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES ($1, $2, 'user', '历史问题', now() - ($3::text || ' days')::interval)`,
      [`${id}-msg`, id, String(lastMessageDaysAgo)],
    )
  }
}

const archivedIds = async () => (await query<{ id: string }>(
  'SELECT id FROM conversations WHERE archived_at IS NOT NULL ORDER BY id',
)).map((row) => row.id)

test('daily archiving follows last message activity, keeps recent conversations and is idempotent', async () => {
  await seedConversation('conv-stale', 16, 16)          // 16 天没有动静 → 归档
  await seedConversation('conv-recent', 14, 14)         // 14 天没有动静 → 保留
  await seedConversation('conv-empty-old', 20, null)    // 无消息按创建时间 → 归档
  await seedConversation('conv-old-active', 30, 1)      // 创建很早但昨天有消息 → 保留

  assert.equal(await archiveStaleConversations(workspace.principal.tenantId, 15), 2)
  assert.deepEqual(await archivedIds(), ['conv-empty-old', 'conv-stale'])
  // 消息与引用完整保留，归档不删除任何内容。
  assert.equal((await query('SELECT id FROM messages WHERE conversation_id = $1', ['conv-stale'])).length, 1)
  assert.equal(await archiveStaleConversations(workspace.principal.tenantId, 15), 0)
  // 归档后有新消息的会话不会被再次归档。
  await query(`INSERT INTO messages (id, conversation_id, role, content) VALUES ('conv-stale-new', 'conv-stale', 'user', '新问题')`)
  assert.equal(await archiveStaleConversations(workspace.principal.tenantId, 15), 0)
})

test('archive_after_days=0 disables automatic archiving', async () => {
  await seedConversation('conv-ancient', 365, 365)
  assert.equal(await archiveStaleConversations(workspace.principal.tenantId, 0), 0)
  assert.deepEqual(await archivedIds(), [])
})

test('conversation lists separate active and archived, sorted by last activity', async () => {
  await seedConversation('conv-stale', 16, 16)
  await seedConversation('conv-recent', 14, 14)
  await seedConversation('conv-old-active', 30, 1)
  await archiveStaleConversations(workspace.principal.tenantId, 15)

  const active = await app.inject({ method: 'GET', url: '/api/v1/conversations', headers: workspace.headers })
  assert.equal(active.statusCode, 200)
  assert.deepEqual(active.json().items.map((item: { id: string }) => item.id), ['conv-old-active', 'conv-recent'])
  assert.ok(active.json().items.every((item: { archived_at: string | null }) => item.archived_at === null))

  const archived = await app.inject({ method: 'GET', url: '/api/v1/conversations?archived=1', headers: workspace.headers })
  assert.equal(archived.statusCode, 200)
  const items = archived.json().items
  assert.deepEqual(items.map((item: { id: string }) => item.id), ['conv-stale'])
  assert.ok(items[0].archived_at)
  assert.ok(items[0].last_activity_at)

  // 归档会话仍可完整读取。
  const detail = await app.inject({ method: 'GET', url: '/api/v1/conversations/conv-stale', headers: workspace.headers })
  assert.equal(detail.statusCode, 200)
  assert.ok(detail.json().archived_at)
  assert.equal(detail.json().messages.length, 1)
})

test('asking in an archived conversation restores it to the active list', async () => {
  await seedConversation('conv-stale', 16, 16)
  await archiveStaleConversations(workspace.principal.tenantId, 15)
  assert.deepEqual(await archivedIds(), ['conv-stale'])

  const result = await ask(workspace.principal, { question: '知织支持什么？', conversationId: 'conv-stale' })
  assert.equal(result.conversation_id, 'conv-stale')
  assert.equal((await queryOne<{ archived_at: string | null }>('SELECT archived_at FROM conversations WHERE id = $1', ['conv-stale']))?.archived_at, null)
  const active = await app.inject({ method: 'GET', url: '/api/v1/conversations', headers: workspace.headers })
  assert.deepEqual(active.json().items.map((item: { id: string }) => item.id), ['conv-stale'])
})

test('manual archive and unarchive are owner-only and keep the first archive time', async () => {
  await seedConversation('conv-manual', 1, 1)
  await seedConversation('conv-other', 1, 1, 'u_someone_else')

  const archive = await app.inject({ method: 'POST', url: '/api/v1/conversations/conv-manual/archive', headers: workspace.headers })
  assert.equal(archive.statusCode, 200)
  assert.equal(archive.json().archived, true)
  const firstArchivedAt = archive.json().archived_at
  assert.ok(firstArchivedAt)
  const again = await app.inject({ method: 'POST', url: '/api/v1/conversations/conv-manual/archive', headers: workspace.headers })
  assert.equal(again.json().archived_at, firstArchivedAt)

  const unarchive = await app.inject({ method: 'POST', url: '/api/v1/conversations/conv-manual/unarchive', headers: workspace.headers })
  assert.equal(unarchive.statusCode, 200)
  assert.equal(unarchive.json().archived, false)
  assert.equal(unarchive.json().archived_at, null)

  for (const action of ['archive', 'unarchive']) {
    const foreign = await app.inject({ method: 'POST', url: `/api/v1/conversations/conv-other/${action}`, headers: workspace.headers })
    assert.equal(foreign.statusCode, 404)
    const missing = await app.inject({ method: 'POST', url: `/api/v1/conversations/conv-missing/${action}`, headers: workspace.headers })
    assert.equal(missing.statusCode, 404)
  }
  await assert.rejects(setConversationArchived(workspace.principal, 'conv-other', true), /会话不存在/)
})

test('interval maintenance archives stale conversations alongside trash cleanup', async () => {
  await seedConversation('conv-stale', 20, 20)
  await seedConversation('conv-recent', 2, 2)
  await runIntervalMaintenance()
  assert.deepEqual(await archivedIds(), ['conv-stale'])
})
