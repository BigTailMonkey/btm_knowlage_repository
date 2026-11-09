import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServer } from '../src/app/server.js'
import { query, queryOne } from '../src/db/index.js'
import { testWorkspace } from './helpers.js'

test('DELETE /entities/:id removes subject facts, unlinks object facts and closes reviews', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  const tenant = workspace.principal.tenantId
  const acl = '["tenant:public"]'
  try {
    await query(
      `INSERT INTO entities(id,tenant_id,type,canonical_name,normalized_name,acl_principals)
       VALUES ('ent-orchid',$1,'product','Orchid','orchid',$2::jsonb),
              ('ent-aurora',$1,'product','Aurora','aurora',$2::jsonb),
              ('ent-acme',$1,'org','Acme','acme',$2::jsonb)`,
      [tenant, acl],
    )
    await query(
      `INSERT INTO entity_aliases(id,entity_id,alias,normalized_alias,source)
       VALUES ('ali-orchid','ent-orchid','Orchid','orchid','extraction')`,
    )
    await query(
      `INSERT INTO facts(id,tenant_id,subject_id,predicate,object_id,object_literal,status,confidence,acl_principals)
       VALUES ('fact-subject',$1,'ent-orchid','uses','ent-aurora',NULL,'active',0.9,$2::jsonb),
              ('fact-object',$1,'ent-acme','depends on','ent-orchid',NULL,'active',0.8,$2::jsonb),
              ('fact-literal',$1,'ent-aurora','version',NULL,'1.0','active',0.8,$2::jsonb)`,
      [tenant, acl],
    )
    await query(
      `INSERT INTO fact_evidence(id,fact_id,doc_id,quote) VALUES ('ev-subject','fact-subject','doc-1','Orchid uses Aurora.')`,
    )
    await query(
      `INSERT INTO review_queue(id,tenant_id,kind,title,payload,status)
       VALUES ('rev-open',$1,'fact_validation','Orchid uses Aurora',$2::jsonb,'open')`,
      [tenant, JSON.stringify({ subject: 'Orchid', new_fact_id: 'fact-subject', old_fact_ids: [] })],
    )

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/entities/ent-orchid',
      headers: workspace.headers,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.name, 'Orchid')
    assert.equal(body.facts_removed, 1)
    assert.equal(body.facts_unlinked, 1)
    assert.equal(body.reviews_closed, 1)

    assert.equal((await query('SELECT id FROM entities WHERE id = $1', ['ent-orchid'])).length, 0)
    assert.equal((await query('SELECT id FROM entity_aliases WHERE entity_id = $1', ['ent-orchid'])).length, 0)
    assert.equal((await query('SELECT id FROM facts WHERE id = $1', ['fact-subject'])).length, 0)
    assert.equal((await query('SELECT id FROM fact_evidence WHERE fact_id = $1', ['fact-subject'])).length, 0)

    const unlinked = await queryOne<{ object_id: string | null; object_literal: string | null }>(
      'SELECT object_id, object_literal FROM facts WHERE id = $1',
      ['fact-object'],
    )
    assert.equal(unlinked!.object_id, null)
    assert.equal(unlinked!.object_literal, 'Orchid')

    const literal = await queryOne<{ object_id: string | null; object_literal: string | null }>(
      'SELECT object_id, object_literal FROM facts WHERE id = $1',
      ['fact-literal'],
    )
    assert.equal(literal!.object_id, null)
    assert.equal(literal!.object_literal, '1.0')

    const review = await queryOne<{ status: string }>('SELECT status FROM review_queue WHERE id = $1', ['rev-open'])
    assert.equal(review!.status, 'resolved')

    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/entities/ent-orchid', headers: workspace.headers })
    assert.equal(missing.statusCode, 404)
  } finally {
    await app.close()
    await workspace.close()
  }
})
