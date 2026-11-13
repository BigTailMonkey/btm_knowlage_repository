import { FastifyInstance } from 'fastify'

import { authenticate, currentPrincipal } from '../server.js'
import { query, queryOne } from '../../db/index.js'
import { newId } from '../../core/ids.js'

/**
 * 原生对话反馈：DSH“好的回答 / 有问题的回答”按钮由知织接管后提交到这里，
 * 只记录在本系统，不发送上游，也不参与检索/证据权重调整（与研究台 feedback 分开）。
 */

const COMMENT_LIMIT = 2000
const CONTEXT_LIMIT = 4000

function trimmedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, limit) : null
}

export async function chatFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat-feedback', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const payload = request.body as {
      session_id?: string
      message_id?: string
      value?: number
      comment?: string
      context?: string
    }
    const sessionId = trimmedText(payload.session_id, 200)
    const messageId = trimmedText(payload.message_id, 200)
    if (!sessionId || !messageId) throw Object.assign(new Error('session_id 与 message_id 不能为空'), { statusCode: 400 })
    if (![1, -1].includes(payload.value as number)) throw Object.assign(new Error('反馈值必须是 1 或 -1'), { statusCode: 400 })
    const comment = trimmedText(payload.comment, COMMENT_LIMIT)
    const context = trimmedText(payload.context, CONTEXT_LIMIT)
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM chat_feedback WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND message_id = $4',
      [principal.tenantId, principal.userId, sessionId, messageId],
    )
    if (existing) {
      await query(
        'UPDATE chat_feedback SET value = $1, comment = $2, context = COALESCE($3, context), updated_at = now() WHERE id = $4',
        [payload.value, comment, context, existing.id],
      )
      return { status: 'ok', id: existing.id, value: payload.value }
    }
    const id = newId('cf')
    await query(
      `INSERT INTO chat_feedback (id, tenant_id, user_id, session_id, message_id, value, comment, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, principal.tenantId, principal.userId, sessionId, messageId, payload.value, comment, context],
    )
    return { status: 'ok', id, value: payload.value }
  })

  app.get('/chat-feedback', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    const params = request.query as { limit?: string }
    const limit = Math.min(200, Math.max(1, Number(params.limit ?? 50)))
    const items = await query<{
      id: string
      user_id: string
      session_id: string
      message_id: string
      value: number
      comment: string | null
      context: string | null
      created_at: string
      updated_at: string
    }>(
      `SELECT id, user_id, session_id, message_id, value, comment, context, created_at, updated_at
       FROM chat_feedback WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT ${limit}`,
      [principal.tenantId],
    )
    return { items }
  })
}
