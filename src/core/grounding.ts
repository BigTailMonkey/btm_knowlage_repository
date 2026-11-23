import { parseStructuredJson } from '../util/structured-json.js'
import { tokenize } from '../adapters/embeddings/index.js'
import { completeStructured, modelUnavailable, requireModelText } from '../adapters/harness/index.js'

const CITATION = /\[(\d+)\]/g
const CODE_START = /^(?:export\s|(?:async\s+)?function\s|class\s|(?:const|let|var|import|interface|type|return|void)\s|(?:if|for|while|switch|catch)\s*\()/
function excerptIntro(value: string): boolean {
  const label = value.replace(CITATION, '').replace(/`[^`]+`|《[^》]+》/g, '').replace(/\s/g, '').replace(/^中[，,]/, '中')
  return /^(?:(?:片段中|中)?(?:可以确认|可确认)?(?:包含(?:该符号)?|关于)?的?(?:原文|原文片段|代码片段|代码|摘录|定义|完整定义|原文摘录)(?:如下所示|如下|为)?(?:[，,]引自)?)[：:]$/.test(label)
}

function fencedExcerpt(value: string): { text: string; references: string } | null {
  const opening = /^(`{3,}|~{3,})[^\n]*\n/.exec(value)
  if (!opening) return null
  const closing = new RegExp(`\\n[ \\t]{0,3}${opening[1]![0]}{${opening[1]!.length},}([\\s\\S]*)$`).exec(value)
  if (!closing) return { text: value.slice(opening[0].length).trim(), references: '' }
  return { text: value.slice(opening[0].length, closing.index).trim(), references: closing[1]! }
}

function rawExcerpt(value: string): { text: string; references: string } | null {
  if (!CODE_START.test(value)) return null
  const suffix = /((?:\[\d+\]\s*)+)$/.exec(value)
  return { text: (suffix ? value.slice(0, suffix.index) : value).trim(), references: suffix?.[1] ?? '' }
}

export interface EvidenceText { text: string; context?: string }
export interface GroundingIssue {
  claim: string
  evidence_indices: number[]
  reasons: string[]
}

export interface GroundingCheck {
  valid: boolean
  coverage: number
  sentences: number
  supported: number
  quotes: Record<number, string>
  reason: string | null
  issues: GroundingIssue[]
  /** Only exact code excerpts and trusted source labels need no wording inference. */
  semanticRequired?: boolean
}

/** Citation scope is a prose sentence, table row, or fenced excerpt. */
export function claimSentences(answer: string): string[] {
  const units: string[] = []
  const lines = answer.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.trim()
    const intro = text.replace(CITATION, '').trim()
    if (!text || /^#{1,6}\s/.test(text) || /^\|?\s*:?-{3,}/.test(text)) continue
    if (/^\|/.test(text) && /^\|?\s*:?-{3,}/.test(lines[index + 1]?.trim() ?? '')) continue
    // Only structural introductions are exempt; factual prefixes still need citations.
    if (/^(?:(?:根据现有资料|资料明确支持|原文摘录|结论|关键依据)|(?:(?:包含该符号的)?原文|相关原文|证据|依据|摘录)(?:如下)?)[：:]$/.test(text)) continue
    if (/^(?:\[\d+\]\s*)+$/.test(text) && units.length) {
      units[units.length - 1] += ` ${text}`
      continue
    }
    if (excerptIntro(intro)) {
      if (text.match(CITATION)?.length && /^(?:`{3,}|~{3,})/.test(lines.slice(index+1).find((line) => line.trim())?.trim() ?? '')) units.push(text.match(CITATION)!.join(''))
      continue
    }
    const fence = /^(`{3,}|~{3,})[^`~]*$/.exec(text)
    if (fence) {
      const block = [text]
      while (++index < lines.length) {
        block.push(lines[index]!)
        if (new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*(?:\\[\\d+\\]\\s*)*$`).test(lines[index]!)) break
      }
      const prefix = /^(?:\[\d+\]\s*)+$/.test(units.at(-1) ?? '') ? units.pop()! : ''
      units.push(`${block.join('\n')} ${prefix}`.trim())
      continue
    }
    if (CODE_START.test(text) && !text.match(CITATION)) {
      const end = lines.findIndex((line, lineIndex) => lineIndex > index && /^(?:\[\d+\]\s*)+$/.test(line.trim()))
      if (end > index) {
        units.push(lines.slice(index, end + 1).join('\n').trim())
        index = end
        continue
      }
    }
    if (text.startsWith('|')) { units.push(text); continue }
    // Closing emphasis markers belong to the sentence before a trailing citation.
    units.push(...text.replace(/([。！？!?])([*_~]*)\s*((?:\[\d+\]\s*)+)([*_~]*)/g, '$2$4$3$1')
      .split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z])/)
      .map((part) => part.trim()).filter(part => part.replace(/[*_~]/g, '').trim()))
  }
  return units
}

