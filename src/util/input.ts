/** Parse API integer parameters before they reach SQL or graph traversal. */
export function integerParam(value: unknown, name: string, initial: number, min: number, max: number): number {
  if (value === undefined) return initial
  if (typeof value !== 'string' && typeof value !== 'number'
    || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error(`${name} 必须为整数`), { statusCode: 400 })
  }
  return Math.min(max, Math.max(min, Number(value)))
}
