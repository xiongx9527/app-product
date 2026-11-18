/**
 * 「查询诗词 / 古文」工具（edu）：LLM 在用户点名诗词/古文时调用。
 * 数据源负责取真实原文 + 百度朗读音频（见 ../edu/），
 * 工具层负责下发媒体播放 + 字幕，并给 LLM 一句简短回复（不让它背全文）。
 */
import { z } from 'zod'
import type { Lang } from '../../protocol'
import type { MediaDirective } from './musicTool'
import { queryPoem, type EduFetcher } from '../edu'

/** 工具名固定，作为 LLM function-call 标识，不本地化。 */
export const POEM_TOOL_NAME = 'query_poem'

export interface PoemToolOptions {
  fetcher?: EduFetcher
  emit?: (m: MediaDirective) => void
}

const DESCRIPTIONS: Record<string, string> = {
  zh: '查询诗词、古文、文言文名篇的原文与朗读。用户点名某首诗词/古文（如「滕王阁序」「岳阳楼记」「静夜思」「将进酒」）或说「背一下/朗读/念一下 XX」时调用，query 传作品名（可带作者，如「王勃的滕王阁序」）。返回真实原文并以百度朗读音频播放，不要自己背诵或编造诗词内容。',
  en: 'Look up Chinese poems and classical prose with original text and audio. Call when the user names a poem/essay (e.g. "Tengwang Ge Xu", "Memorial to Yueyang Tower") or says "recite / read X" — pass the title as query. Returns the real text with audio; never recite or invent from memory.',
}

export function createPoemTool(lang: Lang | string, options: PoemToolOptions = {}) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const fetcher = options.fetcher
  const emit = options.emit

  return {
    name: POEM_TOOL_NAME,
    description: DESCRIPTIONS[prefix] ?? DESCRIPTIONS.zh,
    inputSchema: z.object({
      query: z.string().min(1).describe('诗词/古文作品名，可带作者，如「王勃的滕王阁序」「岳阳楼记」'),
    }),
    async call(args: { query?: string }) {
      const raw = (args?.query ?? '').trim()
      if (!raw) return prefix === 'en' ? 'Please tell me which poem.' : '请告诉我想查哪首诗词。'
      const entry = await queryPoem(raw, fetcher)
      if (!entry) {
        return prefix === 'en'
          ? `Sorry, I couldn't find "${raw}".`
          : `暂时没查到「${raw}」的原文。`
      }
      // 字幕：逐句分行（原文与音频同源），带近似 time
      const lines = entry.lines.map((text, i) => ({ time: i * 3.2, text }))
      emit?.({ type: 'media.subtitle', title: entry.title, lines })
      // 音频：百度朗读 mp3 直链（source:tts），无音频则只显示字幕
      if (entry.audioUrl) {
        emit?.({ type: 'media.play', url: entry.audioUrl, title: entry.title, source: 'tts' })
      }
      // 给 LLM 的回复只是简短引导，不是原文（原文已进字幕、音频已播放）
      return prefix === 'en'
        ? `Found "${entry.title}" by ${entry.author}; playing it now.`
        : `找到${entry.author ? entry.author + '的' : ''}《${entry.title}》，正在为你朗读。`
    },
  }
}
