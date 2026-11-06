import { newId } from './ids.js'

export interface ParsedBlock {
  type: string
  text: string
  headingPath: string[]
  page: number | null
  bbox: number[] | null
  order: number
}

/** UTF-16 offsets into document_versions.text (the normalized, parsed text). */
export interface ChunkSourceSpan {
  blockOrder: number
  start: number
  end: number
  page: number | null
  bbox: number[] | null
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
  sourceSpans: ChunkSourceSpan[]
}

export const MAX_TOKENS = 512
const OVERLAP_TOKENS = 64
const ATOMIC_TYPES = new Set(['table', 'code', 'formula'])

export function estimateTokens(text: string): number {
  let chinese = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) chinese += 1
  }
  const others = Math.max(0, text.length - chinese)
  return Math.max(1, Math.floor(chinese / 1.7 + others / 4))
}

interface Segment {
  block: ParsedBlock
  base: number
  start: number
  end: number
}

function segmentText(segment: Segment): string {
  return segment.block.text.slice(segment.start, segment.end)
}

function body(segments: Segment[]): string {
  return segments.map(segmentText).join('\n\n')
}

function trimRange(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start]!)) start += 1
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1
  return [start, end]
}

function sourceSpans(segments: Segment[]): ChunkSourceSpan[] {
  return segments.map(({ block, base, start, end }) => ({
    blockOrder: block.order, start: base + start, end: base + end,
    page: block.page, bbox: block.bbox,
  }))
}

function boundingBox(segments: Segment[]): number[] | null {
  if (segments.some(({ block }) => !block.bbox || block.bbox.length !== 4)) return null
  const boxes = segments.map(({ block }) => block.bbox!)
  return [
    Math.min(...boxes.map((box) => box[0]!)), Math.min(...boxes.map((box) => box[1]!)),
    Math.max(...boxes.map((box) => box[2]!)), Math.max(...boxes.map((box) => box[3]!)),
  ]
}

/** Find a token-sized suffix without cutting a UTF-16 surrogate pair. */
function suffixStart(text: string, start: number, end: number, tokens: number): number {
  let cursor = end
  let units = 0
  while (cursor > start) {
    let previous = cursor - 1
    if (previous > start && /[\uDC00-\uDFFF]/.test(text[previous]!)) previous -= 1
    const character = text.slice(previous, cursor)
    const code = character.codePointAt(0) ?? 0
    const cost = (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)
      ? 1 / 1.7 : character.length / 4
    if (units + cost > tokens) break
    units += cost
    cursor = previous
  }
  return cursor
}

function splitParagraph(segment: Segment): Segment[] {
  const { block } = segment
  const pieces: Segment[] = []
  let start = segment.start
  while (start < segment.end) {
    let end = start
    let units = 0
    let sentenceEnd = start
    while (end < segment.end) {
      const character = String.fromCodePoint(block.text.codePointAt(end)!)
      const code = character.codePointAt(0)!
      const cost = (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)
        ? 1 / 1.7 : character.length / 4
      if (units + cost > MAX_TOKENS) break
      units += cost
      end += character.length
      if (units >= MAX_TOKENS / 2 && /[。！？!?；;\n]/.test(character)) sentenceEnd = end
    }
    if (end < segment.end && sentenceEnd > start) end = sentenceEnd
    const [trimmedStart, trimmedEnd] = trimRange(block.text, start, end)
    if (trimmedEnd > trimmedStart) pieces.push({ ...segment, start: trimmedStart, end: trimmedEnd })
    if (end >= segment.end) break
    const overlapStart = suffixStart(block.text, start, end, OVERLAP_TOKENS)
    start = overlapStart > start ? overlapStart : end
  }
  return pieces
}

export function chunkBlocks(blocks: ParsedBlock[]): ChunkDraft[] {
  // Offsets follow ingestion's join, even for empty blocks.
  let offset = 0
  const sections: Array<{ key: string[]; segments: Segment[] }> = []
  for (const block of blocks) {
    const base = offset
    offset += block.text.length + 2
    const trimmed = trimRange(block.text, 0, block.text.length)
    if (trimmed[1] <= trimmed[0]) continue
    const [start, end] = ATOMIC_TYPES.has(block.type) ? [0, block.text.length] : trimmed
    const key = block.headingPath.length ? [...block.headingPath] : ['正文']
    let section = sections.at(-1)
    if (!section || JSON.stringify(section.key) !== JSON.stringify(key)) {
      section = { key, segments: [] }
      sections.push(section)
    }
    section.segments.push({ block, base, start, end })
  }

  const chunks: ChunkDraft[] = []
  let seq = 0
  for (const section of sections) {
    const parentId = newId('ch')
    const emit = (segments: Segment[], blockType: string, isParent = false) => {
      if (!segments.length) return
      const text = body(segments)
      const pages = new Set(segments.map(({ block }) => block.page))
      chunks.push({
        id: isParent ? parentId : newId('ch'), seq: seq++, headingPath: section.key,
        page: pages.size === 1 ? segments[0]!.block.page : null,
        bbox: pages.size === 1 ? boundingBox(segments) : null,
        blockType, text, tokenCount: estimateTokens(text),
        parentId: isParent ? null : parentId, isParent,
        sourceSpans: sourceSpans(segments),
      })
    }
    emit(section.segments, 'section', true)
    let pending: Segment[] = []
    const flush = () => {
      emit(pending, pending.length === 1 ? pending[0]!.block.type : 'paragraph')
      pending = []
    }
    for (const segment of section.segments) {
      if (ATOMIC_TYPES.has(segment.block.type)) {
        flush()
        // Atomic structures can exceed the text budget. Their tails are never
        // duplicated into another block or detached from the structure.
        emit([segment], segment.block.type)
        continue
      }
      const pieces = splitParagraph(segment)
      if (pieces.length > 1) {
        flush()
        for (const piece of pieces) emit([piece], segment.block.type)
        continue
      }
      const piece = pieces[0]!
      if (pending.length && pending[0]!.block.page !== piece.block.page) flush()
      if (pending.length && estimateTokens(body([...pending, piece])) > MAX_TOKENS) {
        const previous = pending.at(-1)!
        const tail = { ...previous, start: suffixStart(previous.block.text, previous.start, previous.end, OVERLAP_TOKENS) }
        flush()
        if (estimateTokens(body([tail, piece])) <= MAX_TOKENS) pending.push(tail)
      }
      pending.push(piece)
    }
    flush()
  }
  return chunks
}
