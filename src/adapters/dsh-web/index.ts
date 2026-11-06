import { spawn, ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { settings } from '../../config.js'

const WELCOME_VERSION = '2026-09-28.1'

/**
 * 关闭 DSH 自带的新手引导弹窗：
 * - ui-settings-general.welcomeNoticeVersion 标记预览版说明已读；
 * - ui-settings-models.credentialOnboarding=false 不再自动弹出 API Key 引导。
 */
function ensureQuietProfile(): void {
  const profileDir = join(settings.dshWebHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let content = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]\n'
  const trimmed = content.trim()
  if (trimmed === '[]' || trimmed === '') content = ''
  const hasId = (id: string) => new RegExp(`-\\s*id:\\s*${id}\\b`).test(content)
  let appended = ''
  if (!hasId('ui-settings-general')) {
    appended +=
      `- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: '${WELCOME_VERSION}'\n`
  }
  if (!hasId('ui-settings-models')) {
    appended += '- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n'
  }
  // DSH 默认工作区落在系统「文档」目录，容器/沙箱内不可写会弹出工作区选择；
  // 指向项目内目录后首次使用自动建好并直接进入对话。
  if (!hasId('workspace-controller')) {
    const documentsDir = join(settings.dataDir, 'dsh-documents')
    mkdirSync(documentsDir, { recursive: true })
    appended += `- id: workspace-controller\n  config:\n    documentsDirectory: '${documentsDir}'\n`
  }
  if (appended) {
    const prefix = content.trim() ? `${content.trimEnd()}\n` : ''
    const body = prefix + appended
    writeFileSync(patchPath, body.startsWith('#') ? body : `# managed by KnoWeave\n${body}`, 'utf8')
  }
}

let child: ChildProcess | null = null
let managed = false
let ready = false
let startupUrl: string | null = null
let lastError: string | null = null
let starting: Promise<void> | null = null
let shuttingDown = false
let restartAttempts = 0
let restartTimer: NodeJS.Timeout | null = null

function dshBin(): string {
  return join(settings.rootDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 用独立补丁加载知织界面，保留用户已有的运行时配置与完整对话功能。 */
function ensureBrandingPatch(): string {
  const patchPath = join(settings.dshWebHome, 'knowweave-branding.patch.yml')
  const pluginPath = join(settings.rootDir, 'src', 'adapters', 'dsh-web', 'branding', 'index.mjs')
  const content = [
    '# managed by KnoWeave',
    '- id: ui-brand-official',
    '  disabled: true',
    '- insert:',
    '    - id: knowweave-branding',
    `      name: ${JSON.stringify(pluginPath)}`,
    '',
  ].join('\n')
  if (!existsSync(patchPath) || readFileSync(patchPath, 'utf8') !== content) {
    writeFileSync(patchPath, content, 'utf8')
  }
  return patchPath
}

function scheduleRestart(): void {
  if (shuttingDown || restartTimer) return
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(restartAttempts, 5))
  restartAttempts += 1
  restartTimer = setTimeout(() => {
    restartTimer = null
    void ensureDshWeb()
  }, delay)
  restartTimer.unref()
}

function capture(line: string): void {
  const match = /dsh web:\s*(http[^\s]+)/.exec(line)
  if (match) {
    startupUrl = match[1]!.trim()
    ready = true
    lastError = null
    restartAttempts = 0
  }
  const failure = /startup failed|error:|Error:/.exec(line)
  if (failure && !startupUrl) lastError = line.trim().slice(0, 300)
}

async function spawnAndWait(): Promise<void> {
  if (!existsSync(dshBin())) {
    lastError = '找不到对话服务运行时，请先安装项目依赖'
    return
  }
  mkdirSync(settings.dshWebHome, { recursive: true })
  mkdirSync(settings.dshRuntimeCwd, { recursive: true })
  ensureQuietProfile()
  const brandingPatch = ensureBrandingPatch()

  child = spawn(
    process.execPath,
    [dshBin(), '--profile', 'web', '--patch', brandingPatch, '--no-open', '--port', String(settings.dshWebPort)],
    {
      cwd: settings.dshRuntimeCwd,
      env: {
        ...process.env,
        DSH_HOME: settings.dshWebHome,
        DEEPSEEK_BASE_URL: settings.modelBaseUrl,
        ...(settings.modelApiKey ? { DEEPSEEK_API_KEY: settings.modelApiKey } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  managed = true
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) capture(line)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) capture(line)
  })
  child.on('exit', (code, signal) => {
    const expected = shuttingDown
    child = null
    managed = false
    ready = false
    if (!expected) {
      lastError = `对话服务退出（code=${code ?? '-'} signal=${signal ?? '-'}）`
      scheduleRestart()
    }
  })
  child.on('error', (error) => {
    lastError = error.message
    ready = false
    scheduleRestart()
  })

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (shuttingDown) return
    if (ready) return
    if (child === null) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  lastError = '对话服务启动超时'
  child?.kill('SIGKILL')
}

export function ensureDshWeb(): Promise<void> {
  if (!settings.dshWebEnabled) return Promise.resolve()
  if (ready) return Promise.resolve()
  if (starting) return starting
  starting = spawnAndWait().finally(() => {
    starting = null
  })
  return starting
}

/** 可选的独立运行时调试界面，不作为知识库聊天入口。 */
export function startDshWeb(): void {
  if (!settings.dshWebEnabled || !settings.dshWebAutoStart) return
  void ensureDshWeb()
}

export async function stopDshWeb(): Promise<void> {
  shuttingDown = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (!child) return
  const process = child
  child = null
  ready = false
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

export interface DshWebStatus {
  enabled: boolean
  ready: boolean
  managed: boolean
  url: string | null
  port: number
  restartAttempts: number
  lastError: string | null
}

export function dshWebStatus(): DshWebStatus {
  return {
    enabled: settings.dshWebEnabled,
    ready,
    managed,
    url: startupUrl,
    port: settings.dshWebPort,
    restartAttempts,
    lastError,
  }
}
