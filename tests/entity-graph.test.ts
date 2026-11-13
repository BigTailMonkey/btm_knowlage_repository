import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServer } from '../src/app/server.js'
import { relationOf } from '../src/core/relation-types.js'
import { query } from '../src/db/index.js'
import { clearKnowledge, testWorkspace } from './helpers.js'

test('predicates collapse into stable relation types', () => {
  const cases: Array<[string, string]> = [
    ['计算方式为', 'definition'],
    ['计算公式为', 'definition'],
    ['2030年目标为', 'target'],
    ['宣传栏不少于', 'threshold'],
    ['每月至少举办', 'frequency'],
    ['治疗疗程为', 'frequency'],
    ['牵头推进', 'responsible'],
    ['包括', 'composition'],
    ['应当具备', 'requirement'],
    ['组织专家编写', 'action'],
    ['适用于', 'applicability'],
    ['对6岁儿童增加1剂', 'other'],
  ]
  for (const [predicate, key] of cases) assert.equal(relationOf(predicate).key, key, predicate)
  // 未归类的谓语在图上有兜底展示名，不会被吞掉
  assert.equal(relationOf('对6岁儿童增加1剂').label, '其它')
})

test('entity graph focuses on one entity, keeps hops on the ring and values as attributes', async () => {
  const workspace = await testWorkspace()
  const app = await createServer()
  app.log.level = 'silent'
  try {
    await clearKnowledge()
    const tenant = workspace.principal.tenantId
    const acl = '["tenant:public"]'
    await query(
      `INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,type,acl_principals) VALUES
        ('metric',$1,'高血压患者规范管理率','高血压患者规范管理率','concept',$2::jsonb),
        ('center',$1,'乡镇卫生院','乡镇卫生院','org',$2::jsonb),
        ('lecture',$1,'健康知识讲座','健康知识讲座','concept',$2::jsonb),
        ('province',$1,'山东省','山东省','org',$2::jsonb)`,
      [tenant, acl],
    )
    await query(
      `INSERT INTO facts(id,tenant_id,subject_id,predicate,object_id,object_literal,status,confidence,acl_principals) VALUES
        ('definition',$1,'metric','计算方式为','lecture',NULL,'active',0.95,$2::jsonb),
        ('responsible',$1,'metric','由乡镇卫生院负责','center',NULL,'active',0.90,$2::jsonb),
        ('frequency',$1,'center','每月至少举办','lecture',NULL,'disputed',0.85,$2::jsonb),
        ('target',$1,'metric','2030年目标为',NULL,'90%','active',0.90,$2::jsonb),
        ('province',$1,'province','牵头推进','center',NULL,'active',0.80,$2::jsonb)`,
      [tenant, acl],
    )

    const inject = async (url: string) => {
      const response = await app.inject({ url: '/api/v1' + url, headers: workspace.headers })
      return { status: response.statusCode, body: response.json() }
    }

    const oneHop = await inject('/graph?focus=metric&hops=1')
    assert.equal(oneHop.status, 200)
    const one = oneHop.body
    assert.equal(one.focus, 'metric')
    assert.deepEqual(one.nodes.map((node: { id: string; hop: number }) => [node.id, node.hop]).sort(), [
      ['center', 1], ['lecture', 1], ['metric', 0],
    ])
    assert.deepEqual(one.edges.map((edge: { id: string }) => edge.id).sort(), ['definition', 'responsible'])
    // 每条关系都带归一后的类型，边标签不再是一条长句
    const definition = one.edges.find((edge: { id: string }) => edge.id === 'definition')
    assert.equal(definition.relation.key, 'definition')
    assert.equal(definition.relation.label, '定义/口径')
    assert.equal(definition.target, 'lecture')
    // 字面值不占节点，只作为主语属性
    assert.ok(!one.nodes.some((node: { name: string }) => node.name === '90%'))
    const metric = one.nodes.find((node: { id: string }) => node.id === 'metric')
    assert.deepEqual(metric.attrs.map((attr: { fact_id: string; value: string }) => [attr.fact_id, attr.value]), [['target', '90%']])
    assert.equal(metric.attrs[0].relation.label, '目标值')

    const twoHops = await inject('/graph?focus=metric&hops=2')
    assert.equal(twoHops.body.nodes.find((node: { id: string }) => node.id === 'province')?.hop, 2)
    assert.ok(twoHops.body.edges.some((edge: { id: string }) => edge.id === 'province'))

    const missing = await inject('/graph?focus=missing')
    assert.equal(missing.status, 404)

    const legacy = await inject('/graph')
    assert.equal(legacy.status, 200)
    assert.ok(Array.isArray(legacy.body.nodes))

    await query(
      `INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,type,acl_principals) VALUES
        ('isolated',$1,'疫苗覆盖率','疫苗覆盖率','concept',$2::jsonb),
        ('private',$1,'未公开指标','未公开指标','concept','["user:another"]'::jsonb)`,
      [tenant, acl],
    )
    await query(
      `INSERT INTO facts(id,tenant_id,subject_id,predicate,object_id,object_literal,status,confidence,acl_principals) VALUES
        ('isolated-target',$1,'isolated','目标为',NULL,'95%','active',0.90,$2::jsonb),
        ('private-link',$1,'isolated','相关于','private',NULL,'active',0.90,$2::jsonb),
        ('hidden-link',$1,'isolated','相关于','metric',NULL,'disputed',0.50,$2::jsonb)`,
      [tenant, acl],
    )
    const overview = await inject('/graph?scope=overview')
    assert.equal(overview.status, 200)
    assert.equal(overview.body.focus, null)
    assert.deepEqual(overview.body.nodes.map((node: { id: string }) => node.id).sort(),
      ['center', 'isolated', 'lecture', 'metric', 'province'])
    assert.deepEqual(overview.body.edges.map((edge: { id: string }) => edge.id).sort(),
      ['definition', 'frequency', 'province', 'responsible'])
    assert.equal(overview.body.nodes.find((node: { id: string }) => node.id === 'isolated').attrs[0].value, '95%')
  } finally {
    await app.close()
    await workspace.close()
  }
})
