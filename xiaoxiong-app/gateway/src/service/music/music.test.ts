import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import {
  createBilibiliSearchSource,
  titleMatchesKeyword,
  titleMatchesKeywordLoose,
  looksLikeCompilation,
} from './bilibiliSearchSource'
import { extractBvidsFromHtml } from './bilibiliAudio'
import { createMusicSource } from './index'
import { SOMA_CHANNELS } from '../tools/musicChannels'
import type { MusicFetcher } from './types'
import { isGenreRequest, genreToKeyword, isSpokenContentRequest } from './types'

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

  it('genreToKeyword：泛化点歌回落空串（由路由判为风格请求走 SomaFM，避免拿「歌」去白搜）', () => {
    for (const t of ['播放个', '播放个音乐', '给我放首歌', '放首歌', '来首歌', '放点音乐', '随便放点']) {
      expect(genreToKeyword(t)).toBe('')
    }
    // 空串在 isGenreRequest 里判为风格请求 → 走 SomaFM 电台
    expect(isGenreRequest(genreToKeyword('播放个音乐'))).toBe(true)
  })

  it('genreToKeyword：「背景音乐」是风格请求（走轻音乐电台），不能当影视内容', () => {
    expect(genreToKeyword('播放背景音乐')).toBe('轻音乐')
    expect(isGenreRequest(genreToKeyword('播放背景音乐'))).toBe(true)
    // 反过来：它不该被判定成「非歌曲内容」，失败时仍应说「没找到这首歌」
    expect(isSpokenContentRequest('播放背景音乐')).toBe(false)
  })

  it('genreToKeyword：评书/相声这类内容保留类型词，量词「段」要剔掉', () => {
    // 用户反馈「播放刘兰芳的岳飞专评书」被当成点歌报「没找到这首歌」——类型词必须留在检索词里，
    // 否则会变成「刘兰芳 岳飞专」这种只认歌名的词，B 站命中率骤降。
    expect(genreToKeyword('播放刘兰芳的岳飞专评书')).toBe('刘兰芳 岳飞专评书')
    expect(genreToKeyword('播放刘兰芳的评书')).toBe('刘兰芳 评书')
    expect(genreToKeyword('播放郭德纲的相声')).toBe('郭德纲 相声')
    // 「放段相声」开头的「段」是量词，不清掉会拿「段相声」白搜
    expect(genreToKeyword('放段相声')).toBe('相声')
    expect(genreToKeyword('来一段郭德纲的相声')).toBe('郭德纲 相声')
  })

  it('genreToKeyword：电视/电影/动画片/漫剧也保留类型词，「看 / 演」当播放动词剥掉', () => {
    expect(genreToKeyword('播放三国演义的电视剧')).toBe('三国演义 电视剧')
    expect(genreToKeyword('播放流浪地球的电影')).toBe('流浪地球 电影')
    expect(genreToKeyword('看动画片')).toBe('动画片')
    expect(genreToKeyword('看漫剧')).toBe('漫剧')
    expect(genreToKeyword('看电影')).toBe('电影')
    // 「看 / 演」作开头动词要剥掉，否则检索词会变成「看电视」「演电影」这种搜不到的词
    expect(genreToKeyword('看电视')).toBe('电视')
    expect(genreToKeyword('演电影')).toBe('电影')
    expect(genreToKeyword('演个电影')).toBe('电影')
    expect(genreToKeyword('演个电视剧')).toBe('电视剧')
    // 「我想看 / 我看」口语前缀也要剥掉，否则「我想看西游记」会变成带「想看」的垃圾检索词。
    // 作品名与类型词粘连（无「的」）时保持原样，由模糊匹配兜底命中。
    expect(genreToKeyword('我想看西游记动画片')).toBe('西游记动画片')
    expect(genreToKeyword('我想看流浪地球电影')).toBe('流浪地球电影')
    expect(genreToKeyword('我看电视剧')).toBe('电视剧')
  })

  it('genreToKeyword：「主演 / 参演 / 出演 / 导演 / 拍 / 唱」是谓语，不是作品名的一部分', () => {
    // 用户反馈「演的电影」「主演、参演」「导演」「拍的电影」「唱的歌」这类说法——
    // 留着会让检索词变成「主演 电影」「周星驰演 电影」「周杰伦唱 歌」，B 站标题里不会有这些组合，
    // 严格匹配必然落空。
    expect(genreToKeyword('演的电影')).toBe('电影')
    expect(genreToKeyword('主演的电影')).toBe('电影')
    expect(genreToKeyword('参演的电视剧')).toBe('电视剧')
    expect(genreToKeyword('周星驰演的电影')).toBe('周星驰 电影')
    expect(genreToKeyword('成龙主演的电影')).toBe('成龙 电影')
    expect(genreToKeyword('周星驰导演的电影')).toBe('周星驰 电影')
    expect(genreToKeyword('葛优出演的电视剧')).toBe('葛优 电视剧')
    expect(genreToKeyword('张艺谋监制的电视剧')).toBe('张艺谋 电视剧')
    expect(genreToKeyword('周星驰监制的电影')).toBe('周星驰 电影')
    // 拍：拍电影 / 拍的电影 / 拍的电视剧 / 拍的电视
    expect(genreToKeyword('拍电影')).toBe('电影')
    expect(genreToKeyword('拍的电影')).toBe('电影')
    expect(genreToKeyword('拍的电视剧')).toBe('电视剧')
    expect(genreToKeyword('拍的电视')).toBe('电视')
    expect(genreToKeyword('周星驰拍的电影')).toBe('周星驰 电影')
    expect(genreToKeyword('张艺谋拍的电视剧')).toBe('张艺谋 电视剧')
    // 唱：唱的 / 唱的歌
    expect(genreToKeyword('周杰伦唱的歌')).toBe('周杰伦 歌')
    expect(genreToKeyword('唱的歌')).toBe('') // 只剩泛化词 → 回落电台，不白搜
    expect(genreToKeyword('唱的')).toBe('')
    // MV 也当内容类型词保留
    expect(genreToKeyword('播放周杰伦的mv')).toBe('周杰伦 mv')
    expect(genreToKeyword('放个mv')).toBe('mv')
    // 画质修饰词（4K / 高清 / 蓝光…）是偏好不是作品名，剔掉后仍能搜到
    expect(genreToKeyword('播放4k的流浪地球')).toBe('流浪地球')
    expect(genreToKeyword('流浪地球 4K 蓝光')).toBe('流浪地球')
    expect(genreToKeyword('播放高清电影')).toBe('电影')
    expect(genreToKeyword('1080p 周杰伦 稻香')).toBe('周杰伦 稻香')
    // 「作品」是泛称，不是作品名，剔掉后按人名检索
    expect(genreToKeyword('播放周杰伦的作品')).toBe('周杰伦')
    expect(genreToKeyword('周星驰的作品')).toBe('周星驰')
    // 「精彩」是评价词不是内容名
    expect(genreToKeyword('精彩集锦')).toBe('集锦')
    expect(genreToKeyword('精彩比赛')).toBe('比赛')
    // 「听戏 / 放段戏」：戏是内容类型，动词剥掉后收敛到「戏曲」再检索（单搜「戏」太泛）
    expect(genreToKeyword('听戏')).toBe('戏曲')
    expect(genreToKeyword('放段戏')).toBe('戏曲')
    // 「演员」是名词，不能把「演」当动词剥掉
    expect(genreToKeyword('演员')).toBe('演员')
  })
})

