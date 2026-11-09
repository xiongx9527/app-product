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
import {
  isH5AudioSupported,
  onPlaybackIdle,
  playPcm,
  startCapture,
  stopCapture,
  stopPlayback,
} from '@/core/audio/h5Audio'
import { isAppCaptureSupported, startAppCapture, stopAppCapture } from '@/core/audio/appCapture'
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
import { getLanguage } from '@/core/config'

/** 一轮对话的阶段：界面据此告诉用户「现在在干嘛」，避免以为卡住而插话。 */
export type Phase = 'idle' | 'listening' | 'thinking' | 'replying' | 'speaking' | 'done'

const PHASE_LABEL: Record<Phase, string> = {
  idle: '待唤醒',
  listening: '正在听…',
  thinking: '正在思考…',
  replying: '正在回答…',
  speaking: '正在播报…',
  done: '本轮完成',
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
  const isSpeaking = ref(false)
  // 网关判定回声兜底中：播报期间不拾音，只能点「打断」
  const halfDuplex = ref(false)
  const errorMessage = ref('')
  /** 队列已满（排队数超上限）的专用话术，显示在页面顶部横幅，不进「你说」卡片 */
  const queueFullMsg = ref('')
  /** 歌词面板：网关下发 media.lyrics 后展示 */
  const lyrics = ref<{ title: string; artist?: string; lyrics: string } | null>(null)

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
  /** 助手正在思考/回答/播报：此时挂起 T1 静默计时，否则长回答会被「还在吗」打断 */
  let assistantBusy = false
  /** 本轮回答是否已经开始 TTS：llm.done 早于 tts.end，不能提前算空闲 */
  let answerHasTts = false
  /** 等播放队列清空的取消函数：新轮次开始时作废上一轮的等待 */
  let cancelPlaybackIdle: (() => void) | null = null
  /**
   * 网关还有几句排队没轮到：期间「你说」必须锁在当前句，
   * 中间识别结果、播完回执都不能把文字顶掉。
   * 用 ref 暴露给页面，在「你说」卡片右上角显示排队数量。
   */
  const queuePending = ref(0)

  const stateLabel = computed(() => STATE_LABEL[state.value])
  const phaseLabel = computed(() => PHASE_LABEL[phase.value])
  const enabled = computed(() => state.value !== 'idle')
  // 唤醒改为网关本地 ASR（SenseVoice）识别，不依赖浏览器/Google 的语音服务
  const wakeSupported = true
  const wakeProviderName = '网关语音（本地 ASR）'

  transport.onEvent(handleServerEvent)
  transport.onAudio((chunk) => playPcm(chunk, 24000))
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
    if (!enabled.value || gatewayDownAnnounced) return
    gatewayDownAnnounced = true
    playPromptCue('gatewayDown')
  }
  transport.onStatusChange((connected) => {
    wsConnected.value = connected
    if (connected) resetGatewayDownAnnounce()
    else announceGatewayDown()
  })
  // 自动重连次数耗尽：不再静默，用本地语音提示「网关连不上」（断网也能出声），
  // 并提示用户可手动点页面「重试连接」；重置播报标记以便这次能再念一次。
  transport.onReconnectExhausted(() => {
    if (!enabled.value) return
    resetGatewayDownAnnounce()
    announceGatewayDown()
  })
  /** 正在建连状态（含自动重连每次尝试）：用于连接状态胶囊显示「连接中…」，且不弹独立标签 */
  const connecting = ref(false)
  transport.onConnecting((value) => {
    connecting.value = value
  })
  // 网关能力健康度（LLM / ASR / TTS / 外网）：连上后定时轮询，负责「运行中 ok→down」的瞬时变化；
  // 「建连那一刻就已不可用」的兜底下发由网关 client.cue 事件负责（见 handleServerEvent）。
  const { health } = useHealth(wsConnected)
  // 设备权限只读检测（不弹授权框）：麦克风未授权要出声提示，定位只显示状态。
  const { permissions, refreshPermissions } = usePermissions(wsConnected)
  // 定时检测结果：只在某能力「ok → down」时念一次；down→down / down→ok / ok→ok 都静默。
  // 前提是网关连通（断开时 useHealth 清空 health，不触发）。首次拿到报告 prev 为空、不念，
  // 那种「一开始就不可用」的情形由网关 client.cue 负责播报，避免漏报。
  let prevHealthStatus: Partial<Record<HealthItem['key'], HealthStatus>> = {}
  watch(health, (report) => {
    if (!report) {
      prevHealthStatus = {}
      return
    }
    if (!wsConnected.value) return
    const downKeys: HealthItem['key'][] = []
    for (const item of toHealthItems(report)) {
      if (prevHealthStatus[item.key] === 'ok' && item.status === 'down') downKeys.push(item.key)
      prevHealthStatus[item.key] = item.status
    }
    if (!downKeys.length) return
    const cues = HEALTH_PRIORITY.filter((k) => downKeys.includes(k)).map((k) => HEALTH_CUE[k])
    if (cues.length) playPromptCueSequence(cues)
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

  function handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'asr.partial':
        // 待唤醒阶段用流式识别结果实时匹配唤醒词，不等整句定稿——
        // 网关 asr.final 要等 VAD 静音 endpointMs(默认 2.5s) 才下发，那样「说完了还得等一下」
        // 才唤醒。asr.partial 在说话过程中就随缓冲重识别下发，命中即唤醒；asr.final 仍作兜底。
        if (mode === 'wake') {
          if (matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) dispatch({ type: 'WAKE' })
          break
        }
        // 监听阶段把实时识别文字作为「草稿」展示在页面下方，不进「你说」卡片；
        // 本轮（思考/回答/播报）或排队未消费时不更新，避免顶掉定稿。
        // 播报（TTS）进行中也不更新：其它声音不该被当成实时识别刷出来。
        if (mode === 'dialog' && !assistantBusy && !queuePending.value && !isSpeaking.value) {
          liveText.value = event.text
          if (phase.value !== 'listening') phase.value = 'listening'
        }
        break
      case 'asr.queued':
        // 只更新排队数量（「你说」卡片右上角的红标）；不展示多余提示文字，
        // 这句话等播完轮到它才由 asr.final 进入「你说」卡片
        if (mode === 'dialog') {
          queuePending.value = Math.max(queuePending.value, event.position)
        }
        break
      case 'asr.rejected':
        // 队列已满（排队数超上限）时服务端拒收，把专用话术放到页面顶部横幅；
        // 不显示这句识别的内容，也不进「你说」卡片，更不弹浮层
        if (mode === 'dialog') queueFullMsg.value = event.message
        break
      case 'asr.final':
        if (mode === 'wake') {
          // 待唤醒阶段只做唤醒词匹配，命中后进入对话
          if (matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) dispatch({ type: 'WAKE' })
          break
        }
        // 对话进行中再次叫「小熊小熊」：重新唤醒——停掉当前轮次、重新招呼，
        // 回到干净的对听状态。播报（TTS）进行中同样适用；音乐播放不受影响
        // （它不设置 isSpeaking，且此分支只认唤醒词，不会被普通插话触发）。
        if (matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) {
          reWake()
          break
        }
        // 播报（TTS）还没结束：其它声音一律忽略，不显示、不发起新轮次
        if (isSpeaking.value) break
        // 定稿后这一句进入队列成为「当前项」，你说始终显示队列当前项（不显示监听草稿）。
        // 直接采信服务端的权威剩余数，避免拒收/超时等路径下本地计数漂移。
        queuePending.value = event.queueRemaining
        transcript.value = event.text
        // 清掉监听草稿与队列溢出提示；这句轮到被处理，溢出横幅自然失效
        liveText.value = ''
        queueFullMsg.value = ''
        // 新一轮说话：清掉上一轮的回答与思考，等模型重新流式输出
        reply.value = ''
        thinking.value = ''
        thinkingDone.value = false
        replyDone.value = false
        phase.value = 'thinking'
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
        break
      case 'llm.delta':
        if (!assistantTextStarted) {
          assistantTextStarted = true
          thinkingDone.value = true
          reply.value = ''
        }
        reply.value += event.text
        if (phase.value !== 'speaking') phase.value = 'replying'
        break
      case 'llm.done':
        thinkingDone.value = true
        replyDone.value = true
        if (!isSpeaking.value) phase.value = 'done'
        // 没有 TTS 的回答到这里就结束了，从现在起重新算静默
        if (!answerHasTts) markAnswerDone()
        break
      case 'tts.start':
        cancelPendingIdle()
        // 不再 resetPlayback()：网关已等上一句播完才下发这一句，
        // 清空队列会把「上一句」的尾音掐掉，正是用户听到的中断。
        answerHasTts = true
        isSpeaking.value = true
        phase.value = 'speaking'
        // 播报期间压低正在播放的音乐，避免盖住助手说话
        duckMusic(true)
        break
      case 'tts.stop':
        // 被打断：立刻掐掉已排队的音频，不等它播完
        cancelPendingIdle()
        stopPlayback()
        duckMusic(false)
        isSpeaking.value = false
        phase.value = 'done'
        markAnswerDone()
        break
      case 'tts.end':
        // 网关下发完 ≠ 客户端播完：播完前保持静音上行、挂起 T1，
        // 否则尾音被收回当成用户说话，或还没播完就触发「还在吗」。
        cancelPendingIdle()
        cancelPlaybackIdle = onPlaybackIdle(() => {
          cancelPlaybackIdle = null
          duckMusic(false)
          isSpeaking.value = false
          phase.value = 'done'
          markAnswerDone()
          // 播完回执：网关等它才消费排队的下一句，保证上一句完整播完
          transport.notifyPlaybackDone()
        })
        break
      case 'media.play':
        // B 站音轨走网关代理补 Referer；SomaFM 等公共流直连。
        playMusic(
          toProxiedMusicUrl(event.url, event.channel, resolveGatewayHttpBase()),
          event.title,
          event.loop != null ? { loop: event.loop } : undefined
        )
        break
      case 'media.pause':
        pauseMusic()
        break
      case 'media.resume':
        resumeMusic()
        break
      case 'media.stop':
        stopMusic()
        break
      case 'media.lyrics':
        lyrics.value = { title: event.title, artist: event.artist, lyrics: event.lyrics }
        break
      case 'media.volume':
        // 网关语音「音量 30% / 调大 / 调小」下发，直接设到本地播放器与滑块显示；
        // 这是服务端驱动的，不回执（避免又把同一值上报回去形成环）。
        setMusicVolume(event.volume)
        break
      case 'audio.duplex':
        halfDuplex.value = event.mode === 'half'
        break
      case 'error':
        errorMessage.value = event.message
        phase.value = 'idle'
        assistantBusy = false
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        cancelPendingIdle()
        dispatch({ type: 'ERROR' })
        break
      case 'client.cue': {
        // 网关在建连即探测到 ASR/TTS/LLM 不可用，下发预录提示音；
        // 此时网关没法用语音播报，只能靠提示音让用户「听得见地」知道能力缺失。
        // 事件里的 cue 是文件名（kebab-case，如 asr-down），需转成 PromptCue（camelCase，如 asrDown）。
        const map: Record<string, PromptCue> = {
          'asr-down': 'asrDown',
          'tts-down': 'ttsDown',
          'llm-down': 'llmDown',
          'network-down': 'networkDown',
        }
        const cue = map[event.cue]
        if (cue) playPromptCue(cue)
        break
      }
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
  }

  function dispatch(event: AssistantEvent): void {
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
        stopPlayback()
        isSpeaking.value = false
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        phase.value = 'idle'
        assistantTextStarted = false
        break
      case 'cancelSession':
        cancelPendingIdle()
        stopPlayback()
        transport.sendCancel()
        isSpeaking.value = false
        queuePending.value = 0
        liveText.value = ''
        queueFullMsg.value = ''
        phase.value = 'done'
        assistantTextStarted = false
        break
      case 'playGreeting': {
        // 招呼先落到界面，声音由本地提示音负责
        reply.value = '我在'
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

  /** 待唤醒：连网关（wake 模式，只做 ASR）并开启麦克风上行。 */
  async function enterWake(): Promise<void> {
    mode = 'wake'
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
    } catch (err) {
      errorMessage.value = (err as Error).message
      // 开启唤醒但首次就建连失败（网关一直不可达）：主动念一次「网络不通」
      announceGatewayDown()
    }
  }

  /** 命中唤醒：在同一条连接上切到 dialog 模式，进入 LLM/TTS。 */
  async function enterDialog(): Promise<void> {
    mode = 'dialog'
    if (transport.isConnected()) {
      transport.startSession('dialog')
      return
    }
    try {
      await transport.connect('dialog')
    } catch (err) {
      errorMessage.value = (err as Error).message
      // 唤醒后切到对话时建连失败，同样提示一次网络不通
      announceGatewayDown()
    }
  }

  /** 关闭助手：停采集、关连接，并停掉音乐。两个采集后端互斥，都尝试停止（未启动的是 no-op）。 */
  function leaveWake(): void {
    resetGatewayDownAnnounce()
    if (capturing) {
      stopCapture()
      stopAppCapture()
      capturing = false
    }
    stopPlayback()
    stopMusic()
    lyrics.value = null
    transport.close()
  }

  async function ensureCapture(): Promise<void> {
    if (capturing) return
    // 播报期间继续保持上行：用户插话要能识别并排队，不能掐掉麦克风。
    // 回声由浏览器 AEC + 网关 strict VAD / 文本比对 / 半双工兜底处理。
    // 只有本地提示音（扬声器外放的固定短音）期间把上行帧清零。
    const onPcm = (pcm: ArrayBuffer): void => {
      transport.sendAudioChunk(isPromptCuePlaying() ? new ArrayBuffer(pcm.byteLength) : pcm)
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
      const ok = startAppCapture(onPcm, (message) => {
        errorMessage.value = t('error.micUnavailable', { reason: message })
      })
      if (ok) capturing = true
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

  function enable(): void {
    dispatch({ type: 'ENABLE' })
  }

  function disable(): void {
    dispatch({ type: 'DISABLE' })
  }

  function interrupt(): void {
    dispatch({ type: 'CANCEL' })
  }

  /** 点中间圆球手动开始一轮：等同说「小熊小熊」唤醒，仅待唤醒(standby)态有效。 */
  function wake(): void {
    if (state.value !== 'standby') return
    dispatch({ type: 'WAKE' })
  }

  /** 网关掉线后手动重连：沿用当前会话模式，立即清掉待执行的自动重连再建连。
   * 前提是开启了唤醒（助手处于启用状态），否则无需重连。 */
  async function retry(): Promise<void> {
    if (!enabled.value || transport.isConnected() || connecting.value) return
    // 重新武装掉线播报，连不上能再提示一次
    resetGatewayDownAnnounce()
    try {
      await transport.connect(mode)
    } catch (err) {
      errorMessage.value = (err as Error).message
      announceGatewayDown()
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

  /** 重新唤醒：对话进行中再次叫「小熊小熊」时，停掉当前轮次并重新招呼。 */
  function reWake(): void {
    dispatch({ type: 'REWAKE' })
    phase.value = 'listening'
  }

  /** 关闭歌词面板 */
  function closeLyrics(): void {
    lyrics.value = null
  }

  onUnmounted(() => {
    clearT1()
    clearT2()
    clearClosing()
    cancelPendingIdle()
    leaveWake()
  })

  // 单曲循环是否进行中（按钮高亮/aria）：语音「循环 N 遍」的有限 loopRemaining
  // 和按钮开启的 Infinity 都算「循环播放中」。
  const musicLoopActive = computed(() => musicState.loopRemaining.value > 0)
  // 循环剩余次数（不含当前这一遍）：有限值时即界面要在按钮上显示的剩余遍数；无限时为 Infinity。
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
    wakeSupported,
    wakeProviderName,
    wsConnected,
    connecting,
    retry,
    wake,
    enable,
    disable,
    interrupt,
    // 音乐播放 / 歌词
    musicPlaying: musicState.playing,
    musicPaused: musicState.paused,
    musicEnded: musicState.ended,
    musicLoopActive,
    musicLoopRemaining,
    musicVolume,
    setMusicVolume,
    musicError: musicState.musicError,
    musicVisible: musicState.visible,
    musicTitle: musicState.title,
    musicCurrent: musicState.currentTime,
    musicDuration: musicState.duration,
    musicLive: musicState.live,
    lyrics,
    stopMusic,
    pauseMusic,
    resumeMusic,
    replayMusic,
    cycleLoop,
    nextMusic,
    reportVolume,
    seekMusic,
    closeLyrics,
  }
}
