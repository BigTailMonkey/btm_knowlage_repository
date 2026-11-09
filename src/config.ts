import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseToml } from 'smol-toml'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
// 源码运行时位于 src/，编译后位于 dist/src/；两种情况都要回到仓库根目录。
export const ROOT_DIR = basename(MODULE_DIR) === 'src' && basename(dirname(MODULE_DIR)) === 'dist'
  ? resolve(MODULE_DIR, '..', '..')
  : resolve(MODULE_DIR, '..')
const CONFIG_CANDIDATES = [join(ROOT_DIR, 'config.toml'), join(ROOT_DIR, 'knowweave', 'config.toml')]

type RawConfig = Record<string, Record<string, unknown>>

function readConfig(): RawConfig {
  for (const path of CONFIG_CANDIDATES) {
    try {
      return parseToml(readFileSync(path, 'utf8')) as RawConfig
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`无法读取项目配置 ${path}`, { cause: error })
      }
    }
  }
  return {}
}

function resolvePath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return isAbsolute(value) ? value : resolve(ROOT_DIR, value)
}

function num(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const raw = readConfig()
const storage = raw.storage ?? {}
const database = raw.database ?? {}
const time = raw.time ?? {}
const model = raw.model ?? {}
const embedding = raw.embedding ?? {}
const retrieval = raw.retrieval ?? {}
const reflection = raw.reflection ?? {}
const trash = raw.trash ?? {}
const tenant = raw.tenant ?? {}
const server = raw.server ?? {}
const dsh = raw.dsh ?? {}
const sidecar = raw.sidecar ?? {}
const parsing = raw.parsing ?? {}

const dataDir = resolvePath(storage.data_dir, join(ROOT_DIR, 'data'))
const priceRows = (raw.prices ?? {}) as Record<string, Record<string, unknown>>
const modelMaxTokens = model.max_tokens
if (modelMaxTokens !== undefined && (typeof modelMaxTokens !== 'number' || !Number.isSafeInteger(modelMaxTokens) || modelMaxTokens <= 0)) {
  throw new Error('[model].max_tokens 必须为正整数')
}

export const settings = {
  rootDir: ROOT_DIR,
  webDir: resolvePath(raw.web?.dir, join(ROOT_DIR, 'knowweave', 'web')),
  dataDir,
  databaseUrl: text(database.url, ''),
  seedDemo: bool(database.seed, true),
  timezone: text(time.timezone, 'Asia/Shanghai'),

  serverHost: text(server.host, process.env.HOST ?? '0.0.0.0'),
  serverPort: num(process.env.PORT, num(server.port, 8730)),

  dshRuntimeCwd: resolvePath(dsh.workspace, join(ROOT_DIR, 'data', 'dsh-workspace')),
  dshWebEnabled: bool(dsh.web_enabled, true),
  dshWebAutoStart: bool(dsh.web_auto_start, true),
  dshWebSearchEnabled: bool(dsh.web_search_enabled, false),
  dshWebPort: num(dsh.web_port, 3081),
  dshWebHome: resolvePath(dsh.web_home, join(ROOT_DIR, 'data', 'dsh-web-home')),
  modelProvider: text(model.provider, 'openai-compatible').trim(),
  model: text(model.model, '').trim(),
  modelApiKey: text(model.api_key, '').trim(),
  modelBaseUrl: text(model.base_url, '').trim(),
  modelMaxTokens,

  embeddingProvider: text(embedding.provider, 'volcengine-ark'),
  embeddingModel: text(embedding.model, 'doubao-embedding-vision'),
  embeddingDim: num(embedding.dim, 1024),
  embeddingBaseUrl: text(embedding.base_url, 'https://ark.cn-beijing.volces.com/api/v3'),
  embeddingApiKey: text(embedding.api_key, ''),
  embeddingPath: text(embedding.path, '/embeddings/multimodal'),
  embeddingInstructions: text(embedding.instructions, ''),
  embeddingBatchSize: num(embedding.batch_size, 32),
  embeddingTimeoutSeconds: num(embedding.timeout_seconds, 30),
  // 重试策略：首次失败后最多重试 retry_max_retries 次；间隔在 base_ms→max_ms 之间等比均匀铺开（含首次共 retries+1 次请求）
  embeddingRetryMaxRetries: Math.max(0, Math.trunc(num(embedding.retry_max_retries, 10))),
  embeddingRetryBaseMs: Math.max(1, num(embedding.retry_base_ms, 5_000)),
  embeddingRetryMaxMs: Math.max(1, num(embedding.retry_max_ms, 180_000)),
  embeddingRetryJitter: bool(embedding.retry_jitter, false),

  rerankThreshold: num(retrieval.rerank_threshold, 0.36),
  rerankUrl: text(retrieval.rerank_url, ''),
  rerankModel: text(retrieval.rerank_model, ''),
  rerankApiKey: text(retrieval.rerank_api_key, ''),
  semanticEntities: bool(retrieval.semantic_entities, true),
  groundingVerifier: bool(retrieval.grounding_verifier, true),
  parseEngine: text(parsing.engine, 'auto'),
  parseMinQuality: num(parsing.min_quality, 0.25),
  reflectionEnabled: bool(reflection.enabled, true),
  reflectionRunAt: typeof reflection.run_at === 'string' ? reflection.run_at : '03:00',
  reflectionIntervalSeconds: num(reflection.interval_seconds, 21600),
  // 回收站保留天数；到期由每日维护自动彻底清除，0 表示不自动清除
  trashRetentionDays: Math.max(0, Math.trunc(num(trash.retention_days, 30))),

  sidecarUrl: text(sidecar.url, 'http://127.0.0.1:8732'),
  sidecarEnabled: bool(sidecar.enabled, true),
  sidecarAutoStart: bool(sidecar.auto_start, true),
  sidecarCommand: resolvePath(sidecar.python, join(ROOT_DIR, 'knowweave', '.venv', 'bin', 'python')),

  defaultTenantId: text(tenant.default_id, 'tn_knowweave'),
  prices: Object.fromEntries(
    Object.entries(priceRows).map(([name, values]) => [
      name,
      [
        num(values.input_per_1m, 0),
        num(values.output_per_1m, 0),
        text(values.currency, 'CNY'),
      ] as [number, number, string],
    ]),
  ),
}

export type Settings = typeof settings
