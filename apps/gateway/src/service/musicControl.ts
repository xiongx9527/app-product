/**
 * 音乐控制指令识别：把用户口语映射到动作，绕开大模型，保证「说播放就真播」。
 * 只识别高置信度的控制词，避免与普通对话冲突（如「我想听你说」不会误触发）。
 */

export type MusicAction = 'play' | 'next' | 'pause' | 'resume' | 'stop'

const ACTION_PATTERNS: Array<{ action: MusicAction; re: RegExp }> = [
  // 停止类：强意图，优先匹配
  { action: 'stop', re: /(停止播放|关掉(音乐|播放)|别放了|停(掉)?音乐|关闭音乐|不(要|放)了|停播)/ },
  // 暂停类
  { action: 'pause', re: /(暂停|先停|停一下|歇一下)/ },
  // 继续类
  { action: 'resume', re: /(继续(播放|放)?|接着(放|播|听)|恢复(播放)?|再放)/ },
  // 换一首 / 换个风格 / 下一首
  { action: 'next', re: /(换一?首|下一?首|换个?风格|换首|切歌|来点别的|换一?个风格|换台)/ },
  // 开始播放类（故意不含「我想听/想听」，避免「我想听你说」误触发）
  { action: 'play', re: /(播(放|歌)|来一?首|放一?首|点一?首|唱一?首|唱首|放歌|听歌|整首|放点)/ },
]

/** 返回匹配到的音乐动作；非音乐指令返回 null。 */
export function detectMusicCommand(text: string): MusicAction | null {
  const t = (text || '').trim()
  if (!t) return null
  for (const { action, re } of ACTION_PATTERNS) {
    if (re.test(t)) return action
  }
  return null
}
