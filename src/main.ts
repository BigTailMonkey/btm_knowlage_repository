import { mkdirSync } from 'node:fs'

import { settings } from './config.js'
import { closePool, initSchema, seedIfEmpty } from './db/index.js'
import { assertModelReady, harness } from './adapters/harness/index.js'
import { startDshWeb, stopDshWeb } from './adapters/dsh-web/index.js'
import { startSidecar, stopSidecar } from './adapters/sidecar/index.js'
import { createServer } from './app/server.js'
import { startIngestWorker, stopIngestWorker } from './core/ingestion.js'
import { runDailyReflection, runIntervalMaintenance } from './core/scheduling.js'

async function main(): Promise<void> {
  await assertModelReady()
  mkdirSync(settings.dataDir, { recursive: true })
  await initSchema()
  if (settings.seedDemo) await seedIfEmpty()

  const app = await createServer()
  await app.listen({ host: settings.serverHost, port: settings.serverPort })

  // 对话界面在后台预热，与边车启动并行，用户打开对话页时无需等待进程启动。
  void startDshWeb().catch((error) => {
    app.log.warn(`对话服务预热未完成：${error instanceof Error ? error.message : String(error)}`)
  })

  try {
    await startSidecar()
  } catch (error) {
    app.log.warn(`解析边车未就绪：${error instanceof Error ? error.message : String(error)}`)
  }
  startIngestWorker()

  let timer: NodeJS.Timeout | null = null
  if (settings.reflectionEnabled) {
    const reflect = () => settings.reflectionRunAt
      ? runDailyReflection()
      : runIntervalMaintenance()
    void reflect().catch((error) => app.log.error(error as Error))
    timer = setInterval(() => { void reflect().catch((error) => app.log.error(error as Error)) }, settings.reflectionRunAt ? 60_000 : settings.reflectionIntervalSeconds * 1000)
    timer.unref()
  }

  const shutdown = async () => {
    if (timer) clearInterval(timer)
    await stopIngestWorker()
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