describe('isSpokenContentRequest（决定「没找到」的措辞，不能把评书说成「这首歌」）', () => {
  it('评书/相声/有声书/电视剧/电影/动画片/漫剧等非歌曲内容返回 true', () => {
    for (const t of [
      '刘兰芳 岳飞传 评书',
      '郭德纲 相声',
      '三体 有声书',
      '三国演义 评话',
      '京剧 戏曲',
      '听戏',
      '单田芳 广播剧',
      '三国演义 电视剧',
      '放个电视节目',
      '流浪地球 电影',
      '流浪地球 微电影',
      '西游记 动画片',
      '斗罗大陆 漫剧',
      '放个票房高的电影',
      '放个mv',
      '放个MV',
      '百家讲坛',
      '公开课 课堂',
      '三只小猪 故事',
      '格林 童话',
      '开学典礼 讲话',
      '讲座 录播',
      '晚会 录影',
      '雷雨 话剧',
      '春节 晚会',
      '舌尖上的中国 纪录片',
      '综艺节目',
      '世界杯 比赛',
      'NBA 直播',
      '精彩集锦',
      '精彩比赛',
      '易中天 评说三国',
      '戏说乾隆',
      '比赛 解说',
      '解说员 评论员',
      '世界杯 回放',
      '西游记 主题曲',
    ]) {
      expect(isSpokenContentRequest(t)).toBe(true)
    }
  })

  it('普通点歌/风格请求返回 false', () => {
    for (const t of ['周杰伦 稻香', '放点轻音乐', '陈奕迅 十年', '', undefined]) {
      expect(isSpokenContentRequest(t)).toBe(false)
    }
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

  it('严格匹配一条都没有时才启用模糊兜底：评书带错字仍能播', async () => {
    // 用户反馈：「播放刘兰芳的岳飞专评书」报「没找到这首歌」，但 B 站确实有《岳飞传》。
    // 严格匹配因「岳飞专 ≠ 岳飞传」全部落空 → 落到模糊兜底，命中真实资源。
    const titles = ['【117回全本】经典长篇评书《岳飞传》，刘兰芳播讲', '郭德纲相声精选']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const track = await source.resolve('刘兰芳 岳飞专评书')
    expect(track.title).toContain('岳飞传')
  })

  it('严格匹配有命中时不走模糊兜底（保证「歌手、歌名要一样」优先）', async () => {
    // 第二条严格命中；第一条只能靠模糊命中，但相关性更高（含「完整版」）。
    // 若实现退化成「总是模糊匹配」，第一条就会被选中——这里断言必须选严格命中的那条。
    const titles = ['刘兰芳 岳飞扬家将 评书 完整版', '《岳飞传》刘兰芳 评书 第001回']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const track = await source.resolve('刘兰芳 岳飞传 评书')
    expect(track.title).toContain('岳飞传')
  })

  it('相声这类内容也能搜到（关键字不只评书）', async () => {
    const titles = ['郭德纲 于谦 经典相声《报菜名》完整版', '周杰伦演唱会精选']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const track = await source.resolve('郭德纲 相声')
    expect(track.title).toContain('相声')
  })

  it('电视剧这类内容也能搜到', async () => {
    const titles = ['1994版《三国演义》第01集 桃园结义', '周杰伦演唱会精选']
    const source = createBilibiliSearchSource({}, biliFetcher(() => titles))
    const track = await source.resolve('三国演义 电视剧')
    expect(track.title).toContain('三国演义')
  })

  it('电影 / 动画片 / 漫剧这类内容也能搜到', async () => {
    const cases: Array<[string, string, string]> = [
      ['流浪地球 电影', '《流浪地球》高清完整版 国产科幻电影', '流浪地球'],
      ['西游记 动画片', '西游记 动画片 第01集 大闹天宫', '西游记'],
      ['斗罗大陆 漫剧', '斗罗大陆 漫剧 第01集', '斗罗大陆'],
      // 「X 演的电影」清洗成「X 电影」后能正常检索
      ['周星驰演的电影', '周星驰 电影《喜剧之王》完整版', '喜剧之王'],
    ]
    for (const [keyword, title, expectTitle] of cases) {
      const source = createBilibiliSearchSource({}, biliFetcher(() => [title, '周杰伦演唱会精选']))
      const track = await source.resolve(keyword)
      expect(track.title).toContain(expectTitle)
    }
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

describe('titleMatchesKeywordLoose（容忍 ASR 错字，但仍不许乱播）', () => {
  it('ASR 把「岳飞传」听成「岳飞专」时仍能命中真实的评书资源', () => {
    // 用户反馈：「播放刘兰芳的岳飞专评书」→ 报「没找到这首歌」，但资源其实存在。
    // 严格匹配要求 token 原样出现，「岳飞专」自然一条都过不了，必须靠模糊兜底。
    const title = '【117回全本】经典长篇评书《岳飞传》，刘兰芳播讲'
    expect(titleMatchesKeyword(title, '刘兰芳 岳飞专评书')).toBe(false)
    expect(titleMatchesKeywordLoose(title, '刘兰芳 岳飞专评书')).toBe(true)
  })

  it('类型词（评书/相声/电视剧）不参与模糊比对，避免把不同作品撞到一起', () => {
    // 「评书」是通用类型词，不能靠它把「郭德纲相声」判成「刘兰芳评书」的命中
    expect(titleMatchesKeywordLoose('郭德纲相声精选', '刘兰芳 岳飞专评书')).toBe(false)
    expect(titleMatchesKeywordLoose('郭德纲 相声 大合集', '郭德纲 相声')).toBe(true)
    // 「电视剧」同理：标题里没有类型词，但作品名对得上就该命中
    expect(titleMatchesKeywordLoose('《三国演义》第01集 桃园结义', '三国演义 电视剧')).toBe(true)
    expect(titleMatchesKeywordLoose('《红楼梦》第01集', '三国演义 电视剧')).toBe(false)
    // 话剧 / 纪录片 / 比赛 同理
    expect(titleMatchesKeywordLoose('《雷雨》话剧 全场录像', '雷雨 话剧')).toBe(true)
    expect(titleMatchesKeywordLoose('《雷雨》全场录像', '雷雨 话剧')).toBe(true)
    expect(titleMatchesKeywordLoose('舌尖上的中国 第一集', '舌尖上的中国 纪录片')).toBe(true)
    expect(titleMatchesKeywordLoose('世界杯 决赛 全场回放', '世界杯 比赛')).toBe(true)
    // 评说 / 戏说：类型词剔掉后靠作品名匹配（「戏说乾隆」不能只剩「说乾隆」）
    expect(titleMatchesKeywordLoose('易中天 评说三国 第01集', '易中天 评说三国')).toBe(true)
    expect(titleMatchesKeywordLoose('《戏说乾隆》第01集', '戏说乾隆')).toBe(true)
    expect(titleMatchesKeywordLoose('《康熙王朝》第01集', '戏说乾隆')).toBe(false)
    // 解说 / 评论员：类型词剔掉后靠赛事名匹配（赛事名对不上就不算命中）
    expect(titleMatchesKeywordLoose('世界杯 决赛 全场回放 詹俊解说', '世界杯 解说')).toBe(true)
    expect(titleMatchesKeywordLoose('世界杯 决赛 全场回放 詹俊解说', '英超 评论员')).toBe(false)
  })

  it('至少要有 token 完整出现，纯靠零散两字不算命中', () => {
    expect(titleMatchesKeywordLoose('随便一个音乐视频', '周杰伦 稻香')).toBe(false)
    expect(titleMatchesKeywordLoose('周杰伦演唱会精选', '周杰伦 稻香')).toBe(false)
  })

  it('空标题不命中；无实词关键词不拦截', () => {
    expect(titleMatchesKeywordLoose('', '评书')).toBe(false)
    expect(titleMatchesKeywordLoose('任意视频', '歌')).toBe(true)
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

  it('用户自己就要「集锦 / 精选」时，不能再当合集排除', () => {
    // 用户反馈「集锦、精彩比赛、精彩集锦」——赛事集锦本身就是标题带「集锦」的正片，
    // 按老的合集规则会被全部排除，反而报没找到。
    expect(looksLikeCompilation('世界杯 精彩集锦 决赛全场高光', '集锦')).toBe(false)
    expect(looksLikeCompilation('世界杯 精彩集锦 决赛全场高光', '精彩集锦')).toBe(false)
    // 但没点名集锦时，合集仍要排除
    expect(looksLikeCompilation('世界杯 精彩集锦 决赛全场高光', '世界杯 决赛')).toBe(true)
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
