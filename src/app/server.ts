import { existsSync } from 'node:fs'
import { join } from 'node:path'

import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { settings } from '../config.js'
import { Principal, resolveToken } from '../core/security.js'
import { apiRoutes } from './routes/index.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw Object.assign(new Error('缺少 Bearer 令牌'), { statusCode: 401 })
  }
  const token = header.slice('bearer '.length).trim()
  const principal = await resolveToken(token)
  if (!principal) {
    throw Object.assign(new Error('令牌无效或已停用'), { statusCode: 401 })
  }
  const tenantHeader = request.headers['x-tenant-id']
  if (typeof tenantHeader === 'string' && tenantHeader !== principal.tenantId) {
    throw Object.assign(new Error('令牌与租户不匹配'), { statusCode: 403 })
  }
  request.principal = principal
}

export function currentPrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw Object.assign(new Error('缺少 Bearer 令牌'), { statusCode: 401 })
  }
  return request.principal
}

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'info',
      transport: process.env.NODE_ENV === 'production' ? undefined : undefined,
    },
    bodyLimit: 32 * 1024 * 1024,
  })

  await app.register(cors, { origin: true, credentials: false })
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } })

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) app.log.error(error as Error)
    reply.status(status).send({ detail: (error as Error).message })
  })

  await app.register(apiRoutes, { prefix: '/api/v1' })

  if (existsSync(settings.webDir)) {
    await app.register(fastifyStatic, { root: settings.webDir, prefix: '/assets/' })
    app.get('/', async (_request, reply) => reply.sendFile('index.html'))
  }

  // 版式预览自带 PDF.js 与字体/CMap 资源，由主服务同源提供，避免依赖外部 CDN。
  const pdfjsDir = join(settings.rootDir, 'node_modules', 'pdfjs-dist')
  if (existsSync(pdfjsDir)) {
    await app.register(fastifyStatic, {
      root: pdfjsDir,
      prefix: '/vendor/pdfjs/',
      decorateReply: false,
      maxAge: '7d',
    })
  }

  return app
}

export function webIndexPath(): string {
  return join(settings.webDir, 'index.html')
}
