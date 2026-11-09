(() => {
  'use strict'

  const embedded = window.self !== window.top
  if (embedded) {
    document.documentElement.dataset.knowweaveEmbedded = ''
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]')
      if (!link || !link.href.startsWith('https://citation.knowweave.invalid/')) return
      const path = new URL(link.href).pathname
      if (!/^\/[\w-]{1,100}\/[\w-]{1,100}(?:\/[\w-]{1,100})?$/.test(path)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      window.parent.postMessage({ type: 'knowweave:open-citation', path }, '*')
    }, true)

    // The embedding shell cannot see this page's WebSocket. A heartbeat lets it tell a
    // live conversation surface from a dead, unauthenticated or crashed one.
    const heartbeat = () => {
      try { window.parent.postMessage({ type: 'knowweave:heartbeat' }, '*') } catch (_) { /* parent gone */ }
    }
    heartbeat()
    setInterval(heartbeat, 4000)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat() }, true)

    // Sending while the transport is down only produces a failure notice, so hold the
    // composer until the Connection indicator reports an established generation again.
    // Enter is the composer's submit key; gating it here keeps a draft in the editor.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (!document.documentElement.hasAttribute('data-knowweave-offline')) return
      const card = event.target?.closest?.('[data-composer-card]')
      if (card === undefined || card === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }, true)
  }

  /** The Connection indicator is DSH's own transport state; mirror it into a page marker. */
  function updateTransport() {
    if (!embedded) return
    const phase = document.querySelector('button[data-phase]')?.dataset.phase
      ?? (window.navigator?.onLine === false ? 'disconnected' : undefined)
    const offline = phase === 'connecting' || phase === 'disconnected'
    if (offline === document.documentElement.hasAttribute('data-knowweave-offline')) return
    if (offline) document.documentElement.setAttribute('data-knowweave-offline', '')
    else document.documentElement.removeAttribute('data-knowweave-offline')
  }

  // Only presentation templates are adapted. IDs, URLs, substituted parameters,
  // editable fields and user-authored messages never pass through this function.
  function brandCopy(value) {
    if (typeof value !== 'string') return value
    return value.replace(/https?:\/\/[^\s<>"']+|DeepSeek[\s_-]+Harness|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bdeepseek[-_][a-z0-9._-]+\b|DeepSeek(?![a-z0-9._/-])|\bDSH\b/gi, (token) => {
      if (/^DeepSeek[\s_-]+Harness$/i.test(token)) return '知织'
      if (/^(?:https?:\/\/|[A-Z][A-Z0-9]*_)|^deepseek[-_]/i.test(token)) return token
      return /^DSH$/i.test(token) ? '知织' : '模型服务'
    })
  }

  function brandDictionary(ns, dict) {
    if (!dict || typeof dict !== 'object') return dict
    return Object.fromEntries(Object.entries(dict).map(([key, text]) => [key,
      ns === 'conversation' && key === 'hero.headline' ? '让知识触手可及'
        : ns === 'conversation' && key === 'hero.preview' ? '' : brandCopy(text),
    ]))
  }

  // The bundled locale package owns every system dictionary. Decorate its
  // public registration API before activation, so replacements precede runtime
  // interpolation and cannot alter model IDs or other dynamic values.
  const wrappedRuntimes = new WeakSet()
  function wrapLocale(exports) {
    const proto = exports?.LocaleRuntime?.prototype
    if (!proto || wrappedRuntimes.has(proto)) return
    wrappedRuntimes.add(proto)
    const register = proto.register
    proto.register = function (ns, localeOrDicts, dict) {
      if (typeof localeOrDicts === 'string') return register.call(this, ns, localeOrDicts, brandDictionary(ns, dict))
      const dictionaries = Object.fromEntries(Object.entries(localeOrDicts).map(([locale, entries]) => [locale, brandDictionary(ns, entries)]))
      return register.call(this, ns, dictionaries)
    }
    const resolveText = proto.resolveText
    proto.resolveText = function (text) { return brandCopy(resolveText.call(this, text)) }
  }

  const wrappedFacades = new WeakSet()
  function wrapFacade(facade) {
    if (!facade || wrappedFacades.has(facade)) return facade
    wrappedFacades.add(facade)
    let load = facade.load
    Object.defineProperty(facade, 'load', {
      configurable: true,
      get() {
        return function (registration) {
          if (registration.id === '@deepseek-ai/dsh-client-locale') {
            const factory = registration.factory
            registration = { ...registration, factory(require) {
              const exports = factory(require)
              wrapLocale(exports)
              return exports
            } }
          }
          return load.call(this, registration)
        }
      },
      set(next) { load = next },
    })
    return facade
  }

  let facade = wrapFacade(window.__ModuleLoader__)
  Object.defineProperty(window, '__ModuleLoader__', {
    configurable: true,
    get() { return facade },
    set(next) { facade = wrapFacade(next) },
  })

  function updateTitle() {
    const title = document.title
    // Preserve a session's user-authored title and change only the shell suffix.
    const next = title.replace(/(?:^| — )DeepSeek Harness$/, (suffix) => suffix.startsWith(' — ') ? ' — 知织' : '知织')
    if (next !== title) document.title = next
  }

  function modelLabel(value) {
    return brandCopy(value).replace(/\bdeepseek[-_]([a-z0-9._-]+)\b/gi, (_model, variant) => {
      const label = { chat: '标准', reasoner: '推理' }[variant.toLowerCase()] || variant
      return `对话模型 · ${label}`
    })
  }

  function rewriteText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // A model's label is a presentation alias. The original input values,
      // option values and API payloads retain their configured identifiers.
      const next = modelLabel(node.nodeValue)
      if (next !== node.nodeValue) node.nodeValue = next
    }
  }

  // These are upstream system-label class suffixes, deliberately excluding
  // conversation trees, document previews, search results and editable values.
  const labelSelector = [
    '[class~="zGbnIq_rowName"]', '[class~="zGbnIq_editorTitle"]',
    '[class~="_7KE1Ra_badgedNameText"]', '[class~="_7KE1Ra_triggerLabel"]',
    '[class~="_7KE1Ra_modelName"]',
  ].join(',')
  const controlSelector = [
    '[class~="_7KE1Ra_trigger"]', '[class~="_7KE1Ra_modelOption"]',
    '[class~="_7KE1Ra_option"]', labelSelector,
  ].join(',')

  let blankSession = null
  function notifyNewConversation() {
    // DSH uses the hero phase for its new conversation, including keyboard
    // shortcuts and workspace actions that do not click the sidebar button.
    const conversation = document.querySelector('[data-conversation-content]')
    const next = conversation?.dataset.contentPhase === 'hero'
      ? conversation.dataset.conversationSession ?? ''
      : null
    if (next !== null && next !== blankSession) {
      window.parent.postMessage({ type: 'knowweave:new-conversation' }, '*')
    }
    blankSession = next
  }

  function updateChrome() {
    if (embedded) notifyNewConversation()
    updateTransport()
    updateTitle()
    for (const boot of document.querySelectorAll('[data-dsh-boot]')) {
      for (const child of boot.querySelectorAll('div')) {
        if (child.childElementCount === 0 && child.textContent === 'HARNESS') child.textContent = '知织'
        if (child.childElementCount === 0 && child.textContent === 'Loading plugins…') child.textContent = '正在准备对话…'
      }
    }
    for (const label of document.querySelectorAll(labelSelector)) rewriteText(label)
    for (const control of document.querySelectorAll(controlSelector)) {
      for (const attribute of ['title', 'aria-label']) {
        const value = control.getAttribute(attribute)
        if (value === null) continue
        const next = modelLabel(value)
        if (next !== value) control.setAttribute(attribute, next)
      }
    }
  }

  let pending = false
  const observer = new MutationObserver(() => {
    if (pending) return
    pending = true
    queueMicrotask(() => { pending = false; updateChrome() })
  })
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['title', 'aria-label', 'data-content-phase', 'data-conversation-session', 'data-phase'],
  })
  updateChrome()
})()
