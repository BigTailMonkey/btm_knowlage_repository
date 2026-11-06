import { settings } from '../../config.js'
import { ensureSidecar } from '../sidecar/index.js'

export interface ParsedDocument {
  title: string
  blocks: ParsedBlock[]
  parser: string
  quality: number
  meta: Record<string, unknown>
}

export interface ParsedBlock {
  type: string
  text: string
  headingPath: string[]
  page: number | null
  bbox: number[] | null
  order: number
}

const HEADING = /^(#{1,6})\s+(.*)$/
const CJK_SPACE = /(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/

function quality(text: string): number {
  if (!text.trim()) return 0
  let printable = 0
  for (const ch of text) {
    if (!/\s/.test(ch)) printable += 1
  }
  const coverage = printable / Math.max(1, text.length)
  const size = Math.min(1, text.length / 600)
  return Number((0.5 * coverage + 0.5 * size).toFixed(3))
}

function block(type: string, text: string, headingPath: string[], order: number, page: number | null = null): ParsedBlock {
  return { type, text, headingPath, page, bbox: null, order }
}

export function parseText(text: string, title: string): ParsedDocument {
  const blocks: ParsedBlock[] = []
  for (const paragraph of text.split(/\n\s*\n/)) {
    const body = paragraph.trim()
    if (!body) continue
    blocks.push(block('paragraph', body, [], blocks.length))
  }
  return { title, blocks, parser: 'plain-text', quality: quality(text), meta: { chars: text.length } }
}

export function parseMarkdown(text: string, title: string): ParsedDocument {
  const blocks: ParsedBlock[] = []
  const headingStack: Array<[number, string]> = []
  let buffer: string[] = []
  let inCode = false
  let codeLines: string[] = []

  const headingPath = (): string[] => headingStack.map(([, name]) => name)
  const flush = () => {
    const body = buffer.join('\n').trim()
    buffer = []
    if (!body) return
    const isTable = body.split('\n').every((line) => line.trim().startsWith('|'))
    blocks.push(block(isTable ? 'table' : 'paragraph', body, headingPath(), blocks.length))
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().startsWith('```')) {
      if (inCode) {
        const code = codeLines.join('\n').trim()
        if (code) blocks.push(block('code', code, headingPath(), blocks.length))
        codeLines = []
        inCode = false
      } else {
        flush()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(raw)
      continue
    }
    const match = HEADING.exec(line)
    if (match) {
      flush()
      const level = match[1]!.length
      const name = match[2]!.trim()
      while (headingStack.length && headingStack.at(-1)![0] >= level) headingStack.pop()
      headingStack.push([level, name])
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  if (inCode && codeLines.length) blocks.push(block('code', codeLines.join('\n'), headingPath(), blocks.length))

  const merged: ParsedBlock[] = []
  for (const item of blocks) {
    const previous = merged.at(-1)
    if (previous && item.text.startsWith('|') && previous.text.startsWith('|')) {
      previous.text += `\n${item.text}`
    } else {
      merged.push(item)
    }
  }
  return { title, blocks: merged, parser: 'markdown', quality: quality(text), meta: { chars: text.length } }
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function parseHtml(html: string, title: string, parserName = 'html'): ParsedDocument {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
  const blocks: ParsedBlock[] = []
  const headingStack: Array<[number, string]> = []
  const pattern = /<(h[1-6]|p|li|pre|table|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi
  for (const match of cleaned.matchAll(pattern)) {
    const tag = match[1]!.toLowerCase()
    const inner = match[2]!
    if (tag.startsWith('h')) {
      const text = stripTags(inner)
      if (!text) continue
      const level = Number(tag.slice(1))
      while (headingStack.length && headingStack.at(-1)![0] >= level) headingStack.pop()
      headingStack.push([level, text])
      continue
    }
    let type = 'paragraph'
    let text = stripTags(inner)
    if (tag === 'pre') type = 'code'
    if (tag === 'table') {
      type = 'table'
      text = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((row) =>
          [...(row[1] ?? '').matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/\1>/gi)]
            .map((cell) => stripTags(cell[1] ?? ''))
            .join(' | '),
        )
        .join('\n')
    }
    if (tag === 'li') type = 'list'
    if (!text) continue
    blocks.push(block(type, text, headingStack.map(([, name]) => name), blocks.length))
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const documentTitle = titleMatch ? stripTags(titleMatch[1]!) : title
  const bodyText = blocks.map((item) => item.text).join('\n')
  return { title: documentTitle || title, blocks, parser: parserName, quality: quality(bodyText), meta: {} }
}

export function normalizeCjkSpaces(text: string): string {
  return text.replace(CJK_SPACE, '')
}

async function sidecarParse(filename: string, data: Buffer, title: string | null): Promise<ParsedDocument> {
  if (!settings.sidecarEnabled) throw new Error('未启用解析边车，无法解析 PDF/DOCX')
  if (!(await ensureSidecar())) {
    throw Object.assign(new Error('解析边车不可用，PDF/DOCX 暂无法解析'), { statusCode: 503 })
  }
  const url = `${settings.sidecarUrl.replace(/\/$/, '')}/parse`
  const parseOnce = async (): Promise<ParsedDocument> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename, data: data.toString('base64'), title }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`解析边车返回 ${response.status}: ${(await response.text()).slice(0, 300)}`)
    return (await response.json()) as ParsedDocument
  }
  try {
    return await parseOnce()
  } catch (error) {
    // 边缘故障：边车可能刚退出，重试前再确保一次。
    if (!(await ensureSidecar())) throw error
    return parseOnce()
  }
}

export async function parseBytes(filename: string, data: Buffer, title?: string | null): Promise<ParsedDocument> {
  const suffix = filename.includes('.') ? `.${filename.split('.').pop()!.toLowerCase()}` : ''
  const baseTitle = title || (filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename) || '未命名文档'
  if (['.md', '.markdown'].includes(suffix)) return parseMarkdown(data.toString('utf8'), baseTitle)
  if (['.html', '.htm'].includes(suffix)) return parseHtml(data.toString('utf8'), baseTitle)
  if (['.txt', '.log', '.csv', '.json', '.yaml', '.yml'].includes(suffix)) return parseMarkdown(data.toString('utf8'), baseTitle)
  if (suffix === '.pdf' || suffix === '.docx') return sidecarParse(filename, data, title ?? null)
  if (suffix === '.doc') throw new Error('暂不支持 .doc，请转换为 .docx 或 PDF')
  return parseText(data.toString('utf8'), baseTitle)
}

export function parseTextContent(text: string, title?: string | null): ParsedDocument {
  if (HEADING.test(text ?? '')) return parseMarkdown(text, title || '粘贴的文本')
  return parseText(text, title || '粘贴的文本')
}
