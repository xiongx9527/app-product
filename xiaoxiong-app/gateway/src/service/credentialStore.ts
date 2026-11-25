/**
 * 通用账号本的全局读取入口（模块级注入，避免把 getter 穿过 13 个 agentFactory 参数）。
 * 入口 createGateway 注入 data.getAccountByType；agentService 在工具调用层按 type 取凭据。
 */
import type { AccountCredential } from '../mapper/accountMapper'

type GetCredential = (type: string) => Promise<AccountCredential | null>

let getter: GetCredential = async () => null

/** 入口注入：把账号本的按类型读取能力挂进来。 */
export function setCredentialGetter(fn: GetCredential): void {
  getter = fn
}

/** Agent / 工具内部按 type 取凭据（含明文），未配置返回 null。 */
export async function getCredentialByType(type: string): Promise<AccountCredential | null> {
  return getter(type)
}

// ── 通用 API Key（系统级，与 MCP 无关）：来自 session.start.voice.apiKey ──
// 所有工具调用都带上它（工具 schema 有对应字段时），不只 MCP 工具。
let globalApiKey = ''

/** 会话建连/重武装时由 session.start 注入当前语音服务的 API Key。 */
export function setGlobalApiKey(key: string): void {
  globalApiKey = (key ?? '').trim()
}

/** 工具调用层读取通用 API Key（可能为空）。 */
export function getGlobalApiKey(): string {
  return globalApiKey
}
