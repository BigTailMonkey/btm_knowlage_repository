window.__ModuleLoader__.load({
  id: '@knowweave/chat-branding',
  factory(require) {
    const { jsx } = require('react/jsx-runtime')

    function Mark({ size = 28, className }) {
      return jsx('svg', {
        width: size, height: size, viewBox: '0 0 24 24', className,
        'aria-hidden': true, 'data-knowweave-mark': true,
        children: jsx('path', {
          d: 'M3 9c4.5 0 4.5-5 9-5s4.5 5 9 5M3 15c4.5 0 4.5 5 9 5s4.5-5 9-5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        }),
      })
    }

    function Wordmark() {
      return jsx('span', { style: { fontSize: 18, fontWeight: 600, letterSpacing: '0.08em' }, children: '知织' })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [slot, component] of [
          ['sidebar.brand.mark', Mark],
          ['sidebar.brand.name', Wordmark],
          ['conversation.hero.brand.mark', Mark],
        ]) {
          ctx.slots.inject(slot, () => ctx.slots.register({ name: slot }, component))
        }
      },
    }
  },
})
