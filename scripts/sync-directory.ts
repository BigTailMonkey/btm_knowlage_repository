import { opendir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, join, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'
const directory = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
if (!directory) throw new Error('用法：npm run sync:directory -- /path/to/notes [--watch]')
const root = resolve(directory)
const base = (process.env.KNOWWEAVE_URL || 'http://127.0.0.1:8730').replace(/\/$/,'')
const headers = { authorization: `Bearer ${process.env.KNOWWEAVE_TOKEN || 'owner-token'}` }
const cachePath = join(root,'.knowweave-sync.json')
let cache: Record<string,{ hash: string; docId: string; version: number }> = {}
try { cache = JSON.parse(await readFile(cachePath,'utf8')) } catch { /* first sync */ }
const extensions = new Set(['.txt','.md','.markdown','.html','.htm','.pdf','.docx','.csv','.json','.yaml','.yml','.png','.jpg','.jpeg','.tiff','.tif','.webp','.bmp','.wav','.mp3','.m4a','.mp4','.webm','.ogg','.flac'])
let stopping = false
process.once('SIGINT',()=>{ stopping=true }); process.once('SIGTERM',()=>{ stopping=true })
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(base+'/api/v1'+path,{signal:AbortSignal.timeout(30_000),...init,headers:{...headers,...init.headers}})
  if (!response.ok) throw new Error(`同步API ${response.status}: ${(await response.text()).slice(0,200)}`)
  return response.json() as Promise<any>
}
async function scan(path: string, files: string[]) {
  for await (const entry of await opendir(path)) {
    if (entry.name.startsWith('.') || ['node_modules','dist','__pycache__'].includes(entry.name) || entry.isSymbolicLink()) continue
    const target=join(path,entry.name)
    if (entry.isDirectory()) await scan(target,files)
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) files.push(target)
  }
}
do {
  const files: string[]=[]
  await scan(root,files)
  for (const file of files.sort()) {
    if (stopping) break
    try {
    if ((await stat(file)).size>30*1024*1024) { console.error(`跳过超过30MB文件：${relative(root,file)}`); continue }
    const data=await readFile(file)
    const hash=createHash('sha256').update(data).digest('hex')
    const key=relative(root,file)
    const saved=cache[key]
    if (saved?.hash===hash) {
      try { if ((await api('/documents/'+encodeURIComponent(saved.docId))).document.version===saved.version) continue } catch { /* reupload removed/outdated source */ }
    }
    const form=new FormData()
    const source=createHash('sha256').update(root).digest('hex').slice(0,16)
    form.append('source_uri',`directory:${source}/${key}`)
    form.append('title',key)
    form.append('file',new Blob([data]),key.split('/').at(-1)!)
    const submitted=await api('/documents/upload',{method:'POST',body:form})
    let result: any
    for (let attempts=0;attempts<600 && !stopping;attempts+=1) {
      const jobs=await api('/documents/jobs')
      result=jobs.items.find((job:any)=>job.job_id===submitted.job_id)
      if (result?.status==='done'||result?.status==='failed') break
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
    if (result?.status!=='done') throw new Error(`${key}: ${result?.error||'入库尚未完成，可在页面任务列表查看'}`)
    cache[key]={hash,docId:result.doc_id,version:result.version}
    await writeFile(cachePath,JSON.stringify(cache,null,2),{mode:0o600})
    console.log(JSON.stringify({file:key,version:result.version,status:result.status}))
    } catch (error) {
      console.error(JSON.stringify({file:relative(root,file),error:error instanceof Error?error.message:String(error)}))
      process.exitCode=1
    }
  }
  if (!process.argv.includes('--watch')||stopping) break
  for(let i=0;i<10&&!stopping;i+=1) await new Promise(resolve=>setTimeout(resolve,1000))
} while(!stopping)
