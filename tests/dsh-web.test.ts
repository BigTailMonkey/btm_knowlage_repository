import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dshWebStatus, ensureDshWeb } from '../src/adapters/dsh-web/index.js'
import { settings } from '../src/config.js'
import type { Principal } from '../src/core/security.js'

test('reuses a live DSH process instead of starting another one', async () => {
  const original = {
    dshWebEnabled: settings.dshWebEnabled,
    dshWebHome: settings.dshWebHome,
    dshWebPort: settings.dshWebPort,
    model: settings.model,
    modelApiKey: settings.modelApiKey,
    modelBaseUrl: settings.modelBaseUrl,
  }
  const home = await mkdtemp(join(tmpdir(), 'knowweave-dsh-recovery-'))
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(401, {
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

    const status = dshWebStatus()
    assert.equal(status.ready, true)
    assert.equal(status.managed, false)
    assert.equal(status.lastError, null)
    assert.equal(status.url, `http://127.0.0.1:${address.port}/`)
    assert.equal(requests, 1)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'knowweave-runtime.json'), 'utf8')), { url: status.url })
  } finally {
    Object.assign(settings, original)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
