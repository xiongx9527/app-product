import { describe, it, expect } from 'vitest'
import {
  searchCandidates,
  needsCandidateList,
  candidateQuery,
  parseSelection,
  looksLikeBareMusicQuery,
  filterByCurrentArtist,
  artistMatches,
  isArtistBrowse,
  type MusicCandidate,
} from './musicCandidates'

const candidates: MusicCandidate[] = [
  { title: '稻香', artist: '周杰伦' },
  { title: '晴天', artist: '周杰伦' },
  { title: '七里香', artist: '周杰伦' },
]

describe('needsCandidateList / candidateQuery', () => {
  it('只给歌手 / 只给歌名 / 「X 的歌」→ 需要列表', () => {
    expect(needsCandidateList('周杰伦')).toBe(true)
    expect(needsCandidateList('稻香')).toBe(true)
    expect(needsCandidateList('周杰伦 歌')).toBe(true) // 「周杰伦的歌」清洗后
    expect(needsCandidateList('陈奕迅 歌曲')).toBe(true)
  })

  it('歌手+歌名齐全 → 不需要列表，直接播', () => {
    expect(needsCandidateList('周杰伦 稻香')).toBe(false)
    expect(needsCandidateList('陈奕迅 十年')).toBe(false)
  })

  it('空 / 纯通用词 → 不触发列表（泛化已回落电台）', () => {
    expect(needsCandidateList('')).toBe(false)
    expect(needsCandidateList('歌')).toBe(false)
    expect(needsCandidateList('轻音乐')).toBe(true) // 风格词由 isGenreRequest 分流，不进这里
  })

  it('检索核心词剔除通用音乐词', () => {
    expect(candidateQuery('周杰伦 歌')).toBe('周杰伦')
    expect(candidateQuery('周杰伦')).toBe('周杰伦')
    expect(candidateQuery('周杰伦 稻香')).toBe('周杰伦 稻香')
  })
})

describe('parseSelection（语音选第几首 / 说歌名）', () => {
  it('中文序号「第一首 / 第二首 / 第三个」', () => {
    expect(parseSelection('第一首', candidates)).toBe(0)
    expect(parseSelection('第二首', candidates)).toBe(1)
    expect(parseSelection('就第三个吧', candidates)).toBe(2)
    expect(parseSelection('播放第2首', candidates)).toBe(1)
  })

  it('阿拉伯数字 / 裸数字 / 裸中文数字', () => {
    expect(parseSelection('3', candidates)).toBe(2)
    expect(parseSelection('二', candidates)).toBe(1)
    expect(parseSelection('两', candidates)).toBe(1)
    expect(parseSelection('2首', candidates)).toBe(1)
  })

  it('直接说歌名', () => {
    expect(parseSelection('就听晴天吧', candidates)).toBe(1)
    expect(parseSelection('来一首稻香', candidates)).toBe(0)
  })

  it('越界序号 / 无选择 → null', () => {
    expect(parseSelection('第五首', candidates)).toBeNull()
    expect(parseSelection('9', candidates)).toBeNull()
    expect(parseSelection('今天天气怎么样', candidates)).toBeNull()
    expect(parseSelection('', candidates)).toBeNull()
  })

  it('「再来一首 / 换一首」不被误判成选第 1 首', () => {
    expect(parseSelection('再来一首', candidates)).toBeNull()
    expect(parseSelection('换一首', candidates)).toBeNull()
    expect(parseSelection('随便来一首', candidates)).toBeNull()
  })

  it('空候选列表 → null', () => {
    expect(parseSelection('第二首', [])).toBeNull()
  })
})

describe('artistMatches / filterByCurrentArtist（点歌按当前歌手优先）', () => {
  it('简繁等价：周杰伦(简) 与 周杰倫(繁) 视为同一人', () => {
    expect(artistMatches('周杰伦', '周杰倫')).toBe(true)
    expect(artistMatches('周杰倫', '周杰伦')).toBe(true)
  })

  it('不同歌手不匹配', () => {
    expect(artistMatches('周杰伦', '陈淑桦')).toBe(false)
  })

  it('没有当前歌手 / 单候选 → 原样返回', () => {
    const items: MusicCandidate[] = [
      { title: '七里香', artist: '陈淑桦' },
      { title: '七里香', artist: '周杰伦' },
      { title: '七里香', artist: '周杰伦' },
    ]
    expect(filterByCurrentArtist(items, undefined)).toEqual(items)
    expect(filterByCurrentArtist(items.slice(0, 1), '周杰伦')).toEqual(items.slice(0, 1))
  })

  it('多候选里有当前歌手 → 只留同歌手版本', () => {
    const items: MusicCandidate[] = [
      { title: '七里香', artist: '陈淑桦' },
      { title: '七里香', artist: '周杰伦' },
      { title: '七里香', artist: '周杰伦' },
    ]
    // 当前在听周杰伦（繁体也行），应过滤掉陈淑桦
    expect(filterByCurrentArtist(items, '周杰倫')).toEqual([
      { title: '七里香', artist: '周杰伦' },
      { title: '七里香', artist: '周杰伦' },
    ])
  })

  it('没有任何候选与当前歌手一致 → 原样返回（照旧让用户选）', () => {
    const items: MusicCandidate[] = [
      { title: '七里香', artist: '陈淑桦' },
      { title: '七里香', artist: '邓丽君' },
    ]
    expect(filterByCurrentArtist(items, '周杰伦')).toEqual(items)
  })
})

