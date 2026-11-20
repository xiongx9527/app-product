/**
 * 通用媒体控制模块（系统能力，非 skill，不依赖任何内容 skill）。
 *
 * 职责边界（用户明确「音量/字幕/播放模式/pause/resume/stop/replay 跟 skill 无关」）：
 *  - 这些是对「当前正在播的媒体」的通用控制，与播的是音乐/新闻/诗词/百科无关；
 *    统一收在这层，网关核心只把用户这句话递给 handle()，不写控制逻辑。
 *  - 全部通过 MediaPlaybackCapability 操作状态与下发事件（暂停/继续/停止/音量/字幕/重播）；
 *    播放模式是客户端 UI 控制（client.playMode），不属媒体能力，直接下发。
 *  - 口播用本模块自带的 i18n（./mediaControlI18n），与内容 skill 无关。
 *
 * 注意顺序与诚实反馈（真机踩坑，迁代码时注释一起搬）：
 *  - pause/resume/stop 当前没在播要如实说「没在播放」，不乱称已操作；
 *  - pause 不清 active（暂停≠停止），stop 清全部；
 *  - 关字幕时当前本就没字幕，不说「已关闭」；开字幕但无同源字幕，直说没有；
 *  - replay 优先 tts（百科/诗词），其次音乐曲目（能力层 replay() 已实现此优先级）。
 */
import type { ServerEvent } from '../../protocol'
import type { MediaPlaybackCapability } from './mediaPlaybackCapability'
import { parseLoopCount } from './mediaIntent'
import { pickI18n } from './mediaControlI18n'

/* ── 播放模式切换识别（原 control/playModeControl.ts，通用媒体控制，合并至此）── */
export type PlayModeAction = 'float' | 'player' | 'toggle' | null
const TO_PLAYER_RE =
  /(关闭|关掉|退出|不要|别用)悬浮|切回(播放器|播放条)|播放器模式|播放条模式|普通模式|切换播放器|换成播放器/
const TO_FLOAT_RE = /(打开|开启|显示|用|切到|换成|变成|要|切换)悬浮|悬浮模式/
const TOGGLE_RE = /(切换|换|改变|改).{0,6}(播放模式|显示模式|模式)|切换模式/
export function detectPlayModeCommand(text: string): PlayModeAction {
  const t = (text || '').replace(/\s/g, '')
  if (!t) return null
  if (TO_PLAYER_RE.test(t)) return 'player'
  if (TO_FLOAT_RE.test(t)) return 'float'
  if (TOGGLE_RE.test(t)) return 'toggle'
  return null
}

/* ── 音量指令识别（原 control/volumeControl.ts，通用媒体控制，合并至此）── */
export type VolumeAction =
  | { kind: 'set'; value: number }
  | { kind: 'increase' }
  | { kind: 'decrease' }
  | null

const VOLUME_NOUN = /(音量|声音|声量)/
const INCREASE_RE =
  /(调大|增大|加大|提高|调高|升高|大一点|大一些|大点|大声|再(调大|增大|加大|提高|调高|升高|大|增)|增)/
const DECREASE_RE =
  /(调小|减小|降低|调低|小一点|小一些|小点|小声|再(调小|减小|降低|调低|小|减)|减)/

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
function parseCnNumber(s: string): number | null {
  if (!s) return null
  if (s === '十') return 10
  let total = 0
  let section = 0
  for (const ch of s) {
    if (ch === '十') section = section === 0 ? 10 : section * 10
    else if (ch === '百') section = section === 0 ? 100 : section * 100
    else if (CN_DIGIT[ch] !== undefined) section = CN_DIGIT[ch]
    else return null
    if (ch === '十' || ch === '百') { total += section; section = 0 }
  }
  return total + section
}
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(1, Math.max(0, v))
}
/** 口语音量目标 → 0–1；无目标值返回 null。 */
export function parseVolumePercent(text: string): number | null {
  if (/最大(声|音量)?/.test(text)) return 1
  if (/最小(声|音量)?/.test(text)) return 0
  if (/(一半|适中|中等|半声)/.test(text)) return 0.5
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (pct) return clamp01(Number(pct[1]) / 100)
  const bai = text.match(/百分之\s*([\d零〇一两二三四五六七八九十百]+)/)
  if (bai) {
    const n = bai[1].match(/^\d+(?:\.\d+)?$/) ? Number(bai[1]) : parseCnNumber(bai[1])
    if (n !== null && Number.isFinite(n)) return clamp01(n / 100)
  }
  const num = text.match(/(\d+(?:\.\d+)?)/)
  if (num) return clamp01(Number(num[1]) / 100)
  return null
}
export function detectVolumeCommand(text: string): VolumeAction {
  const t = (text || '').trim()
  if (!t || !(VOLUME_NOUN.test(t) || INCREASE_RE.test(t) || DECREASE_RE.test(t))) return null
  const target = parseVolumePercent(t)
  if (target !== null) return { kind: 'set', value: target }
  if (INCREASE_RE.test(t)) return { kind: 'increase' }
  if (DECREASE_RE.test(t)) return { kind: 'decrease' }
  return null
}

