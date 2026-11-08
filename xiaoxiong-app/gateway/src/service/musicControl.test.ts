import { describe, it, expect } from 'vitest'
import { detectMusicCommand, parseLoopCount } from './musicControl'

describe('detectMusicCommand 音乐控制指令识别', () => {
  it('播放类：含「播放 / 的歌」等触发词', () => {
    expect(detectMusicCommand('播放刘德华的歌')).toBe('play')
    expect(detectMusicCommand('周杰伦的歌')).toBe('play')
    expect(detectMusicCommand('来一首轻音乐')).toBe('play')
  })

  it('「放 X 的歌」也能识别为播放（只说「放」不带「播」）', () => {
    // 用户反馈：说「放刘德华的歌」失灵，只有「播放刘德华的歌」能放。
    // 这里验证指令识别层能认出 play；解析层由 genreToKeyword 兜底去掉开头的「放」。
    expect(detectMusicCommand('放刘德华的歌')).toBe('play')
    expect(detectMusicCommand('放一首歌')).toBe('play')
  })

  it('「唱」作为播放动词与「放 / 播放」同义，识别为 play', () => {
    // 用户要求：唱也应识别为播放（如「唱刘德华的歌」「唱个歌」）。
    expect(detectMusicCommand('唱刘德华的歌')).toBe('play')
    expect(detectMusicCommand('唱个歌')).toBe('play')
    expect(detectMusicCommand('唱一首歌')).toBe('play')
    // 「唱歌」是让助手自己唱/闲聊，不是点歌，不应触发播放
    expect(detectMusicCommand('你唱歌真好听')).toBeNull()
  })

  it('「看 / 我想看」作为播放动词，识别为 play（电视/电影/动画/相声等都能播）', () => {
    // 用户反馈：说「看电视/看电影/我想看动画片」被当成“不能播放的影片”拒绝；
    // 这些其实能走 B 站音轨抽取播放，必须识别成 play。
    expect(detectMusicCommand('看电视')).toBe('play')
    expect(detectMusicCommand('看电影')).toBe('play')
    expect(detectMusicCommand('看西游记动画片')).toBe('play')
    expect(detectMusicCommand('我想看流浪地球电影')).toBe('play')
    expect(detectMusicCommand('我想看郭德纲相声')).toBe('play')
    expect(detectMusicCommand('看个相声')).toBe('play')
    expect(detectMusicCommand('看一集电视剧')).toBe('play')
    // 「看见 / 看着 / 看情况」不是看片请求，不触发播放
    expect(detectMusicCommand('我看见了一只猫')).toBeNull()
    expect(detectMusicCommand('你看着办吧')).toBeNull()
    expect(detectMusicCommand('看情况再说')).toBeNull()
  })

  it('暂停类优先于停止类：避免「暂停播放」被「停播」子串误判成停止', () => {
    // 用户反馈：说「暂停播放」结果被关掉了（误判 stop）。
    expect(detectMusicCommand('暂停播放')).toBe('pause')
    expect(detectMusicCommand('暂停音乐')).toBe('pause')
    expect(detectMusicCommand('先停一下')).toBe('pause')
  })

  it('明确停止类仍识别为 stop，且先于 play（「停止播放」含「播放」不能误触发 play）', () => {
    expect(detectMusicCommand('停止播放')).toBe('stop')
    expect(detectMusicCommand('关掉播放')).toBe('stop')
    expect(detectMusicCommand('关掉音乐')).toBe('stop')
    expect(detectMusicCommand('别放了')).toBe('stop')
  })

  it('继续 / 换一首 / 非音乐闲聊', () => {
    expect(detectMusicCommand('继续播放')).toBe('resume')
    expect(detectMusicCommand('换一首')).toBe('next')
    expect(detectMusicCommand('今天天气怎么样')).toBeNull()
  })

  it('推荐意图：含「推荐」等动词且有歌/音乐/曲/乐/音 关键字时才识别', () => {
    expect(detectMusicCommand('推荐几首歌')).toBe('recommend')
    expect(detectMusicCommand('推荐周杰伦的歌')).toBe('recommend')
    expect(detectMusicCommand('推荐一首舒缓的歌')).toBe('recommend')
    expect(detectMusicCommand('有什么好听的歌')).toBe('recommend')
    expect(detectMusicCommand('来点好听的音乐')).toBe('recommend')
    // 没有音乐关键字不算点歌，避免「推荐餐厅」误触发
    expect(detectMusicCommand('推荐一家餐厅')).toBeNull()
  })

  it('推荐意图：视频/电视/电视剧/剧/评书/有声/读物/小说/电台/广播 等关键字也算媒体，可触发推荐', () => {
    expect(detectMusicCommand('推荐个电视剧')).toBe('recommend')
    expect(detectMusicCommand('来点好听的评书')).toBe('recommend')
    expect(detectMusicCommand('推荐一部有声小说')).toBe('recommend')
    expect(detectMusicCommand('推荐个电台')).toBe('recommend')
    expect(detectMusicCommand('有什么好听的广播')).toBe('recommend')
    // 仍要带推荐动词 + 媒体关键字；纯闲聊（无关键字）不误触发
    expect(detectMusicCommand('推荐一家餐厅')).toBeNull()
  })

  it('循环播放类：识别为 loop（单曲循环 / 重复播放 / 再放 N 遍）', () => {
    expect(detectMusicCommand('循环播放')).toBe('loop')
    expect(detectMusicCommand('单曲循环')).toBe('loop')
    expect(detectMusicCommand('列表循环')).toBe('loop')
    expect(detectMusicCommand('重复播放')).toBe('loop')
    expect(detectMusicCommand('循环播放3遍')).toBe('loop')
    expect(detectMusicCommand('再放一遍')).toBe('loop')
    expect(detectMusicCommand('回放一遍')).toBe('loop')
  })

  it('「再放一遍」不会被「继续/再放(resume)」抢先识别成 resume', () => {
    // loop 模式含「遍」字，必须排在 resume 之前命中；否则会被 resume 的「再放」先截走
    expect(detectMusicCommand('再放一遍')).toBe('loop')
    // 但「再放」（不带遍）仍是继续播放
    expect(detectMusicCommand('再放')).toBe('resume')
  })

  it('parseLoopCount：解析「N 遍」遍数，缺省默认 2（再播一遍），超界收敛', () => {
    expect(parseLoopCount('循环播放3遍')).toBe(3)
    expect(parseLoopCount('循环播放2遍')).toBe(2)
    expect(parseLoopCount('循环播放')).toBe(2) // 没写遍数 → 默认再播一遍（共 2 遍）
    // 只认阿拉伯数字，「一遍」这类中文数词无数字则回落默认 2（= 再播一遍，共 2 遍）
    expect(parseLoopCount('再放一遍')).toBe(2)
    expect(parseLoopCount('循环播放999遍')).toBe(99) // 超上限收敛
    expect(parseLoopCount('放首歌')).toBe(1) // 非循环语境 → 1（不循环）
    expect(parseLoopCount('')).toBe(1)
  })
})
