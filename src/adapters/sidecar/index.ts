import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

import { settings } from '../../config.js'

let child: ChildProcess | null = null
let managed = false
let shuttingDown = false
let restartAttempts = 0
let restartTimer: NodeJS.Timeout | null = null
let lastError: string | null = null
let starting: Promise<boolean> | null = null

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${settings.sidecarUrl.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(800),
    })
    return response.ok
  } catch {
    return false
  }
}

function sidecarPort(): string {
  try {
    return new URL(settings.sidecarUrl).port || '8732'
  } catch {
    return '8732'
  }
}

function scheduleRestart(): void {
  if (shuttingDown || restartTimer) return
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(restartAttempts, 5))
  restartAttempts += 1
  restartTimer = setTimeout(() => {
    restartTimer = null
    void ensureSidecar()
  }, delay)
  restartTimer.unref()
}

async function spawnSidecar(): Promise<boolean> {
  if (!existsSync(settings.sidecarCommand)) {
    lastError = `找不到 Python 解释器：${settings.sidecarCommand}`
    return false
  }
  child = spawn(
    settings.sidecarCommand,
    ['-m', 'uvicorn', 'sidecar.main:app', '--host', '127.0.0.1', '--port', sidecarPort()],
    { cwd: settings.rootDir, stdio: 'ignore' },
  )
  managed = true
  child.on('exit', (code, signal) => {
    const expected = shuttingDown
    child = null
    managed = false
    if (!expected) {
      lastError = `解析边车退出（code=${code ?? '-'} signal=${signal ?? '-'}）`
      scheduleRestart()
    }
  })
  child.on('error', (error) => {
    lastError = error.message
    scheduleRestart()
  })

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (shuttingDown) return false
    if (await healthy()) {
      restartAttempts = 0
      lastError = null
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  lastError = '边车启动超时'
  child?.kill('SIGKILL')
  return false
}

/**
 * 按需确保边车可用：复用外部实例；不可用时自动拉起（带指数退避重启）。
 */
export async function ensureSidecar(): Promise<boolean> {
  if (!settings.sidecarEnabled) return false
  if (await healthy()) return true
  if (!settings.sidecarAutoStart) return false
  if (starting) return starting

  if (child) {
    // 进程还在但已无响应：先终止再重启。
    child.kill('SIGKILL')
    child = null
    managed = false
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  starting = spawnSidecar().finally(() => {
    starting = null
  })
  return starting
}

export async function startSidecar(): Promise<void> {
  if (!settings.sidecarEnabled) return
  if (await healthy()) return
  if (!settings.sidecarAutoStart) return
  const ok = await ensureSidecar()
  if (!ok && lastError) throw new Error(lastError)
}

export async function stopSidecar(): Promise<void> {
  shuttingDown = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (!child) return
  const process = child
  child = null
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill('SIGKILL')
      resolve()
    }, 3000)
    process.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    process.kill('SIGTERM')
  })
}

export interface SidecarStatus {
  enabled: boolean
  managed: boolean
  healthy: boolean
  url: string
  restartAttempts: number
  lastError: string | null
}

export async function sidecarStatus(): Promise<SidecarStatus> {
  return {
    enabled: settings.sidecarEnabled,
    managed,
    healthy: await healthy(),
    url: settings.sidecarUrl,
    restartAttempts,
    lastError,
  }
}
