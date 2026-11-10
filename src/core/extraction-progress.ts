import { withRequestMeter, type RequestCounters } from '../util/request-meter.js'

/**
 * 事实与实体抽取的实时进度。
 *
 * 批次是「底数」，发出多少次请求是「进度数」：一次抽取要打多少请求取决于模型抽出多少候选、
 * 实体池多大，事前算不出来，所以进度以实际请求数和批次完成数表示。
 * 只存在内存里：进程重启后任务本身会从头重跑，进度也随之重建。
 */
export interface ExtractionMeter extends RequestCounters {
  documentId: string
  version: number
  stage: string
  batchesTotal: number
  batchesDone: number
  startedAt: number
  batchStartedAt: number
  lastBatchMs: number | null
}

export interface ExtractionProgress {
  stage: string
  batches_done: number
  batches_total: number
  requests: number
  model_requests: number
  embedding_requests: number
  elapsed_ms: number
  /** 已完成的批次耗时均值 × 剩余批次；不足一批时为 null */
  eta_ms: number | null
}

const meters = new Map<string, ExtractionMeter>()
const keyOf = (documentId: string, version: number): string => `${documentId}:${version}`

export function startExtractionMeter(documentId: string, version: number): ExtractionMeter {
  const meter: ExtractionMeter = {
    documentId, version, stage: '准备抽取',
    batchesTotal: 0, batchesDone: 0,
    startedAt: Date.now(), batchStartedAt: Date.now(), lastBatchMs: null,
    model: 0, embedding: 0,
  }
  meters.set(keyOf(documentId, version), meter)
  return meter
}

export function closeExtractionMeter(meter: ExtractionMeter): void {
  const key = keyOf(meter.documentId, meter.version)
  if (meters.get(key) === meter) meters.delete(key)
}

/** 在有计数的上下文里执行抽取，模型与向量请求会自动累加到这台计数上。 */
export function trackExtraction<T>(meter: ExtractionMeter, run: () => Promise<T>): Promise<T> {
  return withRequestMeter(meter, run)
}

export function setExtractionStage(meter: ExtractionMeter, stage: string): void {
  meter.stage = stage
}

export function planExtractionBatches(meter: ExtractionMeter, total: number): void {
  meter.batchesTotal = total
}

export function completeExtractionBatch(meter: ExtractionMeter): void {
  meter.batchesDone += 1
  meter.lastBatchMs = Date.now() - meter.batchStartedAt
  meter.batchStartedAt = Date.now()
}

/** 当前进度快照；没有正在运行的任务时返回 null。 */
export function extractionProgress(documentId: string, version: number): ExtractionProgress | null {
  const meter = meters.get(keyOf(documentId, version))
  if (!meter) return null
  const remaining = meter.batchesTotal - meter.batchesDone
  return {
    stage: meter.stage,
    batches_done: meter.batchesDone,
    batches_total: meter.batchesTotal,
    requests: meter.model + meter.embedding,
    model_requests: meter.model,
    embedding_requests: meter.embedding,
    elapsed_ms: Date.now() - meter.startedAt,
    eta_ms: meter.lastBatchMs !== null && remaining > 0 ? meter.lastBatchMs * remaining : null,
  }
}

/** 仅测试与运维用：清空所有计数。 */
export function resetExtractionProgress(): void {
  meters.clear()
}