import { describe, it, expect } from 'vitest'
import { joinArtistTitle } from './query'

describe('joinArtistTitle', () => {
  it('歌名里已含歌手时只用歌名，不重复拼接（避免「周杰伦 周杰伦 一路向北」搜不到）', () => {
    expect(joinArtistTitle('周杰伦', '周杰伦 一路向北')).toBe('周杰伦 一路向北')
  })

  it('歌名不含歌手时正常拼成「歌手 歌名」', () => {
    expect(joinArtistTitle('周杰伦', '一路向北')).toBe('周杰伦 一路向北')
  })

  it('歌手或歌名为空时返回另一方', () => {
    expect(joinArtistTitle('', '一路向北')).toBe('一路向北')
    expect(joinArtistTitle('周杰伦', '')).toBe('周杰伦')
  })

  it('大小写不敏感去重', () => {
    expect(joinArtistTitle('Jay', 'Jay Chou 一路向北')).toBe('Jay Chou 一路向北')
  })
})
