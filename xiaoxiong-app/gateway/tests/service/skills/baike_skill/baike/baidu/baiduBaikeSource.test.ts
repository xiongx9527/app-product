import { describe, it, expect } from 'vitest'
import { cleanBaikeText, parseBaikeHtml } from '../../../../../../src/service/skills/baike_skill/baike/baidu/baiduBaikeSource'
import { createDefaultBaikeSource, createBaikeSource, listBaikeSources, DEFAULT_BAIKE_SOURCE } from '../../../../../../src/service/skills/baike_skill/baike/index'

/**
 *  fixture 反映真实百度搜索页结构：摘要在 source 锚点之前，标题在锚点之后。
 *  - 实体卡（人物）："description":"摘要" ... "tools":{"title":"X"} ... "source":"百度百科"
 *  - 概念卡： "abstract":{"abstract":"摘要"} ... "source":{"title":"百度百科"} ... "character":{"title":"X"}
 */
function entityHtml(title: string, desc: string): string {
  return `..."description":"${desc}","tools":{"title":"${title}","url":"https://baike.baidu.com/item/x"},"source":"百度百科","baikeid":"556820",...`
}
function conceptHtml(title: string, abstract: string): string {
  return `..."abstract":{"abstract":"${abstract}","firstCardAbstract":""},"source":{"title":"百度百科"},"character":{"show":false,"title":"${title}","desc":"概念"},...`
}
/**
 * 新版头图知识卡（刘备/李白这类人物词条走这种）：没有 source/description/abstract 摘要字段，
 * 摘要只在 summaryData、标题在 headProps.title.text，卡片边界是 baikeText。
 * headProps.abstract 是一句短标签（如「三国时期蜀汉开国皇帝」），不能当摘要用。
 */
function peakCardHtml(title: string, summary: string): string {
  return `..."headProps":{"title":{"text":"${title}","size":"lg"},"abstract":"三国时期蜀汉开国皇帝"},`
    + `"cardData":{"name":"${title}","tags":["字 玄德"]},"summaryData":"${summary}",`
    + `"catalogData":{"show":true,"list":[{"url":"http://baike.baidu.com/item/${title}/1","text":"人物生平"}]},`
    + `"baikeText":"百度百科","sourceObj":{"items":[{"text":"百度百科"}]},...`
}

describe('parseBaikeHtml 配图', () => {
  it('从 poster 的 src 参数解码出稳定的 bkimg 直链作封面', () => {
    // 真实搜索页里 poster 的 src 参数是单层 URL 编码的 bkimg 直链（逗号/斜杠都被编码）
    const inner = 'https://bkimg.cdn.bcebos.com/smart/abc123-bkimg-process,v_1,rw_1?x-bce-process=image/resize'
    const poster = `https://gimg3.baidu.com/topone/src=${encodeURIComponent(inner)}&refer=http%3A%2F%2Fwww.baidu.com`
    const html = `..."description":"五代后唐开国皇帝，军事才能出众，在位期间励精图治。","tools":{"title":"李存勖"},`
      + `"poster":"${poster}","source":"百度百科",...`
    const entry = parseBaikeHtml(html)
    expect(entry?.image).toBe(inner)
  })

  it('没有 poster 时 image 为空', () => {
    const entry = parseBaikeHtml(entityHtml('李存勖', '五代后唐开国皇帝，军事才能出众，在位期间励精图治。'))
    expect(entry?.image).toBeUndefined()
  })
})

describe('cleanBaikeText', () => {
  it('去 <em> 高亮标签、解实体、压空白、去百度百科后缀', () => {
    expect(cleanBaikeText('<em>李存勖</em> - 百度百科')).toBe('李存勖')
    expect(cleanBaikeText('一代 &quot;枭雄&quot; &nbsp;后唐开国')).toBe('一代 "枭雄" 后唐开国')
  })

  it('JSON 转义的中文摘要能正确反转义', () => {
    expect(cleanBaikeText('<em>人工智能</em>\\u0020是模拟智能')).toContain('人工智能')
  })
})

