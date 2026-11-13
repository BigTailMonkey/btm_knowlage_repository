import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const appSource = readFileSync(new URL('../knowweave/web/app.js', import.meta.url), 'utf8')

class Form {
  fields: Array<[string, unknown]> = []
  append(key: string, value: unknown) { this.fields.push([key, value]) }
}

function frontend(respond: (url: string, options: Record<string, unknown>) => unknown = () => ({ items: [], groups: [] }), site: { hostname?: string; port?: string } = {}) {
  const nodes = new Map<string, any>()
  const calls: Array<{ url: string; options: Record<string, unknown> }> = []
  const listeners = new Map<string, Array<(...args: any[]) => any>>()
  const listen = (target: string) => (type: string, callback: (...args: any[]) => any) => {
    const key = `${target}:${type}`
    listeners.set(key, [...(listeners.get(key) ?? []), callback])
  }
  const hostname = site.hostname ?? '127.0.0.1'
  const port = site.port ?? '8730'
  function element(selector: string): any {
    if (!nodes.has(selector)) {
      const handlers: Record<string, (...args: any[]) => any> = {}
      const node: any = {
        textContent: '', value: '', hidden: false, open: false,
        dataset: {}, style: {}, scrollHeight: 44, handlers,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(type: string, callback: (...args: any[]) => any) { handlers[type] = callback },
        setAttribute(key: string, value: string) { this[key] = value },
        getAttribute(key: string) { return this[key] ?? null },
        removeAttribute(key: string) { delete this[key] },
        focus() {}, scrollIntoView() {},
        appendChild(child: unknown) { this.children = [...(this.children ?? []), child] },
        reset() { this.value = '' },
        showModal() { this.open = true },
        close() { this.open = false; handlers.close?.() },
        querySelector: element,
        querySelectorAll() { return [] },
      }
      // 和真实 DOM 一致：innerHTML 置空会清掉子节点（图谱重绘依赖这个行为）
      let html = ''
      Object.defineProperty(node, 'innerHTML', {
        get() { return html },
        set(value: string) { html = value; if (value === '') node.children = [] },
        enumerable: true,
      })
      nodes.set(selector, node)
    }
    return nodes.get(selector)
  }
  const context = vm.createContext({
    console,
    FormData: Form,
    URL,
    URLSearchParams,
    document: {
      querySelector: element, querySelectorAll: () => [],
      createElementNS: (_namespace: string, tag: string) => {
        const node: any = {
          tag, attrs: {}, children: [], style: {}, textContent: '', handlers: {},
          setAttribute(key: string, value: string) { node.attrs[key] = value },
          getAttribute(key: string) { return node.attrs[key] ?? null },
          removeAttribute(key: string) { delete node.attrs[key] },
          appendChild(child: unknown) { node.children.push(child); return child },
          addEventListener(type: string, callback: (...args: any[]) => any) { node.handlers[type] = callback },
        }
        return node
      },
      addEventListener: listen('document'), visibilityState: 'visible', hidden: false,
      body: { dataset: {} },
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '', hostname, port, href: `http://${hostname}:${port}/`, origin: `http://${hostname}:${port}` },
    window: { addEventListener: listen('window'), parent: { postMessage() {} } },
    navigator: { onLine: true },
    setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    fetch: async (url: string, options = {}) => {
      calls.push({ url, options })
      const payload = await respond(url, options)
      return { ok: true, status: 200, json: async () => payload }
    },
  })
  vm.runInContext(appSource, context)
  const dispatch = (target: string, type: string, event: unknown) => {
    for (const callback of listeners.get(`${target}:${type}`) ?? []) callback(event)
  }
  return { context, nodes, calls, element, dispatch, run: (code: string) => vm.runInContext(code, context) }
}

test('navigation removes old page fragments and keeps page links reloadable', () => {
  const page = frontend();
  page.context.location.href += '?source=bookmark#library';
  page.context.history = {
    state: null,
    replaceState(_state: unknown, _title: string, url: URL) {
      page.context.location.href = url.href;
    },
  };
  page.run('loadPage = () => {}; showPage(pageFromUrl())');
  assert.equal(page.run('state.page'), 'library');
  assert.equal(page.context.location.href, 'http://127.0.0.1:8730/?source=bookmark&page=library');
  assert.equal(page.run('pageFromUrl()'), 'library');
  page.run('showPage("chat")');
  assert.equal(page.context.location.href, 'http://127.0.0.1:8730/?source=bookmark');
});

test('the library offers both decisions for an import awaiting duplicate confirmation', async () => {
  const duplicate = { job_id: 'job/1', title: '重复文档', status: 'awaiting_duplicate', message: '知识库已有内容相同的文档。' }
  const page = frontend((url) => url.endsWith('/duplicate') ? { ...duplicate, status: 'skipped' } : { items: [duplicate] })
  const box = page.element('#ingest-jobs')
  const choices = ['continue', 'skip'].map(decision => Object.assign(page.element(decision), {
    dataset: { duplicateJob: duplicate.job_id, decision },
    parentElement: { querySelectorAll: () => choices },
  }))
  box.querySelectorAll = (selector: string) => selector === '[data-duplicate-job]' ? choices : []
  await page.run('state.page = "library"; loadIngestJobs()')
  assert.match(box.innerHTML, /知识库已有内容相同的文档/)
  assert.match(box.innerHTML, />继续导入<\/button>/)
  assert.match(box.innerHTML, />跳过重复文档<\/button>/)
  await choices[1].handlers.click()
  const request = page.calls.find(call => call.url.endsWith('/duplicate'))
  assert.equal(request?.url, '/api/v1/documents/jobs/job%2F1/duplicate')
  assert.deepEqual(JSON.parse(String(request?.options.body)), { action: 'skip' })
  assert.equal(box.hidden, true)
})

