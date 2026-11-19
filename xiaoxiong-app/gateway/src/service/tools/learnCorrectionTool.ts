/**
 * ASR 同音错词学习工具：LLM 在对话中发现用户说的词被识别成同音错字时，
 * 调用本工具把「错词→正确词」记进本地词表（立即生效，不上传 9529）。
 *
 * 典型场景：用户说"背若神父"，ASR 识别成"若神父"，LLM 结合上下文知道是"洛神赋"，
 * 于是调用 learn_correction(wrong="若神父", correct="洛神赋")。下次再识别成"若神父"就直接纠正。
 *
 * 只依赖通用的 AutoLearnEngine：把 (wrong, correct) 交给引擎的规则链判断，不关心
 * 里面怎么存、怎么算拼音——agent 层对学习引擎的内部实现无知。
 */
import { z } from 'zod'
import type { Lang } from '../../protocol'
import type { AutoLearnEngine } from '../autoLearn'

const DESC: Record<string, string> = {
  zh: '学习一条语音识别的同音错词纠正。当你发现用户的话里有明显的同音识别错误（如"若神父"其实是"洛神赋"、"李存旭"想说"李存勖"、"滕王格式"想说"滕王阁序"），调用本工具记下来：wrong 填识别出的错词，correct 填你认为的正确词。只有你确实能根据上下文推断出正确词时才调用，否则如实按原文处理，不要猜测编造。',
  en: 'Learn a homophone ASR correction. When the user\'s words contain an obvious speech-recognition homophone typo (e.g. "ruo shen fu" means "Luo Shen Fu"), call this tool: wrong = the recognized typo, correct = the intended word you inferred. Only call when you are confident about the correct word from context; otherwise treat the text as-is and never guess.',
}

export function createLearnCorrectionTool(lang: Lang | string, engine: AutoLearnEngine) {
  const p = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  return {
    name: 'learn_correction',
    description: DESC[p] ?? DESC.zh,
    inputSchema: z.object({
      wrong: z.string().min(1).describe('识别出的错词，如 若神父'),
      correct: z.string().min(1).describe('正确的词，如 洛神赋'),
    }),
    async call(args: { wrong?: string; correct?: string }) {
      const wrong = (args?.wrong ?? '').trim()
      const correct = (args?.correct ?? '').trim()
      if (!wrong || !correct) {
        return p === 'en' ? 'Need both wrong and correct words.' : '错词和正确词都要有。'
      }
      if (wrong === correct) {
        return p === 'en' ? 'No typo to learn.' : '没有需要纠正的错字。'
      }
      const ok = await engine.learn(wrong, correct, { source: 'tool' })
      return ok
        ? (p === 'en' ? `Learned: ${wrong} → ${correct}.` : `记住了：${wrong} → ${correct}。`)
        : (p === 'en' ? 'Could not save the correction.' : '没记成功，稍后再试。')
    },
  }
}
