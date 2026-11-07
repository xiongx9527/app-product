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
  })
  instance.onStop(() => {
    playing.value = false
  })
  instance.onEnded(() => {
    playing.value = false
  })
  instance.onError(() => {
    playing.value = false
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
export function playMusic(nextUrl: string, nextTitle: string): void {
  if (!nextUrl) return
  const instance = ensureContext()
  if (!instance) return
  url.value = nextUrl
  title.value = nextTitle
  currentTime.value = 0
  duration.value = 0
  live.value = false
  try {
    instance.stop()
  } catch {
    // 未在播放时 stop 可能抛错，忽略
  }
  instance.src = nextUrl
  // 电台是无限流、歌曲是有限时长：统一不循环，播完即停
  instance.loop = false
  instance.volume = ducked ? 0.2 : 1
  instance.play()
  playing.value = true
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
  currentTime.value = 0
  duration.value = 0
  live.value = false
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
  title,
  url,
  currentTime,
  duration,
  live,
}
