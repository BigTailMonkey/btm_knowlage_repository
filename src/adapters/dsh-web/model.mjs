export const name = 'knowweave-configured-model'
export const inject = ['agentDefaultModel']

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const configured = ctx.agentDefaultModel.currentSelection()
    const current = agent.model.current()
    // A resumed session may carry an old provider or model in its history.
    if (current?.provider !== configured.provider || current?.model !== configured.model) {
      agent.model.select(configured)
    }
  })
}
