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
      nodes.set(selector, {
        innerHTML: '', textContent: '', value: '', hidden: false, open: false,
        dataset: {}, style: {}, scrollHeight: 44, handlers,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(type: string, callback: (...args: any[]) => any) { handlers[type] = callback },
        setAttribute(key: string, value: string) { this[key] = value },
        getAttribute(key: string) { return this[key] ?? null },
        removeAttribute(key: string) { delete this[key] },
        focus() {}, scrollIntoView() {},
        reset() { this.value = '' },
        showModal() { this.open = true },
        close() { this.open = false; handlers.close?.() },
        querySelector: element,
        querySelectorAll() { return [] },
      })
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
  single.dataset.extractionRetry = 'doc-a'
  bulk.dataset.extractionRetry = ''
  box.querySelectorAll = (selector: string) => selector === '[data-extraction-retry]' ? [single, bulk] : []

  await page.run('state.page = "library"; loadIngestJobs()')
  assert.equal(box.hidden, false)
  assert.match(box.innerHTML, /模型 HTTP 401/)
  assert.match(box.innerHTML, /后续文档 · v1[\s\S]*抽取中/)
  await single.handlers.click()
  await bulk.handlers.click()
  assert.deepEqual(page.calls.filter(call => call.url.endsWith('/extractions/retry'))
    .map(call => JSON.parse(String(call.options.body))), [{ document_ids: ['doc-a'] }, {}])
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
    document: { id: 'doc-a', title: 'Doc <A>', version: 2, source_type: 'text', chunks: 1, quality: 1, acl_label: '全员可见' },
    versions: [{ id: 'old-v', version: 1, parser: 'text', hash: 'abc', chars: 8, created_at: '2023-01-01T00:00:00Z' }],
    source: { version_id: 'old-v', version: 1, text: 'old text', coordinate_system: 'normalized-text-utf16' },
    chunks: [{ id: 'old-c', text: 'old text', spans: [{ start: 0, end: 8 }], seq: 0, tokens: 2 }],
    facts: [], entities: [],
  }))
  await page.run('openCitation({doc_id: "doc-a", chunk_id: "old-c", version_id: "old-v"})')
  assert.equal(page.calls[0]!.url, '/api/v1/documents/doc-a?version_id=old-v')
  const html = page.element('#doc-dialog-body').innerHTML
  assert.match(html, /原文 · v1/)
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
