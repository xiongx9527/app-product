import { computed, onUnmounted, ref, watch } from 'vue'
import {
  playPromptCue,
  playPromptCueSequence,
  isPromptCuePlaying,
  type PromptCue,
} from '@/core/audio/promptPlayer'
import {
  playMusic,
  stopMusic,
  pauseMusic,
  resumeMusic,
  replayMusic,
  cycleLoop,
  duckMusic,
  seekMusic,
  setMusicVolume,
  musicState,
} from '@/core/audio/musicPlayer'
import { playDownloadedMedia } from './mediaPlayback'
import {
  isH5AudioSupported,
  onPlaybackIdle,
  playPcm,
  startCapture,
  stopCapture,
  stopPlayback,
} from '@/core/audio/h5Audio'
import {
  isAppPlaybackSupported,
  appPlayPcm,
  onAppPlaybackIdle,
  stopAppPlayback,
  setAppPlaybackVolume,
  markPlaybackInFlight,
} from '@/core/audio/appPlayback'
import { isAppCaptureSupported, requestMicPermission, resumeAppCapture, setAppScreenOn, setMediaPlaying, setDuckConfig, setAecUserEnabled, startAppCapture, stopAppCapture } from '@/core/audio/appCapture'
import { DUCK_LEVEL_PERCENT } from '@/core/config/constants'
import { t } from '@/core/i18n'
import { transition } from '@/core/assistant/stateMachine'
import {
  DEFAULT_ASSISTANT_CONFIG,
  STATE_LABEL,
  type AssistantConfig,
  type AssistantEvent,
  type AssistantState,
  type AssistantEffect,
} from '@/core/assistant/types'
import { createTransport, resolveGatewayHttpBase } from '@/core/transport'
import { waitForEmbeddedGateway } from '@/core/transport/gatewayBootstrap'
import { pingGateway, restartGatewayViaNative } from '@/core/transport/gatewayControl'
import {
  useHealth,
  toHealthItems,
  type HealthItem,
  type HealthStatus,
} from '@/features/assistant/useHealth'
import { usePermissions } from '@/features/assistant/usePermissions'
import type { PermissionState } from '@/core/permission/permissionStatus'
import { toProxiedMusicUrl } from '@/core/audio/resolveMediaUrl'
import type { ServerEvent, SessionMode } from '@/core/transport/types'
import { DEFAULT_WAKE_WORDS } from '@/core/wake/types'
import { matchWakeWord } from '@/core/wake/wakeWord'
import { createWakeService, type WakeService } from '@/core/wake/wakeService'
import { getLanguage } from '@/core/config'
import { appConfig, persistConfig, activeVoiceConfig } from '@/core/config'
import { addFavorite } from '@/features/favorites/favoritesStore'

/** 一轮对话的阶段：界面据此告诉用户「现在在干嘛」，避免以为卡住而插话。 */
export type Phase = 'idle' | 'listening' | 'thinking' | 'replying' | 'speaking' | 'done'

/** 一轮对话的阶段 → i18n key（文案走 core/i18n，按当前语言取值）。 */
const PHASE_LABEL: Record<Phase, string> = {
  idle: 'phase.idle',
  listening: 'phase.listening',
  thinking: 'phase.thinking',
  replying: 'phase.replying',
  speaking: 'phase.speaking',
  done: 'phase.done',
}

/** 健康项 → 不可用提示音：连上时未就绪、以及定时检测到 ok→down 都用它选音 */
const HEALTH_CUE: Record<HealthItem['key'], PromptCue> = {
  llm: 'llmDown',
  asr: 'asrDown',
  tts: 'ttsDown',
  network: 'networkDown',
}
/** 按对语音交互的影响排序：先说「听不见」，再说「念不出 / 答不了 / 上不了网」 */
const HEALTH_PRIORITY: HealthItem['key'][] = ['asr', 'tts', 'llm', 'network']

