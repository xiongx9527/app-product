<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { readScreenInfo, type ScreenInfo } from '@/core/adaptation/screen'
import { FLOAT_POSITION_PRESETS } from '@/core/adaptation/floatLayer'
import { appConfig, persistConfig } from '@/core/config'
import { DEFAULT_SUBTITLE_FONT_SIZE, DEFAULT_SUBTITLE_COLOR } from '@/core/config/constants'
import FloatLayer from '@/components/FloatLayer.vue'
import DetailRenderer from '@/components/DetailRenderer.vue'
import { useAssistant } from '@/features/assistant/useAssistant'
import { captureRecommendation } from '@/features/recommend/recommendStore'
import { toDisplayText } from '@/core/text/displayText'
import { toReplyHtml } from '@/core/text/replyHtml'
import {
  elapsedLabel,
  isSeekable,
  progressPercent,
  seekSeconds,
  totalLabel,
} from '@/core/audio/musicProgress'
import { t } from '@/core/i18n'
import { playPromptCue, type PromptCue } from '@/core/audio/promptPlayer'
import { useHealth, toHealthItems, type HealthItem } from '@/features/assistant/useHealth'
import { usePermissions, type PermissionItem } from '@/features/assistant/usePermissions'
import type { PermissionState } from '@/core/permission/permissionStatus'

const {
  state,
  stateLabel,
  enabled,
  transcript,
  reply,
  thinking,
  thinkingDone,
  replyDone,
  phase,
  phaseLabel,
  isSpeaking,
  halfDuplex,
  queuePending,
  queueFullMsg,
  liveText,
  errorMessage,
  gatewayPreparing,
  wsConnected,
  connecting,
  retry,
  wake,
  enable,
  disable,
  interrupt,
  musicPlaying,
  musicPaused,
  musicEnded,
  musicLoopActive,
  musicLoopRemaining,
  musicVolume,
  setMusicVolume,
  reportVolume,
  musicError,
  musicVisible,
  musicTitle,
  musicCover,
  musicCurrent,
  musicDuration,
  musicLive,
  subtitle,
  copySubtitle,
  copied,
  activeSubtitleIndex,
  currentSubtitleText,
  activeSubtitleSplit,
  stopMusic,
  pauseMusic,
  resumeMusic,
  replayMusic,
  cycleLoop,
  nextMusic,
  seekMusic,
  closeSubtitle,
  detailCard,
  selectDetail,
  closeDetailCard,
} = useAssistant()

/**
 * 助手推荐结果（好价商品 / 开源工具）按 media.detail.kind 自动收进本地列表，
 * 让「推荐设置」里的列表入口能回看历史推荐。只在列表形态（未选中单条）时收，避免重复写。
 */
watch(detailCard, (d) => {
  if (d) captureRecommendation(d)
})

/** 悬浮小圆是否显示：开关打开 + 有内容在播放即可；无封面时显示占位唱片，所有播放内容同等对待 */
const floatDiscVisible = computed(
  () => appConfig.playback.floatPlayer === true && musicVisible.value,
)

/**
 * 切换播放模式（悬浮小圆 ↔ 普通播放条）：与语音「切换播放模式」共用同一份状态
 * appConfig.playback.floatPlayer，并落盘。这样手动切与语音切指向同一个真相源，
 * 不会像「临时收起标记」那样让语音再也切不回来。
 */
function onTogglePlayMode(): void {
  appConfig.playback.floatPlayer = !appConfig.playback.floatPlayer
  persistConfig()
}

/** 切换按钮上的图标：指向「将要切到的模式」——悬浮态显示「切到播放条」，播放条态显示「切到悬浮小圆」 */
const floatPlayerIcon = computed(() =>
  appConfig.playback.floatPlayer ? '/static/icons/mode-bar.svg' : '/static/icons/mode-disc.svg',
)

/** 位置从设置读取（通用 FloatPosition 参数），非法值回退顶部居中 */
const floatDiscPosition = computed(
  () =>
    FLOAT_POSITION_PRESETS[appConfig.playback.floatPosition ?? 'top-center'] ??
    FLOAT_POSITION_PRESETS['top-center'],
)

/** 估算歌词占宽当量（中文/全角按 1 字，英数按 0.55 字） */
function lyricCharWidth(s: string): number {
  let n = 0
  for (const ch of s) n += /[\x00-\xff]/.test(ch) ? 0.55 : 1
  return n
}

/** 当前字幕字号/颜色：来自设置页预设，缺省 18px / 白色；作用于悬浮当前句与字幕面板高亮行 */
const subtitleActiveFontSize = computed(() => appConfig.playback.subtitleFontSize ?? DEFAULT_SUBTITLE_FONT_SIZE)
const subtitleActiveColor = computed(() => appConfig.playback.subtitleColor ?? DEFAULT_SUBTITLE_COLOR)

/** 单行显示整句：以用户设置字号为上限，超长句按比例缩到不换行（最低 13），不撑宽容器 */
const lyricFontSize = computed(() => {
  const base = subtitleActiveFontSize.value
  const w = Math.max(1, lyricCharWidth(currentSubtitleText.value))
  return Math.round(Math.max(13, Math.min(base, 280 / w)))
})

// 网关能力健康度：连上 WS 后轮询 /api/health，把 LLM / ASR / TTS / 外网状态展示出来，
// 静默失效（如 ASR 仍是占位桩）能直接被看到，而不是「唤醒没反应」却毫无提示。
const { health } = useHealth(wsConnected)
const healthItems = computed(() => (health.value ? toHealthItems(health.value) : []))
// 权限只读检测：麦克风/定位排在能力项前，用 | 隔离（见健康面板模板）
const { permissionItems } = usePermissions(wsConnected)

// 点击状态胶囊后的「状态播报」：固定在健康栏下方的行内文字（绝不弹浮层），
// 异常项再补一声本地 mp3 提示音。定位是非必须能力，只显示状态、不播报。
type StatusCapsule = PermissionItem | HealthItem
const activeCapsule = ref<string | null>(null)
const HEALTH_CUE: Record<HealthItem['key'], PromptCue> = {
  llm: 'llmDown',
  asr: 'asrDown',
  tts: 'ttsDown',
  network: 'networkDown',
}

function statusWord(status: string): string {
  if (status === 'ok') return t('health.ok')
  if (status === 'warn') return t('health.unconfigured')
  return t('health.unreachable')
}

function capsuleDetail(item: StatusCapsule): string {
  if ('state' in item) return t(`health.perm.${item.state}`)
  return item.detail || statusWord(item.status)
}

const narrationText = computed(() => {
  const key = activeCapsule.value
  if (!key) return ''
  const items: StatusCapsule[] = [...permissionItems.value, ...healthItems.value]
  const item = items.find((i) => i.key === key)
  if (!item) return ''
  return t('health.narration', { name: t(`health.${key}`), status: capsuleDetail(item) })
})

