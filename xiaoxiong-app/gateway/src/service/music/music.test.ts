import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import { createBilibiliSearchSource, titleMatchesKeyword, looksLikeCompilation } from './bilibiliSearchSource'
import { extractBvidsFromHtml } from './bilibiliAudio'
import { createMusicSource } from './index'
import { SOMA_CHANNELS } from '../tools/musicChannels'
import type { MusicFetcher } from './types'
import { isGenreRequest, genreToKeyword } from './types'

describe('music sources', () => {
  it('soma：无风格时用默认频道', async () => {
    const source = createSomaSource({})
    const track = await source.resolve()
    expect(track.url).toContain(track.channel)
  })

  it('soma：按风格选台（爵士 → sonicuniverse）', async () => {
    const source = createSomaSource({})
    const track = await source.resolve('放点爵士')
    expect(track.channel).toBe('sonicuniverse')
  })

  it('soma：频道表 id 唯一且都指向 ice6 直链', async () => {
    const ids = SOMA_CHANNELS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const channel of SOMA_CHANNELS) {
      expect(channel.url).toBe(`https://ice6.somafm.com/${channel.id}-128-mp3`)
    }
  })

  it('soma：next 切换到一个不同的频道', async () => {
    const source = createSomaSource({ station: 'groovesalad' })
    const first = await source.resolve()
    const second = await source.next!()
    expect(second.channel).not.toBe(first.channel)
    expect(second.url).toContain(second.channel)
  })
})

describe('genre 分流', () => {
  it('isGenreRequest：风格词命中，具体歌名不命中', () => {
    expect(isGenreRequest('放点轻音乐')).toBe(true)
    expect(isGenreRequest('来首爵士')).toBe(true)
    expect(isGenreRequest('周杰伦 稻香')).toBe(false)
    expect(isGenreRequest(undefined)).toBe(true)
  })

  it('genreToKeyword：风格词映射，歌名剔指令词', () => {
    expect(genreToKeyword('放点电子')).toBe('电子')
    expect(genreToKeyword('我想听周杰伦的稻香')).toBe('周杰伦 稻香')
    expect(genreToKeyword('播放个周杰伦的稻香')).toBe('周杰伦 稻香')
    // 只说「放」不带「播」：开头播放动词也要剔掉，否则残留「放」让候选/检索词变「放刘德华」
    // （用户反馈「放刘德华的歌」放不出，只有「播放刘德华的歌」能放）。
    // 注意：结尾的「歌」属泛化词、在 contentWords 阶段去掉，这里仍随串保留，
    // 与「播放刘德华的歌」解析结果一致（都是「刘德华 歌」），保证两者行为相同。
    expect(genreToKeyword('放刘德华的歌')).toBe('刘德华 歌')
    expect(genreToKeyword('放周杰伦')).toBe('周杰伦')
    // 其它点歌动词（唱 / 听）作开头也要剔掉，否则同样残留动词导致搜不到
    // （用户反馈「唱周杰伦的歌」说没播放）。
    expect(genreToKeyword('唱周杰伦的歌')).toBe('周杰伦 歌')
    expect(genreToKeyword('听周杰伦的歌')).toBe('周杰伦 歌')
  })

  it('genreToKeyword：列出/念出/数量词也要剔掉（用户反馈“列出3首周杰伦的歌”报没找到）', () => {
    // 「列出、念出3首周杰伦的歌」含「的歌」被识别成播放，但检索词若不剔指令/数量词，
    // 会变成「列出、念出3首周杰伦」这种 MusicBrainz/百度都搜不到的垃圾词 → 误报「没找到这首歌」。
    // 剔干净后应只剩歌手名，候选列表功能据此检索并口播 3 首歌名（即用户要的「念出」）。
    expect(genreToKeyword('列出、念出3首周杰伦的歌')).toBe('周杰伦 歌')
    expect(genreToKeyword('列出周杰伦的歌')).toBe('周杰伦 歌')
    expect(genreToKeyword('念出几首周杰伦的歌')).toBe('周杰伦 歌')
    expect(genreToKeyword('列出周杰伦')).toBe('周杰伦')
    expect(genreToKeyword('报一下周杰伦的歌')).toBe('周杰伦 歌')
  })

  it('genreToKeyword：剔除“其它/其他/别的/另外”填充词（用户反馈“放一首林俊杰其它的歌”报没找到）', () => {
    // 「林俊杰其它的歌」里的「其它」只是“要一首不同的”的口语填充，不是歌名一部分；
    // 留着会让候选检索与 B 站搜索都拿「林俊杰其它」搜不到，误报「没找到这首歌」。
    expect(genreToKeyword('放一首林俊杰其它的歌')).toBe('林俊杰 歌')
    expect(genreToKeyword('来一首周杰伦其他的歌')).toBe('周杰伦 歌')
    expect(genreToKeyword('唱一首邓紫棋别的歌')).toBe('邓紫棋歌')
    expect(genreToKeyword('放首陈奕迅另外的歌')).toBe('陈奕迅 歌')
  })

  it('genreToKeyword：泛化点歌回落轻音乐（避免拿「歌」去百度白搜报操作失败）', () => {
    for (const t of ['播放个', '播放个音乐', '给我放首歌', '放首歌', '来首歌', '放点音乐', '随便放点']) {
      expect(genreToKeyword(t)).toBe('轻音乐')
    }
    // 泛化词收敛后应判为风格请求 → 走 SomaFM 电台
    expect(isGenreRequest(genreToKeyword('播放个音乐'))).toBe(true)
  })
})

