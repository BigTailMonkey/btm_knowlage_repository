import { randomBytes } from 'node:crypto'

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`
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
