import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 用假 InnerAudioContext 验证播放器与 uni 的接线：
 * 进度回调、时长识别、seek 与停止后的状态复位。
 *
 * 关键点：H5 的 onTimeUpdate / onCanplay 回调**不带参数**（uni-h5 直接 callback()），
 * 播放器必须从 context 的 currentTime / duration getter 读，假实现照此模拟。
 */

class FakeAudioContext {
  src = ''
  loop = false
  volume = 1
  duration = 0
  currentTime = 0
  seeked: number | null = null
  private handlers = new Map<string, Array<() => void>>()

  onPlay(cb: () => void): void {
    this.on('play', cb)
  }
  onStop(cb: () => void): void {
    this.on('stop', cb)
  }
  onEnded(cb: () => void): void {
    this.on('ended', cb)
  }
  onError(cb: () => void): void {
    this.on('error', cb)
  }
  onPause(cb: () => void): void {
    this.on('pause', cb)
  }
  onTimeUpdate(cb: () => void): void {
    this.on('timeupdate', cb)
  }
  onSeeked(cb: () => void): void {
    this.on('seeked', cb)
  }
  onCanplay(cb: () => void): void {
    this.on('canplay', cb)
  }
  play(): void {
    this.emit('play')
  }
  pause(): void {
    this.emit('pause')
  }
  stop(): void {
    this.emit('stop')
  }
  seek(seconds: number): void {
    this.seeked = seconds
    this.currentTime = seconds
    this.emit('seeked')
  }

  /** 模拟播放推进：先更新元素属性，再触发不带参数的回调 */
  tick(currentTime: number, duration: number): void {
    this.currentTime = currentTime
    this.duration = duration
    this.emit('timeupdate')
  }

  emit(name: string): void {
    for (const cb of this.handlers.get(name) ?? []) cb()
  }

  private on(name: string, cb: () => void): void {
    const list = this.handlers.get(name) ?? []
    list.push(cb)
    this.handlers.set(name, list)
  }
}

let fake: FakeAudioContext
let player: typeof import('./musicPlayer')

beforeEach(async () => {
  vi.resetModules()
  fake = new FakeAudioContext()
  ;(globalThis as { uni?: unknown }).uni = { createInnerAudioContext: () => fake }
  player = await import('./musicPlayer')
})

describe('musicPlayer 进度与时长', () => {
  it('开始播放：写入地址并清零进度', () => {
    player.playMusic('https://ice6.somafm.com/groovesalad-128-mp3', 'Groove Salad')
    expect(fake.src).toContain('groovesalad')
    expect(player.musicState.playing.value).toBe(true)
    expect(player.musicState.title.value).toBe('Groove Salad')
    expect(player.musicState.currentTime.value).toBe(0)
    expect(player.musicState.duration.value).toBe(0)
    expect(player.musicState.live.value).toBe(false)
  })

  it('timeupdate 不带参数也能从 context 读到已播时间与总时长', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.tick(30, 180)
    expect(player.musicState.currentTime.value).toBe(30)
    expect(player.musicState.duration.value).toBe(180)
    expect(player.musicState.live.value).toBe(false)
  })

  it('播放推进时进度持续更新', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.tick(1.5, 60)
    expect(player.musicState.currentTime.value).toBeCloseTo(1.5)
    fake.tick(3.9, 60)
    expect(player.musicState.currentTime.value).toBeCloseTo(3.9)
  })

  it('canplay 拿不到总时长时判定为直播', () => {
    player.playMusic('https://ice6.somafm.com/lush-128-mp3', 'Lush')
    fake.duration = Number.POSITIVE_INFINITY
    fake.emit('canplay')
    expect(player.musicState.live.value).toBe(true)
    expect(player.musicState.duration.value).toBe(0)
  })

  it('canplay 有总时长时按歌曲处理', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.duration = 240
    fake.emit('canplay')
    expect(player.musicState.live.value).toBe(false)
    expect(player.musicState.duration.value).toBe(240)
  })

  it('seek 会下发到播放器，并由 seeked 回读真实位置', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.tick(0, 200)
    player.seekMusic(60)
    expect(fake.seeked).toBe(60)
    expect(player.musicState.currentTime.value).toBe(60)
  })

  it('seek 被平台拒绝时，下一次 timeupdate 会纠正显示', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.tick(0, 200)
    player.seekMusic(60)
    // 平台不支持拖动：真实位置仍在 0 附近
    fake.tick(0.8, 200)
    expect(player.musicState.currentTime.value).toBeCloseTo(0.8)
  })

  it('非法 seek 位置不下发', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    player.seekMusic(Number.NaN)
    player.seekMusic(-5)
    expect(fake.seeked).toBeNull()
  })

  it('停止后进度与时长复位', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.tick(90, 200)
    player.stopMusic()
    expect(player.musicState.playing.value).toBe(false)
    expect(player.musicState.currentTime.value).toBe(0)
    expect(player.musicState.duration.value).toBe(0)
    expect(player.musicState.live.value).toBe(false)
  })

  it('TTS 播报时压低音量，播完恢复', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    player.duckMusic(true)
    expect(fake.volume).toBe(0.2)
    player.duckMusic(false)
    expect(fake.volume).toBe(1)
  })

  it('暂停：标记 paused，不再推进进度，但保持 playing', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.tick(10, 200)
    player.pauseMusic()
    expect(player.musicState.paused.value).toBe(true)
    expect(player.musicState.playing.value).toBe(true)
    expect(fake.currentTime).toBe(10)
    // 暂停后时间推进不再更新（播放器已 pause）
    expect(player.musicState.currentTime.value).toBe(10)
  })

  it('恢复：清除 paused 状态', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    player.pauseMusic()
    expect(player.musicState.paused.value).toBe(true)
    player.resumeMusic()
    expect(player.musicState.paused.value).toBe(false)
  })

  it('错误：播放失败时置 musicError 并停止', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    expect(player.musicState.musicError.value).toBe(false)
    fake.emit('error')
    expect(player.musicState.musicError.value).toBe(true)
    expect(player.musicState.playing.value).toBe(false)
  })

  it('重新播放会清除上一次的错误标记', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.emit('error')
    player.playMusic('https://x/other.mp3', '另一首')
    expect(player.musicState.musicError.value).toBe(false)
    expect(player.musicState.playing.value).toBe(true)
  })

  it('播放失败时音乐条仍可见（visible 保持 true），便于展示歌名与失败提示', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    expect(player.musicState.visible.value).toBe(true)
    fake.emit('error')
    expect(player.musicState.visible.value).toBe(true)
    expect(player.musicState.musicError.value).toBe(true)
    expect(player.musicState.playing.value).toBe(false)
  })

  it('停止后音乐条隐藏', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    expect(player.musicState.visible.value).toBe(true)
    player.stopMusic()
    expect(player.musicState.visible.value).toBe(false)
  })
})