/* ── 字幕开关指令识别（原 control/subtitleControl.ts，合并至此）── */
export type SubtitleAction = 'on' | 'off' | null
const SUBTITLE_NOUN = /(字幕|歌词)/
const OFF_RE = /(关闭|关掉|关了|隐藏|去掉|移除|收起|不要|别|停|关)/
const ON_RE = /(开启|打开|显示|展示|要|看字幕|看歌词)/
export function detectSubtitleCommand(text: string): SubtitleAction {
  const t = (text || '').replace(/\s/g, '')
  if (!t || !SUBTITLE_NOUN.test(t)) return null
  if (OFF_RE.test(t)) return 'off'
  if (ON_RE.test(t)) return 'on'
  return null
}

/**
 * 通用媒体控制识别（系统能力，不依赖任何内容 skill）：只认对「当前媒体」的动作，
 * 不认「播什么内容」（play/next/recommend 归内容 skill）。正则从原 musicControl 的
 * 通用控制部分迁入，顺序保证 pause>stop>replay>loop>resume，避免「暂停播放」被 stop/play 抢中。
 */
type MediaAction = 'pause' | 'stop' | 'replay' | 'loop' | 'resume' | null
const CONTROL_PATTERNS: Array<{ action: Exclude<MediaAction, null>; re: RegExp }> = [
  { action: 'pause', re: /(暂停|先停|停一下|歇一下)/ },
  { action: 'stop', re: /(停止播放|关闭播放|关掉(音乐|播放)|别放了|停(掉)?音乐|关闭音乐|不(要|放)了)/ },
  { action: 'replay', re: /(重新播放|重播|重放|重新来(一遍|一次)?|再来一遍)/ },
  { action: 'loop', re: /(循环播放|单曲循环|列表循环|重复播放|再放(一|这|那)?遍|循环(播|放)?|回放(一|这)?遍)/ },
  { action: 'resume', re: /(继续(播放|放)?|接着(放|播|听)|恢复(播放)?|再播放|再放(?=$|[\s，。！？、]))/ },
]
function detectMediaAction(text: string): MediaAction {
  const t = (text || '').trim()
  if (!t) return null
  for (const { action, re } of CONTROL_PATTERNS) if (re.test(t)) return action
  return null
}

export interface MediaControlDeps {
  media: MediaPlaybackCapability
  lang: string
  send: (e: ServerEvent) => void
  speak: (text: string) => Promise<void>
  /** 停止时要清掉的新闻切条上下文（核心状态），由核心回调处理。 */
  onStop?: () => void
  /** 设置里的默认循环遍数（不带遍数的「循环播放」用它，不写死）。 */
  defaultLoop?: () => number
}

export class MediaControl {
  constructor(private readonly deps: MediaControlDeps) {}

  /**
   * 处理一句通用媒体控制指令。返回 consumed=true 表示已消费，网关不再走 skill / LLM。
   * 只认通用控制；play/next/recommend 等「播什么」返回 false，交内容 skill。
   */
  async handle(text: string): Promise<boolean> {
    if (this.handleVolume(text)) return true
    if (await this.handleSubtitle(text)) return true
    if (this.handlePlayMode(text)) return true
    if (await this.handleMediaAction(text)) return true
    return false
  }

