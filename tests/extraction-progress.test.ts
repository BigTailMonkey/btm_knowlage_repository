import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  closeExtractionMeter, completeExtractionBatch, extractionProgress, planExtractionBatches,
  setExtractionStage, startExtractionMeter, trackExtraction,
} from '../src/core/extraction-progress.js'
import { countEmbeddingRequest, countModelRequest } from '../src/util/request-meter.js'

test('进度以批次为底数、实际请求数为进度', async () => {
  const meter = startExtractionMeter('doc-1', 3)
  planExtractionBatches(meter, 4)
  setExtractionStage(meter, '第 1/4 批抽取')
  await trackExtraction(meter, async () => {
    countModelRequest()
    countModelRequest()
    countEmbeddingRequest()
    countEmbeddingRequest()
    countEmbeddingRequest()
    completeExtractionBatch(meter)
    countModelRequest()
  })
  const progress = extractionProgress('doc-1', 3)!
  assert.equal(progress.batches_total, 4, '批次是底数')
  assert.equal(progress.batches_done, 1)
  assert.equal(progress.requests, 6, '请求数是进度，含模型与向量')
  assert.equal(progress.model_requests, 3)
  assert.equal(progress.embedding_requests, 3)
  assert.equal(progress.stage, '第 1/4 批抽取')
  assert.ok(progress.elapsed_ms >= 0)
  assert.notEqual(progress.eta_ms, null, '完成一批且还有剩余批次时给出预计剩余')
  closeExtractionMeter(meter)
  assert.equal(extractionProgress('doc-1', 3), null, '任务结束后不再返回进度')
})

test('计量只在抽取上下文内生效，不同任务互不干扰', async () => {
  const first = startExtractionMeter('doc-a', 1)
  const second = startExtractionMeter('doc-b', 1)
  await trackExtraction(first, async () => countModelRequest())
  countModelRequest()
  countEmbeddingRequest()
  assert.equal(extractionProgress('doc-a', 1)!.requests, 1)
  assert.equal(extractionProgress('doc-b', 1)!.requests, 0)
  closeExtractionMeter(first)
  closeExtractionMeter(second)
})

test('还没跑完一批时不给预计剩余时间', () => {
  const meter = startExtractionMeter('doc-c', 1)
  planExtractionBatches(meter, 2)
  assert.equal(extractionProgress('doc-c', 1)!.eta_ms, null)
  closeExtractionMeter(meter)
})