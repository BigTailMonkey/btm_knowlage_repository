import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const appSource = readFileSync(new URL('../knowweave/web/app.js', import.meta.url), 'utf8')

class Form {
  fields: Array<[string, unknown]> = []
  append(key: string, value: unknown) { this.fields.push([key, value]) }
}

function frontend(respond: (url: string, options: Record<string, unknown>) => unknown = () => ({ items: [], groups: [] })) {
  const nodes = new Map<string, any>()
  const calls: Array<{ url: string; options: Record<string, unknown> }> = []
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
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {}, body: { dataset: {} } },
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    window: { addEventListener() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url: string, options = {}) => {
      calls.push({ url, options })
      const payload = await respond(url, options)
      return { ok: true, status: 200, json: async () => payload }
    },
  })
  vm.runInContext(appSource, context)
  return { context, nodes, calls, element, run: (code: string) => vm.runInContext(code, context) }
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

  page.run('openIngest({id: "existing", title: "Existing title", source_type: "pdf"}); state.file = {name: "new.pdf"}')
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
})
