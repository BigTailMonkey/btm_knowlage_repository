import { tokenize } from '../adapters/embeddings/index.js'
import { completeStructured, modelUnavailable, requireModelText } from '../adapters/harness/index.js'

const CITATION = /\[(\d+)\]/g

export interface EvidenceText { text: string; context?: string }
export interface GroundingCheck {
  valid: boolean
  coverage: number
  sentences: number
  supported: number
  quotes: Record<number, string>
  reason: string | null
}

/** Keep references following a full stop attached to their preceding claim. */
export function claimSentences(answer: string): string[] {
  const lines = answer.split(/\n+/)
  return lines.flatMap((line, index) => {
    const text = line.trim()
    if (!text || /^#{1,6}\s/.test(text) || /^\|?\s*:?-{3,}/.test(text)) return []
    if (/^\|/.test(text) && /^\|?\s*:?-{3,}/.test(lines[index + 1]?.trim() ?? '')) return []
    if (/^(?:根据现有资料|资料明确支持|原文摘录|结论|关键依据)[：:]$/.test(text)) return []
    if (text.startsWith('|')) return [text]
    return text.replace(/([。！？!?；;])\s*((?:\[\d+\]\s*)+)/g, '$2$1')
      .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z])/)
      .map((part) => part.trim()).filter(Boolean)
  })
}

function plain(value: string): string {
  return value.replace(CITATION, '').replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+)/, '').replace(/[|*_`]/g, ' ').trim()
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function overlap(claim: string, source: string): number {
  const tokens = new Set(tokenize(claim))
  if (!tokens.size) return normalized(source).includes(normalized(claim)) ? 1 : 0
  const available = new Set(tokenize(source))
  return [...tokens].filter((token) => available.has(token)).length / tokens.size
}

/** Deterministic evidence checks, not a semantic entailment model. Fail closed to source excerpts. */
export function validateGrounding(answer: string, evidence: EvidenceText[]): GroundingCheck {
  const sentences = claimSentences(answer)
  const quotes: Record<number, string> = {}
  let supported = 0
  let reason: string | null = null
  for (const sentence of sentences) {
    const ids = [...sentence.matchAll(CITATION)].map((match) => Number(match[1]))
    if (!ids.length || ids.some((id) => id < 1 || id > evidence.length)) {
      reason ??= '回答存在缺失或无效引用的句子'
      continue
    }
    const claim = plain(sentence)
    const sources = ids.map((id) => evidence[id - 1]!.text)
    const combined = sources.join('\n')
    const numbers = claim.match(/[+-]?\d+(?:[.,]\d+)*(?:\s*(?:%|％|[A-Za-z]+|毫秒|秒|万元|亿元|元|年|月|天))?/g) ?? []
    const numericSupport = numbers.every((number) => combined.replace(/\s/g, '').includes(number.replace(/\s/g, '')))
    const exactSupport = normalized(combined).includes(normalized(claim))
    const lexicalSupport = exactSupport || overlap(claim, combined) >= 0.6
    const bestSource = sources.flatMap((source) => source.split(/(?<=[。！？!?；;])\s*|\n+/)).sort((a, b) => overlap(claim, b) - overlap(claim, a))[0] ?? combined
    const negative = /\b(?:not|never|cannot|unsupported)\b|不(?:支持|允许|可|能|会|是|应|得|超过|低于|需要)|未(?:支持|启用|实现|提供)|无法|禁止|没有|无需/i
    const polaritySupport = negative.test(claim) === negative.test(bestSource)
    if (!claim || !(exactSupport || numericSupport && lexicalSupport && polaritySupport)) {
      reason ??= '回答中的数字或文字无法与所引证据核对'
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
  return { valid: sentences.length > 0 && supported === sentences.length, coverage, sentences: sentences.length, supported, quotes, reason: reason ?? (sentences.length ? null : '没有可核对的事实句') }
}

/** A separate entailment decision supplements deterministic citation/number checks. */
export async function verifySemanticGrounding(answer: string, evidence: EvidenceText[]): Promise<boolean> {
  const result = await completeStructured(JSON.stringify({ answer, evidence: evidence.map((row,index)=>({id:index+1,text:row.text})) }),
    '逐句检查答案是否被所引编号的原文语义支持。仅有相同关键词不代表支持；检查主客体、因果、条件和否定。不使用常识补全。只输出JSON {"supported":boolean,"unsupported_sentences":[]}；任何事实句无支持则false。')
  const text = requireModelText(result, '回答语义校验')
  let decision: { supported?: unknown; unsupported_sentences?: unknown } | null
  try {
    decision = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? 'null')
  } catch {
    throw modelUnavailable('回答语义校验', '模型返回了无效 JSON')
  }
  if (typeof decision?.supported !== 'boolean' || !Array.isArray(decision.unsupported_sentences)) {
    throw modelUnavailable('回答语义校验', '模型未返回有效的核验结果')
  }
  return decision.supported && decision.unsupported_sentences.length === 0
}