describe('B 站搜索兜底源', () => {
  /**
   * 构造 fetcher：模拟 B 站搜索接口（data.result[].result[] 里的视频条目，带 bvid+title），
   * 以及 wbi 抽音轨三步（nav → view → playurl）。
   * titlesOf(keyword) 控制搜索返回的标题列表，便于验证「歌手、歌名要一样」
   * 「相关性排序」「换一首」「换歌名重新搜索」。
   * bvid 用「BV + 10 位序号 + a」编码序号，view 时按序号回贴搜索标题，playurl 按 bvid 给直链。
   */
  function biliFetcher(
    titlesOf: (keyword: string) => string[],
    audioUrl: (bvid: string) => string = (b) => `https://bili/${b}.m4s`
  ): MusicFetcher {
    let currentTitles: string[] = []
    const titleOf = (bvid: string): string => {
      const i = Number(bvid.slice(2, 12))
      return currentTitles[i] ?? bvid
    }
    return async (url) => {
      if (url.includes('search/all')) {
        const keyword = new URL(url).searchParams.get('keyword') ?? ''
        const titles = titlesOf(keyword)
        currentTitles = titles
        const result = titles.map((title, i) => ({
          bvid: `BV${String(i).padStart(10, '0')}a`,
          title,
          author: 'x',
        }))
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { result: [{ type: 'video', result }] } }),
          text: async () => '',
        }
      }
      if (url.includes('x/web-interface/nav')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { wbi_img: { img_url: 'https://i0.hdslb.com/wbi/xxx.png', sub_url: 'https://i0.hdslb.com/wbi/yyy.png' } } }),
          text: async () => '',
        }
      }
      if (url.includes('wbi/view')) {
        const bvid = /bvid=(BV[0-9A-Za-z]+)/.exec(url)?.[1] ?? ''
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { cid: 123, title: titleOf(bvid) } }), text: async () => '' }
      }
      expect(url).toContain('wbi/playurl')
      const bvid = /bvid=(BV[0-9A-Za-z]+)/.exec(url)?.[1] ?? 'unknown'
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { dash: { audio: [{ bandwidth: 1, baseUrl: audioUrl(bvid) }] } } }),
        text: async () => '',
      }
    }
  }

  it('搜索结果按相关性排序：完整版/原唱优先于鼓谱/翻唱', async () => {
    const titles = [
      '十年【陈奕迅】动态鼓谱',
      '在百万豪装录音棚听陈奕迅《十年》Hi-res',
      '《十年》陈奕迅 完整版',
    ]
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const track = await source.resolve('陈奕迅 十年')
    // 最相关（完整版、无减分词）的那条应排在最前
    expect(track.title).toBe('《十年》陈奕迅 完整版')
    expect(track.channel).toBe('bilibili')
    expect(track.url).toContain('BV0000000002')
  })

  it('视频标题与歌手/歌名对不上时跳过，绝不乱播（报没找到）', async () => {
    const titles = ['周杰伦演唱会精选', '谁说网红只会抄袭翻唱，原创歌曲出圈']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    await expect(source.resolve('周杰伦 稻香')).rejects.toThrow()
  })

  it('多歌曲合集（串烧/歌单）被硬排除，绝不播成乱播放', async () => {
    // 合集标题同时含歌手+歌名（会过 token 校验），但属于「一串烧/合集」不是那一首
    const titles = ['陈奕迅经典串烧：十年+富士山下+爱情转移', '《十年》陈奕迅 完整版']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const track = await source.resolve('陈奕迅 十年')
    // 合集被排除，应落到干净的那条
    expect(track.title).toBe('《十年》陈奕迅 完整版')
  })

  it('搜索结果只有合集、没有干净版本时，报没找到而非乱播', async () => {
    const titles = ['陈奕迅经典歌曲串烧版：十年等15首']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    await expect(source.resolve('陈奕迅 十年')).rejects.toThrow()
  })

  it('next() 依次换到下一首不同的曲目（换一首不再必失败）', async () => {
    const titles = ['《稻香》周杰伦 完整版', '周杰伦《稻香》Live', '稻香-周杰伦 伴奏']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const first = await source.resolve('周杰伦 稻香')
    const second = await source.next!('周杰伦 稻香')
    expect(first.url).not.toBe(second.url)
    expect(second.channel).toBe('bilibili')
  })

  it('换了歌名时重新搜索（不再沿用上一批候选）', async () => {
    const titlesOf = (k: string) =>
      k.includes('稻香') ? ['《稻香》周杰伦 完整版'] : ['《十年》陈奕迅 完整版']
    const source = createBilibiliSearchSource({}, biliFetcher(titlesOf))
    await source.resolve('周杰伦 稻香')
    const b2 = await source.next!('陈奕迅 十年')
    expect(b2.url).toContain('BV0000000000')
  })

  it('抽不到音轨的视频自动跳过，全失败才抛错', async () => {
    const base = biliFetcher(() => ['《稻香》周杰伦 完整版', '周杰伦《稻香》Live'])
    // 让第一个 BVID 的 playurl 返回无音频流，应自动换到第二个
    const wrapped: MusicFetcher = async (url, init) => {
      if (url.includes('wbi/playurl') && url.includes('BV0000000000')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { dash: { audio: [] } } }), text: async () => '' }
      }
      return base(url, init)
    }
    const source = createBilibiliSearchSource({}, wrapped)
    const track = await source.resolve('周杰伦 稻香')
    expect(track.url).toContain('BV0000000001')
  })

  /**
   * 百度兜底：B 站原生搜索召回不足（标题对不上/无结果）时，用百度 web 搜索找回 B 站视频页，
   * 抽音轨并**再过严格匹配**，命中才返回。这里 fake 让 search/all 返回不相干标题（B 站搜不到），
   * baidu.com 返回含 B 站直链的 HTML，view/playurl 按 bvid 回贴正确标题与直链。
   */
  it('B 站搜不到时百度兜底找到（且仍过严格匹配）', async () => {
    const BaiduBV = 'BV9999999999'
    const fake: MusicFetcher = async (url) => {
      if (url.includes('search/all')) {
        // B 站只召回不相干视频 → pickNext 必抛错，触发百度兜底
        const result = [{ bvid: 'BV0000000000', title: '周杰伦演唱会精选', author: 'x' }]
        return { ok: true, status: 200, json: async () => ({ data: { result: [{ type: 'video', result }] } }), text: async () => '' }
      }
      if (url.includes('www.baidu.com')) {
        const html = `mu="https://www.bilibili.com/video/${BaiduBV}/" <a href="https://www.bilibili.com/video/${BaiduBV}">x</a>`
        return { ok: true, status: 200, json: async () => ({}), text: async () => html }
      }
      if (url.includes('x/web-interface/nav')) {
        return { ok: true, status: 200, json: async () => ({ data: { wbi_img: { img_url: 'i', sub_url: 's' } } }), text: async () => '' }
      }
      if (url.includes('wbi/view')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { cid: 1, title: '《稻香》周杰伦 完整版' } }), text: async () => '' }
      }
      // wbi/playurl
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { dash: { audio: [{ bandwidth: 1, baseUrl: `https://bili/${BaiduBV}.m4s` }] } } }), text: async () => '' }
    }
    const source = createBilibiliSearchSource({}, fake)
    const track = await source.resolve('周杰伦 稻香')
    expect(track.url).toContain(BaiduBV)
    expect(track.title).toContain('稻香')
  })

  it('百度找回来的视频标题对不上时仍不算命中，最终报没找到', async () => {
    const BaiduBV = 'BV8888888888'
    const fake: MusicFetcher = async (url) => {
      if (url.includes('search/all')) {
        // B 站无命中
        return { ok: true, status: 200, json: async () => ({ data: { result: [] } }), text: async () => '' }
      }
      if (url.includes('www.baidu.com')) {
        const html = `mu="https://www.bilibili.com/video/${BaiduBV}/"`
        return { ok: true, status: 200, json: async () => ({}), text: async () => html }
      }
      if (url.includes('x/web-interface/nav')) {
        return { ok: true, status: 200, json: async () => ({ data: { wbi_img: { img_url: 'i', sub_url: 's' } } }), text: async () => '' }
      }
      if (url.includes('wbi/view')) {
        // 百度找回的却是无关视频，严格匹配应拒绝
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { cid: 1, title: ' unrelated video about cats' } }), text: async () => '' }
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { dash: { audio: [{ bandwidth: 1, baseUrl: 'x' }] } } }), text: async () => '' }
    }
    const source = createBilibiliSearchSource({}, fake)
    await expect(source.resolve('周杰伦 稻香')).rejects.toThrow()
  })

  it('百度也搜不到（验证页/无 B 站链接）时安静回退报没找到', async () => {
    const fake: MusicFetcher = async (url) => {
      if (url.includes('search/all')) {
        return { ok: true, status: 200, json: async () => ({ data: { result: [] } }), text: async () => '' }
      }
      if (url.includes('www.baidu.com')) {
        // 验证页，不含任何 bilibili 直链
        return { ok: true, status: 200, json: async () => ({}), text: async () => '<html>验证页面 请完成验证</html>' }
      }
      if (url.includes('x/web-interface/nav')) {
        return { ok: true, status: 200, json: async () => ({ data: { wbi_img: { img_url: 'i', sub_url: 's' } } }), text: async () => '' }
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { dash: { audio: [] } } }), text: async () => '' }
    }
    const source = createBilibiliSearchSource({}, fake)
    await expect(source.resolve('周杰伦 稻香')).rejects.toThrow()
  })
})

