import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConverter } from '@deepseek-ai/libreoffice-kit'

let activeConversions = 0

export async function convertWord(
  data: Buffer, input: 'doc' | 'docx', output: 'pdf' | 'docx', signal?: AbortSignal,
): Promise<Buffer> {
  if (activeConversions >= 2) throw Object.assign(new Error('文档转换繁忙，请稍后重试'), { statusCode: 503 })
  activeConversions += 1
  let directory: string | undefined
  let converter: Awaited<ReturnType<typeof createConverter>> | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'knowweave-word-'))
    const inputPath = join(directory, `source.${input}`)
    const outputPath = join(directory, `converted.${output}`)
    await writeFile(inputPath, data, { mode: 0o600, signal })
    converter = await createConverter({
      timeoutMs: 30_000,
      maxInputBytes: 30 * 1024 * 1024,
      maxOutputBytes: 50 * 1024 * 1024,
      fontMetadataCacheDirectory: false,
    })
    await converter.convert({ inputPath, outputPath }, signal)
    return await readFile(outputPath, { signal })
  } finally {
    try {
      await converter?.dispose()
    } finally {
      activeConversions -= 1
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}
