import { FastifyInstance } from 'fastify'

import { settings } from '../../config.js'
import { authenticate, currentPrincipal } from '../server.js'
import { sidecarStatus } from '../../adapters/sidecar/index.js'
import { dshWebStatus, ensureDshWeb } from '../../adapters/dsh-web/index.js'
import { askRoutes } from './ask.js'
import { chatFeedbackRoutes } from './chat-feedback.js'
import { documentRoutes } from './documents.js'
import { learnRoutes } from './learn.js'
import { mcpRoutes } from './mcp.js'
import { opsRoutes } from './ops.js'
import { realtimeRoutes } from './realtime.js'

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'knowweave',
    version: '0.1.0',
    tenant: settings.defaultTenantId,
  }))

  app.get('/auth/me', { preHandler: authenticate }, async (request) => {
    const principal = currentPrincipal(request)
    return {
      user_id: principal.userId,
      tenant_id: principal.tenantId,
      name: principal.name,
      role: principal.role,
      groups: principal.groups,
      principals: [
        ...new Set([`user:${principal.userId}`, 'tenant:public', ...principal.groups.map((group) => `group:${group}`)]),
      ].sort(),
    }
  })

  app.get('/meta', async () => ({
    product: 'KnoWeave 知织',
    sidecar: await sidecarStatus(),
    modes: [
      { id: 'quick', name: '快速', description: '单轮混合召回，适合定义与参数' },
      { id: 'deep', name: '深度', description: '问题拆解与多轮检索，适合跨文档' },
      { id: 'graph', name: '图谱', description: '实体链接 + 事实一跳' },
      { id: 'timeline', name: '时间线', description: '按事实有效期回答' },
      { id: 'compare', name: '对比', description: '多实体并行召回' },
    ],
    rerank_threshold: settings.rerankThreshold,
    model: settings.model,
    embedding_model: settings.embeddingModel,
    embedding_dim: settings.embeddingDim,
    source_types: ['text', 'md', 'markdown', 'pdf', 'docx', 'html', 'web', 'csv', 'json', 'yaml', 'png', 'jpg', 'wav', 'mp3', 'mp4'],
  }))

  app.get('/dsh-web', { preHandler: authenticate }, async (request) => {
    // 等待本次接管或启动完成，避免重试立即读到上一次的错误状态。
    await ensureDshWeb(currentPrincipal(request))
    return dshWebStatus()
  })

  await app.register(askRoutes)
  await app.register(chatFeedbackRoutes)
  await app.register(documentRoutes, { prefix: '/documents' })
  await app.register(learnRoutes)
  await app.register(opsRoutes)
  await app.register(realtimeRoutes)
  await app.register(mcpRoutes)
}