function onStatusTap(item: StatusCapsule): void {
  // 再点同一颗收起说明
  if (activeCapsule.value === item.key) {
    activeCapsule.value = null
    return
  }
  activeCapsule.value = item.key
  // 正常态没有对应提示音，只显示文字；定位按既有约定一律不播报。
  if ('state' in item) {
    if (item.key === 'mic' && item.state === 'denied') playPromptCue('micDenied')
    return
  }
  if (item.status !== 'ok') playPromptCue(HEALTH_CUE[item.key])
}

const screen = ref<ScreenInfo>(readScreenInfo())

const isActive = computed(() => state.value === 'listening' || state.value === 'confirming')
// 模型回复可能是 Markdown 或 HTML，统一转成 rich-text 能渲染的安全 HTML
const replyHtml = computed(() => toReplyHtml(reply.value))
// 思考过程会很长，界面只留最近一段，避免卡片被撑爆
const thinkingTail = computed(() => {
  const text = toDisplayText(thinking.value)
  return text.length > 240 ? `…${text.slice(-240)}` : text
})

// 拖动进度条时先用手指位置显示，松手才真正 seek，避免 timeupdate 把滑块拽回去
const seekPreview = ref<number | null>(null)
const musicProgress = computed(() => ({
  currentTime: musicCurrent.value,
  duration: musicDuration.value,
  live: musicLive.value,
}))
const musicSeekable = computed(() => isSeekable(musicProgress.value))
const musicPercent = computed(() => progressPercent(musicProgress.value, seekPreview.value))

/** 悬浮小圆外层环形进度：conic-gradient 按播放百分比画一圈（直播/未知时长固定 0）；
 * 民国铜色环，与老式播放器主题一致（原为科技蓝） */
const discProgressStyle = computed(() => {
  const pct = Math.min(100, Math.max(0, musicPercent.value))
  return {
    background: `conic-gradient(#c9a063 0%, #e7c987 ${pct}%, rgba(180,140,80,0.18) ${pct}%, rgba(180,140,80,0.18) 100%)`,
  }
})
const musicElapsed = computed(() => elapsedLabel(musicProgress.value, seekPreview.value))
const musicTotal = computed(() => totalLabel(musicProgress.value))

// 循环按钮角标：总播放遍数（含当前这一遍）= 剩余重播次数 + 1，随重播递减；
// 无限循环显示 ∞；未循环（loopRemaining 为 0）不显示。
const loopBadge = computed(() => {
  const r = musicLoopRemaining.value
  if (!Number.isFinite(r)) return '∞'
  return r > 0 ? String(r + 1) : ''
})

// 音乐音量：滑块控制 0–1；0 视为静音，图标切换为静音态。
const musicMuted = computed(() => musicVolume.value < 0.005)
// 喇叭放在播放进度之后，点它展开/收起竖向音量滑块（上下拖拉调音量），
// 避免再出现一条全宽滑杆。
const volExpanded = ref(false)

// 竖向音量轨道：按手指/鼠标在轨道内的纵向位置换算音量（轨道底部=0，顶部=1）。
// 原生 slider 仅横向、CSS 旋转后拖不动，这里用自定义轨道替代。
// 同时支持触摸与鼠标（桌面 :5173 用鼠标，没有触摸事件），用模板 ref 同步取轨道位置（H5 可靠），
// 拿不到时退回 uni.createSelectorQuery 缓存，供原生 App 兜底。
const volTrackRef = ref<unknown>(null)
let volTrackRect: { top: number; height: number } | null = null
let volDragging = false

function volRectFromRef(): { top: number; height: number } | null {
  const raw = (volTrackRef.value as { $el?: unknown } | null) ?? null
  const node = (raw && (raw as { $el?: unknown }).$el) ?? raw
  const el = node as { getBoundingClientRect?: () => { top: number; height: number } } | null
  const rect = el?.getBoundingClientRect?.()
  if (rect && Number.isFinite(rect.height) && rect.height > 0) return { top: rect.top, height: rect.height }
  return null
}

// 从触摸或鼠标事件里取视口 Y 坐标（clientY 两者通用；触摸走 touches[0].clientY）
function clientYOf(event: unknown): number {
  const e = event as { clientY?: number; touches?: Array<{ clientY?: number }> }
  if (typeof e.clientY === 'number') return e.clientY
  const t = e.touches?.[0]
  if (t && typeof t.clientY === 'number') return t.clientY
  return NaN
}

function applyVolFromY(event: unknown): void {
  const y = clientYOf(event)
  if (!Number.isFinite(y)) return
  const rect = volRectFromRef() ?? volTrackRect
  if (!rect) {
    // 退回异步查询并缓存，待后续 move 复用（本次先不跳变）
    uni.createSelectorQuery()
      .select('.vol-track')
      .boundingClientRect((r: unknown) => {
        const rr = r as { top: number; height: number } | null
        if (rr && rr.height) volTrackRect = { top: rr.top, height: rr.height }
      })
      .exec()
    return
  }
  volTrackRect = rect
  const frac = 1 - (y - rect.top) / rect.height
  setMusicVolume(Math.min(1, Math.max(0, frac)))
}

// 按下：开始拖动并立即按落点设一次音量；桌面端鼠标拖动监听 window，保证移出轨道仍跟手
function onVolStart(event: unknown): void {
  volDragging = true
  applyVolFromY(event)
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', onVolMove)
    window.addEventListener('mouseup', onVolEnd)
  }
}

// 移动：仅在拖动中更新（触摸由元素上的 @touchmove 触发；鼠标由 window mousemove 触发）
function onVolMove(event: unknown): void {
  if (!volDragging) return
  applyVolFromY(event)
}

function onVolEnd(): void {
  volDragging = false
  if (typeof window !== 'undefined') {
    window.removeEventListener('mousemove', onVolMove)
    window.removeEventListener('mouseup', onVolEnd)
  }
  // 拖完上报最终音量，让网关音量状态与本地同步（供语音「调大/调小」相对增减准确）。
  // 只在上报用户拖动结果，不监听 musicVolume 变化，避免网关下发 media.volume 又被回执成环。
  reportVolume(musicVolume.value)
}

// 点喇叭图标：展开/收起音量滑块；图标本身按 musicMuted 显示静音态。
function onToggleVolExpand(): void {
  volExpanded.value = !volExpanded.value
  // 展开后预热轨道位置缓存：原生 App 没有 DOM 节点可同步读取，靠 selectorQuery 兜底，
  // 这样第一下拖动就有位置可算，不至于「点了没反应」。
  if (volExpanded.value) {
    nextTick(() => {
      uni.createSelectorQuery()
        .select('.vol-track')
        .boundingClientRect((r: unknown) => {
          const rr = r as { top: number; height: number } | null
          if (rr && rr.height) volTrackRect = { top: rr.top, height: rr.height }
        })
        .exec()
    })
  }
}

