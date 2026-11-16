import { readFileSync } from 'node:fs'

export const name = 'knowweave-chat-branding'
export const inject = ['webServer']

const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#b0d5df"/><path d="M5 10c3.5 0 3.5-4 7-4s3.5 4 7 4M5 14c3.5 0 3.5 4 7 4s3.5-4 7-4" fill="none" stroke="#173945" stroke-width="1.6" stroke-linecap="round"/></svg>'
const iconUrl = `data:image/svg+xml,${encodeURIComponent(icon)}`
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const bootstrap = [
  read('./bootstrap.js'),
  read('../../../../knowweave/web/pickers.js'),
  read('./picker-bridge.js'),
].join('\n;\n').replace(/<\/script/gi, '<\\/script')
const style = `${read('../../../../knowweave/web/theme.css')}
${read('../../../../knowweave/web/pickers.css')}
/* The native theme installs its defaults on body in both appearance modes. */
html > body,
html > body[data-ds-dark-theme] {
  --dsw-alias-bg-base: var(--kw-ground);
  --dsw-alias-bg-layer-1: var(--kw-surface);
  --dsw-alias-bg-layer-2: var(--kw-surface);
  --dsw-alias-bg-layer-3: var(--kw-surface);
  --dsw-alias-bg-layer-4: var(--kw-raised);
  --dsw-alias-bg-module-platform: var(--kw-raised);
  --dsw-alias-bg-multi-select: var(--kw-raised);
  --dsw-alias-border-l1: var(--kw-border);
  --dsw-alias-border-l2: var(--kw-border);
  --dsw-alias-border-l2-darkmode-thin: var(--kw-border);
  --dsw-alias-border-l3: var(--kw-control);
  --dsw-alias-border-l4: var(--kw-control);
  --dsw-alias-brand-primary: var(--kw-primary);
  --dsw-alias-brand-primary-new-colorprimary-new-color: var(--kw-accent);
  --dsw-alias-brand-text: var(--kw-text);
  --dsw-alias-button-primary-fill: var(--kw-primary);
  --dsw-alias-button-primary-hover: var(--kw-primary-hover);
  --dsw-alias-interactive-bg-hover: var(--kw-raised);
  --dsw-alias-interactive-bg-hover-solid: var(--kw-raised);
  --dsw-alias-interactive-bg-hover-accent: var(--kw-active);
  --dsw-alias-interactive-bg-active: var(--kw-active);
  --dsw-alias-label-primary: var(--kw-text);
  --dsw-alias-label-primary-foreground: var(--kw-primary-ink);
  --dsw-alias-label-secondary: var(--kw-muted);
  --dsw-alias-label-tertiary: var(--kw-muted);
  --dsw-alias-label-caption: var(--kw-muted);
  --dsw-alias-link: var(--kw-accent);
  --dsw-alias-state-business-primary: var(--kw-accent);
  --dsw-alias-state-success-primary: var(--kw-success-text);
  --dsw-alias-state-success-tertiary: color-mix(in srgb, var(--kw-success) 20%, var(--kw-surface));
  --dsw-alias-state-warn-label: var(--kw-warning-text);
  --dsw-alias-state-warn-primary: var(--kw-warning-text);
  --dsw-alias-state-warn-tertiary: color-mix(in srgb, var(--kw-warning) 20%, var(--kw-surface));
  --dsw-alias-markdown-code-block: var(--kw-raised);
  --dsw-alias-markdown-code-block-banner: var(--kw-active);
  --dsw-alias-markdown-inline-code: var(--kw-raised);
  background-color: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
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
  border: 1px solid var(--kw-control);
  background: var(--kw-surface);
  vertical-align: middle;
}
input[type="checkbox"] { border-radius: 4px; }
input[type="radio"] { border-radius: 50%; }
input:is([type="checkbox"], [type="radio"]):checked { border-color: var(--kw-accent); }
input[type="checkbox"]:is(:checked, :indeterminate) { background: var(--kw-primary); }
input[type="checkbox"]:checked::after {
  content: '';
  width: 7px;
  height: 4px;
  border: solid var(--kw-primary-ink);
  border-width: 0 0 2px 2px;
  transform: translateY(-1px) rotate(-45deg);
}
input[type="checkbox"]:indeterminate::after { content: ''; width: 8px; height: 2px; background: var(--kw-primary-ink); }
input[type="radio"]:checked::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--kw-accent); }
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
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 78%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 18px;
  text-align: center;
  pointer-events: auto;
}
`

/** Apply the KnoWeave theme and embedded chat integration before the shell boots. */
export function transformIndex(html) {
  if (html.includes('data-knowweave-branding')) return html
  return html
    .replace(/<html(?=[\s>])/i, '<html data-knowweave-sidebar-disabled')
    .replace(/<title>[\s\S]*?<\/title>/i, '<title>知织</title>')
    .replace(/<meta\b[^>]*name=["']apple-mobile-web-app-title["'][^>]*>/gi, '<meta name="apple-mobile-web-app-title" content="知织" />')
    .replace(/<link\b[^>]*rel=["'](?:icon|apple-touch-icon|manifest)["'][^>]*>/gi, '')
    .replace(/<\/head>/i, (head) => `<link rel="icon" href="${iconUrl}" />\n<style data-knowweave-branding-style>${style}</style>\n<script data-knowweave-branding>${bootstrap}</script>\n${head}`)
}

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.webServer.tapIndex(transformIndex), 'knowweave: chat presentation')
  // Present only when started with the matching KnoWeave launch overlay.
  if (config.policyPath) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: config.policyPath,
      handler(_request, response) {
        response.writeHead(204, { 'cache-control': 'no-store' }).end()
      },
    }), 'knowweave: chat policy probe')
  }
}
