import { eq, desc, like, or, sql } from 'drizzle-orm'
import type { AppDb } from '../db/client'
import { accounts } from '../db/schema'

/** 凭据种类：账号密码 / API Key。 */
export type AccountKind = 'password' | 'apikey'

/** Agent 按 type 取到的完整凭据（含明文，仅内部使用，不经列表接口下发）。 */
export interface AccountCredential {
  type: string
  name: string
  kind: AccountKind
  username: string
  password: string
  apiKey: string
}

/** 下发给设置页的条目：凭据值脱敏，只回「是否已配置」，不回明文。 */
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

function maskKind(raw: string): AccountKind {
  return raw === 'apikey' ? 'apikey' : 'password'
}

/**
 * 通用账号本 Mapper：type 为用户自定义自由文本，Agent 按 type 取凭据。
 * 列表/详情只回脱敏视图（hasSecret），明文只通过 getByType 供内部消费。
 */
export function accountMapper(db: AppDb) {
  return {
    /** 全量列表（脱敏），可按 type/name 模糊检索。 */
    async list(q?: string): Promise<AccountView[]> {
      const kw = (q ?? '').trim()
      const where = kw
        ? or(like(accounts.type, `%${kw}%`), like(accounts.name, `%${kw}%`), like(accounts.username, `%${kw}%`))
        : undefined
      const rows = where
        ? await db.select().from(accounts).where(where).orderBy(desc(accounts.updatedAt))
        : await db.select().from(accounts).orderBy(desc(accounts.updatedAt))
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        kind: maskKind(r.kind),
        username: r.username,
        hasSecret: !!(r.kind === 'apikey' ? r.apiKey : r.password),
        note: r.note,
        createdAt: r.createdAt ?? r.updatedAt ?? 0,
        updatedAt: r.updatedAt ?? 0,
      }))
    },

    /** 新增一条；返回新 id。 */
    async create(input: {
      type: string; name?: string; kind?: string; username?: string
      password?: string; apiKey?: string; note?: string
    }): Promise<number> {
      const res = await db.insert(accounts).values({
        type: input.type.trim(),
        name: (input.name ?? '').trim(),
        kind: maskKind(input.kind ?? 'password'),
        username: (input.username ?? '').trim(),
        password: input.password ?? '',
        apiKey: input.apiKey ?? '',
        note: (input.note ?? '').trim(),
      }).returning({ id: accounts.id })
      return res[0]?.id ?? 0
    },

    /** 更新一条：只覆盖传入的字段（undefined 不动），密码/apiKey 传空串表示清空。 */
    async update(id: number, patch: {
      type?: string; name?: string; kind?: string; username?: string
      password?: string; apiKey?: string; note?: string
    }): Promise<void> {
      const set: Record<string, unknown> = { updatedAt: sql`(strftime('%s', 'now'))` }
      if (patch.type !== undefined) set.type = patch.type.trim()
      if (patch.name !== undefined) set.name = patch.name.trim()
      if (patch.kind !== undefined) set.kind = maskKind(patch.kind)
      if (patch.username !== undefined) set.username = patch.username.trim()
      if (patch.password !== undefined) set.password = patch.password
      if (patch.apiKey !== undefined) set.apiKey = patch.apiKey
      if (patch.note !== undefined) set.note = patch.note.trim()
      await db.update(accounts).set(set).where(eq(accounts.id, id))
    },

    async remove(id: number): Promise<void> {
      await db.delete(accounts).where(eq(accounts.id, id))
    },

    /**
     * 按 type 取第一条完整凭据（含明文），供 Agent / 工具内部使用。
     * 不经过设置页接口下发明文。
     */
    async getByType(type: string): Promise<AccountCredential | null> {
      const rows = await db.select().from(accounts)
        .where(eq(accounts.type, type.trim()))
        .orderBy(desc(accounts.updatedAt))
        .limit(1)
      const r = rows[0]
      if (!r) return null
      return {
        type: r.type,
        name: r.name,
        kind: maskKind(r.kind),
        username: r.username,
        password: r.password,
        apiKey: r.apiKey,
      }
    },
  }
}