describe('titleMatchesKeyword（歌手、歌名要一样，杜绝乱播放）', () => {
  it('歌手与歌名都出现在标题里才命中', () => {
    expect(titleMatchesKeyword('周杰伦《稻香》完整版无损音质', '周杰伦 稻香')).toBe(true)
    expect(titleMatchesKeyword('【稻香】周杰伦，高清MV，治愈了整个童年', '周杰伦 稻香')).toBe(true)
  })

  it('只沾一个词、或完全不相干的视频不算命中', () => {
    expect(titleMatchesKeyword('周杰伦演唱会精选', '周杰伦 稻香')).toBe(false)
    expect(titleMatchesKeyword('谁说网红只会抄袭翻唱，原创歌曲出圈', '周杰伦 稻香')).toBe(false)
    expect(titleMatchesKeyword('随便一个音乐视频', '一首谁都没听过 稀奇古怪 歌')).toBe(false)
  })

  it('标点/书名号归一化后仍能匹配；无实词关键词不拦截（泛化已回落电台）', () => {
    expect(titleMatchesKeyword('周杰伦 - 「稻香」 Official MV', '周杰伦 稻香')).toBe(true)
    expect(titleMatchesKeyword('任意视频', '歌')).toBe(true)
  })

  it('空标题不命中', () => {
    expect(titleMatchesKeyword('', '稻香')).toBe(false)
  })
})

