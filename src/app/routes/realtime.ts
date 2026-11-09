import { FastifyInstance } from 'fastify'

import { resolveToken } from '../../core/security.js'
import { subscribeReviewCount } from '../../core/review-events.js'

const HEARTBEAT_MS = 30_000

/**
 * 实时通道：当前只推送审阅队列数量，后续可在此追加其他计数。
 *
 * 浏览器无法给 WebSocket 握手加 Authorization 头，所以令牌走查询参数；
 * 校验失败直接以 4401 关闭，不进入订阅。
 */
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/realtime', { websocket: true }, async (socket, request) => {
    const token = String((request.query as { token?: string }).token ?? '')
    const principal = await resolveToken(token)
    if (!principal) {
      socket.close(4401, '令牌无效')
      return
    }

    let alive = true
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      try {
        socket.ping()
      } catch {
        // 连接已断开，close 事件里统一清理
      }
    }, HEARTBEAT_MS)
    heartbeat.unref()

    const unsubscribe = subscribeReviewCount(principal.tenantId, (count) => {
      if (socket.readyState !== 1) return
      socket.send(JSON.stringify({ type: 'review_count', tenant_id: principal.tenantId, count }))
    })

    const stop = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    socket.on('pong', () => { alive = true })
    socket.on('close', stop)
    socket.on('error', stop)
  })
}
