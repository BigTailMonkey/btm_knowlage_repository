import { settings } from '../../config.js'

/** Compatible with the query/documents/results protocol used by rerank services. */
export async function semanticRerank(query: string, documents: string[]): Promise<number[] | null> {
  if (!settings.rerankUrl || !documents.length) return null
  const response = await fetch(settings.rerankUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(settings.rerankApiKey ? { authorization: `Bearer ${settings.rerankApiKey}` } : {}) },
    body: JSON.stringify({ query, documents, model: settings.rerankModel, top_n: documents.length, return_documents: false }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw Object.assign(new Error(`语义重排服务返回 ${response.status}`), { statusCode: 503 })
  const body = await response.json() as { results?: Array<{ index: number; relevance_score: number }> }
  const scores = new Map<number, number>()
  for (const row of body.results ?? []) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= documents.length || scores.has(row.index)
      || !Number.isFinite(row.relevance_score) || row.relevance_score < 0 || row.relevance_score > 1) {
      throw new Error('语义重排服务返回非法索引或分数')
    }
    scores.set(row.index, row.relevance_score)
  }
  if (scores.size !== documents.length) throw new Error('语义重排服务返回候选不完整')
  return documents.map((_, index) => scores.get(index)!)
}
