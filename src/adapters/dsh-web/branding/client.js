window.__ModuleLoader__.load({
  id: '@knowweave/chat-branding',
  factory(require) {
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useState, useEffect, useRef } = require('react')
    const {
      Tooltip,
      IconLikeOutlineRegular, IconLikeFillRegular,
      IconDislikeOutlineRegular, IconDislikeFillRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

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

    /**
     * 接管上游“好的回答 / 有问题的回答”：上游 ui-message-feedback 已禁用，
     * 这里在 assistant-actions 插槽提供同样的按钮，但评价只 postMessage 给
     * 知织外壳记录到本系统，不发送 DeepSeek。外壳处理后回 ack 更新按钮状态。
     */
    function FeedbackActions({ messageId, sessionId }) {
      const [rating, setRating] = useState(null)
      const [pending, setPending] = useState(false)
      const root = useRef(null)
      const timer = useRef(null)
      const embedded = window.self !== window.top

      useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.type !== 'knowweave:chat-feedback-ack' || data.messageId !== messageId) return
          if (timer.current) { clearTimeout(timer.current); timer.current = null }
          setPending(false)
          if (data.ok) setRating(data.value === 1 ? 'positive' : 'negative')
        }
        window.addEventListener('message', onMessage)
        return () => {
          window.removeEventListener('message', onMessage)
          if (timer.current) clearTimeout(timer.current)
        }
      }, [messageId])

      if (!embedded || !messageId) return null

      const send = (value) => {
        if (pending) return
        const target = value === 1 ? 'positive' : 'negative'
        if (rating === target) return
        setPending(true)
        // 对话轮摘录供运维台回看；只取文本，截断后交给外壳。
        const turn = root.current?.closest?.('[data-chat-turn]')
        const context = turn ? String(turn.innerText || '').slice(0, 1500) : ''
        const session = sessionId
          ?? document.querySelector('[data-conversation-content]')?.dataset?.conversationSession
          ?? ''
        window.parent.postMessage({
          type: 'knowweave:chat-feedback',
          sessionId: String(session), messageId: String(messageId), value, context,
        }, '*')
        // 外壳无响应（如直接打开原生地址）时不要卡住按钮。
        timer.current = setTimeout(() => { timer.current = null; setPending(false) }, 10000)
      }

      const action = (value, label, Icon, IconActive) => jsx(Tooltip, {
        label: rating === (value === 1 ? 'positive' : 'negative') ? '已记录' : label,
        side: 'bottom',
        children: jsx('button', {
          type: 'button',
          className: '_8_XoUG_action',
          'aria-label': label,
          'aria-pressed': rating === (value === 1 ? 'positive' : 'negative'),
          'data-active': rating === (value === 1 ? 'positive' : 'negative') || undefined,
          'data-knowweave-feedback': value === 1 ? 'positive' : 'negative',
          disabled: pending,
          onClick: () => send(value),
          children: jsx(rating === (value === 1 ? 'positive' : 'negative') ? IconActive : Icon, {}),
        }),
      })

      return jsxs('span', {
        ref: root,
        hidden: true,
        children: [
          action(1, '好的回答', IconLikeOutlineRegular, IconLikeFillRegular),
          action(-1, '有问题的回答', IconDislikeOutlineRegular, IconDislikeFillRegular),
        ],
      })
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
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'knowweave-feedback', order: 10 },
          FeedbackActions,
        ))
      },
    }
  },
})
