import { queryOne } from '../db/index.js'

export interface Principal {
  userId: string
  tenantId: string
  name: string
  role: string
  groups: string[]
  token: string
}

export interface UserRow {
  id: string
  tenant_id: string
  name: string
  role: string
  groups: string[]
  token: string
  status: string
}

const USER_COLUMNS = 'id, tenant_id, name, role, groups, token, status'

function toPrincipal(row: UserRow | null): Principal | null {
  if (!row) return null
  return {
    userId: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    role: row.role,
    groups: row.groups ?? [],
    token: row.token,
  }
}

export async function resolveToken(token: string): Promise<Principal | null> {
  if (!token) return null
  return toPrincipal(await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE token = $1 AND status = $2`,
    [token, 'active'],
  ))
}

/** 按已绑定身份解析主体，供 DSH 原生工作区启动预热使用。 */
export async function principalByUserId(tenantId: string, userId: string): Promise<Principal | null> {
  return toPrincipal(await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 AND id = $2 AND status = $3`,
    [tenantId, userId, 'active'],
  ))
}

/** 未绑定身份时使用工作区默认所有者，保证对话进程可在启动阶段预热。 */
export async function defaultPrincipal(tenantId: string): Promise<Principal | null> {
  return toPrincipal(await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users
     WHERE tenant_id = $1 AND status = $2
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at
     LIMIT 1`,
    [tenantId, 'active'],
  ))
}

export function principalSet(principal: Principal): Set<string> {
  const values = new Set([`user:${principal.userId}`, 'tenant:public'])
  for (const group of principal.groups) values.add(`group:${group}`)
  return values
}

export function canRead(principal: Principal, aclPrincipals: unknown): boolean {
  if (!Array.isArray(aclPrincipals) || aclPrincipals.length === 0) {
    // 默认拒绝：没有显式授权的资源不进入检索。
    return false
  }
  const allowed = principalSet(principal)
  return aclPrincipals.some((item) => typeof item === 'string' && allowed.has(item))
}

export function aclLabel(aclPrincipals: unknown): string {
  if (!Array.isArray(aclPrincipals) || aclPrincipals.length === 0) return '未授权'
  if (aclPrincipals.includes('tenant:public')) return '全员可见'
  const groups = aclPrincipals
    .filter((item): item is string => typeof item === 'string' && item.startsWith('group:'))
    .map((item) => item.slice('group:'.length))
  const users = aclPrincipals
    .filter((item): item is string => typeof item === 'string' && item.startsWith('user:'))
    .map((item) => item.slice('user:'.length))
  if (groups.length) return `组：${groups.join('、')}`
  if (users.length) return `个人：${users.join('、')}`
  return '受限'
}

export function requireAdmin(principal: Principal): void {
  if (!['owner', 'admin'].includes(principal.role)) {
    throw Object.assign(new Error('需要管理员权限'), { statusCode: 403 })
  }
}

export function requireEditor(principal: Principal): void {
  if (!['owner', 'admin', 'editor'].includes(principal.role)) {
    throw Object.assign(new Error('当前主体没有写入权限'), { statusCode: 403 })
  }
}
