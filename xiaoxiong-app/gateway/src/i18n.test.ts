import { describe, expect, it } from 'vitest'
import { messages } from './i18n'

/** 中文字符（含扩展区）：英文文案里出现就算漏了本地化。 */
const CJK = /[\u3400-\u9fff]/

/**
 * 英文目录 music 组逐项覆盖：以前靠 ...zhCN.music 展开，漏覆盖的项会在英文会话里
 * 冒出中文口播（「找到几首：第一首…」）。去掉展开后 TypeScript 保证项齐全，
 * 这里再保证每一项的值真的都是英文——新增文案时把新 key 加进 samples 即可。
 */
describe('英文文案目录（en）', () => {
  it('messages("en").music 每一项都是英文，不残留中文', () => {
    const m = messages('en').music
    const samples: Record<string, string> = {
      playing: m.playing('Song A'),
      switched: m.switched('Song A'),
      paused: m.paused(),
      resumed: m.resumed(),
      stopped: m.stopped(),
      notFound: m.notFound(),
      notImplemented: m.notImplemented('baidu'),
      candidates: m.candidates(['Song A', 'Song B']),
      chooseHint: m.chooseHint(),
      chooseAgain: m.chooseAgain(),
      recommend: m.recommend(['Song A', 'Song B']),
      recommendPrompt: m.recommendPrompt(),
      offerOtherType: m.offerOtherType(),
      switchedOther: m.switchedOther(),
      looping: m.looping(3),
      loopNothing: m.loopNothing(),
      volumeSet: m.volumeSet(50),
      volumeUp: m.volumeUp(60),
      volumeDown: m.volumeDown(40),
      volumeMax: m.volumeMax(),
      volumeMin: m.volumeMin(),
      subtitleOff: m.subtitleOff(),
      subtitleOn: m.subtitleOn(),
      subtitleNone: m.subtitleNone(),
      subtitleNoActive: m.subtitleNoActive(),
      musicNotPlaying: m.musicNotPlaying(),
      playModeFloat: m.playModeFloat(),
      playModePlayer: m.playModePlayer(),
      playModeToggled: m.playModeToggled(),
    }

    // key 对齐 = 每一项都被测到；新增 music 文案却没加进 samples 会在这里失败
    expect(Object.keys(samples).sort()).toEqual(Object.keys(m).sort())
    for (const [key, value] of Object.entries(samples)) {
      expect(value, key).not.toMatch(CJK)
    }
    // 分支文案也要本地化：评书/相声口径、循环 1 遍
    expect(m.notFound(true)).not.toMatch(CJK)
    expect(m.looping(1)).not.toMatch(CJK)
  })

  it('带地区码的英文（en-US / en_GB）同样逐项拿到英文', () => {
    for (const lang of ['en-US', 'en_GB']) {
      const m = messages(lang).music
      expect(m.candidates(['Song A']), lang).not.toMatch(CJK)
      expect(m.chooseHint(), lang).not.toMatch(CJK)
      expect(m.chooseAgain(), lang).not.toMatch(CJK)
      expect(m.volumeSet(30), lang).not.toMatch(CJK)
      expect(messages(lang).deals.chooseAgain(), lang).not.toMatch(CJK)
      expect(messages(lang).opensource.chooseAgain(), lang).not.toMatch(CJK)
    }
  })

  it('中文目录不受影响', () => {
    expect(messages('zh-CN').music.chooseAgain()).toMatch(CJK)
    expect(messages('zh-CN').music.candidates(['稻香'])).toMatch(CJK)
  })

  /**
   * music / deals / opensource 三组都已去掉 ...zhCN.xxx 展开，漏项由 tsc 拦截；
   * 这里做运行期复核：每一组的键值路径与中文目录完全对齐，且叶子文案不含中文。
   */
  function collect(group: object): Record<string, string> {
    const out: Record<string, string> = {}
    const argsFor = (path: string): unknown[] => {
      if (/candidates$|recommend$/.test(path)) return [['Item A', 'Item B']]
      if (/playing$|switched$/.test(path)) return ['Song A']
      if (/notImplemented$/.test(path)) return ['baidu']
      if (/detailIntro$/.test(path)) return [2]
      if (/looping$/.test(path)) return [3]
      if (/volume(Set|Up|Down)$/.test(path)) return [50]
      if (/notFound$/.test(path)) return [false]
      return []
    }
    const walk = (node: object, prefix: string): void => {
      for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'function') {
          out[path] = String((value as (...a: unknown[]) => unknown)(...argsFor(path)))
        } else if (value && typeof value === 'object') {
          walk(value, path)
        } else {
          out[path] = String(value)
        }
      }
    }
    walk(group, '')
    return out
  }

  it('music / deals / opensource 三组结构对齐且无中文残留', () => {
    const zh = messages('zh-CN')
    const en = messages('en')
    for (const group of ['music', 'deals', 'opensource'] as const) {
      const zhTexts = collect(zh[group])
      const enTexts = collect(en[group])
      expect(Object.keys(enTexts).sort(), group).toEqual(Object.keys(zhTexts).sort())
      for (const [key, text] of Object.entries(enTexts)) {
        expect(text, `${group}.${key}`).not.toMatch(CJK)
      }
    }
  })
})
