import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testWorkspace } from '../tests/helpers.js'
import { createServer } from '../src/app/server.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { stopIngestWorker } from '../src/core/ingestion.js'
const workspace = await testWorkspace()
const app = await createServer(); app.log.level='silent'
const directory = await mkdtemp(join(tmpdir(),'knowweave-browser-'))
const chrome = process.env.KNOWWEAVE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let browser: ReturnType<typeof spawn> | undefined
let socket: WebSocket | undefined
const errors: string[]=[]
try {
  await ingestParsed(workspace.principal,parseText('知织支持本地文档检索，并为回答提供原文引用。','浏览器验收文档'),{sourceType:'text',uri:'browser:fixture'})
  const url=await app.listen({host:'127.0.0.1',port:0})
  const folder=join(directory,'sync-fixture')
  await mkdir(folder)
  await writeFile(join(folder,'local.txt'),'目录同步验收文档，内容只发送到隔离本地服务。')
  const sync=()=>new Promise<string>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','scripts/sync-directory.ts',folder],{env:{...process.env,KNOWWEAVE_URL:url,KNOWWEAVE_TOKEN:'owner-token'},stdio:['ignore','pipe','pipe']})
    let output='';child.stdout.on('data',value=>{output+=value});child.stderr.on('data',value=>{output+=value})
    child.once('error',reject);child.once('exit',code=>code===0?resolve(output):reject(new Error(output)))
  })
  await sync()
  const cached=await readFile(join(folder,'.knowweave-sync.json'),'utf8')
  assert.ok(cached.includes('local.txt'))
  await sync()
  browser=spawn(chrome,['--headless=new','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-extensions','--no-first-run','--no-default-browser-check','--password-store=basic','--use-mock-keychain','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank'],{stdio:'ignore'})
  let port=''
  for(let i=0;i<200;i+=1) {
    try { port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0]!;break } catch { await new Promise(resolve=>setTimeout(resolve,100)) }
  }
  assert.ok(port,'Chrome debugging endpoint did not start')
  const target=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json() as {webSocketDebuggerUrl:string}
  socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve,reject)=>{socket!.addEventListener('open',()=>resolve(),{once:true});socket!.addEventListener('error',reject,{once:true})})
  let serial=0
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
  socket.addEventListener('message',(event)=>{
    const message=JSON.parse(String(event.data))
    if(message.id) { const entry=pending.get(message.id);pending.delete(message.id);message.error?entry?.reject(new Error(message.error.message)):entry?.resolve(message.result) }
    if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text+': '+(message.params.exceptionDetails.exception?.description||''))
  })
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{
    const id=++serial
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method))},15000)
    pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}})
    socket!.send(JSON.stringify({id,method,params}))
  })
  const evaluate=async(expression:string)=>{
    const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text)
    return result.result.value
  }
  const until=async(expression:string)=>{
    for(let i=0;i<150;i+=1){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100))}
    throw new Error('Page condition timed out: '+expression)
  }
  await call('Page.enable');await call('Runtime.enable')
  await call('Page.navigate',{url})
  await until("document.querySelector('#native-chat-retry')?.hidden === false")
  assert.equal(await evaluate("document.querySelector('.nav-item[data-page=chat]').textContent.trim()"), '对话')
  assert.equal(await evaluate("document.querySelector('#native-chat-frame').hidden"), true)
  await evaluate("document.querySelector('.nav-item[data-page=ask]').click()")
  await until("document.querySelector('#question') && typeof runAsk === 'function'")
  await evaluate("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());document.querySelector('#question').value='知织支持什么？';document.querySelector('#ask-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
  await until("document.querySelector('#ask-result [data-cite]') !== null")
  assert.equal(await evaluate("document.querySelector('#native-chat-frame').hasAttribute('src')"),false)
  await evaluate("document.querySelector('#ask-result [data-cite]').click()")
  await until("document.querySelector('#doc-dialog').open && document.querySelector('#source-highlight-target') !== null")
  const highlighted=await evaluate("document.querySelector('#source-highlight-target').textContent")
  assert.match(highlighted,/知织支持本地文档检索/)
  await evaluate("document.querySelector('[data-doc-action=reindex]').click()")
  await until("document.querySelector('[data-doc-action=reindex]')?.disabled === false")
  assert.equal(await evaluate("document.querySelector('.doc-source').textContent.includes('知织支持本地文档检索')"),true)
  await evaluate("window.prompt=()=> '0.5';document.querySelector('[data-doc-action=policy]').click()")
  await until("document.querySelector('[data-doc-action=policy]')?.disabled === false")
  await evaluate("document.querySelector('#doc-dialog').close();loadEvals()")
  await until("document.querySelector('#import-eval') !== null")
  await evaluate(`window.prompt=()=>JSON.stringify([{question:'浏览器导入评测题',expected_docs:['浏览器验收文档'],expected_keywords:['引用'],should_refuse:false}]);document.querySelector('#import-eval').click()`)
  await until("document.querySelector('#ops-body').textContent.includes('浏览器导入评测题')")
  assert.deepEqual(errors,[])
  await evaluate("document.querySelector('#ask-result [data-cite]').click()")
  await until("document.querySelector('#source-highlight-target') !== null")
  const screenshot=await call('Page.captureScreenshot',{format:'png'})
  const artifact=join(directory,'knowledge-chat.png')
  await writeFile(artifact,Buffer.from(screenshot.data,'base64'))
  console.log(JSON.stringify({browser:'Chrome headless',directoryCli:true,nativeChatDisabledState:true,researchChat:true,citation:true,sourceHighlight:true,reindex:true,sourcePolicy:true,evaluationImport:true,javascriptErrors:errors,artifact}))
} finally {
  socket?.close()
  if(browser && browser.exitCode===null)browser.kill('SIGKILL')
  await stopIngestWorker();await app.close();await workspace.close()
}
