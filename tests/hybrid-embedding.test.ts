import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEmbedder } from '../src/adapters/embeddings/index.js'
import { settings } from '../src/config.js'

test('hybrid embedding retains learned sparse and service indices; invalid vectors fail closed',async()=>{
  const originalFetch=globalThis.fetch
  const previous={embeddingBaseUrl:settings.embeddingBaseUrl,embeddingApiKey:settings.embeddingApiKey,embeddingDim:settings.embeddingDim}
  Object.assign(settings,{embeddingBaseUrl:'http://model-fixture',embeddingApiKey:'',embeddingDim:2})
  try{
    const adapter=createEmbedder('hybrid')
    globalThis.fetch=async()=>Response.json({data:[{index:1,embedding:[0,1],sparse_embedding:{'9':0.8}},{index:0,embedding:[1,0],sparse_embedding:{'2':0.3}}]})
    const vectors=await adapter.embedMany(['alpha','beta'])
    assert.deepEqual(vectors.map(v=>v.sparse),[{'2':0.3},{'9':0.8}])
    assert.deepEqual(vectors.map(v=>v.dense),[[1,0],[0,1]])
    globalThis.fetch=async()=>Response.json({data:[{index:0,embedding:[1,0]}]})
    await assert.rejects(adapter.embed('alpha'),/learned sparse/)
    globalThis.fetch=async()=>Response.json({data:[{index:0,embedding:[1],sparse_embedding:{'2':1}}]})
    await assert.rejects(adapter.embed('alpha'),/维度/)
  }finally{globalThis.fetch=originalFetch;Object.assign(settings,previous)}
})