describe('parseBaikeHtml', () => {
  it('实体卡：提取 title + description（人物事迹）', () => {
    const entry = parseBaikeHtml(entityHtml('李存勖', '<em>李存勖</em>是五代后唐开国皇帝，军事才能出众，在位期间励精图治。'))
    expect(entry?.title).toBe('李存勖')
    expect(entry?.summary).toContain('五代后唐开国皇帝')
    expect(entry?.summary).not.toContain('<em>')
    expect(entry?.url).toContain('baike.baidu.com/item/')
  })

  it('概念卡：提取 character.title + abstract', () => {
    const entry = parseBaikeHtml(conceptHtml('智能时代', '<em>智能时代</em>是随人工智能技术崛起从信息时代演进的新技术阶段，具备人机协同等特征。'))
    expect(entry?.title).toBe('智能时代')
    expect(entry?.summary).toContain('人工智能技术崛起')
  })

  it('摘要太短（导航/空字段）视为无结果', () => {
    expect(parseBaikeHtml(entityHtml('X', '百度百科'))).toBeNull()
  })

  it('新版头图卡：提取 headProps.title + summaryData（刘备这类人物词条）', () => {
    const entry = parseBaikeHtml(
      peakCardHtml(
        '刘备',
        '<em>刘备</em>（161—223年6月10日），字玄德，幽州涿郡涿县人，三国时期蜀汉开国皇帝。',
      ),
    )
    expect(entry?.title).toBe('刘备')
    expect(entry?.summary).toContain('字玄德')
    expect(entry?.summary).toContain('蜀汉开国皇帝')
    // 不能把 headProps.abstract 那句短标签当摘要
    expect(entry?.summary).not.toBe('三国时期蜀汉开国皇帝')
    expect(entry?.url).toContain('baike.baidu.com/item/')
  })

  it('头图卡与旧卡同页时都能解析，不串卡', () => {
    const html = peakCardHtml('刘备', '刘备是三国时期蜀汉开国皇帝，字玄德，以仁义著称，三顾茅庐请诸葛亮出山。')
      + entityHtml('关羽', '关羽是东汉末年名将，字云长，与刘备张飞结为兄弟，威震华夏。')
    const entry = parseBaikeHtml(html)
    expect(entry?.title).toBe('刘备')
    expect(entry?.summary).toContain('三顾茅庐')
  })

  it('没有百科卡片锚点返回 null', () => {
    expect(parseBaikeHtml('<html>无关页面</html>')).toBeNull()
  })

})

describe('源注册表（多源架构）', () => {
  it('默认源是 baidu，且注册表包含它', () => {
    expect(DEFAULT_BAIKE_SOURCE).toBe('baidu')
    expect(listBaikeSources()).toContain('baidu')
  })

  it('按名创建源与默认源一致；未知名字回退默认源', () => {
    expect(createBaikeSource('baidu').name).toBe(createDefaultBaikeSource().name)
    expect(createBaikeSource('unknown').name).toBe(createDefaultBaikeSource().name)
  })

  it('createDefaultBaikeSource 返回 baidu-search 源', () => {
    expect(createDefaultBaikeSource().name).toBe('baidu-search')
  })

  it('fetch 用注入的 fetcher，走 encoded 搜索 URL，解析出词条', async () => {
    const src = createDefaultBaikeSource()
    let calledUrl = ''
    const fetcher = async (url: string) => {
      calledUrl = url
      return { ok: true, text: async () => entityHtml('李存勖', '<em>李存勖</em>是五代后唐开国皇帝，军事才能出众。') }
    }
    const entry = await src.fetch('李存勖', fetcher)
    expect(calledUrl).toContain(encodeURIComponent('李存勖'))
    expect(entry?.title).toBe('李存勖')
  })

  it('fetcher 失败（非 ok）返回 null', async () => {
    const src = createDefaultBaikeSource()
    expect(await src.fetch('X', async () => ({ ok: false, text: async () => '' }))).toBeNull()
  })

  it('空查询直接返回 null，不发请求', async () => {
    const src = createDefaultBaikeSource()
    let called = false
    await src.fetch('  ', async () => { called = true; return { ok: true, text: async () => '' } })
    expect(called).toBe(false)
  })
})
