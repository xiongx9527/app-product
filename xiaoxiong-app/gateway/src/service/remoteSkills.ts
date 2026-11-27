/**
 * 远端 Skill 加载（2026-11-27）：19529 提供渐进披露接口，App 设置页的「Skill 设置」控制是否加载。
 *   GET /skills        → { skills: [{name, description}] }（仅启用项，摘要）
 *   GET /skills/{name} → { name, description, content(markdown) }
 *
 * 规则不在 App/网关硬编码：skill 正文由 19529 维护，网关拉取后注入 systemPrompt，
 * 让 LLM 知道「遇到统计/报表等问数场景要调工具」等指引。
 *
 * 失败降级：任一环节失败只记日志、返回空列表，绝不影响助手其余能力；按 retryCount 重试。
 */
import { bargeDiag } from '../diagLog'

export interface RemoteSkill {
  name: string
  description: string
  content: string
}

interface FetchResult {
  skills: RemoteSkill[]
  error?: string
}

/** 单次请求（带超时），Ok 返回 JSON 对象，失败抛错。 */
async function getJson(url: string, apiKey?: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 拉取 19529 的 skill 清单 + 正文。retryCount=0 不重试；失败退避 500ms×2^n（上限 5s）。
 */
export async function fetchRemoteSkills(
  baseUrl: string,
  apiKey: string | undefined,
  retryCount = 2,
): Promise<FetchResult> {
  const root = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!root) return { skills: [], error: '未配置服务地址' }
  const retries = Number.isInteger(retryCount) && retryCount >= 0 && retryCount <= 10 ? retryCount : 2

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const list = await getJson(`${root}/skills`, apiKey) as { skills?: Array<{ name?: string; description?: string }> }
      const items = (list?.skills ?? []).filter(
        (s): s is { name: string; description: string } => typeof s?.name === 'string' && !!s.name
      )
      const skills: RemoteSkill[] = []
      for (const s of items) {
        try {
          const detail = await getJson(`${root}/skills/${encodeURIComponent(s.name)}`, apiKey) as {
            name?: string; description?: string; content?: string
          }
          skills.push({
            name: detail?.name ?? s.name,
            description: (detail?.description ?? s.description ?? '').trim(),
            content: (detail?.content ?? '').trim(),
          })
        } catch (e) {
          bargeDiag(`SKILL-DETAIL-FAIL name=${s.name} err=${(e as Error).message}`)
        }
      }
      bargeDiag(`SKILL-FETCH ok n=${skills.length} attempt=${attempt}`)
      return { skills }
    } catch (e) {
      const err = (e as Error).message
      if (attempt < retries) {
        const backoff = Math.min(500 * 2 ** attempt, 5000)
        bargeDiag(`SKILL-RETRY attempt=${attempt + 1}/${retries} backoff=${backoff}ms err=${err}`)
        await new Promise((r) => setTimeout(r, backoff))
      } else {
        bargeDiag(`SKILL-FETCH fail attempts=${attempt + 1} err=${err}`)
        return { skills: [], error: err }
      }
    }
  }
  return { skills: [], error: 'unreachable' }
}

/**
 * 把 skill 拼成 systemPrompt 追加片段：清单（name+description）常驻 + 各 skill 正文。
 * 用明确的分隔与「以下是操作指引」前缀，避免 LLM 把 skill 正文当用户指令。
 */
export function skillsToPromptAddon(skills: RemoteSkill[]): string {
  if (!skills.length) return ''
  const blocks = skills.map((s) =>
    `### Skill: ${s.name}\n${s.description ? `${s.description}\n` : ''}${s.content}`.trim()
  )
  return [
    '【可用技能指引·来自服务端动态配置】下面是本助手可用的技能操作指引，遇到对应场景时严格按指引调用工具，不要凭记忆或历史直接回答。',
    ...blocks,
  ].join('\n')
}
