import { queryOne } from '../db/index.js'

/**
 * 审阅队列计数的进程内广播。
 *
 * 写入 review_queue 的业务代码在完成后调用 notifyReviewQueueChanged(tenantId)，
 * 这里把同一租户的突发写入合并成一次计数查询，再推给 WebSocket 订阅者。
 * 没有订阅者时不查库，空闲状态下零开销。
 */
const DEBOUNCE_MS = 150

type Listener = (count: number) => void

const subscribers = new Map<string, Set<Listener>>()
const pending = new Map<string, NodeJS.Timeout>()

export async function openReviewCount(tenantId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM review_queue WHERE tenant_id = $1 AND status = 'open'`,
    [tenantId],
  )
  return Number(row?.count ?? 0)
}

/** 审阅队列写入后调用；没有在线订阅者时直接返回。 */
export function notifyReviewQueueChanged(tenantId: string): void {
  if (!subscribers.get(tenantId)?.size) return
  if (pending.has(tenantId)) return
  const timer = setTimeout(() => {
    pending.delete(tenantId)
    const listeners = subscribers.get(tenantId)
    if (!listeners?.size) return
    void openReviewCount(tenantId)
      .then((count) => {
        for (const notify of listeners) {
          try {
            notify(count)
          } catch {
            // 单个连接出错不影响其他连接
          }
        }
      })
      .catch(() => {
        // 数据库短暂不可用时保持上一次数值，等下一次变更
      })
  }, DEBOUNCE_MS)
  timer.unref()
  pending.set(tenantId, timer)
}

export function subscribeReviewCount(tenantId: string, notify: Listener): () => void {
  let listeners = subscribers.get(tenantId)
  if (!listeners) {
    listeners = new Set()
    subscribers.set(tenantId, listeners)
  }
  listeners.add(notify)
  // 连上就先给一次当前值，首屏不用等通知。
  void openReviewCount(tenantId).then(notify).catch(() => {})
  return () => {
    const current = subscribers.get(tenantId)
    current?.delete(notify)
    if (current && !current.size) subscribers.delete(tenantId)
  }
}

export function stopReviewEvents(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  subscribers.clear()
}
