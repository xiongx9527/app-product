/**
 * 百科查询 skill：识别「百科/事迹/讲讲 XX」→ 抓真实百科词条，音频走百度百科自己的 TTS 直链，
 * 文字进同源字幕、助手框一句确认。业务全在本目录（detect/i18n/run/源）。
 *
 * 网关编排层只按 priority 把话递给 onDirectCommand，不含百科业务。
 * 源可替换：query / audioUrl 由构造注入（换源/测试桩不改本 skill 代码）。
 * 跨域能力（音频落盘/时长/字幕/纠错学习/重播记忆）经 SkillContext 注入，不在这里实现。
 */
import { detectBaikeCommand } from './detect'
import { pickBaikeI18n } from './i18n'
import { queryBaike, type BaikeQueryResult } from './baike'
import { fetchBaikeAudioUrl, splitSummaryToLines } from './baike/baidu/baikeTts'
import type { Skill, SkillContext, SkillModule } from '../types'

export type BaikeQuery = (keyword: string) => Promise<BaikeQueryResult>
export type BaikeAudioUrl = (text: string) => Promise<string>

interface BaikeDeps {
  query?: BaikeQuery
  audioUrl?: BaikeAudioUrl
}

function makeBaikeSkill(ctx: SkillContext, deps: BaikeDeps): Skill {
  const i = pickBaikeI18n(ctx.lang)
  const query: BaikeQuery =
    deps.query ?? ((kw) => queryBaike(kw, ctx.lang))
  const audioUrl: BaikeAudioUrl = deps.audioUrl ?? ((text) => fetchBaikeAudioUrl(text))

  return {
    matchesIntent(text) {
      return detectBaikeCommand(text) !== null
    },
    async onDirectCommand(text) {
      const cmd = detectBaikeCommand(text)
      if (!cmd) return undefined
      let keyword = cmd.keyword
      if (!keyword) {
        // 没说查谁：结合长期记忆偏好查一个词条（如记得「李白」就查李白），查不到再引导反问。
        const prefs = ctx.getPreferenceKeywords ? await ctx.getPreferenceKeywords() : []
        for (const pref of prefs) {
          if (pref.length < 2) continue
          try {
            const r = await query(pref)
            if (r.entry) { keyword = pref; break }
          } catch { /* 换下一个偏好词 */ }
        }
        if (!keyword) {
          await ctx.speak(i.prompt())
          return { consumed: true }
        }
      }
      let result: BaikeQueryResult
      try {
        result = await query(keyword)
      } catch {
        await ctx.speak(i.unavailable())
        return { consumed: true }
      }
      if (!result.entry) {
        // 没查到词条：只有兜底文案、没有可播报内容，照常文字口播
        await ctx.speak(result.text)
        return { consumed: true }
      }
      const entry = result.entry
      const title = entry.title || keyword
      // 数据源已做同音纠错（李存旭→李存勖）：同音错字对学进词表
      ctx.autoLearn?.(keyword, title)
      // 真正被播报的正文（与音频同源）；字幕必须用它，不能用完整 summary（否则字幕比语音快近一倍）。
      const spoken = result.spoken ?? entry.summary ?? ''

      // 百科音频必须用百度百科自己的语音（用户明确不要网关文字转语音）：getaudio 拿 mp3 直链。
      try {
        const url = await audioUrl(result.text)
        // 第三方 mp3 直链直拉不稳——先落盘成本地短链，失败回退原 url。
        const mediaPath = ctx.mediaTools ? await ctx.mediaTools.cacheAudio(url) : null
        // 字幕按真实音频时长铺（网关按字数估算 4.5 字/秒远慢于百度 TTS 实际 6.5 字/秒）。
        const durationSec = mediaPath ? ctx.mediaTools!.audioDuration(mediaPath) : 0
        const lines = splitSummaryToLines(spoken, durationSec || undefined)
        // 确认句走 speak：既显示也 TTS 播报；不 await 避免阻塞 media.play；全文不进助手框、只在字幕逐句展示。
        void ctx.speak(i.playing(title))
        // 先 media.play（客户端据此切到本条内容并清掉上一条字幕），再 media.subtitle（本条字幕）。
        // 顺序反了会导致客户端在 play 时把刚发的本条字幕清掉、或旧字幕串台。
        const audioPath = mediaPath ? mediaPath.replace(/^\//, '') : undefined
        ctx.send({
          type: 'media.play',
          url,
          title,
          source: 'tts',
          ...(audioPath ? { audioPath } : {}),
          ...(entry.image ? { cover: entry.image } : {}),
        })
        ctx.send({ type: 'media.subtitle', title, lines })
        ctx.rememberTtsMedia?.({
          url, title,
          ...(audioPath ? { audioPath } : {}),
          ...(entry.image ? { cover: entry.image } : {}),
          lines,
        })
      } catch {
        // getaudio 是百度非公开接口，失败就不播——不用网关文字转语音兜底（用户明确不要自己合成）。
        // 只补 llm.done 收尾思考态，避免卡在「思考中」。
        ctx.send({ type: 'llm.done' })
      }
      return { consumed: true }
    },
  }
}

/** 工厂：默认用内置百科源；换源/测试桩传 query/audioUrl 即可，detect/run/i18n 不变。 */
export function createBaikeSkill(deps: BaikeDeps = {}): SkillModule {
  return {
    id: 'baike',
    name: '百科查询',
    priority: 33, // 原顺序：择吉日(10)/时间(20)/天气(30)/百科(33)之后、诗词(35)/音乐(40)之前
    description: () => '',
    create: (ctx) => makeBaikeSkill(ctx, deps),
  }
}

export const baikeSkill: SkillModule = createBaikeSkill()
