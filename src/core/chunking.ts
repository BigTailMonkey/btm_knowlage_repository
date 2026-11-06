import { newId } from './ids.js'

export interface ParsedBlock {
  type: string
  text: string
  headingPath: string[]
  page: number | null
  bbox: number[] | null
  order: number
}

export interface ChunkDraft {
  id: string
  seq: number
  headingPath: string[]
  page: number | null
  bbox: number[] | null
  blockType: string
  text: string
  tokenCount: number
  parentId: string | null
  isParent: boolean
}

export const MAX_CHARS = 460
const OVERLAP = 60

export function estimateTokens(text: string): number {
  let chinese = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) chinese += 1
  }
  const others = Math.max(0, text.length - chinese)
  return Math.max(1, Math.floor(chinese / 1.7 + others / 4))
}

function child(
  parentId: string,
  seq: number,
  key: string[],
  first: ParsedBlock,
  text: string,
  blockType: string,
): ChunkDraft {
  return {
    id: newId('ch'),
    seq,
    headingPath: key,
    page: first.page,
    bbox: first.bbox,
    blockType,
    text,
    tokenCount: estimateTokens(text),
    parentId,
    isParent: false,
  }
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text]
  const sentences: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if ('。！？!?；;\n'.includes(ch ?? '') && index + 1 - start >= 80) {
      sentences.push(text.slice(start, index + 1).trim())
      start = index + 1
    }
  }
  if (start < text.length) sentences.push(text.slice(start).trim())

  const pieces: string[] = []
  let buffer = ''
  for (const sentence of sentences) {
    if (buffer.length + sentence.length <= MAX_CHARS) {
      buffer += sentence
      continue
    }
    if (buffer) pieces.push(buffer.trim())
    if (sentence.length > MAX_CHARS) {
      for (let i = 0; i < sentence.length; i += MAX_CHARS) {
        pieces.push(sentence.slice(i, i + MAX_CHARS).trim())
      }
      buffer = ''
    } else {
      buffer = sentence
    }
  }
  if (buffer) pieces.push(buffer.trim())
  return pieces.filter(Boolean)
}

export function chunkBlocks(blocks: ParsedBlock[]): ChunkDraft[] {
  const sections = new Map<string, { key: string[]; blocks: ParsedBlock[] }>()
  const order: string[] = []
  for (const block of blocks) {
    const key = block.headingPath.length ? block.headingPath : ['正文']
    const id = key.join('\u0000')
    if (!sections.has(id)) {
      sections.set(id, { key, blocks: [] })
      order.push(id)
    }
    sections.get(id)!.blocks.push(block)
  }

  const chunks: ChunkDraft[] = []
  let seq = 0
  for (const sectionId of order) {
    const section = sections.get(sectionId)!
    const body = section.blocks.map((block) => block.text).join('\n\n').trim()
    if (!body) continue
    const first = section.blocks[0]!
    const parentId = newId('ch')
    chunks.push({
      id: parentId,
      seq,
      headingPath: section.key,
      page: first.page,
      bbox: first.bbox,
      blockType: 'section',
      text: body,
      tokenCount: estimateTokens(body),
      parentId: null,
      isParent: true,
    })
    seq += 1

    let pending = ''
    let overlapTail = ''
    for (const block of section.blocks) {
      const text = block.text.trim()
      if (!text) continue
      const atomic = block.type === 'table' || block.type === 'code'
      const pieces = atomic
        ? text.length <= MAX_CHARS * 1.6
          ? [text]
          : splitLong(text)
        : splitLong(text)
      for (const piece of pieces) {
        const candidate = pending ? `${pending}\n\n${piece}`.trim() : piece
        if (candidate.length <= MAX_CHARS || !pending) {
          pending = candidate
          continue
        }
        chunks.push(child(parentId, seq, section.key, first, pending, block.type))
        seq += 1
        overlapTail = pending.slice(-OVERLAP)
        pending = overlapTail ? `${overlapTail}\n\n${piece}`.trim() : piece
      }
    }
    if (pending.trim()) {
      chunks.push(child(parentId, seq, section.key, first, pending.trim(), section.blocks.at(-1)!.type))
      seq += 1
    }
  }
  return chunks
}
