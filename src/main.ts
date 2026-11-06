import { mkdirSync } from 'node:fs'

import { settings } from './config.js'
import { closePool, initSchema, seedIfEmpty } from './db/index.js'
import { harness } from './adapters/harness/index.js'
import { startDshWeb, stopDshWeb } from './adapters/dsh-web/index.js'
import { startSidecar, stopSidecar } from './adapters/sidecar/index.js'
import { runReflection } from './core/learning.js'
import { createServer } from './app/server.js'

async function main(): Promise<void> {
  mkdirSync(settings.dataDir, { recursive: true })
  await initSchema()
  if (settings.seedDemo) await seedIfEmpty()

  const app = await createServer()
  await app.listen({ host: settings.serverHost, port: settings.serverPort })

  try {
    await startSidecar()
  } catch (error) {
    app.log.warn(`解析边车未就绪：${error instanceof Error ? error.message : String(error)}`)
  }
  startDshWeb()

  let timer: NodeJS.Timeout | null = null
  if (settings.reflectionEnabled) {
    timer = setInterval(() => {
      runReflection(settings.defaultTenantId).catch((error) => app.log.error(error as Error))
    }, settings.reflectionIntervalSeconds * 1000)
    timer.unref()
  }

  const shutdown = async () => {
    if (timer) clearInterval(timer)
    await stopDshWeb()
    await stopSidecar()
    await app.close()
    await harness.close()
    await closePool()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