  private handleVolume(text: string): boolean {
    const cmd: VolumeAction = detectVolumeCommand(text)
    if (!cmd) return false
    const i = pickI18n(this.deps.lang)
    const media = this.deps.media
    const step = 0.1
    if (cmd.kind === 'increase') {
      if (media.getVolume() >= 1 - 1e-6) { void this.deps.speak(i.volumeMax()); return true }
      const next = media.setVolume(Math.min(1, media.getVolume() + step))
      void this.deps.speak(i.volumeUp(Math.round(next * 100)))
      return true
    }
    if (cmd.kind === 'decrease') {
      if (media.getVolume() <= 1e-6) { void this.deps.speak(i.volumeMin()); return true }
      const next = media.setVolume(Math.max(0, media.getVolume() - step))
      void this.deps.speak(i.volumeDown(Math.round(next * 100)))
      return true
    }
    const next = media.setVolume(cmd.value)
    void this.deps.speak(i.volumeSet(Math.round(next * 100)))
    return true
  }

  private async handleSubtitle(text: string): Promise<boolean> {
    const action: SubtitleAction = detectSubtitleCommand(text)
    if (!action) return false
    const i = pickI18n(this.deps.lang)
    const media = this.deps.media
    media.setAutoSubtitle(action === 'on')
    if (action === 'off') {
      const had = media.hasSubtitle()
      media.closeSubtitle()
      await this.deps.speak(had ? i.subtitleOff() : i.subtitleNoActive())
      return true
    }
    // 开启：对当前正在播的媒体重发字幕；没有则如实说。
    const current = media.snapshot().current
    if (current && current.source !== 'tts') {
      const has = await media.ensureSubtitle(current.title, current.artist)
      await this.deps.speak(has ? i.subtitleOn() : i.subtitleNone())
      return true
    }
    await this.deps.speak(i.subtitleOn())
    return true
  }

  private handlePlayMode(text: string): boolean {
    const action: PlayModeAction = detectPlayModeCommand(text)
    if (!action) return false
    const i = pickI18n(this.deps.lang)
    const mode = action === 'float' ? 'float' : action === 'player' ? 'player' : undefined
    this.deps.send({ type: 'client.playMode', ...(mode ? { mode } : {}) })
    const confirm = action === 'float' ? i.playModeFloat() : action === 'player' ? i.playModePlayer() : i.playModeToggled()
    void this.deps.speak(confirm)
    return true
  }

  private async handleMediaAction(text: string): Promise<boolean> {
    const action = detectMediaAction(text)
    if (!action) return false
    const i = pickI18n(this.deps.lang)
    const media = this.deps.media
    switch (action) {
      case 'pause': {
        if (!media.pause()) { await this.deps.speak(i.musicNotPlaying()); return true }
        await this.deps.speak(i.paused())
        return true
      }
      case 'resume': {
        if (!media.resume()) { await this.deps.speak(i.musicNotPlaying()); return true }
        await this.deps.speak(i.resumed())
        return true
      }
      case 'stop': {
        const wasActive = media.snapshot().musicActive || media.snapshot().ttsMediaActive
        this.deps.onStop?.()
        if (!media.stop() && !wasActive) { await this.deps.speak(i.musicNotPlaying()); return true }
        await this.deps.speak(i.stopped())
        return true
      }
      case 'replay': {
        // 能力层 replay() 已实现 tts 优先于 music
        if (!media.replay()) { await this.deps.speak(i.musicNotPlaying()); return true }
        return true
      }
      case 'loop': {
        const current = media.snapshot().current
        if (!current) { await this.deps.speak(i.loopNothing()); return true }
        // 显式遍数优先；不带遍数用设置里的默认循环次数（不写死 2，尊重用户的 3 遍设置）。
        const explicit = parseLoopCount(text)
        const loop = explicit > 1 ? explicit : (this.deps.defaultLoop?.() ?? 3)
        media.play(
          { ...current, loop },
          { confirm: i.looping(loop), reuseSubtitle: true, speak: this.deps.speak },
        )
        return true
      }
      default:
        // play/next/recommend 是「播什么」，交内容 skill
        return false
    }
  }
}
