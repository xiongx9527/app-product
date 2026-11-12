import { ref } from 'vue'

/**
 * 音乐播放器：用独立的 InnerAudioContext 播放网关下发的媒体流（电台/歌曲），
 * 与 TTS 的 WebAudio 播放互不干扰。TTS 播报期间压低音量（duck），播完恢复。
 */

const playing = ref(false)
const title = ref('')
const url = ref('')
/** 已播放秒数；电台是无限流，这里当「已听时长」用 */
const currentTime = ref(0)
/** 总时长（秒）；电台为 Infinity/0，用 live 标记区分 */
const duration = ref(0)
/** 直播流没有总时长，界面显示「直播」而不是进度条 */
const live = ref(false)
/** 是否处于暂停状态（暂停后进度不再推进） */
const paused = ref(false)
/** 当前曲目是否已自然播放完毕（非暂停、非出错）；用于让「暂停」按钮显出「重播」态 */
const ended = ref(false)
/**
 * 还需自动重播的次数（单曲循环）：playMusic 带 loop=N 时记为 N-1（首遍已开始），
 * 每次 onEnded 重播一次并递减，归零后进入 ended 态。0 表示不循环。
 */
const loopRemaining = ref(0)
/** 播放是否出错（如地址失效/网络不通/被浏览器自动播放策略拦截）；用于界面提示，不弹浮层 */
const musicError = ref(false)
/** 音乐播放音量（0–1）；界面滑块控制，TTS 播报时按 DUCK_FACTOR 压低。 */
const musicVolume = ref(0.5)
/** TTS 播报时压低音乐的系数（与播放器自身音量相乘）。 */
const DUCK_FACTOR = 0.2
/**
 * 音乐条是否应当显示：只要下发过一首歌（playMusic）就为 true，停止才清掉。
 * 与 playing 解耦——播放被浏览器自动播放策略拦截或地址失效时，playing 会变回
 * false，但我们仍要保留音乐条，把歌名与「播放失败」提示展示出来，而不是整条消失
 * （否则用户只看到助手说「正在播放」却什么都没有，误以为没播）。
 */
const visible = ref(false)

let ctx: UniApp.InnerAudioContext | null = null
/** 是否处于 TTS 播报中；播报中新建/恢复播放也要保持压低音量 */
let ducked = false

function ensureContext(): UniApp.InnerAudioContext | null {
  if (ctx) return ctx
  const scope = globalThis as unknown as {
    uni?: { createInnerAudioContext?: () => UniApp.InnerAudioContext }
  }
  const create = scope.uni?.createInnerAudioContext
  if (typeof create !== 'function') return null
  const instance = create.call(scope.uni)
  instance.onPlay(() => {
    playing.value = true
    paused.value = false
  })
  instance.onStop(() => {
    playing.value = false
    paused.value = false
  })
  instance.onPause(() => {
    paused.value = true
  })
  instance.onEnded(() => {
    // 单曲循环：onPlay 会把 playing 重新置 true、paused 置 false，所以这里先重播再返回，
    // 不进「播完」态。loopRemaining 是「还要重播几次」，首遍已算在内故从 N-1 开始递减。
    if (loopRemaining.value > 0) {
      loopRemaining.value -= 1
      // 重播从 0 开始：同步把进度读数归零，否则 currentTime 还停在上一遍末尾，
      // 字幕高亮会卡在最后一行、看起来「循环后字幕没跟着来」。
      currentTime.value = 0
      try {
        instance.seek(0)
      } catch {
        // 直播流或不支持 seek 的平台忽略，直接 play 也会从头
      }
      instance.play()
      return
    }
    playing.value = false
    paused.value = false
    ended.value = true
  })
  instance.onError(() => {
    playing.value = false
    paused.value = false
    musicError.value = true
  })
  // H5 的 onTimeUpdate 回调不带参数（uni-h5 直接 callback()），
  // 只能从 context 上读 currentTime / duration；原生端同样支持这两个 getter。
  const syncProgress = () => {
    const time = Number(instance.currentTime)
    const total = Number(instance.duration)
    if (Number.isFinite(time) && time >= 0) currentTime.value = time
    if (Number.isFinite(total) && total > 0) {
      duration.value = total
      live.value = false
    }
  }
  instance.onTimeUpdate(syncProgress)
  instance.onSeeked(syncProgress)
  instance.onCanplay(() => {
    const total = Number(instance.duration)
    if (Number.isFinite(total) && total > 0) {
      duration.value = total
      live.value = false
    } else {
      live.value = true
    }
    syncProgress()
  })
  ctx = instance
  return ctx
}

