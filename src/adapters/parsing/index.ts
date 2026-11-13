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

export class ParseQualityError extends Error {
  readonly statusCode = 422
}

export function cleanParsedText(text: string): string {
  return text.replaceAll('\u0000', '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
}

function cleanParserOutput(value: unknown): unknown {
  if (typeof value === 'string') return cleanParsedText(value)
  if (Array.isArray(value)) return value.map(cleanParserOutput)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanParsedText(key), cleanParserOutput(item)]))
  }
  return value
}

const HEADING = /^(#{1,6})\s+(.*)$/
const CJK_SPACE = /(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g

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
  const lines = text.split('\n')
  let buffer: string[] = []
  const headingPath = (): string[] => headingStack.map(([, name]) => name)
  const flush = () => {
    const body = buffer.join('\n').trim()
    buffer = []
    if (body) blocks.push(block('paragraph', body, headingPath(), blocks.length))
  }
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    const line = raw.replace(/\s+$/, '')
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]![0]!
      const width = fence[1]!.length
      const code: string[] = []
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index]!
        const closing = next.trim()
        if (closing.length >= width && [...closing].every((character) => character === marker)) break
        code.push(next)
      }
      const body = code.join('\n').replace(/^\n+|\n+$/g, '')
      if (body.trim()) blocks.push(block('code', body, headingPath(), blocks.length))
      continue
    }
    if (line.trim().startsWith('$$')) {
      flush()
      const opening = line.trim().slice(2)
      const formula: string[] = []
      if (opening.endsWith('$$')) {
        formula.push(opening.slice(0, -2))
      } else {
        if (opening) formula.push(opening)
        for (index += 1; index < lines.length; index += 1) {
          const next = lines[index]!
          if (next.trimEnd().endsWith('$$')) {
            formula.push(next.trimEnd().slice(0, -2))
            break
          }
          formula.push(next)
        }
      }
      const body = formula.join('\n').trim()
      if (body) blocks.push(block('formula', body, headingPath(), blocks.length))
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
    if (line.trim().startsWith('|') || (line.includes('|') && separator.test(lines[index + 1] ?? ''))) {
      flush()
      const rows = [line]
      while (index + 1 < lines.length && lines[index + 1]!.trim() && lines[index + 1]!.includes('|')) {
        rows.push(lines[++index]!)
      }
      blocks.push(block('table', rows.join('\n').trim(), headingPath(), blocks.length))
      continue
    }
    if (!line.trim()) flush()
    else buffer.push(line)
  }
  flush()
  return { title, blocks, parser: 'markdown', quality: quality(text), meta: { chars: text.length } }
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
    if (tag === 'pre') {
      type = 'code'
      text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '')
    }
    if (tag === 'table') {
      type = 'table'
      text = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((row) =>
          [...(row[1] ?? '').matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)]
            .map((cell) => stripTags(cell[2] ?? ''))
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
  return { title: cleanParsedText(documentTitle || title), blocks, parser: parserName, quality: quality(bodyText), meta: {} }
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
      body: JSON.stringify({ filename, data: data.toString('base64'), title, engine: settings.parseEngine }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      if (response.status === 422) {
        const report = await response.clone().json().catch(() => null) as { detail?: { attempts?: Array<{ status: string }> } } | null
        if (Array.isArray(report?.detail?.attempts) && report.detail.attempts.some((attempt) => attempt?.status === 'low_quality')) {
          throw new ParseQualityError('解析质量不足，需人工修正')
        }
      }
      const message = `解析边车返回 ${response.status}: ${(await response.text()).slice(0, 300)}`
      throw new Error(message)
    }
    const document = cleanParserOutput(await response.json()) as ParsedDocument
    if (document.meta.format === 'markdown') {
      const parsed = parseMarkdown(document.blocks.map((item) => item.text).join('\n\n'), document.title)
      return { ...parsed, parser: document.parser, meta: document.meta }
    }
    return document
  }
  try {
    return await parseOnce()
  } catch (error) {
    if (error instanceof ParseQualityError) throw error
    // 边缘故障：边车可能刚退出，重试前再确保一次。
    if (!(await ensureSidecar())) throw error
    return parseOnce()
  }
}

export async function parseBytes(filename: string, data: Buffer, title?: string | null): Promise<ParsedDocument> {
  const suffix = filename.includes('.') ? `.${filename.split('.').pop()!.toLowerCase()}` : ''
  const baseTitle = cleanParsedText(title || (filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename)) || '未命名文档'
  if (['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.bmp', '.wav', '.mp3', '.m4a', '.mp4', '.webm', '.ogg', '.flac'].includes(suffix)) return sidecarParse(filename, data, title ?? null)
  if (suffix === '.doc') throw new Error('暂不支持 .doc，请转换为 .docx 或 PDF')
  const text = cleanParsedText(data.toString('utf8'))
  if (['.html', '.htm'].includes(suffix)) return parseHtml(text, baseTitle)
  if (['.md', '.markdown', '.txt', '.log', '.csv', '.json', '.yaml', '.yml'].includes(suffix)) return parseMarkdown(text, baseTitle)
  return parseText(text, baseTitle)
}

export function parseTextContent(text: string, title?: string | null): ParsedDocument {
  text = cleanParsedText(text)
  title = title ? cleanParsedText(title) : title
  if (/^(?:#{1,6}\s|\s*(?:`{3,}|~{3,}|\$\$|\|))|^.*\|.*\n\s*\|?\s*:?-{3,}/m.test(text ?? '')) return parseMarkdown(text, title || '粘贴的文本')
  return parseText(text, title || '粘贴的文本')
}
