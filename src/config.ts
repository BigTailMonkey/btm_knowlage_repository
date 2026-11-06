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
    } catch {
      continue
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
const tenant = raw.tenant ?? {}
const server = raw.server ?? {}
const dsh = raw.dsh ?? {}
const sidecar = raw.sidecar ?? {}

const dataDir = resolvePath(storage.data_dir, join(ROOT_DIR, 'data'))
const priceRows = (raw.prices ?? {}) as Record<string, Record<string, unknown>>

export const settings = {
  rootDir: ROOT_DIR,
  webDir: resolvePath(raw.web?.dir, join(ROOT_DIR, 'knowweave', 'web')),
  dataDir,
  databaseUrl: text(database.url, ''),
  seedDemo: bool(database.seed, true),
  timezone: text(time.timezone, 'Asia/Shanghai'),

  serverHost: text(server.host, process.env.HOST ?? '0.0.0.0'),
  serverPort: num(process.env.PORT, num(server.port, 8730)),

  harnessEnabled: bool(model.harness_enabled, true),
  dshHome: resolvePath(dsh.home, join(ROOT_DIR, 'data', 'dsh-home')),
  dshProfile: text(dsh.profile, 'sdk'),
  dshRuntimeCwd: resolvePath(dsh.workspace, join(ROOT_DIR, 'data', 'dsh-workspace')),
  dshWebEnabled: bool(dsh.web_enabled, false),
  dshWebAutoStart: bool(dsh.web_auto_start, false),
  dshWebPort: num(dsh.web_port, 3081),
  dshWebHome: resolvePath(dsh.web_home, join(ROOT_DIR, 'data', 'dsh-web-home')),
  modelProvider: text(model.provider, 'deepseek-official'),
  model: text(model.model, 'deepseek-v4.1-flash'),
  modelApiKey: text(model.api_key, ''),
  modelBaseUrl: text(model.base_url, 'https://api.deepseek.com'),
  modelMaxTokens: num(model.max_tokens, 4096),
  fallbackModel: text(model.fallback_model, 'deepseek-chat'),

  embeddingProvider: text(embedding.provider, 'volcengine-ark'),
  embeddingModel: text(embedding.model, 'doubao-embedding-vision'),
  embeddingDim: num(embedding.dim, 1024),
  embeddingBaseUrl: text(embedding.base_url, 'https://ark.cn-beijing.volces.com/api/v3'),
  embeddingApiKey: text(embedding.api_key, ''),
  embeddingPath: text(embedding.path, '/embeddings/multimodal'),
  embeddingInstructions: text(embedding.instructions, ''),
  embeddingBatchSize: num(embedding.batch_size, 32),
  embeddingTimeoutSeconds: num(embedding.timeout_seconds, 30),

  rerankThreshold: num(retrieval.rerank_threshold, 0.36),
  reflectionEnabled: bool(reflection.enabled, true),
  reflectionIntervalSeconds: num(reflection.interval_seconds, 21600),

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
