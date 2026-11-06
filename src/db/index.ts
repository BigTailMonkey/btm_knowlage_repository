import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { newId, todayLocal } from '../core/ids.js'
import { settings } from '../config.js'

export interface DbClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
}

interface Driver {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[] }>
  exec(text: string): Promise<void>
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>
  close(): Promise<void>
}

let driverPromise: Promise<Driver> | null = null

async function createDriver(): Promise<Driver> {
  const url = settings.databaseUrl
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: url, max: 20 })
    return {
      async query(text, params) {
        return pool.query(text, params)
      },
      async exec(text) {
        await pool.query(text)
      },
      async transaction(fn) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await fn({
            async query(text, params = []) {
              return (await client.query(text, params)).rows as never
            },
          })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
      async close() {
        await pool.end()
      },
    }
  }

  // 本地零依赖运行：PGlite 是 PostgreSQL 的嵌入式实现，同一份 schema 与 SQL。
  const { PGlite } = await import('@electric-sql/pglite')
  const pglite = new PGlite(join(settings.dataDir, 'pglite'))
  await pglite.waitReady
  // A PGlite instance owns one connection. Keep transactions exclusive while
  // allowing their client queries to run directly inside the queued operation.
  let pending: Promise<void> = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation)
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  const client: DbClient = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await pglite.query<T>(text, params as unknown[])
      return result.rows
    },
  }
  return {
    async query(text, params) {
      return serialize(async () => {
        const result = await pglite.query(text, params as unknown[])
        return { rows: result.rows }
      })
    },
    async exec(text) {
      await serialize(() => pglite.exec(text).then(() => undefined))
    },
    async transaction(fn) {
      return serialize(async () => {
        await pglite.query('BEGIN')
        try {
          const result = await fn(client)
          await pglite.query('COMMIT')
          return result
        } catch (error) {
          await pglite.query('ROLLBACK')
          throw error
        }
      })
    },
    async close() {
      await serialize(() => pglite.close())
    },
  }
}

async function driver(): Promise<Driver> {
  if (!driverPromise) driverPromise = createDriver()
  return driverPromise
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = await driver()
  return (await db.query(text, params)).rows as T[]
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

export async function transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const db = await driver()
  return db.transaction(fn)
}

export async function initSchema(): Promise<void> {
  const candidates = [
    join(settings.rootDir, 'src', 'db', 'schema.sql'),
    join(settings.rootDir, 'dist', 'src', 'db', 'schema.sql'),
  ]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) throw new Error('找不到数据库 schema.sql')
  const sql = readFileSync(path, 'utf8')
  const db = await driver()
  await db.exec(sql)
}

export async function seedIfEmpty(): Promise<void> {
  const existing = await queryOne<{ id: string }>('SELECT id FROM tenants LIMIT 1')
  if (existing) return

  await transaction(async (client) => {
    await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      settings.defaultTenantId,
      '知织工作区',
    ])
    await client.query(
      `INSERT INTO users (id, tenant_id, name, email, role, groups, token)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        'u_owner',
        settings.defaultTenantId,
        '何道伟',
        'owner@knowweave.local',
        'owner',
        JSON.stringify(['everyone', 'finance', 'exec', 'engineering']),
        'owner-token',
      ],
    )
    await client.query(
      `INSERT INTO budgets (id, tenant_id, scope, period, limit_amount, used_amount, alert_at)
       VALUES ($1, $2, 'tenant', 'month', 100, 0, 0.8)`,
      [newId('bud'), settings.defaultTenantId],
    )
    for (const [model, [input, output, currency]] of Object.entries(settings.prices)) {
      await client.query(
        `INSERT INTO model_prices
           (id, provider, model, input_per_1m, output_per_1m, currency, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('price'), settings.modelProvider, model, input, output, currency, todayLocal(settings.timezone)],
      )
    }
  })
}

export async function closePool(): Promise<void> {
  if (!driverPromise) return
  const db = await driverPromise
  await db.close()
  driverPromise = null
}