function readSliderValue(event: unknown): number {
  const detail = (event as { detail?: { value?: unknown } } | null)?.detail
  const value = Number(detail?.value)
  return Number.isFinite(value) ? value : 0
}

function onSeekPreview(event: unknown): void {
  if (!musicSeekable.value) return
  seekPreview.value = seekSeconds(readSliderValue(event), musicDuration.value)
}

function onSeekCommit(event: unknown): void {
  if (!musicSeekable.value) return
  seekMusic(seekSeconds(readSliderValue(event), musicDuration.value))
  seekPreview.value = null
}

function onStopMusic(): void {
  seekPreview.value = null
  stopMusic()
}

function onTogglePause(): void {
  seekPreview.value = null
  // 已自然播完：按钮即「继续播放」，点一下从头重播一遍
  if (musicEnded.value) {
    replayMusic()
    return
  }
  if (musicPaused.value) resumeMusic()
  else pauseMusic()
}

function onToggleLoop(): void {
  seekPreview.value = null
  cycleLoop()
}

function onNextMusic(): void {
  seekPreview.value = null
  nextMusic()
}

const hint = computed(() => {
  // 静默提示与退出优先，其余按对话阶段说明「现在在干嘛」，免得用户以为卡住
  if (state.value === 'confirming') return t('hint.confirming')
  if (state.value === 'closing') return t('hint.closing')
  switch (phase.value) {
    case 'listening':
      return t('hint.listening')
    case 'thinking':
      return t('hint.thinking')
    case 'replying':
      return t('hint.replying')
    case 'speaking':
      return halfDuplex.value ? t('hint.speakingHalf') : t('hint.speakingFull')
    case 'done':
      return t('hint.done')
    default:
      return state.value === 'idle' ? t('hint.idle') : t('hint.standby')
  }
})

function onResize(): void {
  screen.value = readScreenInfo()
}

function openSettings(): void {
  uni.navigateTo({ url: '/pages/settings/settings' })
}

onMounted(() => {
  uni.onWindowResize(onResize)
})

onUnmounted(() => {
  uni.offWindowResize(onResize)
  // 清掉音量拖动可能遗留的 window 监听，避免泄漏
  volDragging = false
  if (typeof window !== 'undefined') {
    window.removeEventListener('mousemove', onVolMove)
    window.removeEventListener('mouseup', onVolEnd)
  }
})

function onToggle(event: Event): void {
  const value = (event as unknown as { detail?: { value?: boolean } }).detail?.value
  if (typeof value !== 'boolean') return
  if (value) enable()
  else disable()
}

function onOrbTap(): void {
  // 未开启时点圆球先开启；已在待唤醒时点圆球手动开始一轮（等同说「小熊小熊」）
  if (state.value === 'idle') enable()
  else if (state.value === 'standby') wake()
}

// 网关未连上时，点状态胶囊即可手动重连（沿用开启唤醒时的会话模式），不另出独立标签
function onConnTap(): void {
  if (!wsConnected.value && enabled.value) retry()
}
</script>

