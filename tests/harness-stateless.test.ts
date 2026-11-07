import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DshHarness } from '../src/adapters/harness/index.js'

test('independent completions do not reuse conversational sessions',async()=>{
  const harness=new DshHarness()
  const sessions:string[]=[]
  harness.ask=async(session)=>{sessions.push(session);return{text:'{}',tokensIn:0,tokensOut:0,latencyMs:0,model:'fixture',provider:'fixture',ok:true,error:null}}
  await harness.complete('verify one');await harness.complete('verify two')
  assert.equal(sessions.length,2)
  assert.notEqual(sessions[0],sessions[1])
  assert.ok(sessions.every(id=>id.startsWith('completion-')))
})
