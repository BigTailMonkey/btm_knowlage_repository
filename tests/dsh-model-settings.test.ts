import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureBrandingPatch, ensureQuietProfile } from '../src/adapters/dsh-web/index.js'
import { settings } from '../src/config.js'

async function withDshHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'knowweave-dsh-settings-'))
  const original = {
    dshWebHome: settings.dshWebHome,
    dataDir: settings.dataDir,
    model: settings.model,
    modelBaseUrl: settings.modelBaseUrl,
    modelMaxTokens: settings.modelMaxTokens,
  }
  Object.assign(settings, {
    dshWebHome: home,
    dataDir: join(home, 'data'),
    model: 'test-model',
    modelBaseUrl: 'http://model.invalid/v1',
    modelMaxTokens: undefined,
  })
  try {
    await run(home)
  } finally {
    Object.assign(settings, original)
    await rm(home, { recursive: true, force: true })
  }
}

const profilePath = (home: string) => join(home, 'profiles', 'web', 'cordis.patch.yml')

test('model settings are seeded once into the editable profile and native edits survive restarts', async () => {
  await withDshHome(async (home) => {
    ensureQuietProfile()
    const seeded = await readFile(profilePath(home), 'utf8')
    // 原生模型设置页保持可用，且不再自动弹出 API Key 引导。
    assert.match(seeded, /- id: ui-settings-models\n  config:\n    credentialOnboarding: false/)
    assert.match(seeded, /- id: agent-default-model\n  config:\n    provider: knowweave-model\n    model: "test-model"/)
    assert.match(seeded, /apiKeyEnv: KNOWWEAVE_CONFIGURED_MODEL_API_KEY/)
    assert.match(seeded, /baseURL: "http:\/\/model\.invalid\/v1"/)

    // 模拟用户在原生模型设置页改模型：重启（再次 ensureQuietProfile）不得覆盖。
    const edited = seeded.replace('model: "test-model"', 'model: "user-chosen-model"')
    await writeFile(profilePath(home), edited, 'utf8')
    ensureQuietProfile()
    const afterRestart = await readFile(profilePath(home), 'utf8')
    assert.equal(afterRestart, edited)
    assert.match(afterRestart, /- id: agent-default-model\n  config:\n    provider: knowweave-model\n    model: "user-chosen-model"/)
  })
})

test('an existing profile without model entries receives the seed on upgrade', async () => {
  await withDshHome(async (home) => {
    // 旧版本只写过引导与工作区配置，模型配置由启动补丁强制；升级后补种一次。
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(profilePath(home), [
      '# managed by KnoWeave',
      '- id: ui-settings-general',
      '  config:',
      "    welcomeNoticeVersion: '2026-09-28.1'",
      '',
    ].join('\n'), 'utf8')
    ensureQuietProfile()
    const upgraded = await readFile(profilePath(home), 'utf8')
    assert.match(upgraded, /- id: agent-default-model/)
    assert.match(upgraded, /- id: llm-pi-ai/)
    assert.match(upgraded, /- id: ui-settings-models/)
  })
})

test('the launch patch keeps the models page, drops account feedback/login and never forces the model', async () => {
  await withDshHome(async (home) => {
    ensureQuietProfile()
    const patchPath = ensureBrandingPatch()
    const patch = await readFile(patchPath, 'utf8')
    // 模型设置页恢复：启动补丁不再禁用 ui-settings-models。
    assert.ok(!patch.includes('ui-settings-models'))
    // 左下角“更多”里的意见反馈与登录随账号 UI 一并移除，设置按钮由设置壳默认提供。
    assert.match(patch, /- id: ui-settings-account\n  disabled: true/)
    // 上游消息反馈（会连同会话日志提交 DeepSeek）禁用，由知织按钮接管。
    assert.match(patch, /- id: ui-message-feedback\n  disabled: true/)
    // 官方 DeepSeek 供应商与账号登录仍不进入嵌入式对话。
    assert.match(patch, /- id: llm-deepseek\n  disabled: true/)
    assert.match(patch, /- id: llm-deepseek-account\n  disabled: true/)
    // 模型选择以可编辑 profile 为准：启动补丁不再强制模型，也不再注入强制选择插件。
    assert.ok(!patch.includes('agent-default-model'))
    assert.ok(!patch.includes('llm-pi-ai'))
    assert.ok(!patch.includes('knowweave-configured-model'))
    // 知识库工具与知织界面 branding 不受影响。
    assert.match(patch, /- id: knowweave-knowledge/)
    assert.match(patch, /- id: knowweave-branding/)
  })
})