/** 开始播放一段媒体流；会先停掉上一段，避免叠音。 */
export function playMusic(
  nextUrl: string,
  nextTitle: string,
  opts?: { loop?: number }
): void {
  if (!nextUrl) return
  // 幂等防护：同一首歌正在播放时，重复下发的 media.play（重武装 / 重连 / 两条路径同时触发）
  // 不再 stop+play 重头放一遍——否则听感就是「放两遍」。已自然播完（ended）后的重播是用户
  // 明确意图（点重播按钮 / 换源），不在防护范围内，照常播放。
  if (nextUrl === url.value && playing.value && !ended.value) return
  // 复用同一 InnerAudioContext 实例：原生端直接给实例换 src 即可重新拉流（这是 uni
  // 原生音频的标准用法，比销毁重建更稳——重建在部分机型上会与旧实例抢音频焦点而播不出）。
  // 切换前先 stop 旧曲，避免叠音。
  const instance = ensureContext()
  if (!instance) return
  url.value = nextUrl
  title.value = nextTitle
  currentTime.value = 0
  duration.value = 0
  live.value = false
  paused.value = false
  ended.value = false
  musicError.value = false
  visible.value = true
  // loop 是「总共播放几遍」：首遍已经要播，所以「还要重播几次」= N-1；
  // 不合法（缺省/1/非正整数）一律当作不循环。
  const total = Number(opts?.loop)
  const validLoop = Number.isFinite(total) && total > 1
  loopRemaining.value = validLoop ? Math.floor(total) - 1 : 0
  // 同步循环档位索引：命中预设则记录，否则（普通播放 / 非预设遍数）记为关闭，
  // 保证音乐条「循环」按钮的当前档位与实际一致。
  loopPresetIndex.value = validLoop ? LOOP_PRESETS_TOTAL.indexOf(Math.floor(total)) : -1
  // 先停旧曲（未在播放时 stop 个别平台会抛错，忽略），再赋新 src 并播放。
  try {
    instance.stop()
  } catch {
    // 未播放时 stop 可能抛错，忽略
  }
  instance.src = nextUrl
  // 单曲循环由我们自己在 onEnded 里重播实现（可精确控制遍数），故原生 loop 始终关闭。
  instance.loop = false
  applyVolume()
  try {
    instance.play()
  } catch {
    // 个别平台 play 不支持或异常，忽略，由界面/重试兜底
  }
  playing.value = true
}

/** 暂停当前播放（再调用 resumeMusic 恢复）。 */
export function pauseMusic(): void {
  if (!ctx) return
  // paused 是「意图」状态，必须无条件置位：即使 ctx.pause() 在个别平台抛错，
  // 界面也要立即反映暂停，否则按钮图标会与真实状态脱节。
  try {
    ctx.pause()
  } catch {
    // 某些平台 pause 不支持，忽略
  }
  paused.value = true
}

/** 恢复（继续）被暂停的播放。 */
export function resumeMusic(): void {
  if (!ctx) return
  // 与 pauseMusic / playMusic 一致：paused 无条件置 false，先反映「意图继续」，
  // 若 ctx.play() 被浏览器自动播放策略拦截（非用户手势触发，如语音指令），
  // 用 playPromise 的 reject 标记 musicError，但不回退 paused，让按钮正确切回暂停态。
  try {
    const p = ctx.play() as unknown as Promise<void> | undefined
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        musicError.value = true
      })
    }
  } catch {
    musicError.value = true
  }
  paused.value = false
}