describe('searchCandidates（MusicBrainz，桩）', () => {
  it('解析歌名+歌手，过滤空标题', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({
        recordings: [
          { title: '稻香', 'artist-credit': [{ name: '周杰伦' }] },
          { title: '晴天', 'artist-credit': [{ name: 'Jay Chou' }] },
          { title: '', 'artist-credit': [] },
        ],
      }),
    })
    expect(await searchCandidates('周杰伦', fetcher)).toEqual([
      { title: '稻香', artist: '周杰伦' },
      { title: '晴天', artist: 'Jay Chou' },
    ])
  })

  it('候选上限 3（语音口播太长记不住，且靠后结果越不准）', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({
        recordings: Array.from({ length: 8 }, (_, i) => ({
          title: `歌${i + 1}`,
          'artist-credit': [{ name: '周杰伦' }],
        })),
      }),
    })
    const got = await searchCandidates('周杰伦', fetcher)
    expect(got).toHaveLength(3)
  })

  it('服务异常 / 非 2xx / 空结果 → 空数组', async () => {
    expect(await searchCandidates('x', async () => { throw new Error('offline') })).toEqual([])
    expect(await searchCandidates('x', async () => ({ ok: false, json: async () => ({}) }))).toEqual([])
    expect(await searchCandidates('x', async () => ({ ok: true, json: async () => ({}) }))).toEqual([])
    expect(await searchCandidates('', async () => ({ ok: true, json: async () => ({}) }))).toEqual([])
  })
})

describe('looksLikeBareMusicQuery（裸歌手/歌名判定）', () => {
  it('像裸歌手 / 歌名 → true', () => {
    expect(looksLikeBareMusicQuery('周杰伦')).toBe(true)
    expect(looksLikeBareMusicQuery('稻香')).toBe(true)
    expect(looksLikeBareMusicQuery('Jay Chou')).toBe(true)
  })

  it('招呼 / 闲聊 / 疑问 / 指令 → false（交回 LLM）', () => {
    expect(looksLikeBareMusicQuery('你好')).toBe(false)
    expect(looksLikeBareMusicQuery('在吗')).toBe(false)
    expect(looksLikeBareMusicQuery('今天天气怎么样')).toBe(false)
    expect(looksLikeBareMusicQuery('打开灯')).toBe(false)
  })

  it('太长 / 太短 → false', () => {
    expect(looksLikeBareMusicQuery('a')).toBe(false)
    expect(looksLikeBareMusicQuery('周杰伦的非常好听的歌')).toBe(false)
  })
})

describe('isArtistBrowse（按歌手浏览应列清单，不自动播放）', () => {
  it('「歌手 + 的歌 / 歌曲 / 作品 / 音乐」→ 浏览', () => {
    expect(isArtistBrowse('周杰伦的歌')).toBe(true)
    expect(isArtistBrowse('播放周杰伦的歌')).toBe(true)
    expect(isArtistBrowse('刘德华歌曲')).toBe(true)
    expect(isArtistBrowse('邓丽君的作品')).toBe(true)
    expect(isArtistBrowse('周杰伦的音乐')).toBe(true)
    expect(isArtistBrowse('周杰伦唱的歌')).toBe(true)
    expect(isArtistBrowse('来点周杰伦的歌')).toBe(true)
  })

  it('具体歌名（应靠当前歌手上下文自动选，不强制列表）→ false', () => {
    expect(isArtistBrowse('放一首稻香')).toBe(false)
    expect(isArtistBrowse('稻香')).toBe(false)
    expect(isArtistBrowse('周杰伦 稻香')).toBe(false)
  })

  it('裸歌手（无泛歌曲词）→ false（走常规候选列表分支即可）', () => {
    expect(isArtistBrowse('周杰伦')).toBe(false)
  })

  it('空 / 泛化 → false', () => {
    expect(isArtistBrowse('歌')).toBe(false)
    expect(isArtistBrowse('')).toBe(false)
  })
})
