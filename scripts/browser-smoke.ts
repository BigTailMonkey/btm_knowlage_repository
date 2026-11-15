import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harness } from '../src/adapters/harness/index.js'
import { parseText } from '../src/adapters/parsing/index.js'
import { createServer } from '../src/app/server.js'
import { ingestParsed, stopIngestWorker } from '../src/core/ingestion.js'
import { query, queryOne } from '../src/db/index.js'
import { testWorkspace } from '../tests/helpers.js'
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
    <input id="fixture-date" type="date" aria-label="规则日期" min="2024-02-10" max="2024-04-20">
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
  browser=spawn(chrome,['--headless=new','--window-size=1280,900','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-extensions','--no-first-run','--no-default-browser-check','--password-store=basic','--use-mock-keychain','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank'],{stdio:'ignore'})
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
  const docPath = `/library/${encodeURIComponent(String(source.document_id))}`
  const docRow = `#doc-table-body [data-doc="${source.document_id}"]`
  const docLink = `document.querySelector(${JSON.stringify(`${docRow} a`)})`
  await until(`${docLink}?.pathname === ${JSON.stringify(docPath)}`)
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await evaluate(`${docLink}.focus(); ${docLink}.click()`)
  const documentReady = `location.pathname === ${JSON.stringify(docPath)} && document.querySelector('#page-document.active #doc-page-title')?.textContent === '浏览器验收文档'`
  await until(documentReady)
  assert.equal(await evaluate('document.activeElement.id'), 'doc-page-title')
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'none')
  const entityPillsWrap = `(() => {
    const names = ['跨部门联合知识治理工作组和文档版本溯源项目'.repeat(4), 'KnowledgeGraphEntityWithoutSpaces'.repeat(4)];
    const fragment = document.createRange().createContextualFragment(entityPills(names.map(name => ({ name })), 'done'));
    const row = fragment.firstElementChild;
    document.querySelector('#doc-related-entities').append(fragment);
    try {
      const rowBounds = row.getBoundingClientRect();
      const pills = [...row.children];
      return pills.length === names.length && pills.every((pill, index) => {
        const bounds = pill.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(pill);
        const lines = [...text.getClientRects()];
        return pill.textContent === names[index] && bounds.right <= rowBounds.right + 1 && lines.length > 1
          && lines.every(line => line.left >= bounds.left && line.right <= bounds.right + 1
            && line.top >= bounds.top && line.bottom <= bounds.bottom + 1);
      });
    } finally {
      row.remove();
    }
  })()`
  assert.equal(await evaluate(entityPillsWrap), true)
  assert.equal(await evaluate(`(() => {
    const back = document.querySelector('#page-document [data-goto=library]').getBoundingClientRect();
    const rail = document.querySelector('#doc-page-info').getBoundingClientRect();
    const main = document.querySelector('.doc-page-main').getBoundingClientRect();
    const note = document.querySelector('#doc-source-footer').getBoundingClientRect();
    const content = document.querySelector('.doc-rail-content').getBoundingClientRect();
    const footer = document.querySelector('.doc-rail-danger').getBoundingClientRect();
    return Math.abs(back.top - rail.top) < 1 && rail.left > back.right
      && Math.abs(main.bottom - note.top) < 1 && Math.abs(note.bottom - rail.bottom) < 1
      && Math.abs(content.bottom - footer.top) < 1 && Math.abs(footer.bottom - (rail.bottom - 1)) < 1;
  })()`), true)
  assert.equal(await evaluate(`(() => {
    const source = document.querySelector('#doc-panel-source .doc-source');
    const note = document.querySelector('#doc-source-footer');
    const noteTop = note.getBoundingClientRect().top;
    const reachesNote = () => Math.abs(source.getBoundingClientRect().bottom - noteTop) < 1;
    const background = getComputedStyle(source).backgroundColor;
    const filled = reachesNote() && background !== 'rgba(0, 0, 0, 0)';
    const text = [...source.childNodes];
    source.replaceChildren();
    const filledWhenEmpty = reachesNote();
    source.replaceChildren(...text);
    return filled && filledWhenEmpty && note.textContent.includes('区间坐标');
  })()`), true)
  assert.equal(await evaluate(`(() => {
    const header = document.querySelector('.doc-page-header').getBoundingClientRect();
    const title = document.querySelector('#doc-page-title').getBoundingClientRect();
    const panel = document.querySelector('#doc-page-status');
    const status = panel.getBoundingClientRect();
    const rail = document.querySelector('#doc-page-info').getBoundingClientRect();
    const toolbar = document.querySelector('.doc-page-toolbar').getBoundingClientRect();
    const tabs = document.querySelector('#doc-page-tabbar').getBoundingClientRect();
    const heading = document.querySelector('.doc-page-heading').getBoundingClientRect();
    const copy = document.querySelector('[data-copy-source]').getBoundingClientRect();
    const source = document.querySelector('#doc-tab-source').getBoundingClientRect();
    const facts = document.querySelector('#doc-tab-facts').getBoundingClientRect();
    return !panel.querySelector('h2') && status.left >= title.right
      && Math.abs(status.top - rail.top) < 1 && Math.abs(status.right - header.right) < 1 && status.right < rail.left
      && Math.abs(status.bottom - tabs.bottom) < 1
      && toolbar.right <= status.left && Math.abs(tabs.top - heading.bottom - 4) < 1 && tabs.right <= status.left
      && copy.left >= facts.right && Math.abs(copy.right - tabs.right) < 1 && copy.bottom <= tabs.bottom
      && Math.abs((copy.top + copy.bottom) / 2 - (source.top + source.bottom) / 2) < 1;
  })()`), true)
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#doc-page-status dt')].map(label => label.textContent)"), ['权限', '可信度', '内容哈希'])
  assert.match(await evaluate("document.querySelector('#doc-page-meta span').textContent"), /^PDF · 更新于 /)
  assert.equal(await evaluate(`(() => {
    const writeText = navigator.clipboard.writeText;
    let copied;
    navigator.clipboard.writeText = async (text) => { copied = text; };
    try {
      document.querySelector('[data-copy-source]').click();
      return Boolean(copied) && copied === document.querySelector('#doc-panel-source .doc-source').textContent;
    } finally {
      navigator.clipboard.writeText = writeText;
    }
  })()`), true)
  await evaluate("const tab = document.querySelector('#doc-tab-chunks'); tab.focus(); tab.click()")
  assert.equal(await evaluate("!document.querySelector('#doc-panel-chunks').hidden && document.querySelector('#doc-panel-source').hidden && document.querySelector('[data-copy-source]').hidden && document.querySelector('#doc-source-footer').hidden"), true)
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' })
  assert.equal(await evaluate("document.activeElement.id === 'doc-tab-source' && !document.querySelector('#doc-panel-source').hidden && !document.querySelector('#doc-source-footer').hidden"), true)
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid')
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#doc-page-info h3')].map(heading => heading.textContent)"), ['关联实体', '沿革'])
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.nav-item[aria-current=page]')].map(item => item.textContent.trim())"), ['知识库'])
  assert.equal(await evaluate("document.querySelectorAll('dialog[open]').length"), 0)
  await evaluate('history.back()')
  await until("location.pathname === '/library' && document.querySelector('#page-library.active')")
  await evaluate('history.forward()')
  await until(documentReady)
  await call('Page.reload')
  await until(`performance.getEntriesByType('navigation')[0]?.type === 'reload' && ${documentReady}`)
  await evaluate("document.querySelector('#page-document [data-goto=library]').click()")
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
  assert.deepEqual(await nativeEval(`(() => {
    document.querySelector('#fixture-date + .kw-embedded-picker button').click();
    const panel = document.querySelector('.kw-picker-panel:popover-open');
    panel.querySelector('.kw-calendar-period-toggle').click();
    const year = panel.querySelector('.kw-calendar-year input');
    const months = [...panel.querySelectorAll('.kw-calendar-months button')];
    year.value = '2023';
    year.dispatchEvent(new Event('input', { bubbles: true }));
    const invalid = year.getAttribute('aria-invalid') === 'true' && months.every(month => month.disabled);
    year.value = '2024';
    year.dispatchEvent(new Event('input', { bubbles: true }));
    const allowed = months.filter(month => !month.disabled).map(month => month.textContent);
    months[1].click();
    const bounded = panel.querySelector('[data-date="2024-02-09"]').disabled;
    panel.querySelector('[data-date="2024-02-29"]').click();
    return { invalid, allowed, bounded, saved: document.querySelector('#fixture-date').dataset.saved };
  })()`), { invalid: true, allowed: ['2 月', '3 月', '4 月'], bounded: true, saved: '2024-02-29' })
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
  await until("document.querySelector('#page-document.active #source-highlight-target') !== null")
  const highlighted=await evaluate("document.querySelector('#source-highlight-target').textContent")
  assert.match(highlighted,/知织支持本地文档检索/)
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 400, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(() => {
    const extra = document.createElement('span');
    extra.id = 'long-source-fixture';
    extra.textContent = "\\n" + "用于验证独立滚动的原文段落。\\n".repeat(60);
    document.querySelector('#doc-panel-source .doc-source').append(extra);
  })()`)
  assert.equal(await evaluate(`(() => {
    const main = document.querySelector('.doc-page-main');
    return main.scrollHeight > main.clientHeight;
  })()`), true)
  const documentScrollPoint = (selector: string) => evaluate(`(() => {
    const { left, right, top, bottom } = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  })()`)
  const footerTop = await evaluate("document.querySelector('.doc-rail-danger').getBoundingClientRect().top")
  await call('Input.synthesizeScrollGesture', { yDistance: -1000, gestureSourceType: 'mouse', ...await documentScrollPoint('.doc-rail-content') })
  await until(`(() => {
    const content = document.querySelector('.doc-rail-content');
    return content.scrollTop > 0 && content.scrollHeight - content.clientHeight - content.scrollTop < 1;
  })()`)
  assert.equal(await evaluate("document.querySelector('.doc-page-main').scrollTop"), 0)
  assert.equal(await evaluate("document.querySelector('.doc-rail-danger').getBoundingClientRect().top"), footerTop)
  const railScrollTop = await evaluate("document.querySelector('.doc-rail-content').scrollTop")
  const sourceFooterTop = await evaluate("document.querySelector('#doc-source-footer').getBoundingClientRect().top")
  await call('Input.synthesizeScrollGesture', { yDistance: -500, gestureSourceType: 'mouse', ...await documentScrollPoint('.doc-tabs') })
  await until("document.querySelector('.doc-page-main').scrollTop > 0")
  assert.equal(await evaluate("document.querySelector('.doc-rail-content').scrollTop"), railScrollTop)
  assert.equal(await evaluate("document.querySelector('#doc-source-footer').getBoundingClientRect().top"), sourceFooterTop)
  assert.equal(await evaluate(`(() => {
    const main = document.querySelector('.doc-page-main');
    const back = document.querySelector('#page-document [data-goto=library]');
    return document.querySelector('#sheet').scrollTop === 0
      && back.getBoundingClientRect().top >= main.getBoundingClientRect().top;
  })()`), true)
  await evaluate("document.querySelector('#long-source-fixture').remove(); document.querySelector('.doc-rail-content').scrollTop = 0")
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 720, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate(entityPillsWrap), true)
  assert.equal(await evaluate(`(() => {
    const meta = document.querySelector('#doc-page-meta');
    const metrics = [...meta.querySelectorAll('small')];
    const source = document.querySelector('#doc-page-body').getBoundingClientRect();
    const note = document.querySelector('#doc-source-footer').getBoundingClientRect();
    const rail = document.querySelector('#doc-page-info').getBoundingClientRect();
    const status = document.querySelector('#doc-page-status').getBoundingClientRect();
    return meta.getBoundingClientRect().bottom <= status.top && status.bottom <= source.top
      && source.bottom <= note.top && note.bottom <= rail.top && metrics.length === 5 && meta.scrollWidth === meta.clientWidth
      && metrics.every(node => getComputedStyle(node).fontSize === '11px');
  })()`), true)
  await evaluate("document.querySelector('[data-doc-info]').click()")
  await until(`(() => {
    const box = document.querySelector('.doc-rail .doc-actions [data-continuation-open]').getBoundingClientRect();
    const toolbar = document.querySelector('.doc-page-toolbar').getBoundingClientRect();
    return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= toolbar.bottom && box.bottom <= innerHeight;
  })()`)
  assert.equal(await evaluate(`(() => {
    const trigger = document.querySelector('.doc-rail .doc-actions [data-continuation-open]');
    trigger.focus();
    trigger.click();
    return document.querySelector('#continuation-dialog').open && !document.querySelector('#page-document #continuation-other');
  })()`), true)
  assert.equal(await evaluate(`(() => {
    const related = document.querySelector('.continuation-related').getBoundingClientRect();
    const current = document.querySelector('.continuation-current').getBoundingClientRect();
    return related.bottom < current.top && related.right <= innerWidth
      && document.querySelector('#continuation-other-label').textContent === '前序文档';
  })()`), true)
  const swapPosition = await evaluate(`(() => {
    const box = document.querySelector('[data-continuation-swap]').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...swapPosition })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...swapPosition })
  assert.equal(await evaluate("document.querySelector('#continuation-other-label').textContent"), '后继文档')
  assert.equal(await evaluate(`(() => {
    const related = document.querySelector('.continuation-related').getBoundingClientRect();
    const current = document.querySelector('.continuation-current').getBoundingClientRect();
    return current.bottom < related.top;
  })()`), true)
  await evaluate("document.querySelector('[data-continuation-cancel]').click()")
  assert.equal(await evaluate("!document.querySelector('#continuation-dialog').open && document.querySelector('#page-document.active') && document.activeElement.matches('[data-continuation-open]')"), true)
  assert.equal(await evaluate("document.querySelector('#source-highlight-target').textContent"), highlighted)
  await call('Emulation.clearDeviceMetricsOverride')
  await evaluate("document.querySelector('[data-continuation-open]').click()")
  await until("document.querySelector('[data-continuation-link]')?.disabled === false")
  assert.equal(await evaluate("document.querySelector('#continuation-other').value"), '')
  await evaluate("document.querySelector('[data-continuation-link]').click()")
  assert.equal(await evaluate("document.querySelector('.continuation-status').textContent"), '请选择关联文档')
  await evaluate("document.querySelector('#continuation-other').click()")
  const relatedDocument = await evaluate(`(() => {
    const option = [...document.querySelectorAll('.kw-picker-panel:popover-open [role=option]')]
      .find(node => node.textContent === 'local.txt');
    option.click();
    return document.querySelector('#continuation-other').value;
  })()`)
  assert.equal(await evaluate(`(() => {
    const picker = document.querySelector('#continuation-other');
    const current = document.querySelector('.continuation-current');
    const related = picker.closest('.continuation-related');
    const value = picker.value;
    if (related.getBoundingClientRect().right >= current.getBoundingClientRect().left) return false;
    document.querySelector('[data-continuation-swap]').click();
    return current.getBoundingClientRect().right < related.getBoundingClientRect().left
      && document.querySelector('#continuation-other') === picker && picker.value === value
      && document.querySelector('#continuation-other-label').textContent === '后继文档';
  })()`), true)
  await evaluate("document.querySelector('[data-continuation-link]').click()")
  assert.equal(await evaluate("document.querySelector('.continuation-status').textContent"), '请选择生效日期')
  await evaluate(`(() => {
    document.querySelector('#continuation-date').click();
    const panel = document.querySelector('#continuation-date-panel');
    panel.querySelector('.kw-calendar-period-toggle').click();
    const year = panel.querySelector('.kw-calendar-year input');
    year.value = '2025';
    year.dispatchEvent(new Event('input', { bubbles: true }));
    panel.querySelector('.kw-calendar-months button:nth-child(3)').click();
    panel.querySelector('[data-date="2025-03-04"]').click();
  })()`)
  assert.equal(await evaluate("document.querySelector('#continuation-date').value"), '2025-03-04')
  await evaluate("document.querySelector('[data-continuation-link]').click()")
  await until("!document.querySelector('#continuation-dialog').open && document.querySelector('[data-continuation-unlink]')")
  assert.equal(await evaluate("document.querySelector('#source-highlight-target').textContent"), highlighted)
  assert.equal(await evaluate("document.querySelector('#doc-page-badges .pill').textContent"), '已被延续')
  const libraryBadge = `[data-doc="${source.document_id}"] .doc-title-line strong + .pill`
  await until(`document.querySelector(${JSON.stringify(libraryBadge)})?.textContent === '已被延续'`)
  // 沿革堆叠：链首只摆当前生效的后继，前序收在下面，点开才看得到
  await evaluate("document.querySelector('.nav-item[data-page=library]').click()")
  await until("location.pathname === '/library' && document.querySelector('#page-library.active')")
  await evaluate("document.querySelector('#doc-view [data-view=stack]').click()")
  await until(`(() => {
    const head = document.querySelector('#doc-table-body [data-stack-head]');
    const child = document.querySelector('#doc-table-body [data-stack-child]');
    return head?.dataset.doc === ${JSON.stringify(relatedDocument)}
      && child?.dataset.doc === ${JSON.stringify(source.document_id)}
      && child.hasAttribute('hidden') && child.getClientRects().length === 0;
  })()`)
  assert.equal(await evaluate("document.querySelector('#doc-view-hint').hidden"), false)
  await evaluate("document.querySelector('#doc-table-body [data-stack-toggle]').click()")
  await until("!document.querySelector('#doc-table-body [data-stack-child]').hasAttribute('hidden') && document.querySelector('#doc-table-body [data-stack-child]').getClientRects().length > 0")
  await evaluate("document.querySelector('#doc-table-body [data-stack-child]').click()")
  await until(documentReady)
  await evaluate("document.querySelector('#page-document [data-goto=library]').click()")
  await until("document.querySelector('#page-library.active #doc-view [data-view=stack]').getAttribute('aria-pressed') === 'true' && !document.querySelector('#doc-table-body [data-stack-child]').hidden")
  await evaluate("document.querySelector('#doc-view [data-view=flat]').click()")
  await until(`document.querySelector(${JSON.stringify(docRow)}) && !document.querySelector('#doc-table-body [data-stack-head]')`)
  await evaluate(`document.querySelector(${JSON.stringify(docRow)}).click()`)
  await until(documentReady)
  const link = await queryOne<{ successor_doc_id: string; effective_date: string }>(
    'SELECT successor_doc_id, effective_date::text FROM document_continuations WHERE predecessor_doc_id = $1', [source.document_id],
  )
  assert.deepEqual(link, { successor_doc_id: relatedDocument, effective_date: '2025-03-04' })
  await evaluate("document.querySelector('[data-continuation-unlink]').click()")
  assert.equal(await evaluate("document.querySelector('[data-unlink-confirm=reconnect]').hidden && document.querySelector('[data-unlink-confirm=separate]').textContent === '确认解除'"), true)
  await evaluate("document.querySelector('#unlink-continuation-dialog [autofocus]').click()")
  await evaluate("document.querySelector('[data-continuation-open]').click(); document.querySelector('[data-continuation-swap]').click()")
  assert.equal(await evaluate("document.querySelector('#continuation-placement').textContent"), '所选文档将插入当前文档与原后续之间。')
  assert.equal(await evaluate("document.querySelector('#continuation-date-label').textContent"), '关联文档生效日期')
  await evaluate("document.querySelector('[data-continuation-cancel]').click()")
  assert.equal(await evaluate("document.querySelectorAll('select, datalist, input[type=date], input[type=color]').length"), 0)
  await evaluate("document.querySelector('[data-doc-action=reindex]').click()")
  await until("document.querySelector('[data-doc-action=reindex]')?.disabled === false")
  assert.equal(await evaluate("document.querySelector('.doc-source').textContent.includes('知织支持本地文档检索')"),true)
  await evaluate("window.prompt = () => { throw new Error('Unexpected native prompt') }; document.querySelector('[data-doc-action=policy]').click()")
  assert.equal(await evaluate("document.querySelector('#policy-dialog').open && document.querySelector('#policy-document').textContent === '浏览器验收文档'"), true)
  assert.deepEqual(await evaluate("[document.querySelector('#policy-trust').value, document.querySelector('#policy-core').checked]"), ['0.5', false])
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 720, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate(`(() => {
    const form = document.querySelector('#policy-form');
    const button = document.querySelector('#policy-save').getBoundingClientRect();
    return form.scrollWidth === form.clientWidth && button.bottom <= innerHeight;
  })()`), true)
  await call('Emulation.clearDeviceMetricsOverride')
  await evaluate("document.querySelector('#policy-trust').value = '1.2'; document.querySelector('#policy-save').click()")
  assert.equal(await evaluate("document.querySelector('#policy-trust').getAttribute('aria-invalid')"), 'true')
  assert.match(await evaluate("document.querySelector('#policy-error').textContent"), /0 到 1/)
  await evaluate("document.querySelector('#policy-form [data-close]').click(); document.querySelector('[data-doc-action=policy]').click()")
  assert.equal(await evaluate("document.querySelector('#policy-trust').value"), '0.5')
  await evaluate("document.querySelector('#policy-trust').value = '0.73'; document.querySelector('#policy-core').click(); document.querySelector('#policy-save').click()")
  await until("!document.querySelector('#policy-dialog').open && document.querySelector('.doc-meta')?.textContent.includes('0.73 · 核心')")
  const policy = await queryOne('SELECT source_trust, is_core FROM documents WHERE id = $1', [source.document_id])
  assert.deepEqual(policy, { source_trust: 0.73, is_core: true })
  await evaluate("document.querySelector('.nav-item[data-page=ops]').click()")
  await until("document.querySelector('#page-ops.active #ops-body .metric-label')?.textContent === '轨迹'")
  await evaluate("document.querySelector('#ops-tabs [data-ops=evals]').click()")
  await until("document.querySelector('#import-eval') !== null")
  await evaluate(`window.prompt=()=>JSON.stringify([{question:'浏览器导入评测题',expected_docs:['浏览器验收文档'],expected_keywords:['引用'],should_refuse:false}]);document.querySelector('#import-eval').click()`)
  await until("document.querySelector('#ops-body').textContent.includes('浏览器导入评测题')")
  const middle = await ingestParsed(workspace.principal, parseText('沿革链中的中间版本。', '沿革验收中间文档'), { sourceType: 'text' })
  const inserted = await app.inject({
    method: 'POST', url: `/api/v1/documents/${source.document_id}/continuation`, headers: workspace.headers,
    payload: { other_doc_id: middle.document_id, relation: 'continued_by', effective_date: '2024-03-04' },
  })
  assert.equal(inserted.statusCode, 200, inserted.body)
  await evaluate(`openDoc(${JSON.stringify(middle.document_id)})`)
  assert.equal(await evaluate("document.querySelectorAll('#page-document.active [data-continuation-unlink]').length"), 1)
  await evaluate("document.querySelector('[data-continuation-unlink]').click()")
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#unlink-continuation-dialog [data-unlink-confirm]:not([hidden])')].map(button => button.textContent)"), ['仅解除', '解除并续接'])
  await evaluate("document.querySelector('[data-unlink-confirm=reconnect]').click()")
  await until("!document.querySelector('#unlink-continuation-dialog').open && document.querySelector('#doc-page-body .doc-source') && !document.querySelector('[data-continuation-unlink]')")
  assert.deepEqual(await queryOne('SELECT successor_doc_id, effective_date FROM document_continuations WHERE predecessor_doc_id = $1', [source.document_id]), link)
  assert.deepEqual(errors,[])
  await evaluate("document.querySelector('#ask-result [data-cite]').click()")
  await until("document.querySelector('#page-document.active #source-highlight-target') !== null")
  const screenshot=await call('Page.captureScreenshot',{format:'png'})
  const artifact=join(directory,'knowledge-chat.png')
  await writeFile(artifact,Buffer.from(screenshot.data,'base64'))

  const newQuote = '新版知织仅为引用提供摘要。'
  const latest = await ingestParsed(workspace.principal, parseText(newQuote, '浏览器验收文档'), { sourceType: 'text', documentId: String(source.document_id) })
  const latestChunk = await queryOne<{ id: string }>('SELECT id FROM chunks WHERE version_id=$1 AND is_parent=false', [latest.version_id])
  const tenant = workspace.principal.tenantId
  await query(`INSERT INTO entities(id,tenant_id,canonical_name,normalized_name,acl_principals)
    VALUES ('browser-subject',$1,'知织','知织','["tenant:public"]')`, [tenant])
  await query(`INSERT INTO facts(id,tenant_id,subject_id,predicate,object_literal,acl_principals) VALUES
    ('browser-old',$1,'browser-subject','提供','原文引用','["tenant:public"]'),
    ('browser-new',$1,'browser-subject','提供','摘要','["tenant:public"]')`, [tenant])
  await query(`INSERT INTO fact_evidence(id,fact_id,doc_id,chunk_id,quote) VALUES
    ('browser-old-evidence','browser-old',$1,$2,'为回答提供原文引用'),
    ('browser-new-evidence','browser-new',$1,$3,$4)`, [source.document_id, chunk!.id, latestChunk!.id, newQuote])
  await query(`INSERT INTO review_queue(id,tenant_id,kind,payload) VALUES ('browser-review',$1,'fact_conflict',$2::jsonb)`, [tenant, JSON.stringify({
    subject: '知织', predicate: '提供', new_object: '摘要', new_fact_id: 'browser-new', old_objects: ['原文引用'], old_fact_ids: ['browser-old'],
  })])
  await evaluate("document.querySelector('.nav-item[data-page=review]').click()")
  await until("document.querySelector('[data-review-source=browser-review]')")
  await evaluate("document.querySelector('[data-review-source=browser-review]').click()")
  await until("document.querySelector('#review-source-highlight-current') && document.querySelector('#review-source-highlight-existing')")
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.review-source-pane [data-review-location]')].map(node => node.textContent)"), ['《浏览器验收文档》 · v2', '《浏览器验收文档》 · v1'])
  assert.equal(await evaluate("document.querySelector('#review-source-highlight-current').textContent"), newQuote)
  assert.match(await evaluate("document.querySelector('#review-source-highlight-existing').textContent"), /为回答提供原文引用/)
  const panes = "[...document.querySelectorAll('.review-source-pane')].map(pane => pane.getBoundingClientRect())"
  assert.equal(await evaluate(`(() => { const [current, old] = ${panes}; return current.top === old.top && current.right <= old.left; })()`), true)
  await call('Emulation.setDeviceMetricsOverride', { width: 420, height: 840, deviceScaleFactor: 1, mobile: false })
  await until(`(() => { const [current, old] = ${panes}; return current.left === old.left && current.bottom <= old.top; })()`)
  await evaluate(`document.querySelector('#review-source-dialog').close();
    document.querySelector('[data-review=browser-review][data-action=reject_new]').click()`)
  const centeredNotice = `(() => {
    const notice = document.querySelector('#toast.show');
    if (notice?.textContent !== '审阅项已处理') return false;
    const { left, width, top, height } = notice.getBoundingClientRect();
    return Math.abs(left + width / 2 - innerWidth / 2) < 1 && Math.abs(top + height / 2 - innerHeight / 2) < 1;
  })()`
  await until(centeredNotice)
  await call('Emulation.clearDeviceMetricsOverride')
  await until(centeredNotice)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({browser:'Chrome headless',directoryCli:true,nativeChatDisabledState:true,nativeChatCitation:true,researchChat:true,citation:true,sourceHighlight:true,documentPage:true,reindex:true,sourcePolicy:true,evaluationImport:true,reviewComparison:true,libraryStack:true,javascriptErrors:errors,artifact}))
} finally {
  socket?.close()
  if(browser && browser.exitCode===null)browser.kill('SIGKILL')
  await stopIngestWorker();await app.close();await workspace.close()
}