test('review keeps each existing fact next to its own verbatim source', async () => {
  const page = frontend(() => ({ items: [{
    id: 'review', kind: 'fact_conflict', created_at: '2026-01-01',
    payload: { subject: '医院', predicate: '提供', new_object: '夜诊', old_objects: ['日诊', null, '急诊'], quote: '本院新增夜诊' },
    source: { title: '新通知', page: 1 },
    old_sources: [
      { title: '门诊须知', page: 3, quote: '日诊 *仅限工作日*' },
      null,
      { title: '值班表', heading: ['正文', '急诊'], quote: '急诊 <全天>\n节假日照常' },
    ],
  }] }))
  await page.run('loadReview()')
  const html = page.element('#review-list').innerHTML
  assert.match(html, /原文（《新通知》 · 第 1 页）：本院新增夜诊/)
  assert.match(html, /医院提供日诊<\/div>\s*<div class="conflict-quote">原文（《门诊须知》 · 第 3 页）：日诊 \*仅限工作日\*<\/div>/)
  assert.match(html, /医院提供急诊<\/div>\s*<div class="conflict-quote">原文（《值班表》 · 急诊）：急诊 &lt;全天&gt;\n节假日照常<\/div>/)
})

test('default chat mounts the complete native DSH UI and keeps it alive across navigation', async () => {
  const nativeUrl = 'http://127.0.0.1:3081/?token=test-runtime';
  const page = frontend(() => ({ enabled: true, ready: true, url: nativeUrl }));
  await page.run('loadChat()');
  assert.deepEqual(page.calls.map(call => call.url), ['/api/v1/dsh-web']);
  assert.equal(page.element('#native-chat-frame').src, nativeUrl);
  assert.equal(page.element('#native-chat-frame').hidden, false);
  assert.equal(page.element('#native-chat-status').hidden, true);
  await page.run('loadChat()');
  assert.equal(page.calls.length, 1, 'do not reload the active native session');
  assert.equal(page.run('typeof sendChat'), 'undefined', 'no buffered replacement for native streaming');
  const html = readFileSync(new URL('../knowweave/web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<iframe[^>]*id="native-chat-frame"/);
  assert.ok(!html.includes('id="chat-form"'));
  assert.match(html, /data-page="chat"[^>]*>[\s\S]*?<span>对话<\/span>[\s\S]*?<\/button>/);
});

test('native chat shows startup, disabled and error states with retry', async () => {
  let response: Record<string, unknown> = { enabled: true, ready: false };
  const page = frontend(() => response);
  page.run('setupChat()');
  await page.run('loadChat()');
  assert.equal(page.element('#native-chat-frame').src, undefined);
  assert.equal(page.element('#native-chat-retry').hidden, true);
  response = { enabled: false, ready: false };
  await page.run('loadChat()');
  assert.match(page.element('#native-chat-message').textContent, /web_enabled/);
  assert.equal(page.element('#native-chat-retry').hidden, false);
  response = { enabled: true, ready: false, lastError: 'startup failed' };
  await page.run('loadChat()');
  assert.equal(page.element('#native-chat-message').textContent, 'startup failed');
  response = { enabled: true, ready: true, url: 'http://127.0.0.1:3081/' };
  await page.element('#native-chat-retry').handlers.click();
  await page.run('Promise.resolve()');
  assert.equal(page.element('#native-chat-frame').hidden, false);
});

test('identity reset ignores an earlier in-flight native runtime response', async () => {
  let resolve: (value: unknown) => void = () => {};
  const response = new Promise(done => { resolve = done });
  const page = frontend(() => response);
  const loading = page.run('loadChat()');
  page.run('resetNativeChat()');
  resolve({ enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=old' });
  await loading;
  assert.equal(page.element('#native-chat-frame').src, undefined);
  assert.equal(page.element('#native-chat-frame').hidden, true);
});

test('native chat heartbeat marks the surface alive', async () => {
  const page = frontend(() => ({ enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=t' }));
  page.run('setupChat()');
  await page.run('loadChat()');
  const frame = page.element('#native-chat-frame');
  frame.contentWindow = { sentinel: true };
  page.run('nativeChat.beatAt = 0; nativeChat.graceUntil = 0');
  page.dispatch('window', 'message', { source: {}, origin: 'http://127.0.0.1:3081', data: { type: 'knowweave:heartbeat' } });
  assert.equal(page.run('nativeChat.beatAt'), 0, 'ignores a heartbeat from another window');
  page.dispatch('window', 'message', { source: frame.contentWindow, origin: 'http://127.0.0.1:3081', data: { type: 'knowweave:heartbeat' } });
  assert.equal(page.run('nativeChat.beatAt > 0'), true);
  assert.equal(page.run('nativeChat.watcher !== null'), true, 'watchdog runs while the frame is mounted');
});

test('silent native chat remounts on the restarted runtime URL', async () => {
  let runtimeUrl = 'http://127.0.0.1:3081/?token=old';
  const page = frontend(() => ({ enabled: true, ready: true, url: runtimeUrl }));
  await page.run('loadChat()');
  // A restarted DSH re-issues its launch token; reloading the stale URL would stay 401.
  runtimeUrl = 'http://127.0.0.1:3081/?token=new';
  page.run('nativeChat.graceUntil = 0; nativeChat.beatAt = 0');
  await page.run('checkNativeChatHealth()');
  assert.equal(page.element('#native-chat-frame').src, 'http://127.0.0.1:3081/?token=old', 'one miss is not enough');
  await page.run('checkNativeChatHealth()');
  assert.equal(page.element('#native-chat-frame').src, 'http://127.0.0.1:3081/?token=new');
  assert.equal(page.element('#native-chat-frame').hidden, false);
  assert.equal(page.run('nativeChat.reloads'), 0, 'a restarted process remounts without spending the reload');
  assert.equal(page.element('#native-chat-status').hidden, true);
});

test('a live but unusable native chat reloads once and then defers to the user', async () => {
  const page = frontend(() => ({ enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=t' }));
  await page.run('loadChat()');
  page.run('nativeChat.graceUntil = 0; nativeChat.beatAt = 0; nativeChat.misses = 1');
  await page.run('checkNativeChatHealth()');
  assert.equal(page.run('nativeChat.reloads'), 1, 'the same URL gets one reload');
  assert.equal(page.element('#native-chat-frame').hidden, false);
  page.run('nativeChat.graceUntil = 0; nativeChat.beatAt = 0; nativeChat.misses = 1');
  await page.run('checkNativeChatHealth()');
  assert.match(page.element('#native-chat-message').textContent, /没有响应/);
  assert.equal(page.element('#native-chat-frame').hidden, true);
  assert.equal(page.element('#native-chat-retry').hidden, false);
});

test('silent native chat surfaces the service error with a retry entry', async () => {
  let runtime: Record<string, unknown> = { enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=old' };
  const page = frontend(() => runtime);
  await page.run('loadChat()');
  runtime = { enabled: true, ready: false, lastError: '对话服务退出（code=1 signal=-）' };
  page.run('nativeChat.graceUntil = 0; nativeChat.beatAt = 0; nativeChat.misses = 1');
  await page.run('checkNativeChatHealth()');
  assert.equal(page.element('#native-chat-frame').hidden, true);
  assert.equal(page.element('#native-chat-message').textContent, '对话服务退出（code=1 signal=-）');
  assert.equal(page.element('#native-chat-retry').hidden, false);
});

test('returning to the chat page keeps the session and delays the judgement', async () => {
  const page = frontend(() => ({ enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=t' }));
  await page.run('loadChat()');
  page.run('nativeChat.graceUntil = 0');
  await page.run('loadPage("chat")');
  assert.equal(page.calls.length, 1, 'no reload when returning to the chat page');
  assert.equal(page.run('nativeChat.graceUntil > Date.now()'), true, 'hidden iframe timers were throttled');
});

test('native chat refuses a page host that cannot share the login cookie', async () => {
  const page = frontend(() => ({ enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=t' }), { hostname: '192.168.1.5' });
  await page.run('loadChat()');
  assert.equal(page.calls.length, 0, 'no probe for a surface that can never authenticate');
  assert.equal(page.element('#native-chat-frame').src, undefined);
  assert.match(page.element('#native-chat-message').textContent, /本机地址/);
  assert.equal(page.element('#native-chat-retry').hidden, false);
});

test('localhost pages load the iframe on the same site so the Strict cookie is sent', async () => {
  const page = frontend(() => ({ enabled: true, ready: true, url: 'http://127.0.0.1:3081/?token=t' }), { hostname: 'localhost' });
  await page.run('loadChat()');
  assert.equal(page.element('#native-chat-frame').src, 'http://localhost:3081/?token=t');
});

test('library exposes model failures and sends the chosen single or bulk retry', async () => {
  const page = frontend(url => url.endsWith('/extractions/retry') ? { queued: 1 }
    : url.endsWith('/extractions') ? { can_retry: true, items: [
      { id: 'doc-a', title: '失败文档', version: 2, status: 'failed', error: '模型 HTTP 401' },
      { id: 'doc-b', title: '后续文档', version: 1, status: 'running', error: null },
    ] } : { items: [] })
  const box = page.element('#extraction-jobs')
  const single = page.element('single-retry')
  const bulk = page.element('bulk-retry')
  const reset = page.element('reset-retry')
  single.dataset.extractionRetry = 'doc-a'
  bulk.dataset.extractionRetry = ''
  reset.dataset.extractionReset = 'doc-a'
  box.querySelectorAll = (selector: string) => selector === '[data-extraction-retry], [data-extraction-reset]'
    ? [single, bulk, reset] : []

  await page.run('state.page = "library"; loadIngestJobs()')
  assert.equal(box.hidden, false)
  assert.match(box.innerHTML, /模型 HTTP 401/)
  assert.match(box.innerHTML, /后续文档 · v1[\s\S]*抽取中/)
  assert.match(box.innerHTML, /从头重抽/)
  await single.handlers.click()
  await bulk.handlers.click()
  await reset.handlers.click()
  assert.deepEqual(page.calls.filter(call => call.url.endsWith('/extractions/retry'))
    .map(call => JSON.parse(String(call.options.body))),
    [{ document_ids: ['doc-a'], reset: false }, { reset: false }, { document_ids: ['doc-a'], reset: true }])
})

test('running extraction shows batch base, request count and remaining time instead of a bare 抽取中', async () => {
  const page = frontend(url => url.endsWith('/extractions') ? { can_retry: true, items: [
    { id: 'doc-a', title: '长文档', version: 3, status: 'running', error: null,
      progress: { stage: '第 5/13 批校验', batches_done: 4, batches_total: 13, requests: 1280,
        model_requests: 30, embedding_requests: 1250, elapsed_ms: 92_000, eta_ms: 138_000 } },
    { id: 'doc-b', title: '排队文档', version: 1, status: 'pending', error: null, progress: null },
  ] } : { items: [] })
  const box = page.element('#extraction-jobs')
  await page.run('state.page = "library"; loadIngestJobs()')
  assert.match(box.innerHTML, /长文档 · v3[\s\S]*抽取中 · 4\/13 批 · 1,280 次请求 · 1分32秒/)
  assert.match(box.innerHTML, /预计还需 2分18秒/)
  assert.match(box.innerHTML, /job-progress[\s\S]*width:31%/)
  assert.match(box.innerHTML, /排队文档 · v1[\s\S]*等待抽取/)
  assert.doesNotMatch(box.innerHTML, /排队文档[\s\S]*次请求/, '还没开始的任务不编造进度')
})

test('source highlighting uses UTF-16 offsets, merges overlap, and escapes document HTML', () => {
  const page = frontend()
  const source = '标题😀\n证据 <img src=x onerror=alert(1)> & 结尾'
  const start = source.indexOf('证据')
  const end = source.indexOf(' &')
  page.context.fixture = {
    source: { text: source },
    chunks: [{ id: 'hit', spans: [{ start, end }, { start: start + 1, end: end - 1 }, { start: -1, end: 2 }, { start: 1, end: 9999 }] }],
  }
  const ranges = JSON.parse(page.run('JSON.stringify(sourceRanges(fixture, {chunk_id: "hit"}))'))
  assert.deepEqual(ranges, [[start, end]])
  const html = page.run('sourceHtml(fixture.source.text, sourceRanges(fixture, {chunk_id: "hit"}))')
  assert.equal((html.match(/<mark /g) || []).length, 1)
  assert.ok(html.includes('标题😀\n'))
  assert.ok(html.includes('证据 &lt;img src=x onerror=alert(1)&gt;</mark> &amp; 结尾'))
  assert.ok(!html.includes('<img'))
})

test('legacy citations fall back to a matching literal quote without changing the source', () => {
  const page = frontend()
  page.context.fixture = { source: { text: 'Prefix <script>bad()</script> suffix' }, chunks: [] }
  const ranges = JSON.parse(page.run('JSON.stringify(sourceRanges(fixture, {quote: "<script>bad()</script>"}))'))
  assert.deepEqual(ranges, [[7, 29]])
  const html = page.run('sourceHtml(fixture.source.text, sourceRanges(fixture, {quote: "<script>bad()</script>"}))')
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.equal(page.run('fixture.source.text'), 'Prefix <script>bad()</script> suffix')
})

test('opening a citation requests its recorded version and renders a marked source plus version navigation', async () => {
  const page = frontend(() => ({
    document: { id: 'doc-a', title: 'Doc <A>', version: 2, status: 'active', source_type: 'text', chunks: 1, quality: 1, acl_label: '全员可见', source_trust: 0.5, content_hash: 'abc123', updated_at: '2023-01-01T00:00:00Z', enrichment_status: 'done', summary: '' },
    versions: [{ id: 'old-v', version: 1, parser: 'text', hash: 'abc', chars: 8, created_at: '2023-01-01T00:00:00Z' }],
    source: { version_id: 'old-v', version: 1, text: 'old text', coordinate_system: 'normalized-text-utf16' },
    chunks: [{ id: 'old-c', text: 'old text', spans: [{ start: 0, end: 8 }], seq: 0, tokens: 2 }],
    facts: [], entities: [],
  }))
  await page.run('openCitation({doc_id: "doc-a", chunk_id: "old-c", version_id: "old-v"})')
  assert.equal(page.calls[0]!.url, '/api/v1/documents/doc-a?version_id=old-v')
  const html = page.element('#doc-dialog-body').innerHTML
  assert.match(html, /data-doc-tab="source"[^>]*>原文/)
  assert.match(html, /查看版本<\/span><strong>v1/)
  assert.match(html, /<mark[^>]*>old text<\/mark>/)
  assert.match(html, /data-doc-version="old-v" aria-current="true"/)
  assert.match(html, /data-doc-action="update"/)
  assert.equal(page.element('#doc-dialog-title').textContent, 'Doc <A>')
})

test('document updates send doc_id in text, URL and multipart requests and clear it on close', async () => {
  const page = frontend((url) => url.endsWith('/acl-options') ? { groups: [] } : {})
  page.run('setupIngest()')
  const event = { preventDefault() {}, submitter: page.element('submit') }
  page.run('openIngest({id: "existing", title: "Existing title", source_type: "text"})')
  assert.equal(page.element('#ingest-title').textContent, '更新文档')
  page.element('#text-input').value = 'Updated text'
  await page.element('#ingest-text-form').handlers.submit(event)
  const text = page.calls.find(call => call.url.endsWith('/documents/text'))!
  assert.equal(JSON.parse(String(text.options.body)).doc_id, 'existing')
  assert.equal(JSON.parse(String(text.options.body)).acl, null)
  assert.equal(page.run('state.ingestDocumentId'), null)

  page.run('openIngest({id: "existing", title: "Existing title", source_type: "web", uri: "https://example.test/doc"})')
  await page.element('#ingest-url-form').handlers.submit(event)
  const url = page.calls.find(call => call.url.endsWith('/documents/url'))!
  assert.equal(JSON.parse(String(url.options.body)).doc_id, 'existing')

  page.run('openIngest({id: "existing", title: "Existing title", source_type: "pdf"})')
  const input = page.element('#file-input')
  assert.equal(input.multiple, false)
  page.element('#file-drop').handlers.drop({
    preventDefault() {},
    dataTransfer: { files: [{ name: 'a.pdf' }, { name: 'b.pdf' }] },
  })
  assert.equal(page.run('state.ingestFiles.length'), 0)
  assert.match(page.element('#file-submit-status').textContent, /请选择一份文件/)
  input.files = [{ name: 'new.pdf', size: 10 }]
  input.handlers.change()
  await page.element('#ingest-file-form').handlers.submit(event)
  const file = page.calls.find(call => call.url.endsWith('/documents/upload'))!
  const fields = (file.options.body as Form).fields
  assert.deepEqual(fields[0], ['doc_id', 'existing'])
  assert.equal(fields[fields.length - 1]![0], 'file')
  assert.ok(!fields.some(([key]) => key === 'acl'))

  page.run('openIngest({id: "existing", title: "Existing title"})')
  page.element('#ingest-dialog').close()
  assert.equal(page.run('state.ingestDocumentId'), null)
  assert.equal(page.element('#ingest-title').textContent, '添加文档')
  assert.equal(input.multiple, true)
})

test('batch file ingestion queues each file with shared permissions and retries only failed submissions', async () => {
  let failOnce = true
  const page = frontend((url, options) => {
    if (url.endsWith('/acl-options')) return { groups: ['team'] }
    const file = (options.body as Form).fields.find(([key]) => key === 'file')?.[1] as { name: string }
    if (file.name === '<retry>.txt' && failOnce) {
      failOnce = false
      throw new Error('<temporary failure>')
    }
    return { job_id: file.name, title: file.name, status: 'pending' }
  })
  page.run('setupIngest(); openIngest(); aclPickerState.set($("#file-acl"), { selected: new Set(["group:team"]) })')
  assert.equal(page.element('#file-input').multiple, true)
  const names = ['first.md', '<retry>.txt', 'last.pdf']
  const event = { preventDefault() {} }
  page.element('#file-drop').handlers.drop({
    ...event,
    dataTransfer: { files: names.map(name => ({ name, size: 10 })) },
  })
  assert.equal(page.element('#file-title-field').hidden, true)
  assert.match(page.element('#ingest-files').innerHTML, /first\.md.*&lt;retry&gt;\.txt.*last\.pdf/)

  const submit = page.element('#ingest-file-form').handlers.submit
  const uploads = () => page.calls.filter(call => call.url.endsWith('/documents/upload'))
  const initial = submit(event)
  await submit(event)
  await initial
  assert.equal(uploads().length, 3)
  for (const [index, call] of uploads().entries()) {
    assert.deepEqual((call.options.body as Form).fields, [
      ['acl', 'group:team'],
      ['file', { name: names[index], size: 10 }],
    ])
  }
  assert.equal(page.run('state.jobs.length'), 2)
  assert.equal(page.element('#ingest-dialog').open, true)
  assert.equal(page.element('#file-submit-status').textContent, '已提交 2 份，1 份提交失败。')
  assert.match(page.element('#ingest-files').innerHTML, /&lt;retry&gt;\.txt.*&lt;temporary failure&gt;/)
  assert.doesNotMatch(page.element('#ingest-files').innerHTML, /first\.md|last\.pdf/)

  await submit(event)
  assert.equal(uploads().length, 4)
  assert.deepEqual((uploads()[3]!.options.body as Form).fields, (uploads()[1]!.options.body as Form).fields)
  assert.equal(page.run('state.jobs.length'), 3)
  assert.equal(page.element('#ingest-dialog').open, false)
})

test('trash dialog lists documents and can restore or permanently delete them', async () => {
  let items = [{ id: 'doc-1', title: '回收样例', source_type: 'text', version: 1, chunks: 0, deleted_at: '2026-11-01T02:00:00Z', expires_at: '2026-12-01T02:00:00Z', acl_label: '全员可见' }]
  const page = frontend(url => {
    if (url === '/api/v1/documents/trash') return { items, retention_days: 30, can_manage: true }
    if (url === '/api/v1/documents/doc-1/restore') { items = []; return { status: 'active', message: '文档已恢复，检索索引与事实抽取已重新排队' } }
    if (url === '/api/v1/documents/doc-1/permanent') { items = []; return { status: 'purged', removed_facts: 2 } }
    return { items: [] }
  })
  const restore = page.element('restore-btn')
  const purge = page.element('purge-btn')
  restore.dataset.trashRestore = 'doc-1'
  purge.dataset.trashPurge = 'doc-1'
  purge.dataset.trashTitle = '回收样例'
  page.context.document.querySelectorAll = (selector: string) => selector === '#trash-list [data-trash-restore]'
    ? [restore]
    : selector === '#trash-list [data-trash-purge]' ? [purge] : []

  await page.run('openTrash()')
  assert.equal(page.element('#trash-dialog').open, true)
  assert.match(page.element('#trash-note').textContent, /超过 30 天的文档会被自动彻底删除/)
  const list = page.element('#trash-list')
  assert.match(list.innerHTML, /回收样例/)
  assert.match(list.innerHTML, /v1 · 移入于/)
  assert.match(list.innerHTML, /自动清除/)

  await restore.handlers.click()
  assert.deepEqual(page.calls.filter(call => call.options.method === 'POST').map(call => call.url), ['/api/v1/documents/doc-1/restore'])
  assert.equal(page.element('#trash-list').innerHTML, '<div class="empty-block">回收站为空</div>')

  page.context.confirm = () => true
  page.context.document.querySelectorAll = (selector: string) => selector === '#trash-list [data-trash-purge]' ? [purge] : []
  await purge.handlers.click()
  assert.deepEqual(page.calls.filter(call => call.options.method === 'DELETE').map(call => call.url), ['/api/v1/documents/doc-1/permanent'])
})

test('entity page defaults to the entity list and expands the relation graph in place', async () => {
  const page = frontend(() => ({ nodes: [], edges: [] }))
  page.run('setupEntityView()')
  const layout = page.element('#entities-layout')
  const toggle = page.element('#graph-toggle')
  assert.equal(layout.dataset.view, 'entity')
  assert.equal(toggle['aria-pressed'], 'false')
  assert.equal(page.element('span').textContent, '查看关系图谱')

  toggle.handlers.click()
  assert.equal(layout.dataset.view, 'graph')
  assert.equal(toggle['aria-pressed'], 'true')
  assert.equal(page.element('span').textContent, '收起图谱')

  toggle.handlers.click()
  assert.equal(layout.dataset.view, 'entity')
  assert.equal(toggle['aria-pressed'], 'false')

  // 缩略图里点空白处也展开，点节点则只选中实体
  const canvas = page.element('#graph-canvas')
  canvas.handlers.click({ target: canvas })
  assert.equal(layout.dataset.view, 'graph')

  // 展开态默认收起实体列表，把空间全给图谱；需要时再拉出来
  const rail = page.element('#entity-rail-toggle')
  assert.equal(layout.dataset.rail, 'hidden')
  assert.equal(rail['aria-pressed'], 'false')
  rail.handlers.click()
  assert.equal(layout.dataset.rail, 'shown')
  assert.equal(rail['aria-pressed'], 'true')
  rail.handlers.click()
  assert.equal(layout.dataset.rail, 'hidden')
})

const graphFixture = () => ({
  focus: 'a',
  hops: 2,
  hidden: { nodes: 0, edges: 0 },
  nodes: [
    { id: 'a', name: '高血压患者规范管理率', type: 'concept', hop: 0, degree: 2, attrs: [
      { fact_id: 'f1', predicate: '等于', relation: { key: 'definition', label: '定义/口径' }, value: '按照规范要求进行…×100％', status: 'active', confidence: 0.95 },
    ] },
    { id: 'b', name: '指标口径', type: 'concept', hop: 1, degree: 1, attrs: [] },
    { id: 'c', name: '乡镇卫生院', type: 'org', hop: 1, degree: 2, attrs: [] },
    { id: 'd', name: '健康知识讲座', type: 'concept', hop: 2, degree: 1, attrs: [] },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', predicate: '计算方式为', label: '计算方式为', relation: { key: 'definition', label: '定义/口径' }, value: null, object_literal: null, status: 'active', confidence: 0.9, hop: 1 },
    { id: 'e2', source: 'a', target: 'c', predicate: '由乡镇卫生院负责', label: '由乡镇卫生院负责', relation: { key: 'responsible', label: '实施主体' }, value: null, object_literal: null, status: 'active', confidence: 0.8, hop: 1 },
    { id: 'e3', source: 'c', target: 'd', predicate: '每月至少举办', label: '每月至少举办', relation: { key: 'frequency', label: '频次/时限' }, value: null, object_literal: null, status: 'disputed', confidence: 0.75, hop: 2 },
  ],
})

const svgChildren = (canvas: any) => canvas.children ?? []
const withClass = (canvas: any, tag: string, prefix: string) =>
  svgChildren(canvas).filter((child: any) => child.tag === tag && String(child.attrs?.class ?? '').startsWith(prefix))
const allWithClass = (canvas: any, prefix: string) =>
  svgChildren(canvas).filter((child: any) => String(child.attrs?.class ?? '').startsWith(prefix))

function centerOf(group: any) {
  const match = String(group.attrs.transform).match(/translate\(([-\d.]+),([-\d.]+)\)/)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: NaN, y: NaN }
}

test('relation graph draws every node and edge label with directed arrows', () => {
  const page = frontend()
  page.context.graphProbe = graphFixture()
  page.run('state.graph = graphProbe; state.activeEntity = "a"; state.entityView = "graph"; drawGraph()')
  const canvas = page.element('#graph-canvas')
  canvas.clientWidth = 720
  canvas.clientHeight = 480
  page.run('renderGraph()')

  const nodeGroups = withClass(canvas, 'g', 'g-node')
  assert.equal(nodeGroups.length, 4, '四个实体都应占节点')
  assert.equal(allWithClass(canvas, 'g-node').length, 4)

  // 关系标签一条都不能少：这是上一版最难读的地方（短边标签被阈值吞掉）
  const edgeLabels = withClass(canvas, 'g', 'g-edge-tag')
  assert.equal(edgeLabels.length, 3, '每条实体关系都要有标签')
  const labelTexts = edgeLabels.map((group: any) => group.children.find((child: any) => child.tag === 'text').textContent)
  assert.deepEqual(labelTexts.sort(), ['每月至少举办', '由乡镇卫生院负责', '计算方式为'].sort())
  assert.ok(!labelTexts.includes('定义/口径'), '边标签用原文谓语，不再用归类名')

  // 缩略标签悬停可看完整原文；缩略的节点名也能在节点提示里看全
  const tagTitles = edgeLabels.map((group: any) => group.children.find((child: any) => child.tag === 'title')?.textContent)
  assert.ok(tagTitles.every((text: string) => text && text.includes('→')), '每个边标签都要带完整三元组提示')
  assert.ok(tagTitles.some((text: string) => text.includes('由乡镇卫生院负责')), '悬停可读到未截断的谓语')
  nodeGroups.forEach((group: any) => {
    const title = group.children.find((child: any) => child.tag === 'title')
    assert.ok(title && title.textContent.length > 0, '节点提示里保留完整名称')
  })

  // 归类名退到悬停提示，原文谓语与类别都能看到
  const pathTitles = svgChildren(canvas)
    .filter((child: any) => child.tag === 'path' && String(child.attrs?.class ?? '').startsWith('g-link'))
    .flatMap((path: any) => (path.children || []).filter((child: any) => child.tag === 'title'))
    .map((title: any) => title.textContent)
  assert.ok(pathTitles.some((text: string) => text.includes('关系类型：实施主体')), '悬停提示保留关系类型')
  assert.ok(pathTitles.some((text: string) => text.includes('由乡镇卫生院负责')), '悬停提示保留原文谓语')

  // 方向：每条边一个箭头
  assert.equal(allWithClass(canvas, 'g-arrow').length, 3, '每条关系都要有箭头')
  assert.equal(allWithClass(canvas, 'g-arrow disputed').length, 1, '存疑关系用存疑箭头')

  // 每个节点都要有名字，中心节点居中放大，二跳节点在外环
  nodeGroups.forEach((group: any) => assert.ok(group.children.some((child: any) => child.tag === 'text')))
  const centers = nodeGroups.map((group: any) => ({ id: group.attrs['aria-label'] ?? 'focus', ...centerOf(group) }))
  const focus = centers.find((item: any) => item.id === 'focus')
  assert.equal(focus.x, 360)
  assert.equal(focus.y, 240)
  const ring = (id: string) => centers.find((item: any) => item.id === `选择实体 ${{ b: '指标口径', c: '乡镇卫生院', d: '健康知识讲座' }[id]}`)
  const radiusOf = (item: any) => Math.hypot(item.x - 360, item.y - 240)
  assert.ok(Math.abs(radiusOf(ring('b')) - radiusOf(ring('c'))) < 1, '一跳邻居在同一环上')
  assert.ok(radiusOf(ring('d')) > radiusOf(ring('b')) + 20, '二跳实体落在外环')

  // 字面值不进图，改挂在焦点的属性条上；属性条被 CSS 抳断时，悬停可看完整谓语与值
  assert.match(page.element('#graph-attrs').innerHTML, /属性/)
  assert.match(page.element('#graph-attrs').innerHTML, /按照规范要求进行…×100％/)
  assert.match(page.element('#graph-attrs').innerHTML, /title="等于：按照规范要求进行…×100％"/)
  assert.equal(page.element('#graph-attrs').hidden, false)
})

test('graph legend explains shapes, direction and relation states', () => {
  const page = frontend()
  page.context.graphProbe = graphFixture()
  page.run('state.graph = graphProbe; state.activeEntity = "a"; state.entityView = "graph"; drawGraph()')
  const legend = page.element('#graph-legend').innerHTML
  assert.match(legend, /概念/)
  assert.match(legend, /机构/)
  assert.match(legend, /指向宾语/)
  assert.match(legend, /存疑/)
})

test('graph overview keeps the selected node in view until local mode is requested', async () => {
  const page = frontend((url) => {
    const fixture = graphFixture()
    if (url.includes('scope=overview')) return {
      ...fixture, focus: null,
      nodes: [...fixture.nodes, { id: 'isolated', name: '独立指标', type: 'concept', degree: 0, attrs: [] }],
      edges: [...fixture.edges, { ...fixture.edges[0], id: 'reverse', source: 'b', target: 'a', predicate: '用于计算' }],
    }
    if (url.includes('/graph')) return { focus: 'isolated', nodes: [], edges: [] }
    return { entity: { id: 'isolated', name: '独立指标' }, facts: [], documents: [] }
  })
  const scope = page.element('[data-graph-scope]')
  scope.dataset.graphScope = 'overview'
  const local = page.element('[data-graph-scope="local"]')
  local.dataset.graphScope = 'local'
  page.context.document.querySelectorAll = (selector: string) => selector === '[data-graph-scope]' ? [scope, local] : []
  page.run('setupEntityView()')
  scope.handlers.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.run('state.graphScope'), 'overview')
  assert.equal(page.run('state.entityView'), 'graph')
  const canvas = page.element('#graph-canvas')
  assert.equal(allWithClass(canvas, 'g-overview-cluster').length, 0)
  assert.equal(allWithClass(canvas, 'g-node').length, 5)
  const lines = allWithClass(canvas, 'g-overview-edge')
  assert.equal(lines.length, 4)
  const forward = lines.find((line: any) => line.attrs['data-fact-id'] === 'e1')
  const reverse = lines.find((line: any) => line.attrs['data-fact-id'] === 'reverse')
  assert.equal(forward.children[0].textContent, '高血压患者规范管理率 — 计算方式为 → 指标口径')
  assert.equal(reverse.children[0].textContent, '指标口径 — 用于计算 → 高血压患者规范管理率')
  assert.ok(lines.every((line: any) => withClass(line, 'path', 'g-arrow').length === 1))
  assert.notEqual(forward.children[1].attrs.d.split(' Q')[1].split(' ')[0],
    reverse.children[1].attrs.d.split(' Q')[1].split(' ')[0])
  const metric = allWithClass(canvas, 'g-node').find((item: any) => item.attrs['aria-label'].includes('高血压'))
  assert.match(metric.attrs.class, /\bhub\b/)
  const [, , width, height] = canvas.viewBox.split(' ').map(Number)
  assert.ok(Math.abs(centerOf(metric).x - (Number(canvas.viewBox.split(' ')[0]) + width / 2)) < 0.01)
  assert.ok(Math.abs(centerOf(metric).y - (Number(canvas.viewBox.split(' ')[1]) + height / 2)) < 0.01)
  assert.equal(lines.filter((line: any) => /\bspoke\b/.test(line.attrs.class)).length, 3)
  metric.handlers.pointerenter()
  assert.equal(forward.attrs['data-highlighted'], 'true')
  assert.equal(reverse.attrs['data-highlighted'], 'true')
  assert.equal(lines.find((line: any) => line.attrs['data-fact-id'] === 'e3').attrs['data-highlighted'], undefined)
  metric.handlers.pointerleave()
  assert.equal(forward.attrs['data-highlighted'], undefined)
  const node = canvas.children.find((item: any) => item.attrs['aria-label'] === '查看 独立指标 的详情')
  assert.ok(node)
  assert.equal(canvas.style.height, '')
  page.element('#graph-overview-size').handlers.click()
  assert.match(canvas.style.height, /px$/)
  const graphCalls = page.calls.filter(call => call.url.includes('/graph')).length
  const zoomedNode = canvas.children.find((item: any) => item.attrs['data-entity'] === 'isolated')
  zoomedNode.handlers.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.run('state.graphScope'), 'overview')
  assert.equal(scope['aria-pressed'], 'true')
  assert.equal(page.calls.filter(call => call.url.includes('/graph')).length, graphCalls)
  assert.ok(canvas.children.includes(zoomedNode))
  assert.match(page.element('#entity-detail').innerHTML, /独立指标/)
  local.handlers.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.run('state.graphScope'), 'local')
  assert.ok(page.calls.some(call => call.url.includes('/graph?focus=isolated&hops=2')))
  assert.match(page.element('#entity-detail').innerHTML, /独立指标/)
})

test('graph edge labels show the raw predicate instead of the relation type', () => {
  const page = frontend()
  assert.equal(page.run('graphRelationLabel({ predicate: "对6岁儿童增加1剂", relation: { key: "other", label: "其它" } })'), '对6岁儿童增加1剂')
  assert.equal(page.run('graphRelationLabel({ predicate: "等于", relation: { key: "definition", label: "定义/口径" } })'), '等于')
  assert.equal(page.run('graphRelationType({ predicate: "等于", relation: { key: "definition", label: "定义/口径" } })'), '定义/口径')
})

test('entity detail groups facts by relation type and marks inbound relations', () => {
  const page = frontend()
  const entity = { id: 'a', name: '高血压患者规范管理率' }
  const facts = [
    { id: 'f1', subject_id: 'a', object_id: 'b', subject: '高血压患者规范管理率', object: '指标口径', predicate: '计算方式为', relation: { key: 'definition', label: '定义/口径' }, status: 'active', confidence: 0.9 },
    { id: 'f2', subject_id: 'c', object_id: 'a', subject: '山东省', object: '高血压患者规范管理率', predicate: '对…提出', relation: { key: 'requirement', label: '要求' }, status: 'active', confidence: 0.8 },
    { id: 'f3', subject_id: 'a', object_id: null, subject: '高血压患者规范管理率', object_literal: '90%', predicate: '2030年目标为', relation: { key: 'target', label: '目标值' }, status: 'active', confidence: 0.85 },
  ]
  page.context.factProbe = { entity, facts }
  page.run('__detail = entityFactGroups(factProbe.facts.filter(f => f.object_id), factProbe.entity)')
  const html = page.context.__detail
  assert.match(html, /定义\/口径/)
  assert.match(html, /要求/)
  assert.match(html, /山东省 →/, '本实体作为宾语时要标出主语')
})


test('entity graph requests the focused neighbourhood and widens it to two hops when expanded', async () => {
  const page = frontend((url) => {
    if (url.includes('/graph')) return { focus: 'a', hops: 1, nodes: [], edges: [], hidden: { nodes: 0, edges: 0 } }
    if (url.includes('/entities/')) {
      return { entity: { id: 'a', name: '甲', type: 'concept', acl_label: '全员可见' }, facts: [], documents: [] }
    }
    return { items: [] }
  })
  await page.run('selectEntity("a")')
  await new Promise((resolve) => setImmediate(resolve))
  const graphUrls = () => page.calls.filter((call) => call.url.includes('/graph')).map((call) => call.url)
  assert.deepEqual(graphUrls(), ['/api/v1/graph?focus=a&hops=1&limit=80'], '缩略图只要一跳')

  page.run('setEntityView("graph")')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(graphUrls(), ['/api/v1/graph?focus=a&hops=1&limit=80', '/api/v1/graph?focus=a&hops=2&limit=80'], '展开后补取二跳')
})

test('duplicate facts between the same pair collapse into one edge with a count', () => {
  const page = frontend()
  page.context.edgeProbe = [
    { id: 'f1', source: 'a', target: 'b', predicate: '等于', relation: { key: 'definition', label: '定义/口径' }, status: 'active' },
    { id: 'f2', source: 'a', target: 'b', predicate: '计算方式为', relation: { key: 'definition', label: '定义/口径' }, status: 'active' },
    { id: 'f3', source: 'a', target: 'b', predicate: '计算为', relation: { key: 'definition', label: '定义/口径' }, status: 'disputed' },
    { id: 'f4', source: 'a', target: 'c', predicate: '负责', relation: { key: 'responsible', label: '实施主体' }, status: 'active' },
  ]
  const merged = page.run('graphMergeEdges(edgeProbe)')
  assert.equal(merged.length, 3, '同状态同关系合并，不同状态与不同宾语不合并')
  assert.equal(merged[0].count, 2)
  assert.equal(JSON.stringify(merged[0].predicates), JSON.stringify(['等于', '计算方式为']))
})
