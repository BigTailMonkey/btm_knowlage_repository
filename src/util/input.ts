/** Validate JSON objects and PostgreSQL-safe text before calling core services. */
export function objectParam(value: unknown, name = '请求体'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${name} 必须为对象`), { statusCode: 400 })
  }
  return value as Record<string, unknown>
}

export function textParam(value: unknown, name: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000')) {
    throw Object.assign(new Error(`${name} 必须为不含 NUL 的非空字符串，最长 ${max} 字符`), { statusCode: 400 })
  }
  return value.trim()
}

/** Parse API integer parameters before they reach SQL or graph traversal. */
export function integerParam(value: unknown, name: string, initial: number, min: number, max: number): number {
  if (value === undefined) return initial
  if (typeof value !== 'string' && typeof value !== 'number'
    || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error(`${name} 必须为整数`), { statusCode: 400 })
  }
  const parsed = Number(value)
  if (parsed < min || parsed > max) {
    throw Object.assign(new Error(`${name} 必须在 ${min}–${max} 之间`), { statusCode: 400 })
  }
  return parsed
}