/** 停止当前播放。 */
export function stopMusic(): void {
  if (ctx) {
    try {
      ctx.stop()
    } catch {
      // 忽略
    }
    // 原生端必须 destroy：仅 stop() 不会释放底层音频对象，webview 刷新后它仍会
    // 在原生音频层继续播放、且无法再被本页面控制（表现为「关不掉 / 刷新后还在放」）。
    // 销毁后下一次 playMusic 会经 ensureContext 重建，不影响再次播放。
    try {
      ctx.destroy()
    } catch {
      // 个别平台 destroy 不支持，忽略
    }
    ctx = null
  }
  playing.value = false
  paused.value = false
  ended.value = false
  loopRemaining.value = 0
  currentTime.value = 0
  duration.value = 0
  live.value = false
  musicError.value = false
  visible.value = false
}

/** 当前曲目自然播完后再点「播放」：从开头重新播放一遍（不循环）。 */
export function replayMusic(): void {
  if (!url.value) return
  playMusic(url.value, title.value)
}

/**
 * 循环播放的遍数预设（总播放遍数，含当前这一遍）：3 / 5 / 10 / 无限。
 * 点按循环按钮依次循环；默认 3 次。
 */
export const LOOP_PRESETS_TOTAL = [3, 5, 10, Number.POSITIVE_INFINITY]

/** 当前循环档位索引：-1 表示关闭，其余对应 LOOP_PRESETS_TOTAL。 */
const loopPresetIndex = ref(-1)

/**
 * 应用某一循环档位：把 loopRemaining 设为「除当前这一遍外还要重播几次」，
 * 即界面要显示的剩余次数（无限时为 Infinity）。仅在「已播完」态开启循环时立即从头重播。
 */
function applyLoopPreset(index: number): void {
  loopPresetIndex.value = index
  if (index < 0) {
    loopRemaining.value = 0
    return
  }
  const total = LOOP_PRESETS_TOTAL[index]
  loopRemaining.value = Number.isFinite(total) ? total - 1 : Number.POSITIVE_INFINITY
  if (ended.value) {
    const instance = ensureContext()
    if (!instance) return
    try {
      instance.seek(0)
    } catch {
      // 直播流或不支持 seek 的平台忽略
    }
    instance.play()
    ended.value = false
  }
}

/**
 * 音乐条「循环」按钮：按预设循环切换（关 → 3 → 5 → 10 → ∞ → 关）。
 * 默认首次开启为 3 次；循环过程中再点切到下一档，到 ∞ 后再点关闭。
 */
export function cycleLoop(): void {
  const next = loopPresetIndex.value + 1
  applyLoopPreset(next >= LOOP_PRESETS_TOTAL.length ? -1 : next)
}

/** 拖动进度条：只在有总时长的歌曲上有效，电台忽略。 */
export function seekMusic(seconds: number): void {
  if (!ctx) return
  if (!Number.isFinite(seconds) || seconds < 0) return
  try {
    ctx.seek(seconds)
    currentTime.value = seconds
  } catch {
    // 直播流或不支持 seek 的平台忽略
  }
}

/** 把当前音量（用户音量 × 压低系数）写到播放器；平台 volume 只读时忽略。 */
function applyVolume(): void {
  if (!ctx) return
  try {
    ctx.volume = musicVolume.value * (ducked ? DUCK_FACTOR : 1)
  } catch {
    // 某些平台 volume 只读，忽略
  }
}

/** 设置音乐播放音量（0–1）；TTS 播报时仍会按 DUCK_FACTOR 压低。 */
export function setMusicVolume(value: number): void {
  const v = Number(value)
  musicVolume.value = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
  applyVolume()
}

/** TTS 播报时压低音乐音量，避免盖住助手说话；播完恢复。 */
export function duckMusic(shouldDuck: boolean): void {
  ducked = shouldDuck
  applyVolume()
}

/** 暴露给界面的只读状态 */
export const musicState = {
  playing,
  paused,
  ended,
  loopRemaining,
  musicError,
  musicVolume,
  visible,
  title,
  url,
  currentTime,
  duration,
  live,
}

