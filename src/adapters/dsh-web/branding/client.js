window.__ModuleLoader__.load({
  id: '@knowweave/chat-branding',
  factory(require) {
    const { jsx, jsxs } = require('react/jsx-runtime')

    function Mark({ size = 28, className }) {
      return jsxs('svg', {
        width: size, height: size, viewBox: '0 0 40 40', className,
        'aria-hidden': true, 'data-knowweave-mark': true,
        children: [
          jsx('rect', { width: 40, height: 40, rx: 12, fill: 'currentColor', opacity: 0.09 }),
          jsx('path', {
            d: 'M11 12v16m7-16v16m7-16-9 8 9 8m5-16v16',
            fill: 'none', stroke: 'currentColor', strokeWidth: 2.5,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        ],
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
