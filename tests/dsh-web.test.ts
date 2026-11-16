import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dshWebStatus, ensureDshWeb } from '../src/adapters/dsh-web/index.js'
import { settings } from '../src/config.js'
import type { Principal } from '../src/core/security.js'

test('only reuses a live DSH process that disables the sidebar and its services', async () => {
  const original = {
    dshWebEnabled: settings.dshWebEnabled,
    dshWebHome: settings.dshWebHome,
    dshWebPort: settings.dshWebPort,
    model: settings.model,
    modelApiKey: settings.modelApiKey,
    modelBaseUrl: settings.modelBaseUrl,
  }
  const home = await mkdtemp(join(tmpdir(), 'knowweave-dsh-recovery-'))
  let sidebarDisabled = false
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    const policy = request.url === '/_knowweave/chat-policy/sidebar-disabled-v1'
    response.writeHead(policy && sidebarDisabled ? 204 : 401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  try {
    Object.assign(settings, {
      dshWebEnabled: true,
      dshWebHome: home,
      dshWebPort: address.port,
      model: 'test-model',
      modelApiKey: 'test-key',
      modelBaseUrl: 'http://model.invalid/v1',
    })
    const principal: Principal = {
      userId: 'u_owner', tenantId: 'tn_test', name: 'Owner', role: 'owner', groups: [], token: 'kb-token',
    }
    await ensureDshWeb(principal)
    assert.equal(dshWebStatus().ready, false)
    assert.equal(dshWebStatus().url, null)
    assert.match(dshWebStatus().lastError ?? '', /禁用右侧栏/)
    assert.deepEqual(requests, ['/', '/_knowweave/chat-policy/sidebar-disabled-v1'])

    sidebarDisabled = true
    requests.length = 0
    await ensureDshWeb(principal)

    const status = dshWebStatus()
    assert.equal(status.ready, true)
    assert.equal(status.managed, false)
    assert.equal(status.lastError, null)
    assert.equal(status.url, `http://127.0.0.1:${address.port}/`)
    assert.deepEqual(requests, ['/', '/_knowweave/chat-policy/sidebar-disabled-v1'])
    assert.deepEqual(JSON.parse(await readFile(join(home, 'knowweave-runtime.json'), 'utf8')), { url: status.url })
  } finally {
    Object.assign(settings, original)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
