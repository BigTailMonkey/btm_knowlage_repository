// The native SDK always adds a token budget. Apply the workspace setting at
// the HTTP boundary, where an omitted field leaves the budget to the model API.
const configuredEndpoint = process.env.KNOWWEAVE_MODEL_COMPLETIONS_URL
const configuredLimit = process.env.KNOWWEAVE_MODEL_MAX_TOKENS
if (configuredEndpoint) {
  const endpoint = new URL(configuredEndpoint).href
  const send = globalThis.fetch
  globalThis.fetch = (input, init) => {
    if (String(input) !== endpoint || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') {
      return send(input, init)
    }
    const body = JSON.parse(init.body)
    delete body.max_completion_tokens
    if (configuredLimit) body.max_tokens = Number(configuredLimit)
    else delete body.max_tokens
    const headers = new Headers(init.headers)
    headers.delete('content-length')
    return send(input, { ...init, headers, body: JSON.stringify(body) })
  }
}
