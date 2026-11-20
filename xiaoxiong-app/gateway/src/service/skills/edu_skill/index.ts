/**
 * 诗词/古文朗读 skill：识别「背诵/朗诵/念/读 XX」→ 走 edu 数据源取原文+朗读音频，
 * 文字进字幕、音频走 media.play，助手框一句确认。业务全在本目录（detect/i18n/run/源）。
 *
 * 网关编排层只按 priority 把话递给 onDirectCommand，不含诗词业务。
 * 源可替换：queryPoem 由构造注入（换源/测试桩不改本 skill 代码）。
 * 跨域能力（音频落盘/时长/字幕/纠错学习/重播记忆）经 SkillContext 注入，不在这里实现。
 */
import { detectPoemCommand } from './detect'
import { pickPoemI18n } from './i18n'
import { queryPoem, type EduFetcher, type PoemEntry } from './edu/baidu/poemSource'
import type { Skill, SkillContext, SkillModule } from '../types'

export type PoemQuery = (title: string) => Promise<PoemEntry | null>

function makePoemSkill(ctx: SkillContext, query: PoemQuery): Skill {
  return {
    matchesIntent(text) {
      return detectPoemCommand(text) !== null
    },
    async onDirectCommand(text) {
      const cmd = detectPoemCommand(text)
      if (!cmd) return undefined
      const i = pickPoemI18n(ctx.lang)
      let title = cmd.title
      if (!title) {
        // 没说诗名：结合长期记忆偏好搜一首（如记得「李白」就找李白的诗），搜不到再引导反问。
        const prefs = ctx.getPreferenceKeywords ? await ctx.getPreferenceKeywords() : []
        for (const pref of prefs) {
          if (pref.length < 2) continue
          let found: PoemEntry | null = null
          try { found = await query(pref) } catch { found = null }
          if (found) { title = pref; break }
        }
        if (!title) {
          await ctx.speak(i.prompt())
          return { consumed: true }
        }
      }
      let entry: PoemEntry | null = null
      try {
        entry = await query(title)
      } catch {
        entry = null
      }
      if (!entry) {
        // 查不到就明说，且消费掉——否则「背诵回乡偶书」会被后面的好价分支抢走、答非所问，
        // 也不让 LLM 自己背全文（用户明确长文本不经过 LLM/TTS）。
        await ctx.speak(i.notFound(title))
        return { consumed: true }
      }
      // edu 数据源把识别词纠成规范标题（滕王格世→滕王阁序）：同音错字对学进词表。
      ctx.autoLearn?.(title, entry.title)

      // 先落盘音频拿真实时长，再按字数比例铺字幕 time（固定 3.2s/行会走太快/太慢）。
      let durationSec = 0
      let mediaPath: string | null = null
      if (entry.audioUrl && ctx.mediaTools) {
        mediaPath = await ctx.mediaTools.cacheAudio(entry.audioUrl)
        if (mediaPath) durationSec = ctx.mediaTools.audioDuration(mediaPath)
      }
      const weights = entry.lines.map((t) => t.replace(/[，。！？、\s]/g, '').length)
      const totalWeight = weights.reduce((a, b) => a + b, 0)
      let acc = 0
      const lines = entry.lines.map((text, idx) => {
        const line = { time: Math.round(acc * 10) / 10, text }
        acc += durationSec && totalWeight > 0 ? durationSec * weights[idx] / totalWeight : 3.2
        return line
      })
      // 先 media.play（客户端清掉上一条字幕、切到本条），再 media.subtitle（本条字幕）——
      // 顺序反了会被客户端在 play 时的清字幕动作误清，或让旧字幕串台。
      if (entry.audioUrl) {
        const audioPath = mediaPath ? mediaPath.replace(/^\//, '') : undefined
        ctx.send({
          type: 'media.play',
          url: entry.audioUrl,
          title: entry.title,
          source: 'tts',
          ...(audioPath ? { audioPath } : {}),
        })
        ctx.rememberTtsMedia?.({ url: entry.audioUrl, title: entry.title, ...(audioPath ? { audioPath } : {}), lines })
      }
      ctx.send({ type: 'media.subtitle', title: entry.title, lines })
      await ctx.speak(i.playing(entry.author, entry.title))
      return { consumed: true }
    },
  }
}

/** 工厂：默认用内置 edu 源；换源/测试桩传 query 即可，detect/run/i18n 不变。 */
export function createPoemSkill(query?: PoemQuery): SkillModule {
  return {
    id: 'poem',
    name: '诗词朗读',
    priority: 35, // 原顺序：百科之后、音乐之前（music 的 play 正则含裸「读/念」需靠它兜底）
    description: () => '',
    create: (ctx) => makePoemSkill(ctx, query ?? ((t) => queryPoem(t))),
  }
}

export const poemSkill: SkillModule = createPoemSkill()

// 供需要直接换源的装配方 / LLM 工具使用
export { queryPoem } from './edu/baidu/poemSource'
export type { EduFetcher, PoemEntry }