describe('looksLikeCompilation（合集/串烧硬排除，杜绝乱播放）', () => {
  it('串烧/合集/歌单/合辑/集锦类标题判为合集', () => {
    for (const t of ['陈奕迅经典串烧：十年', '周杰伦歌曲合集', '华语金曲歌单', '流行合辑 vol.2', '80后集锦']) {
      expect(looksLikeCompilation(t)).toBe(true)
    }
  })
  it('单曲标题（含现场版/MV）不算合集', () => {
    for (const t of ['《十年》陈奕迅 完整版', '周杰伦 稻香 Live', '稻香-周杰伦 高清MV']) {
      expect(looksLikeCompilation(t)).toBe(false)
    }
  })
  it('新增：精选 / 全MV / “数字+首” 计数也判为合集（避免换一首换到合集）', () => {
    // 用户反馈：搜“周杰伦”顶部返回「歌曲精选100首 / 最热门100首 / 全MV」这类合集，
    // 应被硬排除，只播单曲，否则“换一首”会换到合集而非单曲。
    expect(looksLikeCompilation('【无损音质】周杰伦歌曲精选100首 歌词版')).toBe(true)
    expect(looksLikeCompilation('【经典】周杰伦全MV 【200P】')).toBe(true)
    expect(looksLikeCompilation('华语最热门100首热歌 后台循环')).toBe(true)
    // 注意：单首的“高清MV”不带“全”前缀，不应误伤
    expect(looksLikeCompilation('稻香-周杰伦 高清MV')).toBe(false)
  })
})

