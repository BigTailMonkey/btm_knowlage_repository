import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { settings } from '../src/config.js'
import { query, closePool } from '../src/db/index.js'

const artifact=resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('用法：node --import tsx scripts/inspect-evaluation.ts /path/to/evaluation.json（仅在评测进程结束后运行）')
settings.dataDir=dirname(artifact)
settings.databaseUrl=''
try {
  const evaluation=JSON.parse(await readFile(artifact,'utf8'))
  const calls=await query<{trace_id:string;params:Record<string,unknown>;output:{ok?:boolean;error?:string};status:string}>("SELECT trace_id,params,output,status FROM trace_spans WHERE stage='answer.generate'")
  const verification=await query<{output:{supported?:boolean}}>("SELECT output FROM trace_spans WHERE stage='answer.verify'")
  const traces=await query<{id:string;status:string;meta:{answer_strategy?:string}}>("SELECT id,status,meta FROM traces WHERE feature='eval'")
  const strategyOf=(row:typeof traces[number])=>row.status==='refused'?'refused':row.meta.answer_strategy || 'unknown'
  const strategies=Object.fromEntries([...new Set(traces.map(strategyOf))].map(strategy=>[strategy,traces.filter(row=>strategyOf(row)===strategy).length]))
  const report={...evaluation,corpus_version:evaluation.corpus_version ?? (evaluation.results[0]?.question.includes('已提供片段')?2:1),model_verification:{generation_calls:calls.length,generation_successes:calls.filter(row=>row.output.ok===true).length,
    verification_calls:verification.length,verification_supported:verification.filter(row=>row.output.supported===true).length,strategies,
    models:[...new Set(calls.map(row=>String(row.params.model)))],providers:[...new Set(calls.map(row=>String(row.params.provider)))],
    errors:calls.filter(row=>!row.output.ok).map(row=>row.output.error).slice(0,5)},
    results:evaluation.results.map((item:any)=>({...item,strategy:traces.find(row=>row.id===item.trace_id)?.meta.answer_strategy,
      model_succeeded:calls.find(row=>row.trace_id===item.trace_id)?.output.ok===true}))}
  let json=JSON.stringify(report,null,2)
  for(const secret of [settings.modelApiKey,settings.embeddingApiKey,settings.rerankApiKey]) if(secret)json=json.replaceAll(secret,'[redacted]')
  const output=join(dirname(artifact),'verified-evaluation.json')
  await writeFile(output,json)
  console.log(JSON.stringify({metrics:report.metrics,model_verification:report.model_verification,artifact:output}))
} finally {await closePool()}
