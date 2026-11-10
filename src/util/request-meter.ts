import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestCounters {
  /** chat/completions 实际发出的请求数（含退避重试） */
  model: number
  /** 向量服务实际发出的请求数（含退避重试） */
  embedding: number
}

const storage = new AsyncLocalStorage<RequestCounters>()

/**
 * 在当前异步上下文里累计请求数。适配器只在有上下文时计数，
 * 普通问答、检索等路径不受影响，也不需要改造调用链。
 */
export function withRequestMeter<T>(counters: RequestCounters, run: () => Promise<T>): Promise<T> {
  return storage.run(counters, run)
}

export function countModelRequest(): void {
  const counters = storage.getStore()
  if (counters) counters.model += 1
}

export function countEmbeddingRequest(): void {
  const counters = storage.getStore()
  if (counters) counters.embedding += 1
}