function numericText(value: string): string {
  return value.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '').replace(/[ \t]/g, '')
    .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
}

function numericClaims(value: string): string[] {
  return numericText(value).match(/\d{4}-\d{2}-\d{2}|[+-]?\d+(?:\.\d+)*(?:%|[A-Za-z]+|毫秒|秒|万元|亿元|元|年|月|天)?/g) ?? []
}

function plain(value: string): string {
  return value.replace(CITATION, '').replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+)/, '').replace(/[|*`]/g, ' ').trim()
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function overlap(claim: string, source: string): number {
  const tokens = new Set(tokenize(claim))
  if (!tokens.size) return normalized(source).includes(normalized(claim)) ? 1 : 0
  const available = new Set(tokenize(source))
  return [...tokens].filter((token) => available.has(token)).length / tokens.size
}

/** Check citation integrity and numbers before the configured semantic verifier judges the wording. */
export function validateGrounding(
  answer: string,
  evidence: EvidenceText[],
  { checkWording = true, asOf = null }: { checkWording?: boolean; asOf?: string | null } = {},
): GroundingCheck {
  const sentences = claimSentences(answer)
  const quotes: Record<number, string> = {}
  const issues: GroundingIssue[] = []
  let supported = 0
  let semanticRequired = false
  let reason: string | null = null
  const referenced = [...new Set([...answer.matchAll(CITATION)].map((match) => Number(match[1])))].filter((id) => id >= 1 && id <= evidence.length)
  const metadataLabel = (value: string) => value.normalize('NFKC').replace(/\s/g, '').trim()
  for (const sentence of sentences) {
    const excerpt = fencedExcerpt(sentence) ?? rawExcerpt(sentence)
    const code = excerpt !== null
    const references = code ? excerpt?.references ?? '' : sentence
    const ids = [...references.matchAll(CITATION)].map((match) => Number(match[1]))
    const distinctIds = [...new Set(ids)]
    const claim = code ? excerpt?.text ?? '' : plain(sentence)
    const invalid = distinctIds.filter((id) => id < 1 || id > evidence.length)
    // An exact source label above an already cited excerpt is presentation metadata.
    if (!ids.length && /^(?:文档|章节|页码|检索时间切片)[：:]/.test(sentence)
      && referenced.some((id) => evidence[id - 1]!.context?.split(/[；\n]/).some((label) => metadataLabel(label) === metadataLabel(sentence)))) {
      supported += 1
      continue
    }
    if (!code) semanticRequired = true
    if (!ids.length || invalid.length) {
      reason ??= '回答存在缺失或无效引用的句子'
      issues.push({
        claim,
        evidence_indices: distinctIds.filter((id) => id >= 1 && id <= evidence.length),
        reasons: [invalid.length ? `引用编号 ${invalid.join('、')} 不在本轮检索片段中` : '这条表述没有引用原文'],
      })
      continue
    }
    const sources = ids.map((id) => [evidence[id - 1]!.text, evidence[id - 1]!.context].filter(Boolean).join('\n'))
    const combined = sources.join('\n')
    // as_of is trusted retrieval metadata, only in explicit time-slice wording.
    // Actual event dates must still occur in the cited evidence in full.
    const numberClaim = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
      ? numericText(claim).replaceAll(`${asOf}这一时间切片`, '这一时间切片').replaceAll(`${asOf}时间切片`, '时间切片') : claim
    const numericSources = ids.map((id) => [evidence[id - 1]!.text, ...(evidence[id - 1]!.context?.split(/[；\n]/).filter((label) => !/^检索时间切片[：:]/.test(label.trim())) ?? [])].join('\n')).join('\n')
    const availableNumbers = new Set(numericClaims(numericSources))
    const missingNumbers = [...new Set(numericClaims(numberClaim).filter((number) => !availableNumbers.has(number)))]
    const exactSupport = code ? ids.some((id) => evidence[id - 1]!.text.includes(claim)) : normalized(combined).includes(normalized(claim))
    let lexicalSupport = true
    let polaritySupport = true
    if (checkWording && !exactSupport) {
      lexicalSupport = overlap(claim, combined) >= 0.6
      const bestSource = sources.flatMap((source) => source.split(/(?<=[。！？!?；;])\s*|\n+/)).sort((a, b) => overlap(claim, b) - overlap(claim, a))[0] ?? combined
      const negative = /\b(?:not|never|cannot|unsupported)\b|不(?:支持|允许|可|能|会|是|应|得|超过|低于|需要)|未(?:支持|启用|实现|提供)|无法|禁止|没有|无需/i
      polaritySupport = negative.test(claim) === negative.test(bestSource)
    }
    if (!claim || missingNumbers.length || !(exactSupport || !code && lexicalSupport && polaritySupport)) {
      reason ??= '回答中的数字或文字无法与所引证据核对'
      const reasons = []
      if (code && !exactSupport) reasons.push('代码摘录与所引原文不一致')
      if (!claim) reasons.push('引用之外没有可核对的表述')
      if (missingNumbers.length) reasons.push(`所引原文中未找到数字或单位 ${missingNumbers.map((number) => `「${number}」`).join('、')}`)
      if (!lexicalSupport) reasons.push('所引原文与该表述的文字重合度未达到核验要求')
      if (!polaritySupport) reasons.push('该表述和最接近的原文在肯定或否定用语上不一致')
      issues.push({ claim, evidence_indices: distinctIds, reasons })
      continue
    }
    supported += 1
    for (const id of new Set(ids)) {
      const source = evidence[id - 1]!.text
      const excerpts = source.split(/(?<=[。！？!?；;])\s*|\n+/).filter(Boolean)
      const best = excerpts.sort((a, b) => overlap(claim, b) - overlap(claim, a))[0] ?? source
      quotes[id] ??= best
    }
  }
  const coverage = sentences.length ? supported / sentences.length : 0
  return { valid: sentences.length > 0 && supported === sentences.length, coverage, sentences: sentences.length, supported, quotes, reason: reason ?? (sentences.length ? null : '没有可核对的事实句'), issues, semanticRequired }
}

/** A separate entailment decision supplements deterministic citation/number checks. */
export async function verifySemanticGrounding(answer: string, evidence: EvidenceText[]): Promise<boolean> {
  return (await checkSemanticGrounding(answer, evidence)).supported
}

export async function checkSemanticGrounding(answer: string, evidence: EvidenceText[]): Promise<{ supported: boolean; unsupportedSentences: string[] }> {
  const result = await completeStructured(JSON.stringify({ answer, evidence: evidence.map((row,index)=>({id:index+1,text:row.text,context:row.context})) }),
    '逐句检查答案是否被所引编号的原文和来源元数据语义支持。来源元数据只支持文档名、章节、页码及检索时间切片。代码围栏及引出摘录的排版文字不是独立事实句；核对摘录内容及其引用，引用可在摘录的引导语或围栏后。仅有相同关键词不代表支持；检查主客体、因果、条件和否定。不使用常识补全。只输出JSON {"supported":boolean,"unsupported_sentences":[]}；任何事实句无支持则false。unsupported_sentences 必须逐字摘录草稿中未获支持的表述，保留引用编号。')
  const text = requireModelText(result, '回答语义校验')
  let decision: { supported?: unknown; unsupported_sentences?: unknown } | null
  try {
    decision = parseStructuredJson(text) as typeof decision
  } catch {
    throw modelUnavailable('回答语义校验', '模型返回了无效 JSON')
  }
  if (typeof decision?.supported !== 'boolean' || !Array.isArray(decision.unsupported_sentences)) {
    throw modelUnavailable('回答语义校验', '模型未返回有效的核验结果')
  }
  return {
    supported: decision.supported && decision.unsupported_sentences.length === 0,
    unsupportedSentences: decision.unsupported_sentences.filter((sentence): sentence is string => typeof sentence === 'string' && Boolean(sentence.trim())),
  }
}
