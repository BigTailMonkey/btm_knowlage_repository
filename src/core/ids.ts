import { randomBytes } from 'node:crypto'

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`
}

/** enrich 任务 id：每篇文档每个版本一条，抽取检查点也挂在这条任务上。 */
export function enrichJobId(docId: string, version: number): string {
  return `enrich:${docId}:${version}`
}

export function utcNow(): Date {
  return new Date()
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

export function todayLocal(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