<template>
  <view class="page" :class="`bp-${screen.breakpoint}`">
    <view class="header">
      <view class="brand">
        <text class="title">{{ t('app.title') }}</text>
        <text class="subtitle">{{ t('app.subtitle') }}</text>
      </view>
      <view class="header-actions">
        <view class="pill" :class="state">{{ stateLabel }}</view>
        <view class="gear" @tap="openSettings">⚙</view>
      </view>
    </view>

    <view class="status-row">
      <view
        class="conn"
        :class="wsConnected ? 'ok' : (connecting ? 'connecting' : 'down')"
        @tap="onConnTap"
      >
        <view class="conn-dot" />
        <text class="conn-text">{{ connecting ? t('conn.connecting') : (wsConnected ? t('conn.connected') : t('conn.disconnected')) }}</text>
      </view>

      <view v-if="wsConnected" class="health">
        <!-- 权限组放最前：本地只读检测，连上 WS 即显示，不依赖网关 health 是否成功 -->
        <view
          v-for="item in permissionItems"
          :key="item.key"
          class="health-item is-tappable"
          :class="[item.status, { active: activeCapsule === item.key }]"
          :aria-label="t('health.narration', { name: t(`health.${item.key}`), status: capsuleDetail(item) })"
          @tap="onStatusTap(item)"
        >
          <view class="health-dot" />
          <text class="health-label">{{ t(`health.${item.key}`) }}</text>
        </view>
        <text v-if="health" class="health-divider">|</text>
        <template v-if="health">
          <view
            v-for="item in healthItems"
            :key="item.key"
            class="health-item is-tappable"
            :class="[item.status, { active: activeCapsule === item.key }]"
            :aria-label="t('health.narration', { name: t(`health.${item.key}`), status: capsuleDetail(item) })"
            @tap="onStatusTap(item)"
          >
            <view class="health-dot" />
            <text class="health-label">{{ t(`health.${item.key}`) }}</text>
          </view>
        </template>
        <view v-else class="health-checking">{{ t('health.checking') }}</view>
      </view>

      <!-- 状态播报：固定行内文字，不用 toast / 浮层 -->
      <view v-if="narrationText" class="health-narration">
        <text class="health-narration-text">{{ narrationText }}</text>
      </view>
    </view>

    <view v-if="queueFullMsg" class="queue-full-banner">{{ queueFullMsg }}</view>

    <view class="stage">
      <view
        class="orb"
        :class="{ active: isActive, speaking: isSpeaking }"
        @tap="onOrbTap"
      >
        <view class="orb-core">
          <text class="orb-icon">{{ isSpeaking ? '◍' : '◉' }}</text>
        </view>
      </view>
      <text class="hint">{{ hint }}</text>
      <text class="phase" :class="phase">{{ phaseLabel }}</text>
      <text v-if="liveText" class="live-text">{{ liveText }}</text>
      <text v-if="gatewayPreparing" class="hint">{{ t('gateway.preparing') }}</text>
      <text v-if="errorMessage" class="error">{{ errorMessage }}</text>
    </view>

    <view class="cards">
      <view class="card">
        <view class="card-head">
          <text class="card-label">{{ t('card.you') }}</text>
          <text v-if="queuePending > 0" class="queue-badge">{{ t('queue.badge', { count: queuePending }) }}</text>
        </view>
        <text class="card-text">{{ transcript || t('card.placeholder') }}</text>
      </view>
      <view v-if="thinking && !thinkingDone && !reply" class="card thinking">
        <view class="card-head">
          <text class="card-label">{{ t('card.thinking') }}</text>
          <text class="card-badge" :class="{ done: thinkingDone }">
            {{ thinkingDone ? t('card.done') : t('card.thinkingBadge') }}
          </text>
        </view>
        <text class="card-text thinking-text">{{ thinkingTail }}</text>
      </view>
      <view v-if="reply" class="card reply">
        <view class="card-head">
          <text class="card-label">{{ t('card.assistant') }}</text>
          <text class="card-badge" :class="{ done: replyDone }">
            {{ replyDone ? t('card.done') : t('card.generating') }}
          </text>
        </view>
        <rich-text class="card-text reply-rich" :nodes="replyHtml" />
      </view>
    </view>

    <!-- 播放条与悬浮小圆互斥：悬浮显示时隐藏播放条，避免两个播放器同时出现 -->
    <view v-if="musicVisible && !floatDiscVisible" class="music-bar">
      <view class="music-row">
        <!-- 民国留声机：大铜喇叭 + 唱片 + 唱针，作为大播放器左侧视觉主体；
             播放时喇叭暖光呼吸、唱片旋转、唱针‘放下’压片；暂停时喇叭收暗、停转、唱针‘拿起’ -->
        <view
          class="music-phono"
          :class="{ 'music-phono--playing': !musicPaused && !musicEnded, 'music-phono--paused': musicPaused || musicEnded }"
        >
          <view class="phono__horn" />
          <view class="phono__tube" />
          <image v-if="musicCover" class="phono__record" :src="musicCover" mode="aspectFill" />
          <view v-else class="phono__record phono__record--placeholder" />
          <view class="phono__tonearm-base" />
          <view class="phono__tonearm" />
        </view>
        <view class="music-info">
          <text class="music-label" :class="{ paused: musicPaused, ended: musicEnded }">{{ musicEnded ? t('music.ended') : musicPaused ? t('music.pausedLabel') : t('music.nowPlaying') }}</text>
          <text class="music-title">{{ musicTitle }}</text>
        </view>
        <view class="music-actions">
          <view class="music-ctrl" :class="{ primary: !musicPaused && !musicEnded }" :aria-label="t('music.next')" @tap="onNextMusic">
            <image class="music-icon" src="/static/icons/next.svg" mode="aspectFit" />
          </view>
          <view class="music-ctrl loop-ctrl" :class="{ primary: musicLoopActive }" :aria-label="musicLoopActive ? t('music.loopOff') + (loopBadge ? (' ' + loopBadge) : '') : t('music.loopOn')" @tap="onToggleLoop">
            <image class="music-icon" src="/static/icons/loop.svg" mode="aspectFit" />
            <text v-if="loopBadge" class="loop-badge">{{ loopBadge }}</text>
          </view>
          <view class="music-ctrl" :aria-label="t('music.stop')" @tap="onStopMusic">
            <image class="music-icon" src="/static/icons/stop.svg" mode="aspectFit" />
          </view>
          <view class="music-ctrl" :aria-label="t('music.playModeToggle')" @tap="onTogglePlayMode">
            <image class="music-icon" :src="floatPlayerIcon" mode="aspectFit" />
          </view>
          <!-- 喇叭提升到顶行：面板作为喇叭的兄弟节点（避免点击面板冒泡到开关而缩回），
               喇叭已在上方，面板改为向下弹出，盖住下方进度行而非飞出屏幕顶部。 -->
          <view class="vol-group">
            <view
              class="music-ctrl vol-ctrl"
              :class="{ muted: musicMuted, active: volExpanded }"
              :aria-label="musicMuted ? t('music.unmute') : t('music.mute')"
              @tap="onToggleVolExpand"
            >
              <image class="music-icon" :src="musicMuted ? '/static/icons/volume-mute.svg' : '/static/icons/volume.svg'" mode="aspectFit" />
            </view>
            <view v-if="volExpanded" class="vol-slider-wrap">
              <text class="vol-pct">{{ Math.round(musicVolume * 100) }}%</text>
              <view
                ref="volTrackRef"
                class="vol-track"
                @touchstart.stop="onVolStart"
                @touchmove.stop="onVolMove"
                @touchend.stop="onVolEnd"
                @mousedown.stop="onVolStart"
              >
                <view class="vol-rail">
                  <view class="vol-fill" :style="{ height: (musicVolume * 100) + '%' }" />
                  <view class="vol-handle" :style="{ bottom: (musicVolume * 100) + '%' }" />
                </view>
              </view>
            </view>
          </view>
        </view>
      </view>
      <text v-if="musicError" class="music-error">{{ t('music.error') }}</text>
      <!-- 播放进度行：暂停/继续按钮提到进度条之前（同一行），其余空间给进度条/直播标识 -->
      <view class="music-progress">
        <view class="music-ctrl" :aria-label="musicEnded ? t('music.resume') : musicPaused ? t('music.resume') : t('music.pause')" @tap="onTogglePause">
          <image class="music-icon" :src="musicEnded || musicPaused ? '/static/icons/play.svg' : '/static/icons/pause.svg'" mode="aspectFit" />
        </view>
        <text class="music-time">{{ musicElapsed }}</text>
        <slider
          v-if="musicSeekable"
          class="music-slider"
          :value="musicPercent"
          :max="100"
          activeColor="#c9a063"
          backgroundColor="rgba(255, 255, 255, 0.14)"
          block-size="10"
          @changing="onSeekPreview"
          @change="onSeekCommit"
        />
        <view v-else class="music-live">
          <view class="music-live-dot" />
          <text class="music-live-text">{{ t('music.live') }}</text>
        </view>
        <text v-if="musicSeekable" class="music-time">{{ musicTotal }}</text>
      </view>
    </view>

    <!-- 字幕面板与悬浮互斥：悬浮小圆已用大字显示当前歌词，不再叠一份完整字幕列表 -->
    <view v-if="subtitle && !floatDiscVisible" class="subtitle">
      <view class="subtitle-head">
        <text class="subtitle-title">{{ t('music.subtitle') }} · {{ subtitle.title }}</text>
        <view class="subtitle-actions">
          <!-- 复制 / 关闭都用图标；复制成功短暂切成对勾（行内反馈，不弹 toast/浮层） -->
          <view v-if="subtitle.lines.length" class="subtitle-icon-btn" :aria-label="copied ? t('music.copied') : t('music.copySubtitle')" @tap="copySubtitle">
            <image class="subtitle-icon" :src="copied ? '/static/icons/check.svg' : '/static/icons/copy.svg'" mode="aspectFit" />
          </view>
          <view class="subtitle-icon-btn" :aria-label="t('music.close')" @tap="closeSubtitle">
            <image class="subtitle-icon" src="/static/icons/close.svg" mode="aspectFit" />
          </view>
        </view>
      </view>
      <text v-if="subtitle.artist" class="subtitle-artist">{{ subtitle.artist }}</text>
      <!-- 滚到当前行「前 2 行」而非当前行：scroll-into-view 会把目标贴在可视区顶部，
           直接滚当前行 Big 字高亮行会被上沿裁住；往前留两行让高亮行落在中部、上下都有上下文。 -->
      <scroll-view v-if="subtitle.lines.length" scroll-y class="subtitle-body" :scroll-into-view="activeSubtitleIndex >= 2 ? 'sub-' + (activeSubtitleIndex - 2) : 'sub-0'" scroll-with-animation>
        <view
          v-for="(line, i) in subtitle.lines"
          :key="i"
          :id="'sub-' + i"
          class="subtitle-line"
          :class="{ 'subtitle-line--active': i === activeSubtitleIndex }"
          :style="i === activeSubtitleIndex ? { fontSize: subtitleActiveFontSize + 'px', color: subtitleActiveColor } : {}"
        ><block v-if="i === activeSubtitleIndex">{{ activeSubtitleSplit.sung }}<text class="subtitle-line--rest">{{ activeSubtitleSplit.rest }}</text></block><block v-else>{{ line.text }}</block></view>
      </scroll-view>
      <text v-else class="subtitle-empty">{{ t('music.noSubtitle') }}</text>
    </view>

    <!-- 结构化详情卡片：独立内嵌面板（与播放条 / 字幕面板同级，不进助手回复框、不悬浮）。
         纯展示状态，不随新一轮对话 / 切语音来源重置，避免被后续回复顶掉。 -->
    <DetailRenderer
      v-if="detailCard"
      :detail="detailCard"
      @select="selectDetail"
      @close="closeDetailCard"
    />

    <!-- 悬浮小圆：通用悬浮层的一个业务（音乐播放器），内容与容器解耦。
         z-index / 角落由 FloatLayer 统一管；圆形封面播放时旋转、暂停停，下方大字是当前正在唱的那句。 -->
    <!-- 位置由 playback.floatPosition 配置作为统一参数传入，通用层只认参数；点击小圆切暂停/继续 -->
    <FloatLayer id="music-disc" :visible="floatDiscVisible" :position="floatDiscPosition">
      <!-- 固定宽度内容层：歌词再长也不撑宽容器，FloatLayer 的 translateX(-50%) 基准恒定，
           位置不会左右移动；小圆与歌词都在此层内居中，整体严格顶部居中 -->
      <view class="float-disc-body">
        <!-- 切换播放模式（悬浮小圆 ↔ 普通播放条）：与语音「切换播放模式」共用 floatPlayer 状态并落盘；
             @tap.stop 避免误触小圆本身的暂停/继续；不是单纯关闭，故与语音切换互相可逆 -->
        <view class="disc-mode-toggle" :aria-label="t('music.playModeToggle')" @tap.stop="onTogglePlayMode">
          <image class="disc-mode-icon" :src="floatPlayerIcon" mode="aspectFit" />
        </view>
        <view class="disc" :class="{ 'disc--paused': musicPaused || musicEnded, 'disc--playing': !musicPaused && !musicEnded }" @tap="onTogglePause">
          <view class="disc__glow" />
          <view class="disc__progress" :style="discProgressStyle" />
          <!-- 民国留声机唱针：播放时压在唱片上、暂停时抬起，是播放/暂停最直观的区分 -->
          <view class="disc__tonearm-base" />
          <view class="disc__tonearm" />
          <image v-if="musicCover" class="disc__cover" :src="musicCover" mode="aspectFill" />
          <view v-else class="disc__cover disc__cover--placeholder" />
          <view class="disc__hole" />
        </view>
        <!-- 单行显示整句：不换行、不省略、不滚动；超长按句长微缩字号塞进固定宽度 -->
        <text
          v-if="currentSubtitleText"
          class="disc-lyric"
          :style="{ fontSize: lyricFontSize + 'px', color: subtitleActiveColor }"
        >{{ activeSubtitleSplit.sung }}<text class="disc-lyric--rest">{{ activeSubtitleSplit.rest }}</text></text>
      </view>
    </FloatLayer>

    <view class="controls">
      <view class="switch-row">
        <view class="switch-copy">
          <text class="switch-title">{{ t('switch.title') }}</text>
          <text class="switch-desc">{{ t('switch.desc') }}</text>
        </view>
        <switch :checked="enabled" color="#6c8cff" @change="onToggle" />
      </view>

      <view class="buttons">
        <button class="btn warn" :disabled="!isActive" @tap="interrupt">{{ t('btn.interrupt') }}</button>
      </view>
      <text v-if="state === 'standby'" class="talk-hint">{{ t('talk.standby') }}</text>
      <text v-else-if="halfDuplex" class="talk-hint warn">
        {{ t('talk.echo') }}
      </text>
      <text v-else-if="isActive" class="talk-hint">{{ t('talk.listening') }}</text>
    </view>

  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
  padding-top: calc(24px + env(safe-area-inset-top));
  display: flex;
  flex-direction: column;
  gap: 20px;
  background:
    radial-gradient(120% 60% at 50% 0%, rgba(108, 140, 255, 0.22), transparent 60%),
    #0f1220;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gear {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: #b8bdd4;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.subtitle {
  font-size: 12px;
  color: #8b91ab;
}

