import { describe, it, expect } from 'vitest'
import {
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_VOICE,
  isDashscopeVoiceValid,
  resolveDashscopeVoice,
  listTtsVoices,
} from './ttsVoices'
import { DashScopeWsTts } from '../tts/dashscopeWs'

/**
 * 锁住「音色必须属于所选模型」这条官方约束，防止再出现「有回答却没播报」：
 * 旧 v1 音色（longxiang）或编造的 _v3 id 配 v3 模型，云端会回 418 Invalid voice，
 * 网关补静音 → 客户端无声。这里保证这类脏音色一律收敛到该模型的默认音色。
 */
describe('百炼 TTS 音色与模型同源（避免 418 Invalid voice 静音）', () => {
  it('默认音色属于 v3-flash 合法目录', () => {
    expect(DASHSCOPE_DEFAULT_VOICE).toBe('longyumi_v3')
    expect(isDashscopeVoiceValid(DASHSCOPE_DEFAULT_MODEL, DASHSCOPE_DEFAULT_VOICE)).toBe(true)
  })

  it('旧 v1 音色 longxiang 配 v3 模型 → 回退默认音色', () => {
    expect(isDashscopeVoiceValid('cosyvoice-v3-flash', 'longxiang')).toBe(false)
    expect(resolveDashscopeVoice('cosyvoice-v3-flash', 'longxiang')).toBe(DASHSCOPE_DEFAULT_VOICE)
  })

  it('编造 / 错标音色（longshao_v3、longyingbing、longanpei）→ 回退默认音色', () => {
    for (const v of ['longshao_v3', 'longyingbing', 'longanpei']) {
      expect(isDashscopeVoiceValid('cosyvoice-v3-flash', v)).toBe(false)
      expect(resolveDashscopeVoice('cosyvoice-v3-flash', v)).toBe(DASHSCOPE_DEFAULT_VOICE)
    }
  })

  it('合法 v3 音色保持原样（标杆 / 语音助手 / 方言 / 出海）', () => {
    for (const v of ['longanyang', 'longyumi_v3', 'longanyue_v3', 'loongabby_v3', 'longhuhu_v3']) {
      expect(resolveDashscopeVoice('cosyvoice-v3-flash', v)).toBe(v)
    }
  })

  it('v3-plus 与 v3-flash 共用同一套音色', () => {
    expect(resolveDashscopeVoice('cosyvoice-v3-plus', 'longxiang')).toBe(DASHSCOPE_DEFAULT_VOICE)
    expect(resolveDashscopeVoice('cosyvoice-v3-plus', 'longanyang')).toBe('longanyang')
  })

  it('未知模型不拦截，交云端判定（不误伤未来模型）', () => {
    expect(resolveDashscopeVoice('cosyvoice-v2', 'longwan_v2')).toBe('longwan_v2')
  })

  it('目录里每条音色都带 model 且能通过合法性校验（目录即唯一真相源）', async () => {
    const list = await listTtsVoices('dashscope')
    expect(list.defaultVoice).toBe(DASHSCOPE_DEFAULT_VOICE)
    expect(list.defaultModel).toBe(DASHSCOPE_DEFAULT_MODEL)
    expect(list.voices.length).toBeGreaterThan(10)
    for (const v of list.voices) {
      expect(v.model).toBe(DASHSCOPE_DEFAULT_MODEL)
      expect(isDashscopeVoiceValid(v.model, v.value)).toBe(true)
    }
  })

  it('DashScopeWsTts 实例把陈旧音色收敛为默认音色（真正进 run-task 的值）', () => {
    // 复现线上脏配置：voice=longxiang（v1 音色）、没带 model。
    const tts = new DashScopeWsTts(
      'https://dashscope.aliyuncs.com',
      { voice: 'longxiang' },
      'dummy-key',
    )
    // private 字段只做只读断言，验证收敛确实作用到了实例，而非只停在纯函数层。
    const internal = tts as unknown as { model: string; voice: string }
    expect(internal.model).toBe(DASHSCOPE_DEFAULT_MODEL)
    expect(internal.voice).toBe(DASHSCOPE_DEFAULT_VOICE)
  })
})
