import { describe, it, expect } from 'vitest'
import { detectMusicCommand } from './musicControl'

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
})