describe('musicPlayer 单曲循环与播完态', () => {
  it('不循环（缺省 loop）：播完进入「已播完」态，playing/paused 复位', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    expect(player.musicState.ended.value).toBe(false)
    fake.emit('ended')
    expect(player.musicState.playing.value).toBe(false)
    expect(player.musicState.paused.value).toBe(false)
    expect(player.musicState.ended.value).toBe(true)
    // 播完态下「暂停」按钮应表现为可「继续播放」（UI 据此切图标）
    expect(player.musicState.ended.value).toBe(true)
  })

  it('loop=N：会重播 N-1 次，第 N 次播完才进入「已播完」', () => {
    player.playMusic('https://x/song.mp3', '歌曲', { loop: 3 })
    expect(player.musicState.loopRemaining.value).toBe(2)
    // 第 1 遍播完 → 重播，loopRemaining 递减
    fake.emit('ended')
    expect(player.musicState.playing.value).toBe(true)
    expect(player.musicState.ended.value).toBe(false)
    expect(player.musicState.loopRemaining.value).toBe(1)
    // 第 2 遍播完 → 再重播
    fake.emit('ended')
    expect(player.musicState.playing.value).toBe(true)
    expect(player.musicState.loopRemaining.value).toBe(0)
    // 第 3 遍播完 → 进入「已播完」
    fake.emit('ended')
    expect(player.musicState.playing.value).toBe(false)
    expect(player.musicState.ended.value).toBe(true)
  })

  it('loop=1 与不合法值按「不循环」处理：播完即「已播完」', () => {
    player.playMusic('https://x/song.mp3', '歌曲', { loop: 1 })
    expect(player.musicState.loopRemaining.value).toBe(0)
    fake.emit('ended')
    expect(player.musicState.ended.value).toBe(true)
    expect(player.musicState.playing.value).toBe(false)
  })

  it('replayMusic：已播完后从头重播一遍（loop 归零，ended 复位）', () => {
    player.playMusic('https://x/first.mp3', '第一首')
    fake.emit('ended')
    expect(player.musicState.ended.value).toBe(true)
    player.replayMusic()
    expect(player.musicState.ended.value).toBe(false)
    expect(player.musicState.playing.value).toBe(true)
    expect(player.musicState.loopRemaining.value).toBe(0)
    expect(fake.src).toContain('first.mp3')
  })

  it('循环按钮 toggleLoop：开启后无限重播，再点关闭后播完进入「已播完」', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    player.toggleLoop()
    expect(player.musicState.loopRemaining.value).toBe(Number.POSITIVE_INFINITY)
    fake.emit('ended')
    expect(player.musicState.playing.value).toBe(true)
    expect(player.musicState.ended.value).toBe(false)
    fake.emit('ended')
    expect(player.musicState.ended.value).toBe(false) // Infinity-1 仍是 Infinity
    // 再点关闭
    player.toggleLoop()
    expect(player.musicState.loopRemaining.value).toBe(0)
    fake.emit('ended')
    expect(player.musicState.ended.value).toBe(true)
  })

  it('循环按钮：已播完态开启会立即从头重播', () => {
    player.playMusic('https://x/song.mp3', '歌曲')
    fake.emit('ended')
    expect(player.musicState.ended.value).toBe(true)
    player.toggleLoop()
    expect(player.musicState.ended.value).toBe(false)
    expect(player.musicState.playing.value).toBe(true)
    expect(player.musicState.loopRemaining.value).toBe(Number.POSITIVE_INFINITY)
    expect(fake.seeked).toBe(0)
  })

  it('新下发 media.play（playMusic）会重置循环开关', () => {
    player.playMusic('https://x/a.mp3', 'A')
    player.toggleLoop()
    expect(player.musicState.loopRemaining.value).toBe(Number.POSITIVE_INFINITY)
    player.playMusic('https://x/b.mp3', 'B')
    expect(player.musicState.loopRemaining.value).toBe(0)
  })
})
