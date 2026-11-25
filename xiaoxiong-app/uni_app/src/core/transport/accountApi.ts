/**
 * 通用账号本 REST 客户端：App 设置页经网关 /api/admin/accounts 增删改查。
 * 凭据明文不回显（列表只有 hasSecret），密码/apiKey 只在新增/更新时上行。
 * 用 secureRequest 自动加解密（与设置页保存配置同一通道）。
 */
import { resolveGatewayHttpBase } from './webSocketTransport'
import { secureRequest } from './secureRequest'

export type AccountKind = 'password' | 'apikey'

export interface AccountView {
  id: number
  type: string
  name: string
  kind: AccountKind
  username: string
  hasSecret: boolean
  note: string
  createdAt: number
  updatedAt: number
}

export interface AccountInput {
  type: string
  name?: string
  kind?: AccountKind
  username?: string
  password?: string
  apiKey?: string
  note?: string
}

function base(): string {
  return `${resolveGatewayHttpBase()}/api/admin/accounts`
}

/** 从 secureRequest 响应里取业务 body，非 2xx 抛可读错误。 */
function unwrap(res: { statusCode: number; data: unknown }): any {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const d = res.data as { error?: string } | null
    throw new Error(d?.error || `HTTP ${res.statusCode}`)
  }
  return res.data
}

export async function listAccounts(q?: string): Promise<AccountView[]> {
  const url = q ? `${base()}?q=${encodeURIComponent(q)}` : base()
  const data = unwrap(await secureRequest({ url, method: 'GET' }))
  return Array.isArray(data?.accounts) ? data.accounts : []
}

export async function createAccount(input: AccountInput): Promise<number> {
  const data = unwrap(await secureRequest({
    url: base(), method: 'POST', data: input, header: { 'content-type': 'application/json' },
  }))
  return data?.id ?? 0
}

export async function updateAccount(id: number, patch: AccountInput): Promise<void> {
  unwrap(await secureRequest({
    url: `${base()}?id=${id}`, method: 'PUT', data: patch, header: { 'content-type': 'application/json' },
  }))
}

export async function removeAccount(id: number): Promise<void> {
  unwrap(await secureRequest({ url: `${base()}?id=${id}`, method: 'DELETE' }))
}
