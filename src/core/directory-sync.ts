import { opendir, readFile, stat } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { query } from '../db/index.js'
import { processIngestQueue, savedIngestJobs, submitIngest, tombstoneDocument } from './ingestion.js'
import type { Principal } from './security.js'

const EXTENSIONS = new Set(['.txt','.md','.markdown','.html','.htm','.pdf','.docx','.csv','.json','.yaml','.yml','.png','.jpg','.jpeg','.tiff','.tif','.webp','.bmp','.wav','.mp3','.m4a','.mp4','.webm','.ogg','.flac'])

/** A stable file URI keeps same-named files in separate folders independent. Symlinks are never followed. */
export async function syncDirectory(principal: Principal, directory: string, deleteMissing = false) {
  const root = resolve(directory)
  if (!(await stat(root)).isDirectory()) throw new Error('同步路径必须是目录')
  const files: string[] = []
  const visit = async (path: string) => {
    for await (const entry of await opendir(path)) {
      if (entry.name.startsWith('.') || ['node_modules','dist','__pycache__'].includes(entry.name) || entry.isSymbolicLink()) continue
      const target = join(path, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(target)
    }
  }
  await visit(root)
  const seen = new Set<string>()
  const submitted: string[] = []
  let unchanged = 0
  const errors: Array<{ file: string; error: string }> = []
  for (const file of files.sort()) {
    const uri = pathToFileURL(file).href
    seen.add(uri)
    try {
      if ((await stat(file)).size > 30 * 1024 * 1024) throw new Error('文件超过30MB')
      const data = await readFile(file)
      const hash = createHash('sha256').update(data).digest('hex')
      const previous = await query(`SELECT j.id FROM jobs j WHERE j.tenant_id=$1 AND j.status='done'
        AND j.payload->'request'->>'sourceUri'=$2 AND j.payload->'request'->>'rawHash'=$3
        AND EXISTS(SELECT 1 FROM documents d WHERE d.id=j.payload->>'document_id' AND d.status='active') LIMIT 1`, [principal.tenantId, uri, hash])
      if (previous.length) { unchanged += 1; continue }
      const job = await submitIngest(principal, 'file', { filename: file.split('/').at(-1), data, sourceUri: uri })
      submitted.push(String(job.job_id))
    } catch (error) { errors.push({ file, error: error instanceof Error ? error.message : String(error) }) }
  }
  await processIngestQueue()
  let deleted = 0
  if (deleteMissing) {
    const prefix = pathToFileURL(root + '/').href
    const documents = await query<{ id: string; uri: string }>("SELECT id,uri FROM documents WHERE tenant_id=$1 AND status='active' AND left(uri,char_length($2::text))=$2", [principal.tenantId,prefix])
    for (const doc of documents) if (!seen.has(doc.uri)) { await tombstoneDocument(principal,doc.id); deleted += 1 }
  }
  const jobs = (await savedIngestJobs(principal)).filter((job) => submitted.includes(String(job.job_id)))
  return { scanned: files.length, unchanged, submitted: submitted.length, deleted, jobs, errors }
}
