/** Read one balanced JSON object/array, respecting quotes and escape sequences. */
export function parseStructuredJson(text: string): unknown {
  const values: unknown[] = []
  let start = -1
  let quoted = false
  let escaped = false
  const stack: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (start < 0) {
      if (char !== '{' && char !== '[') continue
      start = index
      stack.push(char)
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw new SyntaxError('JSON 括号不匹配')
      if (!stack.length) {
        values.push(JSON.parse(text.slice(start, index + 1)))
        start = -1
      }
    }
  }
  if (start >= 0 || values.length !== 1) throw new SyntaxError('模型必须返回一个完整 JSON 对象或数组')
  return values[0]
}
