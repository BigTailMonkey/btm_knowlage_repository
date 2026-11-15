import { readFileSync } from 'node:fs'

export const name = 'knowweave-chat-branding'
export const inject = ['webServer']

const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 9c4.5 0 4.5-5 9-5s4.5 5 9 5M3 15c4.5 0 4.5 5 9 5s4.5-5 9-5" fill="none" stroke="#1b6c80" stroke-width="2" stroke-linecap="round"/></svg>'
const iconUrl = `data:image/svg+xml,${encodeURIComponent(icon)}`
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const bootstrap = [
  read('./bootstrap.js'),
  read('../../../../knowweave/web/pickers.js'),
  read('./picker-bridge.js'),
].join('\n;\n').replace(/<\/script/gi, '<\\/script')
const style = `${read('../../../../knowweave/web/pickers.css')}
html {
  --kw-picker-text: var(--dsw-alias-label-primary);
  --kw-picker-muted: var(--dsw-alias-label-secondary);
  --kw-picker-surface: var(--dsw-alias-bg-layer-1);
  --kw-picker-hover: var(--dsw-alias-interactive-bg-hover);
  --kw-picker-border: var(--dsw-alias-border-l2);
  --kw-picker-accent: var(--dsw-alias-brand-primary);
  --kw-picker-error: var(--dsw-alias-label-error);
}
[data-kw-picker-source], .kw-embedded-picker[hidden] { display: none !important; }
.kw-embedded-picker { width: 100%; }
input:is([type="checkbox"], [type="radio"]) {
  appearance: none;
  display: inline-grid;
  place-content: center;
  flex: none;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border: 1px solid var(--kw-picker-border, #879398);
  background: var(--kw-picker-surface, #fff);
  vertical-align: middle;
}
input[type="checkbox"] { border-radius: 4px; }
input[type="radio"] { border-radius: 50%; }
input:is([type="checkbox"], [type="radio"]):checked { border-color: var(--kw-picker-accent, #1b6c80); }
input[type="checkbox"]:is(:checked, :indeterminate) { background: var(--kw-picker-accent, #1b6c80); }
input[type="checkbox"]:checked::after {
  content: '';
  width: 7px;
  height: 4px;
  border: solid white;
  border-width: 0 0 2px 2px;
  transform: translateY(-1px) rotate(-45deg);
}
input[type="checkbox"]:indeterminate::after { content: ''; width: 8px; height: 2px; background: white; }
input[type="radio"]:checked::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--kw-picker-accent, #1b6c80); }
input:is([type="checkbox"], [type="radio"]):disabled { opacity: .5; }
[class~="pXSMma_previewBadge"] { display: none !important; }
/* KnoWeave's outer navigation supplies the wordmark when embedded. */
html[data-knowweave-embedded] [class~="hHd-Xa_brand"] { display: none; }
/* Hide local directory opening in the conversation header, including direct access to DSH. */
header[data-window-drag] [data-open-target="directory"] {
  display: none !important;
}
html[data-knowweave-embedded] [class~="hHd-Xa_logoRow"] {
  height: 36px;
  margin-bottom: 4px;
  padding-block: 0;
}
/* Fit New Session into the expanded header beside the 28px toggle. */
html[data-knowweave-embedded] [class~="hHd-Xa_root"]:not([class~="hHd-Xa_collapsed"]) {
  position: relative;
}
html[data-knowweave-embedded] [class~="hHd-Xa_root"]:not([class~="hHd-Xa_collapsed"]) > [class~="hHd-Xa_newSession"] {
  position: absolute;
  inset-block-start: 8px;
  inset-inline: 12px 44px;
  height: 32px;
  margin: 0;
  padding-block: 4px;
}
/* 连接中断时 bootstrap 标记 data-knowweave-offline：盖住输入区并说明原因，
   避免断线状态下提交只得到一条失败提示；标记消失后自动恢复输入。 */
html[data-knowweave-offline] [data-composer-card] {
  position: relative;
}
html[data-knowweave-offline] [data-composer-card]::after {
  content: '与对话服务的连接已断开，正在重新连接…';
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 16px;
  border-radius: var(--dsw-radius-panel, 12px);
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 78%, transparent);
  color: var(--dsw-alias-label-secondary, #666666);
  font-size: 13px;
  line-height: 18px;
  text-align: center;
  pointer-events: auto;
}
`

/** Apply presentation before the upstream shell boots; all transport routes stay intact. */
export function transformIndex(html) {
  if (html.includes('data-knowweave-branding')) return html
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '<title>知织</title>')
    .replace(/<meta\b[^>]*name=["']apple-mobile-web-app-title["'][^>]*>/gi, '<meta name="apple-mobile-web-app-title" content="知织" />')
    .replace(/<link\b[^>]*rel=["'](?:icon|apple-touch-icon|manifest)["'][^>]*>/gi, '')
    .replace(/<\/head>/i, (head) => `<link rel="icon" href="${iconUrl}" />\n<style data-knowweave-branding-style>${style}</style>\n<script data-knowweave-branding>${bootstrap}</script>\n${head}`)
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.tapIndex(transformIndex), 'knowweave: chat presentation')
}
