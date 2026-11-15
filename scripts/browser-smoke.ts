import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testWorkspace } from '../tests/helpers.js'
import { createServer } from '../src/app/server.js'
import { ingestParsed } from '../src/core/ingestion.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { harness } from '../src/adapters/harness/index.js'
import { stopIngestWorker } from '../src/core/ingestion.js'
import { query, queryOne } from '../src/db/index.js'
const workspace = await testWorkspace()
harness.ask = async () => ({
  text: '知织支持本地文档检索，并为回答提供原文引用。[1]',
  model: 'browser-fixture', provider: 'test', ok: true, error: null, tokensIn: 0, tokensOut: 0, latencyMs: 0,
})
const app = await createServer(); app.log.level='silent'
const directory = await mkdtemp(join(tmpdir(),'knowweave-browser-'))
const chrome = process.env.KNOWWEAVE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let browser: ReturnType<typeof spawn> | undefined
let socket: WebSocket | undefined
const errors: string[]=[]
try {
  const source = await ingestParsed(workspace.principal,parseText('知织支持本地文档检索，并为回答提供原文引用。','浏览器验收文档'),{sourceType:'pdf',uri:'browser:fixture'})
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> >>',
  ]
  let pdf = '%PDF-1.7\n'
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`
  await query('UPDATE jobs SET payload = payload || $2::jsonb WHERE id = $1', [
    source.job_id,
    JSON.stringify({ source: 'file', request: { filename: 'fixture.pdf', data: Buffer.from(pdf).toString('base64') } }),
  ])
  const chunk = await queryOne<{ id: string }>('SELECT id FROM chunks WHERE version_id=$1 AND is_parent=false', [source.version_id])
  const citation = `/${source.document_id}/${source.version_id}/${chunk!.id}`
  const brandingUrl = new URL('../src/adapters/dsh-web/branding/index.mjs', import.meta.url)
  const { transformIndex } = await import(brandingUrl.href)
  app.get('/browser-fixture-native', async (_request, reply) => reply.type('text/html; charset=utf-8').send(transformIndex(`
    <!doctype html><html><head><meta charset="utf-8"><title>DSH fixture</title></head><body>
    <div data-conversation-content data-conversation-session="existing" data-content-phase="active">
      <a href="https://citation.knowweave.invalid${citation}">浏览器验收文档</a>
    </div>
    <label>接口类型<select id="fixture-protocol"><option value="a">接口 A</option><option value="b">接口 B</option></select></label>
    <input id="fixture-date" type="date" aria-label="规则日期">
    <input id="fixture-color" type="color" aria-label="背景颜色">
    <input id="fixture-checkbox" type="checkbox" aria-label="启用">
    <script>window.addEventListener('message', (event) => {
      const conversation = document.querySelector('[data-conversation-content]');
      if (event.data === 'new') {
        conversation.dataset.conversationSession = 'new';
        conversation.dataset.contentPhase = 'hero';
      } else if (event.data === 'click') conversation.querySelector('a').click();
    });
    document.addEventListener('change', (event) => {
      if (event.target.matches('[data-kw-picker-source]')) event.target.dataset.saved = event.target.value;
    });</script></body></html>
  `)))
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
  const call=(method:string,params:Record<string,unknown>={},sessionId?:string)=>new Promise<any>((resolve,reject)=>{
    const id=++serial
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method))},15000)
    pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}})
    socket!.send(JSON.stringify({id,method,params,sessionId}))
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
  await call('Page.navigate', { url: `${url}/review` })
  await until("document.querySelector('#page-review.active #review-list')?.textContent.includes('暂无待审')")
  assert.equal(await evaluate('location.pathname + location.search'), '/review')
  assert.equal(await evaluate("document.querySelector('.nav-item[data-page=review]').getAttribute('aria-current')"), 'page')
  await call('Page.reload')
  await until("performance.getEntriesByType('navigation')[0]?.type === 'reload' && document.querySelector('#page-review.active #review-list')?.textContent.includes('暂无待审')")
  await evaluate("document.querySelector('.nav-item[data-page=library]').click()")
  await until("location.pathname === '/library' && document.querySelector('#page-library.active')")
  await evaluate('history.back()')
  await until("location.pathname === '/review' && document.querySelector('#page-review.active')")
  await evaluate('history.forward()')
  await until("location.pathname === '/library' && document.querySelector('#page-library.active')")
  await evaluate("document.querySelector('#tour').hidden = true; document.querySelector('#token-select').focus(); document.querySelector('#token-select').click()")
  assert.equal(await evaluate("document.querySelector('#token-select-panel:popover-open [role=option]').textContent"), '何道伟 · owner')
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  assert.equal(await evaluate("document.activeElement.id === 'token-select' && !document.querySelector('#token-select-panel:popover-open')"), true)
  await evaluate("openEntityDialog({id:'fixture',name:'验收实体',type:'concept'}); document.querySelector('#entity-type').focus(); document.querySelector('#entity-type').click()")
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
  assert.equal(await evaluate("document.querySelector('#entity-type').value"), 'literal')
  await evaluate("document.querySelector('#entity-dialog').close()")
  await call('Page.navigate',{url})
  await until("document.querySelector('#native-chat-retry')?.hidden === false")
  assert.equal(await evaluate("document.querySelector('.nav-item[data-page=chat]').textContent.trim()"), '对话')
  assert.equal(await evaluate("document.querySelector('#native-chat-frame').hidden"), true)
  const fixtureUrl = url.replace('127.0.0.1', 'localhost') + '/browser-fixture-native'
  await evaluate(`new Promise(resolve => {
    const frame = document.querySelector('#native-chat-frame');
    frame.addEventListener('load', () => resolve(true), { once: true });
    frame.hidden = false;
    frame.src = ${JSON.stringify(fixtureUrl)};
  })`)
  const nativeTarget = (await call('Target.getTargets')).targetInfos.find((target: { url: string }) => target.url === fixtureUrl)
  assert.ok(nativeTarget, 'cross-site native fixture has a browser target')
  const { sessionId: nativeSession } = await call('Target.attachToTarget', { targetId: nativeTarget.targetId, flatten: true })
  const nativeEval = async (expression: string) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true }, nativeSession)
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description)
    return result.result.value
  }
  for (let i = 0; i < 100 && !await nativeEval("document.querySelectorAll('.kw-embedded-picker').length === 3"); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const bridged = await nativeEval(`({
    title: document.title,
    library: typeof window.KnowWeavePickers,
    controls: Array.from(document.querySelectorAll('[data-kw-picker-source]'), node => [node.id, getComputedStyle(node).display]),
  })`)
  assert.deepEqual(bridged, { title: '知织', library: 'object', controls: [
    ['fixture-protocol', 'none'], ['fixture-date', 'none'], ['fixture-color', 'none'],
  ] })
  assert.equal(await nativeEval("getComputedStyle(document.querySelector('#fixture-checkbox')).appearance"), 'none')
  assert.equal(await nativeEval(`(() => {
    const trigger = document.querySelector('#fixture-protocol + .kw-embedded-picker button');
    trigger.click();
    document.querySelector('.kw-picker-panel:popover-open [data-index="1"]').click();
    return document.querySelector('#fixture-protocol').dataset.saved;
  })()`), 'b')
  assert.equal(await nativeEval(`(() => {
    document.querySelector('#fixture-color + .kw-embedded-picker button').click();
    document.querySelector('.kw-picker-panel:popover-open [data-color="#16a34a"]').click();
    return document.querySelector('#fixture-color').dataset.saved;
  })()`), '#16a34a')
  await evaluate(`window.postMessage({ type: 'knowweave:open-citation', path: ${JSON.stringify(citation)} }, location.origin)`)
  assert.equal(await evaluate("document.querySelector('#chat-citation').hidden"), true)
  const tellNative = (message: string) => evaluate(`document.querySelector('#native-chat-frame').contentWindow.postMessage(${JSON.stringify(message)}, ${JSON.stringify(new URL(fixtureUrl).origin)})`)
  await tellNative('click')
  await until("document.querySelector('#chat-citation-body .pdf-page.is-rendered')")
  assert.equal(await evaluate("document.querySelector('#chat-citation-title').textContent"), '浏览器验收文档')
  assert.equal(await evaluate("document.querySelector('#chat-citation-toolbar').hidden"), false)
  assert.equal(await evaluate("document.querySelector('#chat-citation-file').getAttribute('aria-pressed')"), 'true')
  await evaluate("document.querySelector('#chat-citation-text').click()")
  await until("document.querySelector('#chat-citation-body mark')?.textContent.includes('知织支持本地文档检索')")
  await tellNative('new')
  await until("document.querySelector('#chat-citation').hidden && document.querySelector('#chat-citation-body').childElementCount === 0")
  await evaluate("resetNativeChat()")
  await evaluate("document.querySelector('.nav-item[data-page=ask]').click()")
  await until("document.querySelector('#question') && typeof runAsk === 'function'")
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate("document.querySelector('#tour').hidden = true; document.querySelector('#as-of').click(); document.querySelector('.kw-picker-panel:popover-open input').value = '2025-02-29'; document.querySelector('.kw-picker-panel:popover-open .kw-picker-footer button').click()")
  assert.equal(await evaluate("document.querySelector('.kw-picker-panel:popover-open input').getAttribute('aria-invalid')"), 'true')
  assert.equal(await evaluate(`(() => {
    const box = document.querySelector('.kw-picker-panel:popover-open').getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  })()`), true)
  await evaluate("document.querySelector('.kw-picker-panel:popover-open input').value = '2024-02-29'; document.querySelector('.kw-picker-panel:popover-open .kw-picker-footer button').click()")
  assert.equal(await evaluate("askPayload('测试').as_of"), '2024-02-29')
  await evaluate("document.querySelector('#as-of').click(); document.querySelector('.kw-picker-panel:popover-open .kw-picker-footer button:last-child').click()")
  assert.equal(await evaluate("Object.hasOwn(askPayload('测试'), 'as_of')"), false)
  await call('Emulation.clearDeviceMetricsOverride')
  await evaluate("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());document.querySelector('#question').value='知织支持什么？';document.querySelector('#ask-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
  await until("document.querySelector('#ask-result [data-cite]') !== null")
  assert.equal(await evaluate("document.querySelector('#native-chat-frame').hasAttribute('src')"),false)
  await evaluate("document.querySelector('#ask-result [data-cite]').click()")
  await until("document.querySelector('#doc-dialog').open && document.querySelector('#source-highlight-target') !== null")
  const highlighted=await evaluate("document.querySelector('#source-highlight-target').textContent")
  assert.match(highlighted,/知织支持本地文档检索/)
  await evaluate("document.querySelector('.doc-link').open = true; document.querySelector('#continuation-direction').scrollIntoView({ block: 'center' })")
  await evaluate("document.querySelector('#continuation-direction').click(); document.querySelector('.kw-picker-panel:popover-open [data-index=\"1\"]').click()")
  assert.equal(await evaluate("document.querySelector('#continuation-direction').value"), 'continued_by')
  await evaluate("document.querySelector('#continuation-date').scrollIntoView({ block: 'center' }); document.querySelector('#continuation-date').click(); document.querySelector('.kw-picker-panel:popover-open input').value = '2025-03-04'; document.querySelector('.kw-picker-panel:popover-open .kw-picker-footer button').click()")
  assert.equal(await evaluate("document.querySelector('#continuation-date').value"), '2025-03-04')
  await evaluate("document.querySelector('#continuation-other').scrollIntoView({ block: 'center' }); document.querySelector('#continuation-other').click()")
  const relatedDocument = await evaluate(`(() => {
    const option = [...document.querySelectorAll('.kw-picker-panel:popover-open [role=option]')]
      .find(node => node.textContent === 'local.txt');
    option.click();
    return document.querySelector('#continuation-other').value;
  })()`)
  await evaluate("document.querySelector('[data-continuation-link]').click()")
  await until("document.querySelector('[data-continuation-unlink=continued_by]')")
  const link = await queryOne<{ successor_doc_id: string; effective_date: string }>(
    'SELECT successor_doc_id, effective_date::text FROM document_continuations WHERE predecessor_doc_id = $1', [source.document_id],
  )
  assert.deepEqual(link, { successor_doc_id: relatedDocument, effective_date: '2025-03-04' })
  assert.equal(await evaluate("document.querySelectorAll('select, datalist, input[type=date], input[type=color]').length"), 0)
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
  console.log(JSON.stringify({browser:'Chrome headless',directoryCli:true,nativeChatDisabledState:true,nativeChatCitation:true,researchChat:true,citation:true,sourceHighlight:true,reindex:true,sourcePolicy:true,evaluationImport:true,javascriptErrors:errors,artifact}))
} finally {
  socket?.close()
  if(browser && browser.exitCode===null)browser.kill('SIGKILL')
  await stopIngestWorker();await app.close();await workspace.close()
}
