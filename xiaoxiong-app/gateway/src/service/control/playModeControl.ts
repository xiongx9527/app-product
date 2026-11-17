/**
 * 播放模式切换指令识别：在「悬浮小圆」与「普通播放条」之间切换，绕开大模型。
 * 只认高置信度的模式切换说法，避免与点歌 / 换一首 / 字幕开关冲突。
 *
 *  - float：明确切到悬浮（打开悬浮 / 切到悬浮 / 悬浮模式…）
 *  - player：明确切回播放器（关闭悬浮 / 切回播放器 / 播放器模式…）
 *  - toggle：只说切换（切换播放模式 / 换个播放模式 / 切换模式…），由客户端翻转当前模式
 *
 * 注意：「切换播放模式」「换个播放模式」含「播放」，会被音乐指令的 play 词误中，
 * 故本检测必须在 detectMusicCommand 之前执行。
 */
export type PlayModeAction = 'float' | 'player' | 'toggle' | null

// 先判「退出/关闭悬浮」，避免被下面「切换悬浮」误判成 float
const TO_PLAYER_RE =
  /(关闭|关掉|退出|不要|别用)悬浮|切回(播放器|播放条)|播放器模式|播放条模式|普通模式|切换播放器|换成播放器/
const TO_FLOAT_RE = /(打开|开启|显示|用|切到|换成|变成|要|切换)悬浮|悬浮模式/
const TOGGLE_RE = /(切换|换|改变|改).{0,6}(播放模式|显示模式|模式)|切换模式/

/** 返回匹配到的播放模式切换动作；非模式切换指令返回 null。 */
export function detectPlayModeCommand(text: string): PlayModeAction {
  const t = (text || '').replace(/\s/g, '')
  if (!t) return null
  if (TO_PLAYER_RE.test(t)) return 'player'
  if (TO_FLOAT_RE.test(t)) return 'float'
  if (TOGGLE_RE.test(t)) return 'toggle'
  return null
}
