import { settings } from '../config.js'
import { query, queryOne } from '../db/index.js'
import type { Principal } from './security.js'

/**
 * 会话归档语义：归档只把会话从“最近”列表隐藏，消息、引用与轨迹完整保留；
 * 归档列表随时可查，继续提问（产生新消息）会自动恢复到最近列表。
 * “动静”以最后一条消息时间为准；没有消息的会话按创建时间计算。
 */

/** 每日维护：归档超过 afterDays 天没有新消息的会话；0 表示不自动归档。 */
export async function archiveStaleConversations(tenantId: string, afterDays = settings.conversationsArchiveDays): Promise<number> {
  if (afterDays <= 0) return 0
  const archived = await query<{ id: string }>(
    `UPDATE conversations SET archived_at = now()
     WHERE tenant_id = $1 AND archived_at IS NULL
       AND COALESCE(
             (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id),
             conversations.created_at
           ) < now() - ($2::text || ' days')::interval
     RETURNING id`,
    [tenantId, String(afterDays)],
  )
  return archived.length
}

/** 手动归档/恢复单个会话；重复归档保留首次归档时间。 */
export async function setConversationArchived(
  principal: Principal,
  conversationId: string,
  archived: boolean,
): Promise<{ id: string; archived: boolean; archived_at: string | null }> {
  const conversation = await queryOne<{ id: string; tenant_id: string; user_id: string }>(
    'SELECT id, tenant_id, user_id FROM conversations WHERE id = $1',
    [conversationId],
  )
  if (!conversation || conversation.tenant_id !== principal.tenantId || conversation.user_id !== principal.userId) {
    throw Object.assign(new Error('会话不存在'), { statusCode: 404 })
  }
  const updated = await queryOne<{ archived_at: string | null }>(
    archived
      ? 'UPDATE conversations SET archived_at = COALESCE(archived_at, now()) WHERE id = $1 RETURNING archived_at'
      : 'UPDATE conversations SET archived_at = NULL WHERE id = $1 RETURNING archived_at',
    [conversationId],
  )
  return { id: conversationId, archived, archived_at: updated?.archived_at ?? null }
}