.pill {
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #b8bdd4;
  background: rgba(255, 255, 255, 0.04);
}

.pill.listening,
.pill.confirming {
  color: #cfd8ff;
  border-color: rgba(108, 140, 255, 0.5);
  background: rgba(108, 140, 255, 0.16);
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.conn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
}

.conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.conn.ok {
  color: #8ee0bd;
  border-color: rgba(92, 214, 178, 0.4);
}

.conn.ok .conn-dot {
  background: #5cd6b2;
  box-shadow: 0 0 8px rgba(92, 214, 178, 0.7);
}

.conn.down {
  color: #ff9a9a;
  border-color: rgba(255, 100, 100, 0.4);
}

.conn.down .conn-dot {
  background: #ff6b6b;
  box-shadow: 0 0 8px rgba(255, 100, 100, 0.6);
}

.conn.connecting {
  color: #ffcf8a;
  border-color: rgba(255, 207, 138, 0.4);
  cursor: pointer;
}

.conn.connecting .conn-dot {
  background: #ffcf8a;
  box-shadow: 0 0 8px rgba(255, 207, 138, 0.6);
  animation: pulse-dot 1s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

.health {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.health-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
}

.health-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: #5cd6b2;
}

.health-item.ok {
  color: #8ee0bd;
  border-color: rgba(92, 214, 178, 0.35);
}

.health-item.warn {
  color: #ffcf8a;
  border-color: rgba(255, 207, 138, 0.4);
}

.health-item.warn .health-dot {
  background: #ffcf8a;
  box-shadow: 0 0 6px rgba(255, 207, 138, 0.6);
}

.health-item.down {
  color: #ff9a9a;
  border-color: rgba(255, 100, 100, 0.4);
}

.health-item.down .health-dot {
  background: #ff6b6b;
  box-shadow: 0 0 6px rgba(255, 100, 100, 0.6);
}

.health-checking {
  font-size: 11px;
  color: #8b91ab;
}

/* 权限组与能力组之间的视觉隔离 */
.health-divider {
  color: rgba(255, 255, 255, 0.28);
  font-size: 13px;
  margin: 0 2px;
}