export function useAssistant(config: AssistantConfig = DEFAULT_ASSISTANT_CONFIG) {
  const state = ref<AssistantState>('idle')
  const transcript = ref('')
  /** 监听阶段实时识别的「草稿」文字，展示在页面下方；定稿后才进「你说」卡片 */
  const liveText = ref('')
  const reply = ref('')
  const thinking = ref('')
  const thinkingDone = ref(false)
  const replyDone = ref(false)
  const phase = ref<Phase>('idle')
  /**
   * 「本轮完成」短暂展示后回到「正在听」（用户 2026-11-19 要求统一）：
   * 播完先显示「本轮完成」约 1 秒，然后自动切回「正在听」——麦克风常开、可直接说下一句，
   * 与唤醒后的「正在听」显示一致。期间若用户已开口/开启新一轮（phase 被改成
   * thinking/listening/speaking 等），回调发现 phase 不再是 done 就不覆盖。
   */
  let doneToListeningTimer: ReturnType<typeof setTimeout> | null = null
  const DONE_TO_LISTENING_MS = 1000
  // 前端 phase 变化经 sendDiag 落到网关 barge-diag.log（Android 无 jsLog，这是唯一可见通路）
  function diagPhase(tag: string): void {
    try {
      transport.sendDiag?.({
        state: state.value,
        speaking: isSpeaking.value,
        cue: false,
        muted: mode === 'wake',
        frames: 0,
        rms: 0,
        connected: transport.isConnected(),
        trace: 'PHASE ' + tag + ' phase=' + phase.value,
      })
    } catch { /* 诊断失败不影响主流程 */ }
  }
  function setPhaseDone(source: string): void {
    // 定位「播报没完状态就变」：记录是谁把 phase 设成 done（speaking→done 的元凶）
    if (phase.value === 'speaking' || phase.value === 'thinking' || phase.value === 'replying') {
      console.info('[da] PHASE_DONE from=' + source + ' prevPhase=' + phase.value
        + ' speaking=' + isSpeaking.value)
    }
    diagPhase('DONE from=' + source)
    phase.value = 'done'
    if (doneToListeningTimer) clearTimeout(doneToListeningTimer)
    doneToListeningTimer = setTimeout(() => {
      doneToListeningTimer = null
      // 本轮完成后停 1 秒 → 切回「正在听」（用户明确要的既有行为）。
      // 条件：会话未结束（非 idle/standby）就切。收尾时 state 常是 confirming（T1 静默超时的
      // 确认态），旧条件只认 listening 导致永远停 done「本轮完成」——放宽到 confirming 也切。
      // 只有真正回到 standby/idle（会话退出）才不切——那时上行静音，显示「待唤醒」才对。
      if (phase.value === 'done' && state.value !== 'idle' && state.value !== 'standby') {
        phase.value = 'listening'
      }
    }, DONE_TO_LISTENING_MS)
  }
  const isSpeaking = ref(false)
  /**
   * 「正在听」独立显示标志：收到真人 asr.partial（网关已过滤噪声/回声）就置位，
   * 静音 HEARING_HOLD_MS 后复位。播报/思考的 phase 与 isSpeaking 不动——
   * 界面用它在播报/思考之上叠加显示「正在听」，说完自动恢复原状态。
   */
  const hearingUser = ref(false)
  const HEARING_HOLD_MS = 1500
  let hearingTimer: ReturnType<typeof setTimeout> | null = null
  function markHearingUser(): void {
    hearingUser.value = true
    if (hearingTimer) clearTimeout(hearingTimer)
    hearingTimer = setTimeout(() => {
      hearingTimer = null
      hearingUser.value = false
    }, HEARING_HOLD_MS)
  }
  // 网关判定回声兜底中：播报期间不拾音，只能点「打断」
  const halfDuplex = ref(false)
  const errorMessage = ref('')
  /** 内嵌网关启动中（enable 时轮询 gateway.url 直到原生进程写出）；启动阶段界面静默，不显示也不播报 */
  const gatewayPreparing = ref(false)
  /** 网关启动失败：首页据此显示失败提示（而非误报"已就绪"），引导点语音球重试 */
  const gatewayFailed = ref(false)
  /** 队列已满（排队数超上限）的专用话术，显示在「我说」卡片右上角（与排队数量徽标同位置同款式），
   *  不进「你说」正文、不用顶部横幅、不弹浮层 */
  const queueFullMsg = ref('')
  /** 当前播放曲目的封面图（与音频同源，网关 media.play.cover 下发），无封面为空串 */
  const musicCover = ref('')
  /** 当前媒体音频的来源方式：music=音乐/电台，tts=第三方语音合成（如百科播报）。
   *  网关 media.play.source 下发，缺省 music；播放模式与音乐相同，仅供界面/逻辑识别类型。 */
  const mediaSource = ref<'music' | 'tts'>('music')
  /** 字幕面板：网关下发 media.subtitle 后展示（lines 带每行起始时间，用于跟随播放高亮） */
  const subtitle = ref<{ title: string; artist?: string; lines: { time: number; text: string }[] } | null>(null)
  /**
   * 字幕可见性：与 subtitle 数据分离，便于「手动关闭后可手动再打开」——手动关闭只翻这个标记、
   * 不丢数据，和语音「关闭字幕 / 开启字幕」共用同一真相源（都落在客户端），因此手动与语音互相可逆。
   * 默认开；播放停止（media.stop）复位为开，让下一首照常自动显示。
   */
  const subtitleVisible = ref(true)
  /** 字幕已复制：行内短暂提示（不弹浮层），复制成功后显示 1.5s */
  const copied = ref(false)
  /**
   * 结构化内容卡片：网关 media.detail 的全量状态快照（kind 判别、容器不感知业务）。
   * 纯展示状态，与 subtitle 同源；不参与重武装/切语音来源的能力重建——切 provider
   * 重发 session.start 时不重置它（商品结果与语音来源无关，见「换源不出问题」）。
   */
  const detailCard = ref<Extract<ServerEvent, { type: 'media.detail' }> | null>(null)

  /** 同一轮掉线自动重连（及手动重试）的次数上限；耗尽后停自动重连，改由页面「重试连接」按钮处理 */
  const MAX_RETRY = 5

  const transport = createTransport(MAX_RETRY)

  let t1Timer: ReturnType<typeof setTimeout> | null = null
  let t2Timer: ReturnType<typeof setTimeout> | null = null
  let closingTimer: ReturnType<typeof setTimeout> | null = null
  // 招呼语先占住“助手”卡片，等模型第一个字到了再换成真实回复
  let assistantTextStarted = false
  let capturing = false
  let mode: SessionMode = 'wake'

  // 网关手动重启自愈（点中间圆球/设置页触发）：互斥 + 冷却，防连点循环重启。
  // 不做自动自愈（用户拍板避免误重启）——只在用户主动点球且 ping 判卡死时才试。
  let healingInProgress = false
  let healCooldownUntil = 0

  // ===== ASR 上行门控：唯一真相源（2026-11-24 用户拍板）=====
  // 「当前是否该让 ASR 静音」只在这一处判定；前端 onPcm 与 iOS 原生都听这里的结果。
  // 以后要改门控规则，只改 isAsrMuted() 一个方法即可，不用到处找判断。
  // 【静音】待唤醒(wake，只靠 KWS)；插话开关关时，思考/说/播报期也静音。
  // 【收音】正在听(listening)、本轮完成(done)；插话开关开时，思考/说/播报期也收音。
  // 【插话开关 bargeIn】（实验性，见设置页文案）：
  //  - 关（默认）：播报/播放/思考全程静音，新闻/音乐外放声不进 ASR（真机铁证：播新闻时正文
  //    被识别成用户话、助手乱答）；此期间只能点屏幕或喊「你好小熊」中断（KWS 端侧不受静音影响）。
  //  - 开：放开 thinking/replying/speaking 与媒体播放期的收音，让插话能进——网关 enqueueDuringBusy
  //    + runTurn 回放链路完整，插话会入队、当前句播完后依次回放。代价：无法可靠区分人声与播放声
  //    （无文字对比、AEC 无 far-end 参考），外放声可能被误识别，功能不稳定，故标注实验性。
  function isAsrMuted(): boolean {
    if (mode === 'wake') return true
    if (appConfig.general.bargeIn === true) return false
    if (musicState.playing.value) return true
    return phase.value === 'thinking' || phase.value === 'replying' || phase.value === 'speaking'
  }
  /** 把统一判据同步给原生（iOS 走 PcmUploader 静音；Android 原生此方法是空操作，走 JS onPcm 门控）。 */
  function syncAsrGate(): void {
    try {
      kwsService.setStandbyMuted(isAsrMuted())
    } catch { /* kwsService 尚未就绪时忽略，enterWake 会再同步一次 */ }
  }
  // phase 一变就重新判定门控（thinking→replying→speaking→done→listening 全自动）
  watch(phase, () => syncAsrGate())

  /** 助手正在思考/回答/播报：此时挂起 T1 静默计时，否则长回答会被「还在吗」打断 */
  let assistantBusy = false
  /** 本轮回答是否已经开始 TTS：llm.done 早于 tts.end，不能提前算空闲 */
  let answerHasTts = false
  /** 等播放队列清空的取消函数：新轮次开始时作废上一轮的等待 */
  let cancelPlaybackIdle: (() => void) | null = null
  /** 播完回执兜底定时器：idle 回调链丢失时强制收尾，保证网关的队列持续推进 */
  let playbackDoneFallback: ReturnType<typeof setTimeout> | null = null
  /**
   * 插话已入队：说话尾音晚到的 partial 不回填草稿，有排队角标就够了。
   * 早期用「入队后 2 秒内无条件挡所有 partial」，但会误伤紧接的新插话：上一句刚入队设下窗口，
   * 下一句说话当下的 partial 正好落在窗口内被挡，界面就看不到正在识别的文字（真机复现：连续说
   * 「截一下」→「停一下」，后句 partial 全被前句窗口吃掉）。改为只挡「与刚入队文本一致的尾音」，
   * 新句的 partial 文本不同，立即照常显示。用时间戳 + 文本双重判据，不用布尔标志（旧布尔会永久卡死）。
   */
  let queuedHideUntil = 0
  /** 最近一次入队的原文，用来区分「尾音回填」与「下一句新插话」 */
  let queuedText = ''
  const QUEUED_HIDE_MS = 2000
  /**
   * 入队后延迟清空识别文字：铁证播报期 partial 与 queued 只隔 7ms，立即清空会让用户
   * 根本看不到识别出的文字。入队后保留约 1 秒让用户看清，再清掉交给排队角标。
   */
  let queuedClearTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 定稿后延迟清空草稿：partial 滚动识别常慢于语速，草稿停在「我喜欢打乒」半截字；
   * 网关定稿时会先补发一次完整文本的 asr.partial，这里让补全的草稿停留约 0.8 秒再清，
   * 用户能看清完整一句，再切到「我说」框正文。新一句 partial 到来时取消这个 timer。
   */
  let finalClearTimer: ReturnType<typeof setTimeout> | null = null
  // 定稿补全后停留时长：让用户看清完整一句（草稿从半截补全），再切到「我说」框正文。
  const FINAL_DRAFT_HOLD_MS = 1000
  function cancelFinalClear(): void {
    if (finalClearTimer) { clearTimeout(finalClearTimer); finalClearTimer = null }
  }
  function cancelQueuedClear(): void {
    if (queuedClearTimer) { clearTimeout(queuedClearTimer); queuedClearTimer = null }
  }
  /** 尾音 partial 与入队原文视为同一句：去掉标点后相等，或互为前缀（部分识别先短后长） */
  function isTailOfQueued(partial: string): boolean {
    if (!queuedText) return false
    const strip = (s: string): string => s.replace(/[。，,.！!？?\s]/g, '')
    const a = strip(partial)
    const b = strip(queuedText)
    return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a))
  }
  /** 「正在思考」安抚提示计时器：思考超过 10s 播本地 mp3（稍等一下），每轮最多一次 */
  let thinkingCueTimer: ReturnType<typeof setTimeout> | null = null
  let thinkingCueFired = false

  /** "还没出声"阶段起计时：超过 5s 还没开始播报就播 thinking.mp3。
   *  覆盖整段等待：思考 + 文字流出 + TTS 合成/下载——用户看到文字刷出来但迟迟没声音，
   *  中间这段最容易以为卡死。所以在 tts.start 才撤销计时，而非 llm.delta（文字一出就撤
   *  会导致"文字等声音"那段完全没提示）。每轮最多一次。 */
  const THINKING_CUE_DELAY_MS = 5_000
  function armThinkingCue(): void {
    disarmThinkingCue()
    thinkingCueFired = false
    thinkingCueTimer = setTimeout(() => {
      thinkingCueTimer = null
      // 未开始播报（thinking/replying）时才播；tts.start 后由 disarm 撤销
      if ((phase.value === 'thinking' || phase.value === 'replying') && !thinkingCueFired && !isSpeaking.value) {
        thinkingCueFired = true
        void playPromptCue('thinking')
      }
    }, THINKING_CUE_DELAY_MS)
  }

  /** 思考结束（开始播报 / 播报中 / 完成）时撤销计时。 */
  function disarmThinkingCue(): void {
    if (thinkingCueTimer) {
      clearTimeout(thinkingCueTimer)
      thinkingCueTimer = null
    }
  }

  /**
   * LLM 下行看门狗：网关的 llm.done / tts.start 若因下行 WS 丢失没到达前端，界面会永远卡在
   * 「正在思考」（真机铁证：thinking.mp3 5s 响了，之后一小时都不退出）。网关侧虽有 15s 硬超时
   * 会补发 llm.done，但下行链断了就白搭。这里在前端再兜一层：每收到任何 llm 事件就续命，
   * 超过 30s 完全无活动、且仍未出声时强制收尾并播 llm-error 提示，不让用户干等。
   * 正常 deepseek-r1 流式思考会持续产生 llm.thinking/delta，不断续命，不会误伤长回答。
   */
  let llmWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  const LLM_WATCHDOG_MS = 30_000
  function clearLlmWatchdog(): void {
    if (llmWatchdogTimer) {
      clearTimeout(llmWatchdogTimer)
      llmWatchdogTimer = null
    }
  }
  function feedLlmWatchdog(): void {
    lastLlmActivityAt = Date.now()
    clearLlmWatchdog()
    llmWatchdogTimer = setTimeout(() => {
      llmWatchdogTimer = null
      if ((phase.value === 'thinking' || phase.value === 'replying') && !isSpeaking.value && !replyDone.value) {
        console.info('[da] LLM_WATCHDOG fire phase=' + phase.value + ' - force settle')
        cancelPendingIdle()
        disarmThinkingCue()
        isSpeaking.value = false
        setPhaseDone('llm-watchdog')
        markAnswerDone()
        void playPromptCue('llmError')
      }
    }, LLM_WATCHDOG_MS)
  }

  /**
   * speaking 阶段播完看门狗：tts.start 后若原生播空检测失效（真机反复验证：checkTtsIdle 偶发
   * 不触发、TTS idle detected 不打日志 → playback_done 不发 → tts.idle 不来 → 界面永久卡
   * 「正在播报」，音乐音量也因 onPlaybackSettled 不执行而一直被 duck 到 0.2 倍），这里兜底：
   * 超过阈值仍未收到 tts.idle 就强制停播 + 收尾（含恢复音乐音量、通知网关推进队列）。
   * 时长要覆盖任意合理单句播报；tts.idle 正常到达会 clear 掉它，不会误伤。
   */
  let speechWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  const SPEECH_WATCHDOG_MS = 60_000
  function clearSpeechWatchdog(): void {
    if (speechWatchdogTimer) {
      clearTimeout(speechWatchdogTimer)
      speechWatchdogTimer = null
    }
  }
  function armSpeechWatchdog(): void {
    clearSpeechWatchdog()
    speechWatchdogTimer = setTimeout(() => {
      speechWatchdogTimer = null
      if (isSpeaking.value || phase.value === 'speaking') {
        console.info('[da] SPEECH_WATCHDOG fire phase=' + phase.value + ' - force settle')
        stopAppPlayback() // 真正停掉原生 AudioQueue，避免继续占着播放态与上行静音
        onPlaybackSettled(true) // 收尾 + duckMusic(false) 恢复音乐音量 + 通知网关推进队列
      }
    }, SPEECH_WATCHDOG_MS)
  }

  /**
   * iOS 后台冻结兜底：iPad 锁屏/退后台时 WebView 连同 JS setTimeout、weex 回调一起被系统挂起，
   * 播空的 tts.idle、播完兜底、thinking 看门狗、T1/T2 全部停摆 → 界面卡「正在播报/正在思考」，
   * 解锁回前台才补触发（真机铁证：13:00:53 锁屏→13:05:41 解锁，SETTLED/TTS_IDLE 相隔 46ms 涌出）。
   * JS 定时器自身冻住，靠看门狗救不了；只能在 App 回前台时用 onAppShow 主动检查并强制收尾。
   * 判据：卡在 speaking/thinking 且距最近一次 llm/tts 活动已超过阈值——正常前台切页间隔很短，
   * 不会误伤；只有经历过后台冻结（秒级空白）才会命中。
   */
  let lastLlmActivityAt = 0
  const RESUME_STALE_MS = 3000
  function resumeFromBackgroundCheck(): void {
    // iOS 熄屏/退后台可能掐断 AVAudioEngine 的 input tap，且亮屏后不自动恢复 → KWS 没输入、
    // 喊"小熊小熊"无反应。先无条件让原生自检重建采集，再做播报/思考态收尾（互相独立）。
    resumeAppCapture()
    // 【关键】待唤醒态不轮询 health，且熄屏期间网关上游可能由 down 转好（或 WS 半死未触发
    // useHealth 的 watcher 刷新）。回前台必须主动拉一次，否则 health.value 停留在熄屏前的旧
    // false → canWake() 恒 false → KWS 命中被静默吞掉、喊词永远进不了对话（真机铁证：熄屏
    // 喊词 KWS HIT 两次但界面纹丝不动）。刷新异步进行，不影响本次播报/思考态收尾。
    void refreshHealth()
    const stale = Date.now() - lastLlmActivityAt
    if (stale < RESUME_STALE_MS) return
    if (isSpeaking.value || phase.value === 'speaking') {
      console.info('[da] RESUME force settle speaking stale=' + stale + 'ms')
      cancelPendingIdle()
      stopAppPlayback()
      duckMusic(false)
      isSpeaking.value = false
      setPhaseDone('app-resume-speech')
      markAnswerDone()
    } else if (phase.value === 'thinking' || phase.value === 'replying') {
      console.info('[da] RESUME force settle thinking stale=' + stale + 'ms')
      cancelPendingIdle()
      disarmThinkingCue()
      clearLlmWatchdog()
      isSpeaking.value = false
      setPhaseDone('app-resume-thinking')
      markAnswerDone()
    }
  }
  /**
   * TTS 播完（或兜底超时）后的统一收尾：复位播报状态、记回声窗口、发播完回执。
   * idle 回调与 12s 兜底共用；重复触发无害（复位幂等，网关回执侧 resolve 幂等）。
   */
  function onPlaybackSettled(notifyGateway = true): void {
    console.info('[da] SETTLED phase=' + phase.value + ' speaking=' + isSpeaking.value + ' notify=' + notifyGateway)
    clearLlmWatchdog()
    clearSpeechWatchdog()
    clearPreciseIdle()
    if (playbackDoneFallback) {
      clearTimeout(playbackDoneFallback)
      playbackDoneFallback = null
    }
    cancelPlaybackIdle = null
    // playRunning 由原生 idle polling 播空后自行复位（finishPlaybackFromIdle）。
    // 这里不再调 stopTts：WakeModule 非单例，前端 stopPlayback 打在另一个实例上是 no-op，
    // 且多句间隙可能误拆正在播的 AudioTrack。
    duckMusic(false)
    isSpeaking.value = false
    // 真正播完这一刻记为「最近一次说话」，覆盖其后的回声窗口：
    // 助手话里若带「小熊小熊」，被麦收回后 2s 内的唤醒词识别当回声忽略。
    lastSpokeAt = Date.now()
    setPhaseDone('onPlaybackSettled')
    markAnswerDone()
    // 【播媒体时播完确认句→立即回待唤醒】插话开关关（默认）的前提下：媒体（新闻/音乐/电台）
    // 正在播放、且刚播完的是确认句（无排队、也无后续回答在跑），直接静默退回待唤醒——
    //  ① 待唤醒态上行天然静音，外放的新闻/音乐声不会被麦克风收回识别成用户话（真机铁证：
    //     播新闻时「韦东奕在学术论坛中演讲」被识别、助手乱答）；
    //  ② KWS 仍常驻听原始帧，喊「你好小熊」可随时中断、喊播放控制词可控制（后续接）。
    // 不这么做的话，状态机会继续走 30s T1 静默→「还在吗」→T2→退下，这段时间界面假显示
    // 「正在听」、上行接收媒体回声。插话开关开时放行、保留边播边插话，不走此分支。
    // endSession/cancelSession 只停 TTS、清队列，不碰媒体音轨，播放不会被打断。
    if (
      appConfig.general.bargeIn !== true &&
      musicState.playing.value &&
      queuePending.value === 0 &&
      state.value === 'listening'
    ) {
      console.info('[da] SETTLED→standby 媒体播放中+插话关，立即回待唤醒')
      dispatch({ type: 'CANCEL' })
    }
    // 播完回执：网关等它才消费排队的下一句，保证上一句完整播完。
    // tts.idle 触发时不要再回报——tts.idle 本就是网关下发的播完确认，再回报会形成
    // 「客户端 idle→网关 playback_done→tts.idle→客户端 idle」循环（真机铁证：15 条/300ms）。
    if (notifyGateway) transport.notifyPlaybackDone()
  }
  /**
   * 抗重复下发：同一首歌（url+title）在 2s 内被重复下发（重连/重武装竞态、或任何未知的双发）
   * 只播一次，避免「放两遍」。下一首/换源是不同的 url，不受影响。
   */
  let lastMediaPlaySig = ''
  let lastMediaPlayAt = 0
  const MEDIA_PLAY_DEDUP_MS = 2000
  /**
   * 回声重新唤醒防护：助手刚播完 TTS 的回声（话里常带「小熊小熊」）会被麦收回、ASR 重新识别成
   * 唤醒词，导致「我在」过一会又来一句。记录最近一次播报结束时刻，窗口内命中的唤醒词一律当回声忽略。
   * 用户真的隔一会儿再喊唤醒词（>2s）不受影响。
   */
  let lastSpokeAt = 0
  const WAKE_ECHO_MS = 2000
  /**
   * KWS 唤醒静默窗：端侧 KWS 命中唤醒词后，同一句话仍会被 ASR 兜底链路再转写一遍
   * （双轨并存），若在窗口内不拦，就会出现「KWS 先唤醒→ASR 的『小熊小熊』又进来二次 reWake、
   * 且把唤醒词写进草稿区」。KWS 命中时记时刻，窗口内 ASR 的唤醒词文本一律忽略。
   * 时长要覆盖 ASR 整段识别延迟。真机 2026-11-23 实测 final 比 KWS 晚 5.9s（命中 14:48:43、
   * ASR 转发"小熊小熊"14:48:48），超了原 5s 窗口→没拦住→ASR 唤醒词二次 reWake/cancel 把
   * 刚建立的会话冲掉，紧接着的用户指令识别为空（喊了中了却没反应）。加大到 8s 留足余量。
   */
  let kwsWakeAt = 0
  const KWS_WAKE_MUTE_MS = 8000
  /** ASR 转写的这句是否就是刚被 KWS 消费掉的那句唤醒词（应忽略，不再写草稿/不再二次唤醒）。 */
  const isKwsWakeEcho = (text: string): boolean =>
    Date.now() - kwsWakeAt < KWS_WAKE_MUTE_MS && !!matchWakeWord(text, DEFAULT_WAKE_WORDS)
  /** 播报期 partial 命中唤醒词打断的节流：流式识别连续多帧命中只打一次，避免重复招呼/重复跳过。 */
  let lastPartialSkipAt = 0
  /** barge-in duck 音量：正常播报 0.2（与原生 PLAYBACK_VOLUME 一致），用户开口压到 0.04。 */
  // TTS 播报音量（0–1）：正常清晰，插话 duck 时压低但仍能听清。
  // 早先为治「播报期插话难」压到 0.2/0.04，但真凶是 weex 回调失效（已用原生直连修复），
  // 降音量并非解药、反而让播报太小声，故调回清晰值。原生默认音量须与此同步。
  const TTS_VOLUME_NORMAL = 0.7
  const TTS_VOLUME_DUCK = 0.05
  const PARTIAL_SKIP_MS = 2500
  /**
   * 网关还有几句排队没轮到：期间「你说」必须锁在当前句，
   * 中间识别结果、播完回执都不能把文字顶掉。
   * 用 ref 暴露给页面，在「你说」卡片右上角显示排队数量。
   */
  const queuePending = ref(0)

  // TTS PCM 播放门面：App 逻辑层没有 WebAudio，必须走原生 AudioTrack；H5 走 WebAudio。
  // 用能力探测分流而非条件编译，保证同一套代码两端都正确；探测读的是缓存模块，无额外开销。
  // 多句 TTS：网关每句播空都发 tts.idle，但只有最后一句播空才该收尾。
  // 记录最近一次音频帧到达时刻，tts.idle 到达后延迟确认——期间若又有新音频帧（下一句），
  // 说明还没播完，取消收尾。只在真正静默后才把 phase 设回 done。
  let lastTtsAudioAt = 0
  let idleSettleTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 精确收尾 timer（iOS 网关停滞兜底）：tts.end 到达时网关已带 durationMs（按实际音频字节估算的
   * 播完时长）。若网关在播报期 DATA_STALL、tts.idle 下发不出来，前端不能干等 60s watchdog
   * （真机铁证：卡「正在播报」→T1/T2→退下→「唤醒后只能聊一次」）。用它到点直接本地收尾。
   * tts.idle 正常到达会走 onPlaybackSettled → clear 掉它，对回执正常的 Android 零影响。
   */
  let preciseIdleTimer: ReturnType<typeof setTimeout> | null = null
  function clearPreciseIdle(): void {
    if (preciseIdleTimer) {
      clearTimeout(preciseIdleTimer)
      preciseIdleTimer = null
    }
  }
  /**
   * 收到 tts.idle（上一句已播空）到前端 600ms 延迟收尾（isSpeaking 置 false）之间的窗口内，
   * 网关收到 playback_done 会立即推进队列、下发下一句 tts.start。此时 isSpeaking 还是 true，
   * 会被 tts.start 的「isSpeaking 抗重复」守卫当重复吞掉 → phase 卡 replying「正在回答」，
   * 永远不切 speaking「正在播报」（真机铁证）。这个标志让守卫能区分「真重复」和「idle 后的合法新句」。
   */
  let ttsIdleSeen = false
  function playTts(chunk: ArrayBuffer): void {
    lastTtsAudioAt = Date.now()
    if (isAppPlaybackSupported()) appPlayPcm(chunk, 24000)
    else playPcm(chunk, 24000)
  }
  function waitPlaybackIdle(fn: () => void): () => void {
    // 【2026-11-21 撤销接回 weex idle——多句 TTS 会在第一句播空就误判整轮完成】
    // 曾把 App 端改成注册 onAppPlaybackIdle（想绕开 tts.idle 丢失），但真机铁证：
    // 一句回答 gateway 切成多句连续播（原生 idle polling 每句播空都回调），weex idle 在
    // 第 1 句播空就 emitIdle → onPlaybackSettled → phase 提前退出 speaking，而第 2/3 句还在播
    // ——正是「播报没完、正在播报状态就变掉」的回归。播报只能认网关在整轮下发完后的 tts.idle
    // （tts.end 才注册等待），tts.idle 万一丢失由 SPEECH_WATCHDOG 25s 兜底。故 App 端回到不注册。
    // H5 端仍用 onPlaybackIdle（WebAudio 无原生直连、也无多句问题）。
    if (isAppPlaybackSupported()) return () => {}
    return onPlaybackIdle(fn)
  }
  function stopTts(): void {
    // 两端都调：H5 端原生门面是 no-op，App 端 WebAudio 门面是 no-op，互不干扰。
    stopPlayback()
    stopAppPlayback()
  }

  const stateLabel = computed(() => t(STATE_LABEL[state.value]))
  const phaseLabel = computed(() => t(PHASE_LABEL[phase.value]))
  const enabled = computed(() => state.value !== 'idle')
  // wakeSupported / wakeProviderName 在 kwsService 创建之后定义（见下方端侧 KWS 段）。

  // 订阅必须保存反订阅函数并在 onUnmounted 清理：transport 是模块级单例、跨 HMR 存活，
  // 若热更新重挂载时旧监听不移除，会往同一个 transport 上叠加多份 handleServerEvent，
  // 导致每条服务器事件被处理两遍（打招呼 / 还在吗 / TTS 全「放两遍」）。这正是在 H5 调试时
  // 反复改代码触发 HMR 后出现的双音频根因。
  const offEvent = transport.onEvent(handleServerEvent)
  const offAudio = transport.onAudio((chunk) => playTts(chunk))
  // 网关 WS 连接状态：让页面直接显示「已连/未连」，免去开 DevTools 看 101。
  const wsConnected = ref(transport.isConnected())
  // 网关掉线播报：只念一次，避免重连抖动期间反复打扰；前提是开启了唤醒（助手处于启用状态）。
  // 播的是打包内的 gateway-down.mp3（网关本身连不上，不可能从网关拉取；gatewayDown 不在 GATEWAY_CUES 列表，
  // 直接走本地文件），断网也能出声、且不弹文字浮层。外网不通另走 networkDown 提示，二者区分开。
  let gatewayDownAnnounced = false
  function resetGatewayDownAnnounce(): void {
    gatewayDownAnnounced = false
  }
  function announceGatewayDown(): void {
    // 只在「确认连不上」时播报：网关等待超时 / 自动重连耗尽。
    // 网关启动中、连接抖动、掉线瞬间都不报——那是正常过程，不打扰。只做去重。
    if (gatewayDownAnnounced) return
    gatewayDownAnnounced = true
    playPromptCue('gatewayDown')
  }
  // 连接状态 / 重连耗尽 / 建连中 三个订阅同样要保存反订阅，避免 HMR 重挂载叠加
  const offStatus = transport.onStatusChange((connected) => {
    console.info('[da] WS_STATUS connected=' + connected + ' state=' + state.value + ' phase=' + phase.value)
    wsConnected.value = connected
    if (connected) {
      resetGatewayDownAnnounce()
      // 连接恢复：清掉「网关未连接/暂时无法唤醒」等过期提示——网关已恢复，旧红字不能一直挂着误导用户
      if (errorMessage.value) errorMessage.value = ''
      // 自动开启语音助手开着时，网关恢复后自动重新进入待唤醒（此前因连不上而停在「未开启」）
      if (appConfig.general.autoConnect && state.value === 'idle') {
        void enable()
        return
      }
      // 连接恢复后无需额外补 session.start：建连（含自动重连）在 onopen 里已按
      // pendingMode 下发一次。待唤醒态不再需要 ASR 会话，重复下发只会让网关重建会话。
      return
    }
    // 掉线瞬间静默：自动重连马上会尝试，连不上由「重连耗尽」统一播报。
    // 原则：网关不正常不允许停留在唤醒态——监听/对话中掉线立即退回待机，
    // 不保留「正在听」的假象。
    if (enabled.value && state.value !== 'standby') {
      mode = 'wake'
      dispatch({ type: 'CANCEL' })
    }
  })
  // 自动重连次数耗尽：不再静默，用本地语音提示「网关连不上」（断网也能出声），
  // 并提示用户可手动点页面「重试连接」；重置播报标记以便这次能再念一次。
  const offReconnectExhausted = transport.onReconnectExhausted(() => {
    if (!enabled.value) return
    resetGatewayDownAnnounce()
    announceGatewayDown()
    // 原则：网关不正常就不允许停留在唤醒态。重连耗尽（网关确实不可达）时强制下线：
    // 停采集/停播报/关连接并回到「未开启」，不保留「正在听」的假象；重开后重走唤醒门槛。
    disable()
  })
  /** 正在建连状态（含自动重连每次尝试）：用于连接状态胶囊显示「连接中…」，且不弹独立标签 */
  const connecting = ref(false)
  const offConnecting = transport.onConnecting((value) => {
    connecting.value = value
  })
  // 语音配置（来源 / 音色 / 模型等）任意变更：在已连会话上重武装，让网关用新配置重建 ASR/TTS/LLM。
  // 改音色（来源没变但音色变了）也要重武装——否则网关仍用旧 TTS 客户端，播报声音不变。
  // 不重连即可生效，记忆与会话不丢；未连时无需动作——下次 connect 自带最新配置。
  watch(
    () => JSON.stringify(activeVoiceConfig()),
    () => {
      if (transport.isConnected()) transport.rearm()
    },
  )
  // 网关能力健康度（LLM / ASR / TTS / 外网）：连上后定时轮询，负责「运行中 ok→down」的瞬时变化；
  // 「建连那一刻就已不可用」的兜底下发由网关 client.cue 事件负责（见 handleServerEvent）。
  const { health, refreshHealth, startPolling: startHealthPolling, stopTimer: stopHealthPolling } = useHealth(wsConnected)
  // 设备权限只读检测（不弹授权框）：麦克风未授权要出声提示，定位只显示状态。
  const { permissions, refreshPermissions } = usePermissions(wsConnected)
  // 能力不可用播报以客户端健康报告为唯一来源：连上后 useHealth 主动拉 /api/health，时序确定、每次连接都会跑。
  // 首次报告把「一开始就 down」的能力（ASR/TTS/LLM）**逐条独立定时**播报：真机上共享串行队列
  // 只推进第一条就卡住，导致只剩 ASR 一条；改为各自 setTimeout，间隔 > 各 mp3 时长，不叠音也不漏。
  // 之后只在「ok → down」变化时补播。不再依赖网关 client.cue（真机时有时无），避免双份提示音。
  let prevHealthStatus: Partial<Record<HealthItem['key'], HealthStatus>> = {}
  let firstReportHandled = false
  // 按能力 key 存首次 down 的待播提示音定时器：若后续报告该能力恢复 ok，
  // 必须取消对应定时器——否则功能其实正常（探测偶发超时导致的短暂 down），
  // 却仍播报「ASR/LLM/TTS 不可用」误导用户（手动点正常、语音却报不可用即此因）。
  const initialCueTimers = new Map<HealthItem['key'], ReturnType<typeof setTimeout>>()
  function clearInitialCueTimer(k: HealthItem['key']): void {
    const t = initialCueTimers.get(k)
    if (t !== undefined) { clearTimeout(t); initialCueTimers.delete(k) }
  }
  function clearInitialCueTimers(): void {
    initialCueTimers.forEach((t) => clearTimeout(t))
    initialCueTimers.clear()
  }
  watch(health, (report) => {
    if (!report) {
      prevHealthStatus = {}
      firstReportHandled = false
      clearInitialCueTimers()
      return
    }
    if (!wsConnected.value) return
    const items = toHealthItems(report)
    if (!firstReportHandled) {
      firstReportHandled = true
      const keys = HEALTH_PRIORITY.filter((k) =>
        items.some((i) => i.key === k && i.status === 'down'),
      )
      clearInitialCueTimers()
      keys.forEach((k, idx) => {
        initialCueTimers.set(k, setTimeout(() => {
          initialCueTimers.delete(k)
          void playPromptCue(HEALTH_CUE[k])
        }, idx * 4600))
      })
      for (const item of items) prevHealthStatus[item.key] = item.status
      return
    }
    const changed: HealthItem['key'][] = []
    for (const item of items) {
      const prev = prevHealthStatus[item.key]
      // 首次报告的 down 若已恢复 ok：取消还没播的提示音，避免误报（探测偶发超时造成的短暂 down）。
      if (prev === 'down' && item.status === 'ok') clearInitialCueTimer(item.key)
      if (prev === 'ok' && item.status === 'down') changed.push(item.key)
    }
    for (const item of items) prevHealthStatus[item.key] = item.status
    const downKeys = HEALTH_PRIORITY.filter((k) => changed.includes(k))
    if (!downKeys.length) return
    playPromptCueSequence(downKeys.map((k) => HEALTH_CUE[k]))
  })

  // 麦克风是核心能力：仅当「已授权 → 未授权/未知」变化时补播一次提示；
  // 首次连上时的未授权由 announceMicIfNeeded() 负责播报，避免重复。
  // 定位是非必须能力，全程只显示状态、绝不播提示音。
  let prevMicState: PermissionState | null = null
  watch(permissions, (p) => {
    if (!wsConnected.value) {
      prevMicState = null
      return
    }
    if (prevMicState === 'granted' && p.mic !== 'granted') playPromptCue('micDenied')
    prevMicState = p.mic
  })

  // 播放完自动收藏（前端）：歌曲自然播放结束（含循环播完）时，若开关开启，
  // 把当前曲目加入收藏。与播放源无关，单一收藏列表；收藏读写后端未实现，先入内存列表演示。
  watch(musicState.ended, (endedNow) => {
    if (!endedNow) return
    if (!appConfig.playback.autoSave) return
    const title = musicState.title.value.trim()
    const url = musicState.url.value.trim()
    if (title && url) addFavorite({ title, url })
  })

  // 媒体播放(音乐/新闻/电台)期间静音上行，由插话开关 bargeIn 决定（与 isAsrMuted 同源口径）：
  //  - 关（默认）：外放声音不经网关 TTS、AEC 无参考信号消不掉回声，新闻/音乐声会被麦克风收回
  //    识别成用户话、助手乱答（真机铁证：播新闻时"韦东奕在学术论坛中演讲"被识别并触发乱答）。
  //    故媒体播放期静音上行，KWS 仍照常听原始帧、可喊词打断、可执行播放控制命令。
  //  - 开：用户明确要边播边插话，则放行上行（接受回声误识别风险）。
  // 两套机制都要跟上 bargeIn：① JS onPcm 每帧读 isAsrMuted()（已含媒体判断）；② iOS 原生
  // setMediaPlaying 走 here（Android 原生无此方法、为空操作，靠 ① 生效）。开关切换/播放起停
  // 都要重算，故 watch 同时监听 playing 与 bargeIn。
  watch(
    [musicState.playing, () => appConfig.general.bargeIn],
    ([playing]) => setMediaPlaying(playing && appConfig.general.bargeIn !== true),
    { immediate: true },
  )

  function handleServerEvent(event: ServerEvent): void {
    // 待唤醒态不消费任何 ASR 事件：唤醒只认端侧 KWS（「唤醒前不调 ASR」是硬原则）。
    // 待唤醒态上行已静音，正常不会有识别结果；这里再兜一层，防止模式切换瞬间的滞后
    // 事件（切换前已在链路上的识别结果）被当成用户输入，造成「一唤醒就冒出一堆文字」。
    if (mode === 'wake' && event.type.startsWith('asr.')) return
    // 定位「播完一轮后直接说话不识别」：记录识别事件是否到达前端及当前状态
    if (event.type === 'asr.partial' || event.type === 'asr.final' || event.type === 'asr.rejected') {
      console.info('[da] ASR_EVT ' + event.type + ' mode=' + mode + ' state=' + state.value
        + ' phase=' + phase.value + ' text=' + ((event as { text?: string }).text ?? ''))
    }
    switch (event.type) {
      case 'asr.partial':
        // confirming（T2 倒计时）下用户一开口就要取消退下：partial 是说话过程中的流式识别，
        // 比等 asr.final（endpointMs 静音 + 识别链 2.5s+）早得多——否则 T2 先炸、话被吞
        //（用户实测「刚好卡在要退下的时机就退下了」）。listening 态下重置 T1 同理早触发。
        if (mode === 'dialog') {
          // 刚被 KWS 消费掉的那句唤醒词，ASR 兜底链路还会再转写一遍——静默窗内直接忽略，
          // 既不写草稿区、也不当成新插话（真机实测：KWS 命中后 3.4s ASR 又把『小熊小熊』送进来）。
          if (isKwsWakeEcho(event.text)) break
          dispatch({ type: 'USER_SPEECH' })
          // 播报中 partial 命中「小熊小熊」= 用户嫌这句太长、想立刻打断：流式识别到就打断，
          // 不等 asr.final 定稿（那要再等 endpoint 1 秒 + 识别链，体感「打断很困难」）。
          // 回声已被网关 resemblesSpoken 在 partial 层挡掉，这里不会把助手自己话当打断。
          if (
            isSpeaking.value &&
            matchWakeWord(event.text, DEFAULT_WAKE_WORDS) &&
            handleWakeHit(event.text, true)
          ) break
          // 刚入队那句的尾音 partial 不回填草稿（有排队角标就够了）；但紧接的新插话要照常显示——
          // 只看时间窗口会把下一句说话当下的 partial 一起挡掉（真机复现），故改成按文本判断：
          // 只有与刚入队原文一致/互为前缀的尾音才挡，新句文本不同立即显示。
          if (Date.now() < queuedHideUntil && isTailOfQueued(event.text)) break
          // 真正的新文字（非尾音）：取消上一句入队/定稿的延迟清空，避免刚显示的文字被误清
          cancelQueuedClear()
          cancelFinalClear()
          liveText.value = event.text
          if (!assistantBusy && !queuePending.value && !isSpeaking.value && phase.value !== 'listening') {
            phase.value = 'listening'
          }
        }
        break
      case 'asr.queued':
        // 思考/播报期间的插话都排进了队列，网关把识别原文一并透传回来做唤醒词匹配：
        // 命中「小熊小熊」= 用户嫌当前这句长、想打断。招呼一声并让网关跳过当前句（队列保留），
        // 且这句唤醒词不能累加排队徽标——它会被网关从队列删掉，随后 asr.final 的权威剩余数会同步回来。
        if (mode === 'dialog' && matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) {
          if (handleWakeHit(event.text)) break
        }
        // 插话已入队：草稿区显示完整定稿文本（和正常「正在听」一样显示全），保留约 1 秒
        // 让用户看清，之后清掉交给右上角排队角标；这句播完轮到它时再由 asr.final 进正文。
        // liveText 用 event.text（网关透传的完整识别原文），这样草稿区内容和出队列时
        // 「我说」框显示的文本一致，不会出现「草稿区一截、出队列另一截」。
        if (mode === 'dialog') {
          queuePending.value = Math.max(queuePending.value, event.position)
          queuedHideUntil = Date.now() + QUEUED_HIDE_MS
          queuedText = event.text
          liveText.value = event.text
          cancelQueuedClear()
          queuedClearTimer = setTimeout(() => {
            queuedClearTimer = null
            liveText.value = ''
          }, 1000)
        }
        break
      case 'queue.drained':
        // 网关队列全部消费完：清掉排队角标（否则最后一句播完后角标卡住不消失）
        queuePending.value = 0
        break
      case 'asr.rejected':
        // 队列已满时服务端拒收，但仍带回了识别原文：唤醒词即使发生在队列满时也要能打断
        // （招呼 + 跳过当前句），否则用户喊「小熊小熊」会被当成又一句被吞掉。
        if (mode === 'dialog' && matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) {
          if (handleWakeHit()) break
        }
        // 专用话术显示在「我说」卡片右上角（与排队数量徽标同位置同款式），不进正文、不弹浮层
        // 同时播一声 mp3「你说的太多了，我记不住」：队列满也要有听得见的反馈，
        // 否则用户说话后既没入队、正文又不变，会以为没识别到。playPromptCue 内部对
        // 相同 cue 有节流，连续多句被拒不会叠播成一串。
        if (mode === 'dialog') {
          queueFullMsg.value = event.message
          playPromptCue('queueFull')
          // 队列满被拒收：这句没入队，识别文字也不该留在草稿区（已有 mp3 提示音反馈）。
          // 停掉可能存在的入队延迟清 timer，立即清掉文字。
          cancelQueuedClear()
          liveText.value = ''
        }
        break
      case 'asr.final':
        // 刚被 KWS 消费掉的唤醒词，ASR 兜底链路的 final 又到了：静默窗内清掉草稿、忽略，
        // 绝不二次 reWake / 二次招呼（用户实测「喊一遍却招呼两次」「文字留在草稿区」）。
        if (isKwsWakeEcho(event.text)) {
          liveText.value = ''
          break
        }
        // 对话中再次叫「小熊小熊」分两种：
        // - 忙（思考/播报/有排队）：只跳过当前句，队列继续播——招呼一声、通知网关
        //   session.skip_current，不重启会话也不清队列。用户嫌当前这句长时的打断方式。
        // - 空闲（对听中）：整轮重来（reWake = cancel+start+招呼），回干净对听状态。
        // 音乐播放不受影响（不设置 isSpeaking），且此分支只认唤醒词，普通插话不会触发。
        if (matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) {
          if (handleWakeHit(event.text)) break
        }
        // 播报（TTS）还没结束：其它声音不显示正文、不发起新轮次
        //（插话原文已随 asr.queued 进队列角标）。但必须清掉监听草稿 liveText——
        // 这句插话若因定稿太晚、网关没当队列项处理（pb 已 false），前端就既收不到 queued
        // 又在这里丢弃 final，草稿会永远挂着清不掉（真机"一直在草稿区"）。
        // 【fromQueue 例外】队列句回放的 asr.final 到达时，上一句刚播空、tts.idle 刚到、
        // onPlaybackSettled 还没把 isSpeaking 置 false → 这条会被误挡，"我说"框不切成队列那句。
        // 网关对回放句标了 fromQueue=true，跳过守卫正常处理（设 transcript/开新一轮）。
        if (isSpeaking.value && !event.fromQueue) {
          // 播报中的插话 final：草稿区同样显示完整定稿文本（与正常「正在听」一致），
          // 约 1 秒后清掉交给队列角标。不立即清空——否则用户只看到不完整的 partial。
          liveText.value = event.text
          cancelQueuedClear()
          queuedClearTimer = setTimeout(() => {
            queuedClearTimer = null
            liveText.value = ''
          }, 1000)
          break
        }
        // 定稿后这一句进入队列成为「当前项」，你说始终显示队列当前项（不显示监听草稿）。
        // 直接采信服务端的权威剩余数，避免拒收/超时等路径下本地计数漂移。
        queuePending.value = event.queueRemaining
        // 这句已出队进入处理：恢复草稿显示（下一句插话的实时识别又能看见了）
        queuedHideUntil = 0
        queuedText = ''
        cancelQueuedClear()
        cancelFinalClear()
        transcript.value = event.text
        // 【插话出队列】这句在入队时（asr.queued）草稿区已经完整显示过了，回放进正文时
        // 不要在草稿区再显示一遍（用户明确要求）。草稿区保持空，正文「我说」框显示这句。
        if (event.fromQueue) {
          liveText.value = ''
        } else {
          // 正常定稿：草稿补全为完整文本并停留约 0.8 秒再清——partial 滚动识别常慢于语速，
          // 草稿会停在「我喜欢打乒」半截字，用户看不全。让用户看清整句后草稿再消失。
          // 期间若用户开口说下一句，新 partial 会取消这个 timer，不会误清新草稿。
          liveText.value = event.text
          finalClearTimer = setTimeout(() => {
            if (liveText.value === event.text) liveText.value = ''
            finalClearTimer = null
          }, FINAL_DRAFT_HOLD_MS)
        }
        // 队列溢出提示这句轮到被处理，横幅自然失效
        queueFullMsg.value = ''
        // 新一轮说话：清掉上一轮的回答与思考，等模型重新流式输出
        reply.value = ''
        thinking.value = ''
        thinkingDone.value = false
        replyDone.value = false
        phase.value = 'thinking'
        armThinkingCue()
        feedLlmWatchdog()
        assistantTextStarted = false
        assistantBusy = true
        answerHasTts = false
        cancelPendingIdle()
        dispatch({ type: 'USER_SPEECH' })
        dispatch({ type: 'ASSISTANT_BUSY' })
        break
      case 'llm.thinking':
        thinking.value += event.text
        if (!assistantTextStarted) phase.value = 'thinking'
        feedLlmWatchdog()
        break
      case 'llm.delta':
        feedLlmWatchdog()
        // 新回答首字要清空上一轮文本。assistantTextStarted 在插话队列路径（asr.final 里
        // isSpeaking 时直接 break）没被重置，单靠它会把新回答累加到旧回答上（助手框累加）。
        // replyDone=true 是 llm.done 设的「上一轮已完成」可靠信号，补上它兜底插话场景。
        if (!assistantTextStarted || replyDone.value) {
          assistantTextStarted = true
          thinkingDone.value = true
          replyDone.value = false
          reply.value = ''
        }
        reply.value += event.text
        // 文字吐出来到真正出声之间是「正在回答」（replying）——原始就有的合理中间态：
        // LLM 流式文字先显示，攒段 TTS 合成完、tts.start 真正出声才切 speaking「正在播报」。
        // 用户明确这个过渡合理、要保留。之前"卡在正在回答不切播报"不是 replying 的错，
        // 而是下一句 tts.start 被抗重复守卫误吞（见 tts.start 分支的 ttsIdleSeen 修复）。
        if (phase.value !== 'speaking') phase.value = 'replying'
        // 不在这里撤销 thinking 提示：文字出来了但 TTS 还没开始播（合成/下载中）这段
        // 也要计入"等待出声"，到 tts.start 才 disarm。
        break
      case 'llm.done':
        console.info('[da] LLM_DONE recv speaking=' + isSpeaking.value + ' phase=' + phase.value)
        clearLlmWatchdog()
        thinkingDone.value = true
        replyDone.value = true
        if (!isSpeaking.value) setPhaseDone('llm.done')
        // 没有 TTS 的回答到这里就结束了，从现在起重新算静默
        if (!answerHasTts) markAnswerDone()
        break
      case 'tts.start':
        // 抗重复：同一句 TTS 若因任何原因被重复下发（传输层/重连竞态/未知双发），
        // 已经在播报中（isSpeaking）又来一个 tts.start 视为重复，直接忽略，避免「放两遍」。
        // 【队列回放例外】播空后网关收到 playback_done 立即推进、下一句 tts.start 会落在
        // 「收到 tts.idle（ttsIdleSeen）→ 600ms 延迟收尾」窗口内，此时 isSpeaking 还没复位——
        // 这是合法新句，不是重复！若不处理就直接 break，phase 卡 replying「正在回答」永不切
        // speaking「正在播报」（真机铁证）。识别到就先同步收尾上一句，再继续处理本句。
        if (isSpeaking.value && !ttsIdleSeen) break
        if (isSpeaking.value && ttsIdleSeen) {
          console.info('[da] TTS_START after idle(新句) - 先同步收尾上一句 phase=' + phase.value)
          // 上一句已播空（tts.idle 到过），立即收尾复位 isSpeaking/phase，避免本句被吞。
          // 不再回执网关：tts.idle 本就是网关下发的播完确认，网关侧已收到 playback_done。
          if (idleSettleTimer) { clearTimeout(idleSettleTimer); idleSettleTimer = null }
          onPlaybackSettled(false)
        }
        ttsIdleSeen = false
        console.info('[da] TTS_START recv phase=' + phase.value)
        diagPhase('TTS_START')
        lastLlmActivityAt = Date.now()
        clearLlmWatchdog()
        cancelPendingIdle()
        // 【必须】撤销 T1 静默计时：上一句播完时 onPlaybackSettled→markAnswerDone 已经
        // 启动了 T1(30s)，而队列里的下一句会在几十毫秒内就 tts.start 开播。T1 不会因为
        // 又出声而自动作废 → 30s 后 T1 超时 → T2(15s) → 退下/会话 cancelled → 剩余批次
        // 被 stale() 跳过（真机铁证：十大瞬间只播到第 7 条就停，日志里 DONE 后 17ms 就
        // TTS_START，30+15s 后 state=standby）。ASSISTANT_BUSY 只做 cancelT1、不改状态。
        dispatch({ type: 'ASSISTANT_BUSY' })
        // 真正开始出声了：撤销"等待出声"提示计时（思考+文字+TTS等待这段已结束）
        disarmThinkingCue()
        // 不再 resetPlayback()：网关已等上一句播完才下发这一句，
        // 清空队列会把「上一句」的尾音掐掉，正是用户听到的中断。
        answerHasTts = true
        // 铁证：TTS 原生直连后 playbackInFlight 永不置 true，tts.end 时 onAppPlaybackIdle
        // 立即兑现（SETTLED sinceTtsEnd=3ms）→ 提前完成并停播。收到 tts.start 显式置位，
        // 等原生播空 emitIdle 才收尾。
        if (isAppPlaybackSupported()) markPlaybackInFlight()
        isSpeaking.value = true
        lastSpokeAt = Date.now()
        phase.value = 'speaking'
        // 新句开始：恢复正常播报音量（兜底，防上句 duck 未恢复就开下一句）
        setAppPlaybackVolume(TTS_VOLUME_NORMAL)
        // 播报期间压低正在播放的音乐，避免盖住助手说话
        duckMusic(true)
        break
      case 'tts.stop':
        // 被打断：立刻掐掉已排队的音频，不等它播完
        cancelPendingIdle()
        stopTts()
        duckMusic(false)
        isSpeaking.value = false
        setPhaseDone('tts.stop')
        markAnswerDone()
        break
      case 'tts.end': {
        // 网关下发完 ≠ 客户端播完：播完前保持静音上行、挂起 T1，
        // 否则尾音被收回当成用户说话，或还没播完就触发「还在吗」。
        cancelPendingIdle()
        // 播完回执兜底：App 端 AudioTrack idle 回调链若丢失（历史坑），这里永不触发，
        // 网关就每句白等 30s 超时——表现正是「队列有数据却不处理」。超时后强制走
        // 与 idle 相同的收尾（复位 + notifyPlaybackDone），保证队列持续推进。
        // 兜底只做最后保险（怕 tts.idle 万一丢），绝不能抢在真播空前面：
        // 铁证超长播报 120 秒时，90s 兜底仍会提前触发 → 提前显示「本轮完成」+ 停播。
        // 正常播完由 tts.idle（原生直连播空回执）收尾，它到达会 clear 掉这个兜底。
        // 300s 足够覆盖任何合理播报长度。
        playbackDoneFallback = setTimeout(onPlaybackSettled, 300_000)
        cancelPlaybackIdle = waitPlaybackIdle(onPlaybackSettled)
        // 更短的播报看门狗：原生播空检测偶发失效时（tts.idle 永不到、300s 兜底太慢），
        // 25s 内强制收尾，避免界面卡「正在播报」、音乐音量一直被 duck。tts.idle 到达会 clear。
        armSpeechWatchdog()
        // 【iOS 网关停滞兜底】用网关按实际音频字节估算的播完时长设精确收尾 timer：
        // iOS 网关 DATA_STALL 时 tts.idle 下发不出来，前端不能干等 60s watchdog（真机铁证
        // 卡「正在播报」→T1/T2→退下→重新唤醒→「只能聊一次」死循环）。到点时若仍在等这轮
        // 播完（playbackDoneFallback 未被清）就本地收尾。tts.idle 正常到达会走 onPlaybackSettled
        // → clearPreciseIdle，对回执正常的 Android 零影响。
        clearPreciseIdle()
        const exactMs = event.durationMs
        if (exactMs && exactMs > 0) {
          console.info('[da] PRECISE-IDLE arm durationMs=' + exactMs)
          preciseIdleTimer = setTimeout(() => {
            preciseIdleTimer = null
            // playbackDoneFallback 未清 = 这轮还没收尾（tts.idle 没来）；已清=已经收尾，幂等跳过
            if (playbackDoneFallback === null) return
            console.info('[da] PRECISE-IDLE fire (tts.idle 未到，按时长强制收尾 + 回执网关)')
            // 【关键】必须通知网关（true）：精确 timer 触发说明 tts.idle 没来=网关没收到播完回执，
            // 网关 playbackPending 仍为 true、回声门控一直开着 → 用户后续说话的帧被当回声过滤、
            // 无法识别（真机铁证：收尾后 235s 内 FRAME 全 rms=0.0000、ASR 0 条）。前端 WS 是通的
            // （ASR 上行/tts.idle 下行都走它），notifyPlaybackDone 能让网关清 playbackPending、关回声
            // 门控、用户立刻可被识别。正常 tts.idle 到达仍走 false（网关已有回执，避免回执循环）。
            onPlaybackSettled(true)
          }, exactMs)
        }
        break
      }
      case 'tts.idle': {
        // 原生直连播空的权威回执（经网关下发）：真正播完的时刻，做本地收尾但不再回报网关
        // （tts.idle 本就是网关发的确认，再回报会形成循环）。
        // 不再用 isSpeaking 作守卫：播报期若被 tts-error 等分支抢先置 false，真正的播空回执
        // 会被守卫跳过、phase 永久卡 speaking。改为「只要还在等播完就收尾」——tts.end 挂了
        // playbackDoneFallback，收尾后清空，故它是否还在即为是否 awaiting 播完的权威标志。
        console.info('[da] TTS_IDLE recv speaking=' + isSpeaking.value
          + ' phase=' + phase.value + ' waiting=' + (playbackDoneFallback !== null))
        diagPhase('TTS_IDLE recv')
        if (playbackDoneFallback !== null || isSpeaking.value || phase.value === 'speaking') {
          // 标记「上一句已播空」：队列回放的下一句 tts.start 常在这之后、前端收尾之前到达，
          // tts.start 守卫据此识别为合法新句而非重复（见 tts.start 分支）。
          ttsIdleSeen = true
          // 延迟确认：网关多句播放时每句播空都发 tts.idle，第一句播空不代表整轮结束。
          // 【关键】TTS 音频在 App 端走原生直连（role=pcm→playPcmBytes），不经 JS 的 playTts，
          // 所以 lastTtsAudioAt 在 App 上永远不更新、不能用来判断下一句。改用 tts.idle 自身：
          // 每收到一个 idle 就重置延迟；600ms 内没有新的 idle（=最后一句）才收尾。
          // 多句之间下一句 TTS 合成+下发需要数百 ms~数秒 > 600ms，中间 idle 会被后续 idle 重置。
          if (idleSettleTimer) clearTimeout(idleSettleTimer)
          idleSettleTimer = setTimeout(() => {
            idleSettleTimer = null
            console.info('[da] TTS_IDLE settle (600ms 无后续 idle)')
            onPlaybackSettled(false)
          }, 600)
        }
        break
      }
      case 'media.play': {
        // proxy 标记由网关按频道判定（B 站等防盗链直链需走网关 /music/stream 代理补 Referer）；
        // 客户端不再写死任何频道名，只按此标记决定是否拼代理地址。
        const playUrl = event.proxy
          ? toProxiedMusicUrl(event.url, resolveGatewayHttpBase())
          : event.url
        // 抗重复：同一首歌（实际播放地址 + 标题）在 2s 内被重复下发只播一次，避免「放两遍」。
        // 用 playUrl 而非原始 event.url 做签名，防止代理地址差异绕过去重。
        // 换一首/换源地址不同，或用户真的点了重播（间隔 >2s）都不受影响。
        // 此外 playMusic 自身对同一首「正在播」的重复调用也直接短路，双保险。
        const sig = `${playUrl}|${event.title}`
        const now = Date.now()
        if (sig === lastMediaPlaySig && now - lastMediaPlayAt < MEDIA_PLAY_DEDUP_MS) break
        lastMediaPlaySig = sig
        lastMediaPlayAt = now
        // 每次新播放先清掉上一条内容的字幕数据，避免张冠李戴：从有字幕的百科/诗词切到无字幕的
        // 新闻/音乐时，旧字幕会留在屏幕上。网关统一在 media.play 之后紧跟本条 media.subtitle，
        // 所以这里清完会被本条字幕覆盖；无字幕内容则清完保持空（显示「暂无字幕」）。
        // 不动 subtitleVisible——保留用户手动「关闭字幕」的意图，新字幕到达时现有逻辑会翻回显示。
        subtitle.value = null
        // 播放方式分两类：能拿到「可下载的文件地址」就先下到本地再播，否则直接把 URL 交给播放器。
        // 之所以优先本地文件：DCloud AudioPlayer 直拉 HTTP 流不稳（实测 -99 且不发请求），本地文件 100% 可靠。
        // 下载 + 起播的细节全部封装在 playDownloadedMedia 里，这里只负责决定「下哪个地址、带什么选项」。
        //
        // downloadUrl 有两个来源（同时存在时 audioPath 优先，因为它是网关预转封装好的短链、更稳）：
        //  1) audioPath —— 网关已备好的音频短链相对路径（B 站 dash 音轨转封装后的 aac：
        //     music/s/<key>.aac；音乐/评书/新闻视频音轨都走此短链）。路径由网关持有，客户端只拼 base，
        //     不区分来源。dash 整轨较大（9MB+），加 preload 让播放器先亮出「正在准备」，避免界面空白。
        //  2) m4s 代理直链 —— B 站 dash 未走短链时的降级路径：下载失败就带回退地址 fallbackUrl，
        //     让 playDownloadedMedia 改用直播流重试（该直链经网关代理补 Referer，见 playUrl）。
        // 两者都没有（普通网络电台/直链歌曲）时 downloadUrl 为 null，走 playMusic 直接播 playUrl。
        const base = resolveGatewayHttpBase()
        const loop = event.loop != null ? { loop: event.loop } : undefined
        const downloadUrl = event.audioPath
          ? `${base}/${event.audioPath}`
          : event.proxy && event.url.includes('.m4s') ? playUrl : null
        if (downloadUrl) {
          playDownloadedMedia(downloadUrl, event.title, {
            ...loop,
            // 短链要预亮播放条；m4s 直链则留回退地址，下载失败时降级重试直播流。二者互斥。
            ...(event.audioPath ? { preload: true } : { fallbackUrl: playUrl }),
          })
        } else {
          playMusic(playUrl, event.title, loop)
        }
        // 封面与音频同源（歌曲宝详情页），每次新播放覆盖，无封面时清空避免显示上一首
        musicCover.value = event.cover ?? ''
        // 记录音频来源方式（音乐 / 第三方 TTS）：播放模式相同，供界面与后续逻辑区分类型
        mediaSource.value = event.source ?? 'music'
        break
      }
      case 'media.pause':
        pauseMusic()
        break
      case 'media.resume':
        resumeMusic()
        break
      case 'media.stop':
        stopMusic()
        musicCover.value = ''
        // 停止后悬浮小圆消失，字幕面板会从「与悬浮互斥」状态切回可见；
        // 清掉上一首的字幕数据并复位 visible 为开，让下一首照常自动显示（而不是停在「已关闭」）。
        subtitle.value = null
        subtitleVisible.value = true
        break
      case 'media.subtitle':
        // close=true 由语音「关闭字幕」指令下发，收起字幕面板（保留数据，便于手动/语音再打开）；
        // 否则按 lines 渲染/更新，并翻 visible 为开（新歌/语音「开启字幕」都走这里，自动或重新显示）。
        if (event.close) {
          subtitleVisible.value = false
          break
        }
        // 循环重播同一首时，网关偶发的空字幕不应把已显示的歌词覆盖成「暂无字幕」。
        // 仅在「同一首歌 + 当前已有非空歌词」时保留；新歌没字幕仍正常显示「暂无字幕」。
        if (
          (!event.lines || event.lines.length === 0) &&
          subtitle.value?.title === event.title &&
          subtitle.value.lines.length
        ) {
          break
        }
        subtitle.value = { title: event.title, artist: event.artist, lines: event.lines ?? [] }
        // 新字幕（新歌 / 语音「开启字幕」重发）一律重新显示，覆盖之前手动/语音关闭的状态。
        subtitleVisible.value = true
        break
      case 'media.volume':
        // 网关语音「音量 30% / 调大 / 调小」下发，直接设到本地播放器与滑块显示；
        // 这是服务端驱动的，不回执（避免又把同一值上报回去形成环）。
        setMusicVolume(event.volume)
        break
      case 'media.detail':
        // 结构化内容卡片的全量状态快照：close=true 收起，否则整体替换。
        // 与助手回复流无关（页面里单独成块展示），后续对话不会顶掉它。
        detailCard.value = event.close ? null : { ...event }
        break
      case 'client.playMode': {
        // 语音「切换播放模式」：网关只下发意图，客户端翻转/指定显示模式并落盘，
        // 让设置页开关与实际呈现同步（悬浮小圆 与 普通播放条互斥，二选一显示）。
        const next = event.mode ? event.mode === 'float' : !appConfig.playback.floatPlayer
        appConfig.playback.floatPlayer = next
        persistConfig()
        break
      }
      case 'audio.duplex':
        halfDuplex.value = event.mode === 'half'
        break
      case 'audio.duck':
        // 【2026-11-23 最终定稿】iOS 无硬件 AEC、无法可靠边播边插话，网关一旦误判回声为
        // 人声就 duck 把音量压低，但识别仍不准——用户拍板：不能插话就别变小声。
        // 忽略 audio.duck，播报音量全程保持正常；插话靠端侧 KWS 喊「小熊小熊」打断。
        // 只在 duck=false（恢复）时确保音量回到正常，兜底防别处误压。
        if (!event.duck) setAppPlaybackVolume(TTS_VOLUME_NORMAL)
        break
      case 'error':
        errorMessage.value = event.message
        phase.value = 'idle'
        assistantBusy = false
        queuedHideUntil = 0
        queuedText = ''
        cancelQueuedClear()
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        cancelPendingIdle()
        disarmThinkingCue()
        dispatch({ type: 'ERROR' })
        break
      case 'client.cue':
        // 能力不可用提示音统一由本地 health 报告驱动（watch health 里的 playPromptCueSequence）。
        // 网关这条 client.cue 在真机上时有时无，不能作为唯一触发源；此处刻意不播，避免与 health 双份叠音。
        // 例外：asr-error 是「运行中识别失败/超时」的瞬时提示（health 不覆盖），按网关节流触发播放。
        if (event.cue === 'asr-error') {
          void playPromptCue('asrError')
        } else if (event.cue === 'llm-error') {
          // LLM 运行中失败：播本地 mp3（不靠 TTS，TTS 可能也坏了）
          void playPromptCue('llmError')
        } else if (event.cue === 'tts-error') {
          // TTS 播报失败：播本地 mp3；并显式复位播报态，避免 tts.start 没配对 tts.end
          // 导致 isSpeaking 卡 true、把队列下一句的 tts.start 当重复吞掉（队列卡死）。
          console.info('[da] TTS_ERROR cue speaking=' + isSpeaking.value + ' phase=' + phase.value)
          if (isSpeaking.value || phase.value === 'speaking') {
            cancelPendingIdle()
            stopAppPlayback() // 复位原生播报态 + playbackInFlight，避免下一句 tts.start 被吞
            duckMusic(false)
            isSpeaking.value = false
            // 关键：只置 isSpeaking=false 不够，phase 仍卡 speaking 会让界面「正在播报」不退出，
            // 且后续真正的 tts.idle 也因 awaiting 已被 cancel 而被忽略。这里一并收尾 phase。
            setPhaseDone('tts-error')
            markAnswerDone()
          }
          void playPromptCue('ttsError')
        }
        break
    }
  }

  /** 回答彻底结束，恢复「用户静默」计时。还有排队句时不启动 T1，避免插话被静默提示打断。 */
  function markAnswerDone(): void {
    assistantBusy = false
    if (queuePending.value > 0) return
    if (state.value === 'listening') dispatch({ type: 'ASSISTANT_IDLE' })
  }

  /** 作废上一轮「等播完」的等待，避免新轮次被旧回调误判为结束。 */
  function cancelPendingIdle(): void {
    cancelPlaybackIdle?.()
    cancelPlaybackIdle = null
    if (idleSettleTimer) { clearTimeout(idleSettleTimer); idleSettleTimer = null }
    clearLlmWatchdog()
    clearSpeechWatchdog()
    // 兜底定时器一并作废：取消等待 = 不再发播完回执（如被打断/重开新轮），防误触发
    if (playbackDoneFallback) {
      clearTimeout(playbackDoneFallback)
      playbackDoneFallback = null
    }
  }

  /** 网关是否真正可用：WS 连通且不在建连/重连中。网关指 WS 本身，与 ASR/LLM/TTS 上游无关。 */
  function gatewayUsable(): boolean {
    return transport.isConnected() && !connecting.value
  }

  /** ASR 是否就绪：语音唤醒完全依赖它，没好就不该唤醒。健康报告没拿到也视为未就绪（不确认好就不放行）。 */
  function asrReady(): boolean {
    const r = health.value
    return !!r && r.asr.configured && r.asr.reachable
  }

  /** 唤醒前置条件（原则）：网关 WS 正常 + ASR 可用，两者缺一不可。 */
  function canWake(): boolean {
    return gatewayUsable() && asrReady()
  }

  /** 被拦时播哪条提示音：优先说清「听不见」的原因，健康报告未到则报网关未连好。 */
  function wakeBlockedCue(): PromptCue {
    const r = health.value
    if (!r) return 'gatewayDown'
    if (!r.asr.configured || !r.asr.reachable) return 'asrDown'
    if (!r.tts.configured || !r.tts.reachable) return 'ttsDown'
    if (!r.llm.configured || !r.llm.reachable) return 'llmDown'
    return 'gatewayDown'
  }

  function dispatch(event: AssistantEvent): void {
    // 原则（硬保证）：网关或 ASR 没好时，任何「进入唤醒/对话」的事件——手动点球 WAKE、
    // 语音唤醒词 WAKE、REWAKE——一律不放行，绝不进入 listening。统一在派发处拦截，
    // 所有路径都绕不过去。提示音由点击入口负责，不在派发处重复播。
    if (
      (event.type === 'WAKE' || event.type === 'REWAKE') &&
      !canWake()
    ) {
      return
    }
    const result = transition(state.value, event)
    state.value = result.state
    result.effects.forEach(applyEffect)
  }

  function applyEffect(effect: AssistantEffect): void {
    switch (effect) {
      case 'startWake':
        void enterWake()
        break
      case 'stopWake':
        leaveWake()
        break
      case 'startSession':
        transcript.value = ''
        reply.value = ''
        thinking.value = ''
        thinkingDone.value = false
        replyDone.value = false
        phase.value = 'listening'
        errorMessage.value = ''
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        assistantTextStarted = false
        assistantBusy = false
        answerHasTts = false
        cancelPendingIdle()
        void enterDialog()
        break
      case 'endSession':
        cancelPendingIdle()
        disarmThinkingCue()
        queuedHideUntil = 0
        queuedText = ''
        cancelQueuedClear()
        stopTts()
        isSpeaking.value = false
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        phase.value = 'idle'
        assistantTextStarted = false
        break
      case 'cancelSession':
        cancelPendingIdle()
        disarmThinkingCue()
        queuedHideUntil = 0
        queuedText = ''
        cancelQueuedClear()
        stopTts()
        transport.sendCancel()
        isSpeaking.value = false
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        setPhaseDone('endSession')
        assistantTextStarted = false
        break
      case 'playGreeting': {
        // 招呼先落到界面，声音由本地提示音负责
        reply.value = '我在'
        // 本地招呼是完整播放、不走 LLM 生成，标记完成，避免助手卡片一直显示「生成中」
        replyDone.value = true
        playPromptCue('greeting')
        break
      }
      case 'scheduleT1':
        clearT1()
        // 助手还在回答时不启动静默计时，避免长回答中途触发「还在吗」
        if (assistantBusy) break
        t1Timer = setTimeout(() => dispatch({ type: 'T1_TIMEOUT' }), config.t1SilenceMs)
        break
      case 'cancelT1':
        clearT1()
        break
      case 'scheduleT2':
        clearT2()
        t2Timer = setTimeout(() => dispatch({ type: 'T2_TIMEOUT' }), config.t2GraceMs)
        break
      case 'cancelT2':
        clearT2()
        break
      case 'playPrompt':
        playPromptCue('stillThere')
        break
      case 'playFarewell':
        playPromptCue('farewell')
        clearClosing()
        closingTimer = setTimeout(() => dispatch({ type: 'SESSION_DONE' }), 1500)
        break
    }
  }

  /** 待唤醒：连网关（wake 模式）并开启麦克风上行；上行静音，只靠端侧 KWS 唤醒。 */
  async function enterWake(): Promise<void> {
    mode = 'wake'
    // 回待唤醒：恢复自动熄屏。对话期间为保定位/防后台 CPU 超限被杀一直常亮，
    // 回到待唤醒后必须放开，否则永远不熄屏、耗尽电量（KWS 仍常驻，熄屏也能喊词唤醒）。
    setAppScreenOn(false)
    // 唤醒前不调 ASR（硬原则）：走统一门控 isAsrMuted()（mode=wake→静音）。
    // 端侧 KWS 在本地跑，不依赖上行，照常能唤醒。
    syncAsrGate()
    // 回到待唤醒态：停掉 30s 健康轮询（KWS 常驻，唤醒前不调 ASR，无需重复探测）。
    stopHealthPolling()
    // 每次开启唤醒重新武装掉线播报，让一次新的「开启」能重新提示一次
    resetGatewayDownAnnounce()
    phase.value = 'idle'
    assistantBusy = false
    answerHasTts = false
    await ensureCapture()
    // 网关可能刚重启过，本地标志会过期；一律以传输层的真实连接状态为准
    if (transport.isConnected()) {
      transport.startSession('wake')
      void announceMicIfNeeded()
      return
    }
    try {
      await transport.connect('wake')
      void announceMicIfNeeded()
    } catch {
      // 建连失败交给自动重连；确认连不上由「重连耗尽」统一播报，此处静默。
    }
  }

  /** 命中唤醒：在同一条连接上切到 dialog 模式，进入 LLM/TTS。 */
  async function enterDialog(): Promise<void> {
    mode = 'dialog'
    // 对话期间保持屏幕常亮：① 后台拿不到定位（天气首次问失败）② 后台高 CPU 触发系统杀进程。
    // 对话结束回待唤醒（enterWake）时恢复自动熄屏。
    setAppScreenOn(true)
    // 进入对话态走统一门控：刚唤醒 phase 还是 listening/idle → 不静音，用户说的话送 ASR。
    syncAsrGate()
    // 进入对话态才启动 30s 健康轮询：对话中要用 ASR/LLM/TTS，需持续掌握可用性。
    startHealthPolling()
    if (transport.isConnected()) {
      transport.startSession('dialog')
      return
    }
    try {
      await transport.connect('dialog')
    } catch {
      // 切到对话时建连失败：自动重连兜底，静默；连不上由「重连耗尽」统一播报
    }
  }

  /** 关闭助手：停采集、关连接，并停掉音乐。两个采集后端互斥，都尝试停止（未启动的是 no-op）。 */
  function leaveWake(): void {
    setAppScreenOn(false) // 退出助手：恢复自动熄屏（对话期保持常亮的对称收尾）
    stopHealthPolling()
    resetGatewayDownAnnounce()
    if (capturing) {
      stopCapture()
      stopAppCapture()
      capturing = false
    }
    stopTts()
    stopMusic()
    subtitle.value = null
    musicCover.value = ''
    transport.close()
  }

  async function ensureCapture(): Promise<void> {
    if (capturing) return
    // 上行掐麦只在「待唤醒」态生效（mode==='wake'）：唤醒前不调 ASR 是硬原则，唤醒只靠端侧 KWS。
    // 一旦进入对话（mode==='dialog'），用户随时可能说话，**绝不能掐麦**——回声交给 App 端 AEC +
    // 网关文本层 resemblesSpoken + 唤醒回声窗口处理。
    //
    // 血泪：旧条件是 isPromptCuePlaying() && !isSpeaking.value。播报期 isSpeaking 一旦被
    // 状态机误置 false，又恰逢 cue 窗口（greeting/thinking/asr-error 提示音）——而 asr-error
    // 因上行静音→识别失败→下发 asr-error→延长 cue 窗口 3.4s——形成恶性循环，播报全程上行
    // 被清零（真机铁证：采集端 rms 0.137，网关收到 0.0001），插话永远识别不到。
    // 改为「仅待唤醒态掐麦」后，对话态永不掐麦，从根上斩断循环。
    let pcmDiagAt = 0
    const onPcm = (pcm: ArrayBuffer): void => {
      // ASR 上行门控：唯一判据 isAsrMuted()（见文件上部定义），前端与 iOS 原生共用。
      // 静音时上行全 0，网关 ASR 收不到音频——待唤醒靠 KWS、思考/说/播报期杜绝回声自激。
      const muted = isAsrMuted()
      const now = Date.now()
      if (now - pcmDiagAt > 3000) {
        pcmDiagAt = now
        console.info('[da] ONPCM muted=' + muted + ' mode=' + mode + ' phase=' + phase.value
          + ' connected=' + transport.isConnected())
      }
      transport.sendAudioChunk(muted ? new ArrayBuffer(pcm.byteLength) : pcm)
    }

    // H5 走 WebAudio；App 走 app-product-wake 原生插件的实时 PCM 接口；
    // 两者都不可用（如未打自定义基座的旧客户端）时明确提示，不静默假装能唤醒。
    if (isH5AudioSupported()) {
      try {
        await startCapture(onPcm)
        capturing = true
      } catch (err) {
        errorMessage.value = t('error.micUnavailable', { reason: (err as Error).message })
      }
      return
    }

    if (isAppCaptureSupported()) {
      // 原生 AudioRecord 需要运行时麦克风权限，且框架不会代请求，必须前端先申请。
      const granted = await requestMicPermission()
      if (!granted) {
        errorMessage.value = t('error.micUnavailable', { reason: '麦克风权限被拒绝' })
        return
      }
      const ok = startAppCapture(onPcm, (message) => {
        errorMessage.value = t('error.micUnavailable', { reason: message })
      })
      if (ok) capturing = true
      else errorMessage.value = t('error.micUnavailable', { reason: '原生录音启动失败' })
      return
    }

    errorMessage.value = t('error.captureUnsupported')
  }

  function clearT1(): void {
    if (t1Timer) clearTimeout(t1Timer)
    t1Timer = null
  }

  function clearT2(): void {
    if (t2Timer) clearTimeout(t2Timer)
    t2Timer = null
  }

  function clearClosing(): void {
    if (closingTimer) clearTimeout(closingTimer)
    closingTimer = null
  }

  /**
   * 开启并连上网关时，只播「麦克风未授权」这一条核心能力提示。
   * ASR/TTS/LLM/外网不可用改由网关经 client.cue 在建连即下发（此时网关还无法用语音播报，
   * 只能靠提示音；且网关是唯一能判定它们是否真接入的一方），客户端不再重复播，避免双份提示音。
   * 定位是非必须能力，只显示状态、不参与播报。
   */
  async function announceMicIfNeeded(): Promise<void> {
    await refreshPermissions()
    if (permissions.value.mic !== 'granted') playPromptCue('micDenied')
  }

  /**
   * 开启助手：先等内嵌网关就绪（原生 :gateway 进程写出 gateway.url）再进入待唤醒。
   * 未就绪（超时）时显示 i18n 提示并出声，不静默、不继续连默认回退地址。
   * 非内嵌（H5 / 外部网关）下 waitForEmbeddedGateway 立即返回 true，行为不变。
   */
  let enabling = false
  async function enable(): Promise<void> {
    if (enabling) return // 防重入：connect 触发的连接恢复回调会试图自动重开
    enabling = true
    try {
      // 把落盘的 duck 配置下发到原生（冷启动时原生还没收到设置页的配置）
      setDuckConfig(
        appConfig.general.interruptDuck !== false,
        DUCK_LEVEL_PERCENT[appConfig.general.duckLevel ?? 'medium'],
        appConfig.general.bargeIn === true,
      )
      setAecUserEnabled(appConfig.general.aecEnabled === true)
      gatewayPreparing.value = true
      gatewayFailed.value = false
      errorMessage.value = ''
      // 「准备中」提示音在调 health/建连之前就播：真机 health 首次探测可达 10s+，
      // 等就绪再播「准备中」就晚了（用户反馈接口都调完了才响）。让它先响、正常播完。
      playPromptCue('gatewayPreparing')
      // KWS 引擎初始化（加载 3.3M 模型约 1-3s）与网关就绪等待并行：放到最前面，
      // 等网关 ready 时 KWS 早已可唤醒，避免「首次启动喊好几遍没反应」。
      // 网关没好时即便命中，dispatch(WAKE) 的 canWake 会拦截，不会进假 listening。
      startKws()
      const ready = await waitForEmbeddedGateway()
      if (!ready) {
        // 网关启动失败：结束"启动中"态、标记失败（首页显示失败提示而非误报已就绪），
        // 不播就绪提示；播一次 gateway-down。用户可点语音球重试（state=idle → enable）。
        // 顺序要紧：先置失败标志，再结束启动态——否则 watch 到 preparing→false 时
        // gatewayFailed 还是 false，会误显示"已就绪"。
        gatewayFailed.value = true
        gatewayPreparing.value = false
        errorMessage.value = t('gateway.startFailedRetry')
        announceGatewayDown()
        return
      }
      gatewayFailed.value = false
      // 网关进程就绪 ≠ WS 已连通。必须先确认 WS 真的连上，才允许进入「待唤醒」；
      // 连不上就当场播报并停在「未开启」，绝不进 standby 让用户以为可以点球/喊唤醒词。
      if (!transport.isConnected()) {
        try {
          await transport.connect('wake')
        } catch {
          // 首次连不上：标记失败（不显示"已就绪"），交给自动重连；连不上由「重连耗尽」统一播报
          gatewayFailed.value = true
          gatewayPreparing.value = false
          return
        }
      }
      // connect 返回却仍未连通（如还在握手中）：同样不进 standby，也非就绪
      if (!transport.isConnected()) {
        gatewayFailed.value = true
        gatewayPreparing.value = false
        return
      }
      dispatch({ type: 'ENABLE' })
      // KWS 已在 enable 开头提前启动（与网关就绪并行），此处不重复 start。
      // 真正就绪：结束"启动中"态，首页据此显示短暂的"已就绪"行内文字
      gatewayPreparing.value = false
      // 「准备中」已在等待之前播过（见上），这里只补「就绪」。若准备中还在播，
      // 用串行队列等它播完再播就绪，保证两条都不被打断、按序完整。失败路径上面已 return。
      // 关键：等 KWS 模型真正加载完再播「已就绪」——首次冷启动 KWS 加载可能比网关慢，
      // 早播会让用户以为能喊、实际白喊好几遍。等待期间界面显示「语音唤醒加载中」。
      // 等满即播（最多 6s）：等待本身已保证「不太早」；无条件播保证「有提示」——
      // 不再用 wakeReady 精确值做门控（原生 ready 回调经 weex 桥的 payload 格式不稳，
      // 一旦解析错就永远不播，正是上一版「已就绪没提示」的根因）。
      await waitKwsReady(6000)
      playPromptCueSequence(['gatewayReady'])
    } catch (err) {
      // 兜底：enable 链路任何未预期异常（如原生插件方法缺失抛错）都必须结束「启动中」态，
      // 否则 gatewayPreparing 永远 true、界面永久卡「网关启动中」且 45s 超时机制也不生效。
      console.warn('[enable] 异常，复位启动态', err)
      gatewayFailed.value = true
      gatewayPreparing.value = false
      errorMessage.value = t('gateway.startFailedRetry')
      announceGatewayDown()
    } finally {
      enabling = false
    }
  }

  function disable(): void {
    stopKws()
    dispatch({ type: 'DISABLE' })
  }

  function interrupt(): void {
    dispatch({ type: 'CANCEL' })
  }

  /**
   * 打断「当前这一句」TTS 播报——点语音球 与 说「小熊小熊」统一的打断语义。
   *
   * 与 interrupt()（CANCEL 整轮）的本质区别：
   *  1) 只作废当前句、保留网关队列里排队的句子，不重启会话；
   *  2) **不碰媒体播放器**：音乐/新闻音轨走 media.play → InnerAudioContext，
   *     与 TTS 是两套独立音频，这里停 TTS 不影响它继续放（用户明确要求「别停音乐」）。
   *
   * 客户端处理与收到网关 `tts.stop` 时完全一致（本地立即停声，不等网关往返）：
   * 先停 TTS、复位播报态，再发 session.skip_current 让网关同步停下发并移除队首唤醒词。
   * 网关随后回的 tts.stop 会再走一遍同样逻辑，全部幂等。
   *
   * 覆盖 standby 空闲直连播报（百科/天气/新闻确认句等不经会话的口播）——
   * 这正是原来点球停不掉的根因：那些场景 state=standby，onOrbTap 走的是 wake()。
   */
  function interruptSpeech(dropText?: string, fromKws = false): void {
    cancelPendingIdle()
    disarmThinkingCue()
    stopTts()
    duckMusic(false)
    isSpeaking.value = false
    setPhaseDone('interruptSpeech')
    markAnswerDone()
    lastSpokeAt = Date.now()
    // 【KWS 命中=整轮停】sendSkipCurrent 只跳当前句、runTurn 会继续 shift 队列下一句接着播
    // （网关 skipCurrent 注释明确如此）→ 用户体感"喊了小熊小熊还在播报"。
    // KWS 命中改用 sendCancel（++turn+清队列+整轮重来），播报彻底停；
    // 点球/ASR 文本等保留原 sendSkipCurrent（只跳当前句、队列继续）。
    if (fromKws) transport.sendCancel()
    else transport.sendSkipCurrent(dropText)
  }

  /** 点中间圆球手动开始一轮：等同说「小熊小熊」唤醒，仅待唤醒(standby)态有效。
   * 原则：网关正常才允许唤醒——没连上网关就不放行 WAKE（连不上则 ASR/TTS 都不工作，
   * 「唤醒了但说不了话」是不诚实的状态），此时诚实提示并顺手触发重连。 */
  async function wake(): Promise<void> {
    if (state.value !== 'standby') return
    // KWS 加载失败时点圆球 = 重试加载模型（用户明确要求「失败时点中间也能重新加载」）。
    // 重新挂载 KWS 引擎会把 wakeReady 重置回 loading，界面显示「加载中」；这次点球不进对话，
    // 等 onReady 成功后用户再点球或喊词进入——避免模型还没好就进假 listening。
    if (wakeReady.value === 'failed') {
      console.info('[da] WAKE retry KWS after failed')
      // 先 stop 重置 kwsService/native 的 running 标志（失败时可能仍为 true，直接 start 会被跳过），
      // stopKws 同时把 wakeReady 置回 loading，界面显示「加载中」；再 start 真正重建 KWS 引擎。
      stopKws()
      startKws()
      return
    }
    // KWS 还在加载中时点球：也允许重试一次（幂等保护在 kwsService.start 的 running 标志），
    // 但不打断正在进行的加载；直接放行下面的 wake 流程（网关好了就进对话，点球本就是手动唤醒兜底）。
    if (!canWake()) {
      // 网关可疑且 WS 还连着：ping 一下确认 8787 是否真卡死。WS 已断的情况交给既有
      // scheduleReconnect 处理，这里不重复。ping 不通 = 健康缓存假绿、网关事件循环卡死 →
      // 走「点球重启网关」自愈；ping 通只是 ASR/能力没就绪 → 维持原提示。
      if (transport.isConnected()) {
        const alive = await pingGateway()
        if (!alive) {
          console.info('[da] SELF-HEAL-TRIGGER ping 失败且 WS 连着，判定网关卡死')
          await tryGatewayRestart()
          return
        }
      }
      // 原则：网关/ASR 没好时手动点球不放行；但要提示，不静默——播对应原因的提示音
      playPromptCue(wakeBlockedCue())
      return
    }
    dispatch({ type: 'WAKE' })
  }

  /**
   * 点中间圆球触发的网关重启自愈（不做自动，避免误重启）。
   * 调原生重启网关 → 等 health 就绪 → 重连 WS；失败播 gatewayDown 诚实提示。
   * 互斥 + 60s 冷却防连点循环；WS 断连不在这里处理（交给 transport 重连）。
   */
  async function tryGatewayRestart(): Promise<void> {
    const now = Date.now()
    if (healingInProgress) {
      console.info('[da] SELF-HEAL-SKIP 互斥：已有重启进行中')
      return
    }
    if (now < healCooldownUntil) {
      console.info('[da] SELF-HEAL-SKIP 冷却中，剩余 ' + (healCooldownUntil - now) + 'ms')
      return
    }
    healingInProgress = true
    console.info('[da] SELF-HEAL-BEGIN 原生重启网关')
    playPromptCue('gatewayPreparing') // 复用本地提示音，告诉用户"正在恢复"
    try {
      const started = await restartGatewayViaNative()
      console.info('[da] SELF-HEAL-NATIVE started=' + started)
      if (!started) throw new Error('native restart unavailable')
      // 等网关重新就绪（复用冷启动同一套健康探测，45s；非内嵌立即 true）
      const ready = await waitForEmbeddedGateway({ timeoutMs: 45000 })
      console.info('[da] SELF-HEAL-READY ready=' + ready)
      if (!ready) throw new Error('gateway not ready after restart')
      transport.close()
      await transport.connect(mode)
      void refreshHealth()
      console.info('[da] SELF-HEAL-OK 网关已恢复并重连')
      healCooldownUntil = Date.now() + 60_000
    } catch (e) {
      console.warn('[da] SELF-HEAL-FAIL', e)
      playPromptCue('gatewayDown')
      announceGatewayDown()
      // 失败也设冷却，防连点疯狂重启
      healCooldownUntil = Date.now() + 60_000
    } finally {
      healingInProgress = false
    }
  }

  /** 网关掉线后手动重连：沿用当前会话模式，立即清掉待执行的自动重连再建连。
   * 前提是开启了唤醒（助手处于启用状态），否则无需重连。 */
  async function retry(): Promise<void> {
    if (!enabled.value || transport.isConnected() || connecting.value) return
    try {
      await transport.connect(mode)
    } catch {
      // 手动重连失败：自动重连兜底，静默；连不上由「重连耗尽」统一播报
    }
  }

  /** 客户端点「换一首 / 换个风格」：直接让网关解析下一首，绕开 LLM。 */
  function nextMusic(): void {
    transport.requestMusicNext()
  }

  /** 客户端拖动音量滑块后，把当前音量回执网关，保持网关音量状态同步（供「调大/调小」相对增减）。 */
  function reportVolume(volume: number): void {
    transport.reportVolume(volume)
  }

  /** 重新唤醒：对话进行中再次叫「小熊小熊」时，停掉当前轮次并重新招呼。
   * 网关不可用时 dispatch 已拦截 REWAKE，此处不得再单独把阶段设成 listening 造成假象。 */
  function reWake(): void {
    if (!canWake()) return
    // 唤醒词命中就停媒体（新闻/音乐 InnerAudioContext）：真机铁证——纯媒体播放新闻时
    // 喊「你好小熊」，ASR 文本命中走 reWake 分支（非 TTS 播报态），旧代码这里不停音乐，
    // 只播了「我在」却新闻照放，用户体感「没中断」。KWS 分支虽已在 handleWakeHit 里调过
    // stopMusic（幂等无害），但统一放在 reWake 入口 ensures 两条命中路径都停媒体。
    stopMusic()
    // 识别到的「小熊小熊」也进「我说」框（用户明确要求唤醒词可见）
    transcript.value = DEFAULT_WAKE_WORDS[0]
    liveText.value = ''
    dispatch({ type: 'REWAKE' })
    phase.value = 'listening'
  }

  /** 播报/思考中重新叫「小熊小熊」：招呼一声，只跳过当前句，队列里的句子继续播。
   *  不 dispatch REWAKE——那会 cancel+start 清掉队列；改走 interruptSpeech，只作废当前句、
   *  保留队列，且**不碰媒体播放器**（音乐/新闻音轨继续放）。招呼与「我说」框照旧。
   *  dropText 带上这句唤醒词原文，网关据此把它从队列删掉（它是打断信号、不是指令）。 */
  function skipCurrentAndGreet(dropText?: string, fromKws = false): void {
    // 【KWS 必须命中】KWS 命中不走 canWake 拦截（health 刚启动未就绪会吞命中）；仅 ASR 文本保留。
    transport.sendDiag?.({
      state: state.value, speaking: isSpeaking.value, cue: false, muted: false,
      frames: 0, rms: 0, connected: transport.isConnected(),
      trace: `SKIP-CURRENT called drop=${dropText ?? ''} canWake=${canWake()} fromKws=${fromKws} pb=${isSpeaking.value}`,
    })
    if (!canWake() && !fromKws) return
    // 唤醒词命中打断：播报停、播放也停（用户明确要求）。
    // 不能只认 fromKws——真机铁证播报期 KWS 常漏检，唤醒词其实走 ASR 文本兜底
    // （fromKws=false）进来。走到这个函数本身就是唤醒词匹配通过的，两种来源都要停音乐。
    stopMusic()
    // 识别到的「小熊小熊」也要进「我说」框：用它原文（无参数时用默认唤醒词）。
    // 用户明确要求唤醒词和普通插话一样在「我说」框可见。
    transcript.value = dropText || DEFAULT_WAKE_WORDS[0]
    liveText.value = ''
    // 招呼落到界面并播本地提示音，与 playGreeting 一致
    reply.value = '我在'
    replyDone.value = true
    // 【插话累加修复】重置助手文本起始标志：插话打断后新回答的第一个 llm.delta 到达时，
    // 必须走 775 的 reply.value='' 把「我在」/上一轮回答清掉再累加。不重置则 assistantTextStarted
    // 还是上一轮的 true → 跳过清空 → 新回答 += 到旧文本 = 助手框累加。
    assistantTextStarted = false
    playPromptCue('greeting')
    interruptSpeech(dropText, fromKws)
  }

  /**
   * 唤醒词命中的统一入口（P0 收敛 + KWS 接入点）。
   *
   * 6 处文本匹配（asr.partial/final 的 wake 与 dialog、asr.queued、asr.rejected）和
   * 端侧 KWS 的 onWake 回调都走这里，保证「唤醒 / 打断」的路由与节流只有一份逻辑：
   * - wake 态：过回声窗后 dispatch(WAKE) 进入对话。
   * - dialog 态：忙（思考/播报/排队）→ skipCurrentAndGreet 只跳当前句；空闲 → reWake 整轮重来。
   * - 回声窗（WAKE_ECHO_MS）：刚播完的回声（助手话里的唤醒词）不当作新命中。
   * - canWake 硬约束由 dispatch / skipCurrentAndGreet / reWake 内部保证，网关/ASR 不可达时不放行。
   *
   * @param text 命中的唤醒词原文（进「我说」框、给网关 dropText）；KWS 回调可传 null 用默认词。
   * @param throttle 是否走 PARTIAL_SKIP_MS 节流。流式 partial（连续多帧）和 KWS 命中要节流，
   *   避免一次喊词触发多次招呼；asr.final / queued / rejected 是离散事件，不节流。
   * @returns 是否真正消费了这次命中（调用点据此决定是否 break 后续逻辑）。
   */
  function handleWakeHit(text?: string, throttle = false, fromKws = false): boolean {
    // 【2026-11-23 KWS 必须命中】端侧 KWS 唤醒是本地能力，命中即生效，不受 health 前置条件拦截。
    // 刚启动时 health 探测要几秒，此前 KWS 命中被 canWake() 静默吞掉 → 用户"喊3遍才响应"。
    // 网关/ASR 没好时 enterDialog/connect 本就有重连兜底，不该在唤醒这一步拦。
    // 仅 ASR 文本唤醒(fromKws=false)保留 canWake 硬约束。
    if (!canWake() && !fromKws) {
      try {
        const r = health.value
        transport.sendDiag?.({
          state: state.value, speaking: isSpeaking.value, cue: false,
          muted: mode === 'wake', frames: 0, rms: 0,
          connected: transport.isConnected(),
          trace: `WAKE-BLOCKED ws=${transport.isConnected()} connecting=${connecting.value} asr=${r?.asr.reachable} healthNull=${!r} text=${text || ''}`,
        })
      } catch { /* 诊断失败不影响主流程 */ }
      return false
    }
    if (mode === 'wake') {
      if (Date.now() - lastSpokeAt < WAKE_ECHO_MS) return false
      // 记下 KWS/文本唤醒时刻：接下来几秒内 ASR 转写的同一句唤醒词当回显忽略（见 isKwsWakeEcho）。
      kwsWakeAt = Date.now()
      dispatch({ type: 'WAKE' })
      return true
    }
    if (throttle) {
      if (Date.now() - lastPartialSkipAt < PARTIAL_SKIP_MS) return false
      lastPartialSkipAt = Date.now()
    }
    // 【2026-11-24 真机铁证·播报中 KWS 打断后识别不进 LLM】
    // 旧逻辑：busy 时一律 skipCurrentAndGreet → interruptSpeech → fromKws 走 sendCancel
    // （整轮 cancel 但**不重新 session.start**）→ 网关 cancelled=true 丢弃后续 asr.final，
    // 用户接着说的话进不了 LLM、界面卡"正在听"草稿不动。
    // 修复：KWS 命中（fromKws）无论忙闲都走 reWake()——它 dispatch(REWAKE) 的 effects 含
    // cancelSession + startSession，cancel 后必然重新 start，会话活着才能收音→LLM。
    // 只有 ASR 文本命中（fromKws=false）的 busy 插话才保留 skipCurrent（队列继续）。
    if (fromKws) {
      stopMusic()          // KWS 命中：播报停 + 播放停（用户要求）
      reWake()
    } else if (assistantBusy || isSpeaking.value || queuePending.value > 0) {
      skipCurrentAndGreet(text, false)
    } else reWake()
    return true
  }

  // ── 端侧 KWS 唤醒 ─────────────────────────────────────────────────
  // 命中回调复用 handleWakeHit（与 ASR 文本匹配同一节流点），避免双重招呼/双跳。
  // 唤醒只认端侧 KWS：唤醒前绝不把音频送 ASR（硬原则）。待唤醒态上行被静音，
  // 网关拿不到有效音频，自然不会产生识别请求；KWS 不可用时退化为「点圆球」。
  /**
   * KWS 就绪态（界面据此告诉用户「能不能喊词」）：
   * - loading：模型加载中（约 1–3s），此时喊词可能没反应，提示可点圆球兜底
   * - ready：可喊「小熊小熊」唤醒
   * - failed：引擎不可用（插件缺失/加载失败），只能点圆球
   */
  const wakeReady = ref<'loading' | 'ready' | 'failed'>('loading')
  // KWS 模型加载完成时兑现所有等待者：用于「网关已就绪」提示音等 KWS 真正可用再播，
  // 避免用户听到「已就绪」就喊、但模型还没加载好而白喊（真机首次冷启动的反馈）。
  let kwsReadyWaiters: Array<() => void> = []
  function resolveKwsReady(): void {
    const waiters = kwsReadyWaiters
    kwsReadyWaiters = []
    waiters.forEach((fn) => fn())
  }
  /** 等 KWS 就绪（最多 timeoutMs）；已 ready/failed 立即返回，避免加载失败时干等。 */
  function waitKwsReady(timeoutMs: number): Promise<void> {
    if (wakeReady.value !== 'loading') return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        if (timer) clearTimeout(timer)
        kwsReadyWaiters = kwsReadyWaiters.filter((f) => f !== done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      kwsReadyWaiters.push(done)
    })
  }
  const kwsService: WakeService = createWakeService({
    wakeWords: DEFAULT_WAKE_WORDS,
    lang: getLanguage(),
    onWake: (word) => {
      // 【KWS 命中必须停播报+停播放】前端立即停声（用户要的效果，不依赖网关往返）：
      // ① 停媒体播放器（音乐/新闻 InnerAudioContext）
      // ② 停 TTS 播报
      stopMusic()
      stopTts()
      isSpeaking.value = false
      duckMusic(false)
      // 记下原生 KWS 命中时刻，让接下来 8s 内 ASR 转写的同一句"小熊小熊"当回显忽略。
      // 必须记在这里而非只在 handleWakeHit 的 wake 分支——dialog 态命中（播报打断）也要覆盖。
      kwsWakeAt = Date.now()
      // 【2026-11-23 真机铁证】这里绝不能再 sendCancel：handleWakeHit 内部 REWAKE 的
      // cancelSession effect 或 interruptSpeech(fromKws) 已经各发一次 cancel。实测一次命中
      // 触发两次 session-cancel（间隔 37ms）后紧接 start，时序竞争导致命中后会话状态错乱、
      // 后续指令识别为空——正是「喊好几遍才有一遍能用」的真凶。停播报靠上面 stopTts 已足够。
      try {
        transport.sendDiag?.({
          state: state.value, speaking: isSpeaking.value, cue: false,
          muted: mode === 'wake', frames: 0, rms: 0,
          connected: transport.isConnected(),
          trace: `KWS-ONWAKE-FORCESTOP word=${word || ''} ws=${transport.isConnected()}`,
        })
      } catch { /* 忽略 */ }
      handleWakeHit(word, true, true) // fromKws：端侧命中不受 health 拦
    },
    onError: (msg) => { console.warn('[kws]', msg) },
    onReady: (ok, raw) => {
      wakeReady.value = ok ? 'ready' : 'failed'
      // 诊断：原生 ready payload 的真实形态经网关落盘（Android 没有 jsLog，这是唯一可见通路）。
      // 桥接把 {ready:true} 变成 JSON 字符串时旧解析会误判 failed → 界面「语音唤醒不可用」。
      try {
        transport.sendDiag?.({
          state: 'wake-ready',
          speaking: false,
          cue: false,
          muted: false,
          frames: 0,
          rms: 0,
          connected: transport.isConnected(),
          trace: `ready=${ok} raw=${JSON.stringify(raw)}`,
        })
      } catch {
        // 诊断失败不影响唤醒
      }
      resolveKwsReady()
    },
  })
  function startKws(): void {
    if (!kwsService.isSupported()) {
      wakeReady.value = 'failed'
      resolveKwsReady()
      return
    }
    kwsService.start()
  }
  function stopKws(): void {
    kwsService.stop()
    // 下次开启会重新加载模型，回到「加载中」
    wakeReady.value = 'loading'
  }
  // 唤醒只走端侧 KWS，没有 ASR 文本兜底（唤醒前不调 ASR 是硬原则）：
  // 不可用时用户仍可点圆球开始，故 wakeSupported 恒 true。
  const wakeSupported = true
  const wakeProviderName = computed(() =>
    kwsService.isSupported() ? kwsService.providerName : '网关语音（本地 ASR）'
  )

  /** 重新打开字幕面板：仅翻 visible 标记，数据仍在（手动关闭后照样能打开） */
  function openSubtitle(): void {
    if (subtitle.value) subtitleVisible.value = true
  }

  /** 字幕显隐切换（界面按钮与语音共用）：有数据才有效 */
  function toggleSubtitle(): void {
    if (!subtitle.value) return
    subtitleVisible.value = !subtitleVisible.value
  }

  /** 关闭字幕面板：只翻 visible 标记、保留数据，便于之后手动/语音重新打开 */
  function closeSubtitle(): void {
    subtitleVisible.value = false
    copied.value = false
  }

  /**
   * 复制字幕：把逐行文本拼成纯文本写入剪贴板。用行内「已复制」提示代替 toast（不弹浮层）。
   * 仅当确有字幕时才复制，空字幕不动作。
   */
  function copySubtitle(): void {
    if (!subtitle.value?.lines.length) return
    const text = subtitle.value.lines.map((l) => l.text).join('\n')
    uni.setClipboardData({
      data: text,
      showToast: false,
      success: () => {
        copied.value = true
        setTimeout(() => (copied.value = false), 1500)
      },
    })
  }

  /**
   * 点编号项选中某条详情：纯本地切换 selectedIndex，不上行、不口播。
   * 与语音「说第二个」落到同一状态（网关下发 media.detail(selectedIndex)）等价：
   * UI 点选不必惊动网关，也避免再说一句被 TTS 抢词。
   */
  function selectDetail(index: number): void {
    const card = detailCard.value
    if (!card || !card.items.some((it) => it.index === index)) return
    detailCard.value = { ...card, selectedIndex: index }
  }

  /**
   * 关闭详情卡片（页面关闭按钮）。纯展示状态，不影响网关 pendingDeals。
   * 详情是从列表点进去的，所以关详情先退回列表（items 本来就在快照里，不需要再问网关），
   * 列表形态下再关才整块收起——否则关一次详情连列表一起没了，用户只能重新问一遍。
   */
  function closeDetailCard(): void {
    const card = detailCard.value
    if (card && card.selectedIndex != null) {
      detailCard.value = { ...card, selectedIndex: null }
      return
    }
    detailCard.value = null
  }

  /**
   * 字幕高亮相对播放进度的时间偏移（秒）。
   * - music（歌曲）：onTimeUpdate 采样/解码滞后，给 +1s 提前量让歌词跟唱（原设计）。
   * - tts（百科/诗词朗读）：effectiveSubtitleLines 用真实 duration 均匀重铺 time，但百度 TTS
   *   「读一句停一秒」，字幕仍略超前于声音。给 -1.0s 让字幕滞后，贴合朗读节奏（真机实测 -0.2s
   *   仍「快了些」，加大到 -1.0s）。
   */
  const subtitleLeadSec = computed(() => (mediaSource.value === 'tts' ? -1.0 : 1.0))

  /**
   * tts（百科/诗词）字幕行：用播放器读到的真实 duration 重铺 time，不信任网关算的 durationSec。
   * 真机踩坑：网关 mp3DurationSec 对设备实际下载的音频可能算错（滕王阁序真实 411s 被算成约 489s），
   * 铺出来的 time 过大 → 字幕推进只有声音一半、明显「慢于声音」。播放器 duration 来自解码器、是准的。
   *
   * 重铺用「均匀句间隔 + 前奏补偿」而非字数占比：百度 TTS 是「读一句停一秒」的节奏（本机 ffmpeg
   * 静音检测：洛神赋开头静音 3s、每句间停 0.7~1.6s），字数占比把停顿均摊、字幕匀速跑到声音前面
   * （本机拟合误差 9.3s）；均匀铺误差降到 3.3s，明显更贴。诗词/骈文每句字数相近，均匀铺尤其合适。
   * music（歌曲）走网关原始 lines，一字不动。tts 已关逐字高亮，不存在末行 span≈0 的旧问题。
   */
  const effectiveSubtitleLines = computed(() => {
    const lines = subtitle.value?.lines
    if (!lines?.length || mediaSource.value !== 'tts') return lines ?? []
    const dur = musicState.duration.value
    if (!Number.isFinite(dur) || dur <= 0 || lines.length < 2) return lines
    // 前奏：TTS 音频开头普遍有静音（本机实测诗词 ~3s）。按总时长比例给，短音频自适应小一点。
    const prelude = Math.min(5, dur * 0.05)
    // 尾部留 1s 缓冲，避免末句 time 顶到音频结束、一闪而过。
    const span = Math.max(dur - prelude - 1, 1)
    const step = span / (lines.length - 1)
    return lines.map((l, i) => ({ ...l, time: Math.round((prelude + step * i) * 10) / 10 }))
  })

  const activeSubtitleIndex = computed(() => {
    const lines = effectiveSubtitleLines.value
    if (!lines?.length) return -1
    const cur = musicState.currentTime.value + subtitleLeadSec.value
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= cur) idx = i
      else break
    }
    return idx
  })

  /** 当前正在播放的那句歌词（activeSubtitleIndex 对应行），供悬浮小圆等业务单独大字展示 */
  const currentSubtitleText = computed(() => {
    const idx = activeSubtitleIndex.value
    const lines = effectiveSubtitleLines.value
    if (idx < 0 || !lines || !lines[idx]) return ''
    return lines[idx].text
  })

  /**
   * 近似逐字高亮：把当前行切成「已唱 / 未唱」两段文本。来源只给行级时间，故按字数平分该行时长，
   * 再按播放进度算出已唱字数。中文每字时长较均匀，歌曲观感好；评书/口语语速不均会略有偏移（属近似）。
   * 用 Array.from 切分以兼容代理对（emoji 等），避免 String.slice 按码元计数错位。最后一行用整曲时长作结束。
   */
  const activeSubtitleSplit = computed(() => {
    const lines = effectiveSubtitleLines.value
    const idx = activeSubtitleIndex.value
    if (!lines || idx < 0 || !lines[idx]) return { sung: '', rest: '' }
    // 百科/诗词(tts)不做逐字高亮：TTS 朗读有停顿/轻重，逐字平分时长会让字「唰唰」advance、
    // 观感「字幕太快」。整句一行一行转（边读边转）更贴合朗读、更从容。
    if (mediaSource.value === 'tts') return { sung: lines[idx].text, rest: '' }
    const chars = Array.from(lines[idx].text)
    if (chars.length === 0) return { sung: '', rest: '' }
    const start = lines[idx].time
    const end = idx + 1 < lines.length ? lines[idx + 1].time : (musicState.duration.value || start + 4)
    const span = Math.max(end - start, 0.1)
    const cur = musicState.currentTime.value + subtitleLeadSec.value
    const prog = Math.min(Math.max((cur - start) / span, 0), 1)
    const n = Math.min(Math.round(prog * chars.length), chars.length)
    return { sung: chars.slice(0, n).join(''), rest: chars.slice(n).join('') }
  })

  // App 回前台兜底：iOS 锁屏冻结的 JS 定时器无法自恢复，靠 onAppShow 主动检查卡死态。
  // uni.onAppShow 是 App 级全局 API，H5 端同样有实现（no-op 或页面 show），两端一致。
  const appShowHandler = () => resumeFromBackgroundCheck()
  const uniAny = typeof uni !== 'undefined' ? (uni as unknown as Record<string, unknown>) : null
  if (uniAny && typeof uniAny.onAppShow === 'function') {
    (uniAny.onAppShow as (fn: () => void) => void)(appShowHandler)
  }

  onUnmounted(() => {
    if (uniAny && typeof uniAny.offAppShow === 'function') {
      (uniAny.offAppShow as (fn: () => void) => void)(appShowHandler)
    }
    clearT1()
    clearT2()
    clearClosing()
    if (doneToListeningTimer) { clearTimeout(doneToListeningTimer); doneToListeningTimer = null }
    cancelFinalClear()
    cancelPendingIdle()
    stopKws()
    leaveWake()
    // 撤销本实例的全部订阅，避免模块级单例 transport 在 HMR 重挂载时叠加重复监听
    offEvent()
    offAudio()
    offStatus()
    offReconnectExhausted()
    offConnecting()
  })

  // 单曲循环是否进行中（按钮高亮/aria）：语音「循环 N 遍」的有限 loopRemaining
  // 和按钮开启的 Infinity 都算「循环播放中」。
  const musicLoopActive = computed(() => musicState.loopRemaining.value > 0)
  // 循环剩余次数（不含当前这一遍）：有限值时即内部还要重播几次；无限时为 Infinity。
  const musicLoopRemaining = musicState.loopRemaining
  // 音乐播放音量（0–1）；界面滑块控制，TTS 播报时自动压低。
  const musicVolume = musicState.musicVolume

  return {
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
    gatewayFailed,
    wakeSupported,
    wakeProviderName,
    wakeReady,
    wsConnected,
    connecting,
    retry,
    restartGateway: tryGatewayRestart,
    wake,
    enable,
    disable,
    interrupt,
    interruptSpeech,
    // 音乐播放 / 歌词
    musicPlaying: musicState.playing,
    musicPaused: musicState.paused,
    musicEnded: musicState.ended,
    musicLoopActive,
    musicLoopRemaining,
    musicVolume,
    setMusicVolume,
    musicError: musicState.musicError,
    musicErrorDetail: musicState.musicErrorDetail,
    musicVisible: musicState.visible,
    musicPreparing: musicState.preparing,
    musicTitle: musicState.title,
    musicCover,
    mediaSource,
    musicCurrent: musicState.currentTime,
    musicDuration: musicState.duration,
    musicLive: musicState.live,
    subtitle,
    subtitleVisible,
    copySubtitle,
    copied,
    toggleSubtitle,
    openSubtitle,
    closeSubtitle,
    detailCard,
    selectDetail,
    closeDetailCard,
    activeSubtitleIndex,
    currentSubtitleText,
    activeSubtitleSplit,
    stopMusic,
    pauseMusic,
    resumeMusic,
    replayMusic,
    cycleLoop,
    nextMusic,
    reportVolume,
    seekMusic,
  }
}
