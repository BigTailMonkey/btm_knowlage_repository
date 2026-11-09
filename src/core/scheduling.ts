import { settings } from '../config.js'
import { query } from '../db/index.js'
import { runReflection } from './learning.js'
import { purgeExpiredTrash } from './trash.js'

export async function runDailyReflection(now = new Date()): Promise<number> {
  const at = settings.reflectionRunAt
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error('reflection.run_at必须为HH:mm')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part)=>[part.type,part.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  if (`${parts.hour}:${parts.minute}` < at) return 0
  let count = 0
  for (const tenant of await query<{ id: string }>('SELECT id FROM tenants')) {
    const id = `reflection:${tenant.id}:${date}`
    const claimed = await query(`INSERT INTO jobs(id,tenant_id,type,status,payload) VALUES($1,$2,'reflection_schedule','running',$3::jsonb)
      ON CONFLICT(id) DO UPDATE SET status='running',updated_at=now()
      WHERE jobs.status='failed' OR jobs.status='running' AND jobs.updated_at<now()-interval '10 minutes' RETURNING id`, [id,tenant.id,JSON.stringify({ date })])
    if (!claimed.length) continue
    try {
      await purgeExpiredTrash(tenant.id)
      await runReflection(tenant.id)
      await query("UPDATE jobs SET status='done',updated_at=now(),error=NULL WHERE id=$1", [id])
      count += 1
    } catch (error) {
      await query("UPDATE jobs SET status='failed',error=$1,updated_at=now() WHERE id=$2", [error instanceof Error ? error.message : String(error),id])
      throw error
    }
  }
  return count
}

/** 间隔模式（未配置 reflection.run_at）下的维护：先清理过期回收站，再运行反思。 */
export async function runIntervalMaintenance(): Promise<void> {
  for (const tenant of await query<{ id: string }>('SELECT id FROM tenants')) {
    await purgeExpiredTrash(tenant.id)
    await runReflection(tenant.id)
  }
}
