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
  loopRemaining.value = Number.isFinite(total) && total > 1 ? Math.floor(total) - 1 : 0
  try {
    instance.stop()
  } catch {
    // 未在播放时 stop 可能抛错，忽略
  }
  instance.src = nextUrl
  // 单曲循环由我们自己在 onEnded 里重播实现（可精确控制遍数），故原生 loop 始终关闭。
  instance.loop = false
  instance.volume = ducked ? 0.2 : 1
  const playPromise = instance.play() as unknown as Promise<void> | undefined
  if (playPromise && typeof playPromise.catch === 'function') {
    // 浏览器自动播放策略可能在用户手势之外拦截：保留 visible，把 playing 置回
    // false 并标记错误，等用户在音乐条上点「换/暂/停」（手势）时重试。
    playPromise.catch(() => {
      playing.value = false
      musicError.value = true
    })
  }
  playing.value = true
}

/** 暂停当前播放（再调用 resumeMusic 恢复）。 */
export function pauseMusic(): void {
  if (!ctx) return
  try {
    ctx.pause()
    paused.value = true
  } catch {
    // 某些平台 pause 不支持，忽略
  }
}

/** 恢复（继续）被暂停的播放。 */
export function resumeMusic(): void {
  if (!ctx) return
  try {
    ctx.play()
    paused.value = false
  } catch {
    // 忽略
  }
}

/** 停止当前播放。 */
export function stopMusic(): void {
  if (ctx) {
    try {
      ctx.stop()
    } catch {
      // 忽略
    }
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
 * 切换单曲循环（音乐条「循环」按钮）：
 *  - 开：loopRemaining 置 Infinity，当前曲播完无限重播，直到再点/停止/换歌/新下发 media.play；
 *  - 关：置 0，播完即停。
 * onEnded 里 `loopRemaining -= 1` 对 Infinity 仍是 Infinity，故无限循环天然成立。
 * 若当前已是「已播完」态，开启时立即从头再播，且不重置 loopRemaining（不走 playMusic）。
 */
export function toggleLoop(): void {
  if (loopRemaining.value > 0) {
    loopRemaining.value = 0
    return
  }
  loopRemaining.value = Number.POSITIVE_INFINITY
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

/** TTS 播报时压低音乐音量，避免盖住助手说话；播完恢复。 */
export function duckMusic(shouldDuck: boolean): void {
  ducked = shouldDuck
  if (!ctx) return
  try {
    ctx.volume = shouldDuck ? 0.2 : 1
  } catch {
    // 某些平台 volume 只读，忽略
  }
}

/** 暴露给界面的只读状态 */
export const musicState = {
  playing,
  paused,
  ended,
  loopRemaining,
  musicError,
  visible,
  title,
  url,
  currentTime,
  duration,
  live,
}

