import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testWorkspace } from './helpers.js'
import { createServer } from '../src/app/server.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { queryOne } from '../src/db/index.js'

test('document API returns exact historical source and persisted UTF-16 citation ranges', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  try {
    const first = await ingestParsed(workspace.principal, parseText('第一版😀：保留原文与引用。', '版本文档'), { sourceType: 'text', uri: 'test:source' })
    const old = await queryOne<{ id: string }>('SELECT id FROM document_versions WHERE doc_id=$1', [first.document_id])
    await ingestParsed(workspace.principal, parseText('第二版：内容已经更新。', '版本文档'), { sourceType: 'text', uri: 'test:source' })
    const historical = await app.inject({ method: 'GET', url: `/api/v1/documents/${first.document_id}?version_id=${old!.id}`, headers: workspace.headers })
    assert.equal(historical.statusCode, 200)
    const data = historical.json()
    assert.equal(data.source.text, '第一版😀：保留原文与引用。')
    assert.equal(data.source.version, 1)
    assert.equal(data.source.coordinate_system, 'normalized-text-utf16')
    assert.equal(data.versions.length, 2)
    for (const chunk of data.chunks) {
      assert.equal(chunk.version_id, old!.id)
      assert.ok(chunk.spans.length)
      for (const span of chunk.spans) assert.ok(chunk.text.includes(data.source.text.slice(span.start, span.end)))
    }
    const current = await app.inject({ method: 'GET', url: `/api/v1/documents/${first.document_id}`, headers: workspace.headers })
    assert.equal(current.json().source.text, '第二版：内容已经更新。')
    const invalid = await app.inject({ method: 'GET', url: `/api/v1/documents/${first.document_id}?version_id=missing`, headers: workspace.headers })
    assert.equal(invalid.statusCode, 404)
  } finally { await app.close(); await workspace.close() }
})