/* 点击可播报状态的胶囊：轻微反馈，选中态高亮边框 */
.health-item.is-tappable:active {
  transform: scale(0.94);
}
.health-item.active {
  border-color: rgba(142, 224, 189, 0.6);
  box-shadow: 0 0 0 1px rgba(142, 224, 189, 0.25);
}

/* 状态播报：健康栏下方固定行内文字，不弹浮层、不遮挡 */
.health-narration {
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.health-narration-text {
  font-size: 12px;
  color: #c9cede;
}

.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 8px 0 4px;
}

.orb {
  width: 148px;
  height: 148px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 50% 35%, rgba(108, 140, 255, 0.5), rgba(108, 140, 255, 0.06) 65%);
  transition: transform 0.2s ease;
}

.orb.active {
  animation: pulse 2.4s ease-in-out infinite;
}

.orb.speaking {
  background: radial-gradient(circle at 50% 35%, rgba(92, 214, 178, 0.55), rgba(92, 214, 178, 0.08) 65%);
}

.orb-core {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 18, 32, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.orb-icon {
  font-size: 42px;
  color: #dfe5ff;
}

.hint {
  font-size: 13px;
  color: #9aa1bd;
  text-align: center;
}

.phase {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  color: #8b91ab;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.phase.listening {
  color: #9fd8ff;
  border-color: rgba(108, 168, 255, 0.45);
}

.phase.thinking {
  color: #c9b8ff;
  border-color: rgba(150, 120, 255, 0.45);
}

.phase.replying {
  color: #cfd8ff;
  border-color: rgba(108, 140, 255, 0.5);
}

.phase.speaking {
  color: #8ee0bd;
  border-color: rgba(92, 214, 178, 0.45);
}

.phase.done {
  color: #8b91ab;
}

.error {
  font-size: 12px;
  color: #ff9a9a;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 76px;
}

.card.reply {
  border-color: rgba(108, 140, 255, 0.28);
  background: rgba(108, 140, 255, 0.08);
}

.card-label {
  font-size: 11px;
  color: #8b91ab;
  letter-spacing: 1px;
}

.card.thinking {
  background: rgba(255, 255, 255, 0.025);
  border-style: dashed;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-badge {
  font-size: 10px;
  color: #8f9bd6;
}

.card-badge.done {
  color: #6f7691;
}

.queue-badge {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
  line-height: 1.6;
  color: #fff;
  background: #e5484d;
}

.queue-full-banner {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  text-align: center;
  color: #fff;
  background: linear-gradient(135deg, #e5484d, #f0743f);
  box-shadow: 0 4px 16px rgba(229, 72, 77, 0.28);
}

.live-text {
  font-size: 14px;
  line-height: 1.6;
  color: #c7cde6;
  text-align: center;
  min-height: 20px;
  word-break: break-word;
}

.thinking-text {
  font-size: 12px;
  line-height: 1.7;
  color: #9aa1bd;
}

.card-text {
  font-size: 14px;
  line-height: 1.6;
  color: #e8eaf6;
  word-break: break-word;
}

.controls {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.switch-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.switch-title {
  font-size: 15px;
  font-weight: 600;
}

.switch-desc {
  font-size: 11px;
  color: #8b91ab;
}

.buttons {
  display: flex;
  gap: 10px;
}

.btn {
  flex: 1;
  margin: 0;
  padding: 0 8px;
  height: 44px;
  line-height: 44px;
  border-radius: 12px;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #e8eaf6;
}

.btn::after {
  border: none;
}

.btn.primary {
  background: linear-gradient(135deg, #6c8cff, #8a6cff);
  border-color: transparent;
  color: #fff;
}

/* 打断：主动中止当前这一轮，用琥珀色描边与文字表达「需谨慎、但非出错」，
   比默认幽灵按钮更显眼，又不像红色那样像报错 */
.btn.warn {
  color: #ffcf8a;
  border-color: rgba(255, 207, 138, 0.42);
  background: rgba(255, 207, 138, 0.1);
}

.btn.warn:active {
  background: rgba(255, 207, 138, 0.2);
}

.btn[disabled] {
  opacity: 0.35;
}

.talk-hint {
  font-size: 11px;
  color: #8b91ab;
  text-align: center;
}

.talk-hint.warn {
  color: #ffcf8a;
}

.music-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 14px;
  /* 民国暖铜调，与悬浮小圆同色系，突出老式播放器质感 */
  background: rgba(201, 160, 99, 0.1);
  border: 1px solid rgba(201, 160, 99, 0.3);
}

.music-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.music-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.music-ctrl {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e8eaf6;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  transition: transform 0.12s ease, background 0.12s ease;
}

.music-icon {
  width: 22px;
  height: 22px;
}

.music-ctrl.primary {
  background: rgba(201, 160, 99, 0.2);
  border-color: rgba(201, 160, 99, 0.45);
  color: #e7c987;
}

/* 循环按钮：容纳剩余次数角标 */
.music-ctrl.loop-ctrl {
  position: relative;
}

.loop-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  color: #0f1220;
  background: #c9a063;
  box-shadow: 0 0 0 1px rgba(15, 18, 32, 0.6);
}

/* 喇叭 + 音量面板的分组：作为竖向面板的定位锚点，面板是其兄弟节点以免点击面板冒泡到开关 */
.vol-group {
  position: relative;
  display: flex;
  align-items: center;
}

/* 喇叭：已提升到顶行控制区末尾 */
.music-ctrl.vol-ctrl {
  color: #e7c987;
}

/* 竖向滑块：uni-app 的 slider 仅支持横向，这里用旋转把它立起来。
   深色圆角面板绝对定位在喇叭正下方、顶部贴着喇叭，向下弹出盖住进度行（不飞出屏幕顶部）；
   顶部显示百分比，绿条自下而上填充到白色手柄。 */
.vol-slider-wrap {
  position: absolute;
  right: 50%;
  top: calc(100% + 10px);
  transform: translateX(50%);
  z-index: 20;
  width: 54px;
  padding: 10px 6px 8px;
  border-radius: 16px;
  background: rgba(15, 18, 32, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.vol-pct {
  font-size: 11px;
  line-height: 1;
  color: #fff;
  font-variant-numeric: tabular-nums;
}

/* 竖向音量轨道：自定义 touch 轨道（原生 slider 旋转后拖不动）。
   整条 40×120 是触摸命中区，内部一条细轨；绿条从底部向上填充到白色手柄。 */
.vol-track {
  position: relative;
  width: 40px;
  height: 120px;
  display: flex;
  justify-content: center;
  touch-action: none;
}

.vol-rail {
  position: relative;
  width: 6px;
  height: 100%;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.16);
  overflow: hidden;
}

.vol-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: #c9a063;
  border-radius: 3px;
}

.vol-handle {
  position: absolute;
  left: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, 50%);
  box-shadow: 0 0 6px rgba(201, 160, 99, 0.75);
}

.music-ctrl.vol-ctrl.muted {
  color: #8b91ab;
}

.music-ctrl.vol-ctrl.active {
  background: rgba(201, 160, 99, 0.2);
  border-color: rgba(201, 160, 99, 0.45);
  color: #e7c987;
}

.music-ctrl:active {
  transform: scale(0.9);
}

.music-error {
  font-size: 11px;
  color: #ffb38a;
}

.music-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.music-time {
  font-size: 11px;
  color: #e7c987;
  min-width: 30px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.music-slider {
  flex: 1;
  margin: 0;
}

.music-live {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}

.music-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c9a063;
}

.music-live-text {
  font-size: 11px;
  letter-spacing: 1px;
  color: #e7c987;
}

/* 民国留声机：大铜喇叭 + 唱片 + 唱针，作为大播放器左侧视觉主体。
   播放时喇叭暖光呼吸、唱片旋转、唱针‘放下’压片；暂停时喇叭收暗、停转、唱针‘拿起’（留在圈内）。 */
.music-phono {
  position: relative;
  width: 78px;
  height: 64px;
  flex-shrink: 0;
}

/* 大铜喇叭：朝左上张开的喇叭口，播放暖光呼吸、暂停收暗 */
.phono__horn {
  position: absolute;
  top: 0;
  left: 0;
  width: 34px;
  height: 30px;
  clip-path: polygon(0% 22%, 58% 0%, 100% 38%, 100% 62%, 58% 100%, 0% 78%);
  background: linear-gradient(135deg, #f7e6b0 0%, #d8b06a 45%, #a8834d 100%);
  border: 1px solid #6b4f25;
  box-shadow: inset 0 0 8px rgba(255, 240, 200, 0.65);
  transform: rotate(-8deg);
  transform-origin: right center;
  transition: opacity 0.4s ease, filter 0.4s ease;
}
/* 喇叭口内膛（暗膛），强化铜喇叭的张口感 */
.phono__horn::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 22%;
  width: 10px;
  height: 56%;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 50%, rgba(60, 40, 20, 0.85), rgba(20, 14, 8, 0.95));
}

/* 连接喇叭与唱片的细铜管 */
.phono__tube {
  position: absolute;
  top: 26px;
  left: 28px;
  width: 18px;
  height: 6px;
  background: linear-gradient(180deg, #e7c987, #8a6d3b);
  border: 1px solid #6b4f25;
  border-radius: 3px;
  transform: rotate(8deg);
}

/* 唱片：承接封面，播放旋转；铜边 + 做旧 */
.phono__record {
  position: absolute;
  top: 14px;
  right: 2px;
  box-sizing: border-box;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 2px solid rgba(201, 160, 99, 0.6);
  box-shadow: 0 0 0 1px rgba(124, 94, 46, 0.35), inset 0 0 10px rgba(0, 0, 0, 0.35);
  filter: sepia(0.3) saturate(0.92) contrast(0.96);
  animation: disc-spin 14s linear infinite;
}
.phono__record--placeholder {
  background: repeating-radial-gradient(circle at 50% 50%, #3a2f1e 0, #3a2f1e 3px, #2a2114 4px, #2a2114 6px);
}

/* 唱针底座在唱片右上，唱针‘拿起/放下’区分播放/暂停（落在圈内） */
.phono__tonearm-base {
  position: absolute;
  top: 16px;
  right: 4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #e7c987, #8a6d3b);
  border: 1px solid #6b4f25;
  /* 转轴高光，做出金属轴芯的立体感 */
  box-shadow: inset 0 1px 2px rgba(255, 240, 200, 0.55), inset 0 -1px 2px rgba(0, 0, 0, 0.4);
  z-index: 3;
}
.phono__tonearm {
  position: absolute;
  top: 19px;
  right: 8px;
  width: 30px;
  height: 4px;
  border-radius: 4px;
  /* 黄铜圆管：上沿高光、下沿暗边，做出金属圆柱质感 */
  background: linear-gradient(180deg, #f7e6b0 0%, #e7c987 38%, #b88a4d 72%, #8a6d3b 100%);
  transform-origin: right center;
  transform: rotate(36deg);
  /* 带回弹的缓动，让‘放下/拿起’更有机械质感 */
  transition: transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 2;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}
/* 针头端（唱头 + 针尖）：落在唱片上的那一端 */
.phono__tonearm::before {
  content: '';
  position: absolute;
  left: -3px;
  top: -2px;
  width: 7px;
  height: 8px;
  border-radius: 2px 2px 3px 3px;
  background: linear-gradient(180deg, #f7e6b0, #a8834d);
  border: 1px solid #6b4f25;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
/* 配重：靠近转轴的一端，平衡锤 */
.phono__tonearm::after {
  content: '';
  position: absolute;
  right: -3px;
  top: -2px;
  width: 6px;
  height: 8px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #e7c987, #7a5e30);
  border: 1px solid #6b4f25;
}
/* 暂停：唱针‘拿起’离开唱片，唱片停转、做旧加深；喇叭收暗 */
.music-phono--paused .phono__tonearm {
  transform: rotate(4deg);
  opacity: 0.8;
}
.music-phono--paused .phono__record {
  animation-play-state: paused;
  filter: sepia(0.6) saturate(0.5) contrast(0.9) brightness(0.92);
}
.music-phono--paused .phono__horn {
  opacity: 0.5;
  filter: saturate(0.6) brightness(0.85);
}
/* 播放：喇叭暖光呼吸 */
.music-phono--playing .phono__horn {
  animation: phono-horn 2.8s ease-in-out infinite;
}
@keyframes phono-horn {
  0%,
  100% {
    filter: brightness(1);
  }
  50% {
    filter: brightness(1.18) drop-shadow(0 0 6px rgba(231, 201, 135, 0.7));
  }
}

.music-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.music-label {
  font-size: 10px;
  letter-spacing: 1px;
  color: #e7c987;
}

.music-label.paused {
  color: #e0a466;
}

.music-title {
  font-size: 14px;
  color: #e8eaf6;
  line-height: 1.35;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.subtitle {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(108, 140, 255, 0.07);
  border: 1px solid rgba(108, 140, 255, 0.22);
}

.subtitle-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.subtitle-title {
  font-size: 12px;
  color: #cfd8ff;
  word-break: break-word;
}

.subtitle-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.subtitle-icon-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  flex-shrink: 0;
}

.subtitle-icon-btn:active {
  background: rgba(108, 140, 255, 0.18);
}

.subtitle-icon {
  width: 18px;
  height: 18px;
}

.subtitle-artist {
  font-size: 11px;
  color: #8b91ab;
}

.subtitle-body {
  max-height: 240px;
  /* 只留少量对称内边距；高亮行靠「滚到前 2 行」居中，不需要底部大留白（会空一大片） */
  padding: 6px 0;
}

.subtitle-empty {
  font-size: 13px;
  color: #8b91ab;
}

/* 悬浮小圆（民国老式留声机风格）：内容是音乐业务，层级/位置由通用 FloatLayer 容器负责 */
.disc {
  position: relative;
  width: 64px;
  height: 64px;
}

.disc__glow {
  position: absolute;
  top: -9px;
  right: -9px;
  bottom: -9px;
  left: -9px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(201, 160, 99, 0.42), rgba(201, 160, 99, 0) 70%);
  transition: opacity 0.45s ease;
}
/* 民国铜色光晕：播放时暖光呼吸，暂停时收暗 */
.disc--playing .disc__glow {
  animation: disc-glow 2.8s ease-in-out infinite;
}
.disc--paused .disc__glow {
  opacity: 0.32;
}

@keyframes disc-glow {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

/* 外层环形进度：封面盖住中心，只露出这一圈；background 由 :style 按播放进度注入 conic-gradient（铜色） */
.disc__progress {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border-radius: 50%;
}

.disc__cover {
  position: absolute;
  top: 6px;
  left: 6px;
  box-sizing: border-box;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  border: 2px solid rgba(201, 160, 99, 0.55);
  box-shadow: 0 0 0 1px rgba(124, 94, 46, 0.35), inset 0 0 10px rgba(0, 0, 0, 0.35);
  /* 民国做旧：常驻轻微 sepia，播放时更暖 */
  filter: sepia(0.32) saturate(0.92) contrast(0.96);
  animation: disc-spin 14s linear infinite;
}

/* 无封面时的占位唱片：暖色黑胶纹路，保证评书/电台/百度兜底等内容也能同等悬浮 */
.disc__cover--placeholder {
  background: repeating-radial-gradient(
    circle at 50% 50%,
    #3a2f1e 0,
    #3a2f1e 3px,
    #2a2114 4px,
    #2a2114 6px
  );
}

.disc--paused .disc__cover {
  animation-play-state: paused;
  /* 暂停：唱片褪成做旧灰黄，与播放的暖亮形成明显反差 */
  filter: sepia(0.6) saturate(0.55) contrast(0.9) brightness(0.92);
}

.disc__hole {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 15px;
  height: 15px;
  margin: -7.5px 0 0 -7.5px;
  border-radius: 50%;
  background: radial-gradient(circle, #c9a063, #8a6d3b);
  border: 2px solid rgba(255, 240, 210, 0.5);
}

/* 民国留声机唱针：底座在唱片圈内右上角（不再伸出圈外）。
   播放：唱针‘放下’压在唱片上；暂停：唱针‘拿起’离开 —— 即播放/暂停最直观的区分。 */
.disc__tonearm-base {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #e7c987, #8a6d3b);
  border: 1px solid #6b4f25;
  /* 转轴高光，做出金属轴芯的立体感 */
  box-shadow: inset 0 1px 2px rgba(255, 240, 200, 0.55), inset 0 -1px 2px rgba(0, 0, 0, 0.4);
  z-index: 6;
}
.disc__tonearm {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 46px;
  height: 5px;
  border-radius: 4px;
  /* 黄铜圆管：上沿高光、下沿暗边，做出金属圆柱质感 */
  background: linear-gradient(180deg, #f7e6b0 0%, #e7c987 38%, #b88a4d 72%, #8a6d3b 100%);
  transform-origin: right center;
  transform: rotate(38deg);
  /* 带回弹的缓动，让‘放下/拿起’更有机械质感 */
  transition: transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 5;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}
/* 针头端（唱头 + 针尖）：落在唱片上的那一端 */
.disc__tonearm::before {
  content: '';
  position: absolute;
  left: -3px;
  top: -2px;
  width: 8px;
  height: 9px;
  border-radius: 2px 2px 3px 3px;
  background: linear-gradient(180deg, #f7e6b0, #a8834d);
  border: 1px solid #6b4f25;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
/* 配重：靠近转轴的一端，平衡锤 */
.disc__tonearm::after {
  content: '';
  position: absolute;
  right: -3px;
  top: -2px;
  width: 7px;
  height: 9px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #e7c987, #7a5e30);
  border: 1px solid #6b4f25;
}
.disc--paused .disc__tonearm {
  transform: rotate(6deg);
  opacity: 0.78;
}

@keyframes disc-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 固定宽度内容层：FloatLayer 宽度恒定 → 居中稳定，不随歌词长度左右移动 */
.float-disc-body {
  position: relative;
  width: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 悬浮小圆上的播放模式切换按钮：位于内容层右上角，点一下在「悬浮小圆 ↔ 普通播放条」间切换 */
.disc-mode-toggle {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(4px);
  border: none;
  transition: background 0.15s ease;
}

.disc-mode-toggle:active {
  background: rgba(255, 255, 255, 0.16);
}

.disc-mode-icon {
  width: 14px;
  height: 14px;
}

/* 当前正在唱的那句：单行显示整句，不换行/不省略/不滚动；字号按句长微缩（由 :style 注入） */
.disc-lyric {
  width: 200px;
  margin-top: 12px;
  font-weight: 600;
  line-height: 1.45;
  color: #f3e6c8;
  text-align: center;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.65);
  white-space: nowrap;
  overflow: visible;
}

/* 卡拉OK未唱到的部分：暗一档，与已唱高亮形成逐字递进 */
.disc-lyric--rest {
  white-space: nowrap;
  color: rgba(243, 230, 200, 0.4);
}

.subtitle-line {
  font-size: 13px;
  line-height: 1.9;
  color: #aeb6d8;
  /* 每行歌词保持单行，超长截断而非换行 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 8px;
  border-radius: 8px;
  transition: color 0.18s ease, background 0.18s ease;
}

/* 当前高亮行：字号/颜色由设置页（:style 注入）控制，这里只给加粗/底色/左侧亮条做区分 */
.subtitle-line--active {
  background: rgba(108, 140, 255, 0.22);
  font-weight: 700;
  line-height: 1.6;
  padding: 6px 10px;
  box-shadow: inset 3px 0 0 #6c8cff;
}

/* 卡拉OK未唱到的部分：暗一档，与已唱高亮形成逐字递进 */
.subtitle-line--rest {
  /* uni-app 的 <text> 编译成 .uni-text，其全局样式可能重置 white-space，
     这里显式 nowrap，确保整行（含未唱段 span）都不换行 */
  white-space: nowrap;
  color: rgba(231, 230, 245, 0.4);
}

/* 平板与折叠屏展开态：内容限宽，布局更舒展 */
.page.bp-medium,
.page.bp-expanded {
  max-width: 720px;
  margin: 0 auto;
}

.page.bp-expanded .cards {
  flex-direction: row;
}

.page.bp-expanded .card {
  flex: 1;
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.9;
  }
  50% {
    transform: scale(1.06);
    opacity: 1;
  }
}
</style>
