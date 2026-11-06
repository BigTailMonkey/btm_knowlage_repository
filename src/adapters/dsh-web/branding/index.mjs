import { readFileSync } from 'node:fs'

export const name = 'knowweave-chat-branding'
export const inject = ['webServer']

const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="12" fill="#202b29"/><path d="M11 12v16m7-16v16m7-16-9 8 9 8m5-16v16" fill="none" stroke="#d5e9d3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const iconUrl = `data:image/svg+xml,${encodeURIComponent(icon)}`
const bootstrap = readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8').replace(/<\/script/gi, '<\\/script')

/** Apply presentation before the upstream shell boots; all transport routes stay intact. */
export function transformIndex(html) {
  if (html.includes('data-knowweave-branding')) return html
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '<title>知织</title>')
    .replace(/<meta\b[^>]*name=["']apple-mobile-web-app-title["'][^>]*>/gi, '<meta name="apple-mobile-web-app-title" content="知织" />')
    .replace(/<link\b[^>]*rel=["'](?:icon|apple-touch-icon|manifest)["'][^>]*>/gi, '')
    .replace(/<head\b[^>]*>/i, (head) => `${head}\n<link rel="icon" href="${iconUrl}" />\n<script data-knowweave-branding>${bootstrap}</script>`)
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.tapIndex(transformIndex), 'knowweave: chat presentation')
}
