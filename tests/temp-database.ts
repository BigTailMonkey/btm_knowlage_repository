import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

import { settings } from '../src/config.js'

// 模块加载时固定基础连接，避免后续 settings.databaseUrl 被替换后连到临时库。
const base = (process.env.KNOWWEAVE_TEST_DATABASE_URL ?? settings.databaseUrl).trim()
if (!base) throw new Error('测试需要 PostgreSQL：请配置 [database].url 或设置 KNOWWEAVE_TEST_DATABASE_URL')
if (!base.startsWith('postgres://') && !base.startsWith('postgresql://')) {
  throw new Error('KNOWWEAVE_TEST_DATABASE_URL 仅支持 PostgreSQL 连接地址')
}

function baseUrl(): string {
  return base
}

export function databaseUrlFor(name: string): string {
  const url = new URL(baseUrl())
  url.pathname = `/${name}`
  return url.toString()
}

export interface TempDatabase {
  name: string
  url: string
  drop(): Promise<void>
}

export async function createTempDatabase(prefix: string): Promise<TempDatabase> {
  const base = baseUrl()
  const name = `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  const client = new Client({ connectionString: base })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }
  return {
    name,
    url: databaseUrlFor(name),
    async drop() {
      const admin = new Client({ connectionString: base })
      await admin.connect()
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    },
  }
}
