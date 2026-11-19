import { describe, it, expect, vi } from 'vitest'
import { baikeAudioSign, fetchBaikeAudioUrl, splitSummaryToLines } from '../../../../src/service/baike/baidu/baikeTts'

describe('baikeAudioSign', () => {
  // 逆向自百度百科 H5 的真实请求，多组样本交叉验证，防止盐/拼接顺序被无意改坏
  const cases = [
    ['刘备', '4100', '1794919523', 'b9708150-0bf6-423b-8714-6ae244024d52', '8c696c944731230cbccfee5c16670c8e'],
    ['刘备', '4100', '1794919943', '213f791d-d909-49cd-a74b-70a65b705bb6', '17d14f8fdae6929a16fb0f6c2e01a968'],
    ['人工智能', '4100', '1794920228', '5e7a083b-e3d9-4697-9eeb-fd16ee97b96f', '7376eae58e9ff41ac974216e5c06c5eb'],
  ] as const
  for (const [text, per, time, once, sign] of cases) {
    it(`文本「${text}」sign 与百度百科真实请求一致`, () => {
      expect(baikeAudioSign(text, per, time, once)).toBe(sign)
    })
  }
})

describe('fetchBaikeAudioUrl', () => {
  it('构造正确的 getaudio 请求并取回 mp3 直链', async () => {
    let calledUrl = ''
    const mock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      calledUrl = String(input)
      return new Response(JSON.stringify({ errno: 0, data: 'https://tts.baidu.com/text2audio?tex=x' }), {
        status: 200,
      })
    })
    const url = await fetchBaikeAudioUrl('刘备', mock as unknown as typeof fetch)
    expect(url).toBe('https://tts.baidu.com/text2audio?tex=x')
    expect(calledUrl).toContain('https://baike.baidu.com/lemma/api/getaudio?')
    expect(calledUrl).toContain('text=%E5%88%98%E5%A4%87')
    expect(calledUrl).toContain('vol=9')
    expect(calledUrl).toContain('per=4100')
    expect(calledUrl).toContain('sign=')
  })

  it('上游 errno≠0：抛错，让上层降级', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ errno: 10001 }), { status: 200 }))
    await expect(fetchBaikeAudioUrl('刘备', mock as unknown as typeof fetch)).rejects.toThrow('errno')
  })

  it('空文本：直接抛错不发请求', async () => {
    const mock = vi.fn()
    await expect(fetchBaikeAudioUrl('', mock as unknown as typeof fetch)).rejects.toThrow('empty text')
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('splitSummaryToLines：百科摘要转歌词格式', () => {
  it('按中文句末标点切行，每行 time 递增，拼回去是原文', () => {
    const summary = '刘备是三国时期蜀汉开国皇帝。他早年颠沛流离，后来建立蜀汉政权！晚年伐吴失利？'
    const lines = splitSummaryToLines(summary)
    // 最后一句较短并入前句，故切成 2 行
    expect(lines.length).toBe(2)
    expect(lines.map((l) => l.text).join('')).toBe(summary)
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].time).toBeGreaterThan(lines[i - 1].time)
    }
  })

  it('短句并入前一句，避免切得太碎', () => {
    const lines = splitSummaryToLines('这是一段足够长的完整句子描述人物生平事迹。嗯。好。')
    // 「嗯。」「好。」太短，应并入前一句
    expect(lines.length).toBe(1)
    expect(lines[0].text).toContain('好。')
  })

  it('空摘要返回空数组', () => {
    expect(splitSummaryToLines('')).toEqual([])
  })
})
