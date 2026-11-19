/**
 * 通用媒体控制文案（跟系统能力走，不依赖任何内容 skill）。
 * 音量/字幕/播放模式/pause/resume/stop/loop 的口播——与正在播的是音乐/新闻/诗词/百科无关。
 * 纯数据、不 import 网关 i18n.ts（避免循环依赖）。
 */
export interface MediaControlI18n {
  volumeSet: (pct: number) => string
  volumeUp: (pct: number) => string
  volumeDown: (pct: number) => string
  volumeMax: () => string
  volumeMin: () => string
  subtitleOff: () => string
  subtitleOn: () => string
  subtitleNone: () => string
  subtitleNoActive: () => string
  musicNotPlaying: () => string
  paused: () => string
  resumed: () => string
  stopped: () => string
  looping: (count: number) => string
  loopNothing: () => string
  playing: (title: string) => string
  playModeFloat: () => string
  playModePlayer: () => string
  playModeToggled: () => string
}

export const mediaControlI18n: Record<string, MediaControlI18n> = {
  'zh-CN': {
    volumeSet: (pct) => `已为您将音量调到 ${pct}%。`,
    volumeUp: (pct) => `已调大，当前音量 ${pct}%。`,
    volumeDown: (pct) => `已调小，当前音量 ${pct}%。`,
    volumeMax: () => '音量已经最大了。',
    volumeMin: () => '音量已经最小了。',
    subtitleOff: () => '已关闭字幕。',
    subtitleOn: () => '已开启字幕。',
    subtitleNone: () => '当前内容没有字幕，先给你开着，下一个有就自动显示。',
    subtitleNoActive: () => '当前没有字幕，本来就是关着的。',
    musicNotPlaying: () => '现在还没在播放什么，先播放点内容吧。',
    paused: () => '已暂停。',
    resumed: () => '继续播放。',
    stopped: () => '已停止播放。',
    looping: (count) => (count > 1 ? `为你循环播放 ${count} 遍。` : '为你重播一遍。'),
    loopNothing: () => '现在还没在播放什么，先播放点内容再让我循环吧。',
    playing: (title) => `正在播放${title}。`,
    playModeFloat: () => '已切换到悬浮模式。',
    playModePlayer: () => '已切换到播放器模式。',
    playModeToggled: () => '已切换播放模式。',
  },
  en: {
    volumeSet: (pct) => `Volume set to ${pct}%.`,
    volumeUp: (pct) => `Volume up — now ${pct}%.`,
    volumeDown: (pct) => `Volume down — now ${pct}%.`,
    volumeMax: () => 'Volume is already at maximum.',
    volumeMin: () => 'Volume is already at minimum.',
    subtitleOff: () => 'Subtitles off.',
    subtitleOn: () => 'Subtitles on.',
    subtitleNone: () => "No subtitles for this content. I've turned them on, and they'll show automatically when the next one has them.",
    subtitleNoActive: () => "There are no subtitles currently — they're already off.",
    musicNotPlaying: () => 'Nothing is playing right now; play something first.',
    paused: () => 'Paused.',
    resumed: () => 'Resuming.',
    stopped: () => 'Stopped.',
    looping: (count) => (count > 1 ? `Looping it ${count} times.` : 'Replaying once.'),
    loopNothing: () => 'Nothing is playing right now; play something first, then ask me to loop it.',
    playing: (title) => `Now playing ${title}.`,
    playModeFloat: () => 'Switched to floating mode.',
    playModePlayer: () => 'Switched to player mode.',
    playModeToggled: () => 'Playback mode switched.',
  },
}

export function pickI18n(lang: string): MediaControlI18n {
  if (mediaControlI18n[lang]) return mediaControlI18n[lang]
  const prefix = lang.toLowerCase().split(/[-_]/)[0]
  return mediaControlI18n[prefix] ?? mediaControlI18n['zh-CN']
}
