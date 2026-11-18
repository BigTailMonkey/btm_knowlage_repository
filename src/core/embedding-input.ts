/** Ingestion, restoration and reindexing must use identical document inputs. */
export function documentEmbeddingInput(title: string, headings: string[], text: string): string {
  return `标题：${title}｜章节：${headings.join(' / ')}\n${text}`
}
