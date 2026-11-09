import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const bootstrapSource = readFileSync(
  new URL('../src/adapters/dsh-web/branding/bootstrap.js', import.meta.url),
  'utf8',
)

/** Run the injected bootstrap against the minimum DOM the embedded DSH shell provides. */
function branding(options: { phase?: string; online?: boolean } = {}) {
  const posted: unknown[] = []
  const documentListeners = new Map<string, Array<(event: any) => void>>()
  const attributes = new Set<string>()
  const transport = { phase: options.phase as string | undefined, online: options.online ?? true }
  const documentElement = {
    dataset: {} as Record<string, string>,
    hasAttribute(name: string) { return attributes.has(name) },
    setAttribute(name: string) { attributes.add(name) },
    removeAttribute(name: string) { attributes.delete(name) },
  }
  let observed: (() => void) | null = null
  let heartbeat: (() => void) | null = null
  const phaseButton = {
    dataset: { get phase() { return transport.phase } },
  }
  const document = {
    title: 'DeepSeek Harness',
    hidden: false,
    documentElement,
    querySelector(selector: string) {
      if (selector === 'button[data-phase]') return phaseButton
      return null
    },
    querySelectorAll() { return [] },
    addEventListener(type: string, callback: (event: any) => void) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), callback])
    },
  }
  const window: Record<string, any> = {
    self: {},
    top: {},
    navigator: { get onLine() { return transport.online } },
    setTimeout,
    parent: { postMessage(message: unknown) { posted.push(message) } },
  }
  window.self = window
  const context = vm.createContext({
    console,
    URL,
    document,
    window,
    queueMicrotask,
    setInterval: (callback: () => void) => { heartbeat = callback; return 1 },
    clearInterval() {},
    MutationObserver: class {
      constructor(callback: () => void) { observed = callback }
      observe() {}
    },
  })
  vm.runInContext(bootstrapSource, context)
  const fire = (type: string, event: unknown) => {
    for (const callback of documentListeners.get(type) ?? []) callback(event)
  }
  return {
    attributes, posted, transport, fire,
    tick() { heartbeat?.() },
    refresh() { observed?.() },
  }
}

test('embedded chat announces a heartbeat the shell can watch', () => {
  const page = branding()
  assert.equal(page.posted.length, 1, 'one beat on boot')
  assert.equal((page.posted[0] as { type: string }).type, 'knowweave:heartbeat')
  page.tick()
  assert.equal(page.posted.length, 2, 'and one per interval')
  page.fire('visibilitychange', {})
  assert.equal(page.posted.length, 3, 'a hidden-tab return beats again')
})

test('a broken transport marks the page so the composer can be held', () => {
  const page = branding({ phase: 'disconnected' })
  assert.equal(page.attributes.has('data-knowweave-offline'), true)
  let prevented = 0
  const event = {
    key: 'Enter', shiftKey: false, isComposing: false,
    target: { closest: () => ({}) },
    preventDefault() { prevented += 1 }, stopImmediatePropagation() {},
  }
  page.fire('keydown', event)
  assert.equal(prevented, 1, 'Enter would submit into no connection')
  assert.equal(page.fire('keydown', { ...event, shiftKey: true }), undefined, 'Shift+Enter still inserts a line')
})

test('a synchronized transport lets the composer submit again', () => {
  const page = branding({ phase: 'connected' })
  assert.equal(page.attributes.has('data-knowweave-offline'), false)
  let prevented = 0
  page.fire('keydown', {
    key: 'Enter', shiftKey: false, isComposing: false,
    target: { closest: () => ({}) },
    preventDefault() { prevented += 1 }, stopImmediatePropagation() {},
  })
  assert.equal(prevented, 0)
})

test('an offline browser holds the composer even without a connection indicator', () => {
  const page = branding({ online: false })
  assert.equal(page.attributes.has('data-knowweave-offline'), true)
})

test('the offline marker clears once the indicator recovers', async () => {
  const page = branding({ phase: 'disconnected' })
  assert.equal(page.attributes.has('data-knowweave-offline'), true)
  page.transport.phase = 'connected'
  page.refresh()
  // The observer coalesces chrome updates into a microtask.
  await Promise.resolve()
  assert.equal(page.attributes.has('data-knowweave-offline'), false, 'recovered transport frees the composer')
})
