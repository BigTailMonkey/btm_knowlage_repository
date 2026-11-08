import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settings } from '../src/config.js'
import { initSchema, seedIfEmpty, closePool } from '../src/db/index.js'
import { ingestParsed, stopIngestWorker } from '../src/core/ingestion.js'
import { parseMarkdown } from '../src/adapters/parsing/index.js'
import { runEvaluation, type EvaluationCase } from '../src/core/evaluation.js'
import { harness } from '../src/adapters/harness/index.js'
import { embedder, sparseVector, tokenize } from '../src/adapters/embeddings/index.js'
import type { Principal } from '../src/core/security.js'

const live = process.argv.includes('--live')
const directory = await mkdtemp(join(tmpdir(), 'knowweave-golden-'))
settings.dataDir = directory
settings.databaseUrl = ''
settings.semanticEntities = false
settings.rerankUrl = ''
if (!live) {
  settings.rerankThreshold = 0.2
  const embedding = (text: string) => ({ dense: [], sparse: sparseVector(tokenize(text), 500), model: 'offline-lexical', dim: 0 })
  // An independent deterministic lexical baseline; no fixed "all vectors equal" test stub.
  embedder.embedMany = async (texts) => texts.map((text) => ({ ...embedding(text), dense: [1] }))
  embedder.embedQuery = async (text) => ({ ...embedding(text), dense: [0] })
}
await initSchema()
await seedIfEmpty()
const principal: Principal = { tenantId: settings.defaultTenantId, userId: 'u_owner', name: 'Golden evaluator', role: 'owner', groups: ['everyone'], token: 'owner-token' }
const cases = JSON.parse(await readFile(join(settings.rootDir, 'tests/fixtures/repository-golden.json'), 'utf8')) as Array<EvaluationCase & { source: string; symbol: string }>
try {
  for (const source of new Set(cases.map((item) => item.source))) {
    const text = await readFile(join(settings.rootDir, source), 'utf8')
    const lines = text.split('\n')
    const excerpts = cases.filter((item) => item.source === source).map((item) => {
      const line = lines.findIndex((value) => value.includes(item.symbol))
      return `## ${item.symbol}\n\n${lines.slice(Math.max(0,line-1),line+6).join('\n')}`
    })
    await ingestParsed(principal, parseMarkdown(`# ${source}\n\n${excerpts.join('\n\n')}`, source), { sourceType: 'md', uri: `repository:${source}` })
    process.stdout.write('.')
  }
  const evaluation = await runEvaluation(principal, cases, live ? 'answer' : 'retrieval', live ? (completed,total)=>process.stdout.write(`\ncompleted ${completed}/${total}`) : undefined)
  const artifact = join(directory, 'evaluation.json')
  await writeFile(artifact, JSON.stringify({ corpus: '20 repository source excerpts; 50 explicit excerpt/citation questions', corpus_version: 2, live, ...evaluation }, null, 2))
  console.log('\n' + JSON.stringify({ ...evaluation.metrics, artifact, live, threshold: settings.rerankThreshold }))
  // Version 2 baseline is 100%; allow at most two percentage points regression.
  if (evaluation.metrics.pass_rate < 0.98 || evaluation.metrics.recall_at_10 < 0.85 || evaluation.metrics.context_precision < 0.75
    || (live && (evaluation.metrics.citation_accuracy ?? 0) < 0.98)) process.exitCode = 1
  if (live && evaluation.metrics.model_successes < cases.length * 0.95) process.exitCode = 1
} catch (error) {
  let message = error instanceof Error ? error.message : String(error)
  for (const key of [settings.modelApiKey,settings.embeddingApiKey]) if (key) message=message.replaceAll(key,'[redacted]')
  console.error(JSON.stringify({live,error:message.slice(0,500)})); process.exitCode=1
} finally { await stopIngestWorker(); await harness.close(); await closePool() }
