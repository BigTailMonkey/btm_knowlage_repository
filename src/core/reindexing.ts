import { embedder } from '../adapters/embeddings/index.js'
import { query, transaction } from '../db/index.js'
import type { ChunkRow } from './rows.js'

/** Rebuild derived vectors for every stored version, retaining citation and fact identities. */
export async function reindexDocument(tenantId: string, docId: string) {
  const chunks = await query<ChunkRow>('SELECT * FROM chunks WHERE tenant_id=$1 AND doc_id=$2 AND is_parent=false ORDER BY id', [tenantId,docId])
  const vectors = await embedder.embedMany(chunks.map(chunk => chunk.text))
  if (vectors.length !== chunks.length || vectors.some(v => !v.dense.length || v.dense.length !== v.dim || v.dense.some(x => !Number.isFinite(x)))) throw new Error('重建向量数量或维度不合法')
  await transaction(async client => {
    const documents = await client.query("SELECT id FROM documents WHERE id=$1 AND tenant_id=$2 AND status='active' FOR UPDATE", [docId,tenantId])
    if (!documents.length) throw Object.assign(new Error('文档已删除，重建取消'), { statusCode: 409 })
    for (let i=0;i<chunks.length;i++) {
      const vector=vectors[i]!
      await client.query('UPDATE chunks SET dense=$1::jsonb,sparse=$2::jsonb,embedding_model=$3,embedding_dim=$4 WHERE id=$5', [JSON.stringify(vector.dense),JSON.stringify(vector.sparse),vector.model,vector.dim,chunks[i]!.id])
    }
  })
  return { document_id: docId, status: 'done', chunks: chunks.length, model: vectors[0]?.model ?? embedder.model }
}