describe('extractBvidsFromHtml', () => {
  it('从 mu=/href 里的 B 站直链抽 BVID，去重保序', () => {
    const html =
      'mu="https://www.bilibili.com/video/BV1111111111/" ' +
      'href="https://www.bilibili.com/video/BV2222222222/?p=1" ' +
      'mu="https://www.bilibili.com/video/BV1111111111/"'
    expect(extractBvidsFromHtml(html)).toEqual(['BV1111111111', 'BV2222222222'])
  })

  it('没有 B 站链接时返回空数组', () => {
    expect(extractBvidsFromHtml('<a href="https://haokan.baidu.com/v">x</a>')).toEqual([])
  })
})

describe('音乐聚合源（无配置）', () => {
  it('始终返回可用源（不再有 undefined）', () => {
    expect(createMusicSource()).toBeTruthy()
  })

  it('风格请求走 SomaFM（离线可验证，不触网）', async () => {
    const source = createMusicSource()
    const track = await source.resolve('放点爵士')
    // channel 是 SomaFM 频道 id，url 指向 ice6 直链
    expect(track.url).toContain('somafm.com')
  })

  it('具体歌名请求走 B 站搜索兜底分支（非风格）', () => {
    // isGenreRequest 已单测；这里仅确认分流方向：具体歌名不命中风格分支
    expect(isGenreRequest('周杰伦 稻香')).toBe(false)
  })

  it('泛化点歌（随便放点/播放个音乐）走 SomaFM 而非 B 站视频搜索', async () => {
    // 这类口语在 genreToKeyword 里已回落轻音乐，必须被识别为风格请求进电台，
    // 否则会误送视频搜索而播到不相关视频（乱播放）。
    const source = createMusicSource()
    for (const q of ['随便放点', '播放个音乐', '给我放首歌', '来首歌']) {
      const track = await source.resolve(q)
      expect(track.url).toContain('somafm.com')
    }
  })
})
