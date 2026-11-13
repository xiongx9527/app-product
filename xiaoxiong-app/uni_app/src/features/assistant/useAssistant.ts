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
import { waitForEmbeddedGateway } from '@/core/transport/gatewayBootstrap'
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
  const isSpeaking = ref(false)
  // 网关判定回声兜底中：播报期间不拾音，只能点「打断」
  const halfDuplex = ref(false)
  const errorMessage = ref('')
  /** 内嵌网关启动中（enable 时轮询 gateway.url 直到原生进程写出）；启动阶段界面静默，不显示也不播报 */
  const gatewayPreparing = ref(false)
  /** 队列已满（排队数超上限）的专用话术，显示在页面顶部横幅，不进「你说」卡片 */
  const queueFullMsg = ref('')
  /** 当前播放曲目的封面图（与音频同源，网关 media.play.cover 下发），无封面为空串 */
  const musicCover = ref('')
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
  /** 助手正在思考/回答/播报：此时挂起 T1 静默计时，否则长回答会被「还在吗」打断 */
  let assistantBusy = false
  /** 本轮回答是否已经开始 TTS：llm.done 早于 tts.end，不能提前算空闲 */
  let answerHasTts = false
  /** 等播放队列清空的取消函数：新轮次开始时作废上一轮的等待 */
  let cancelPlaybackIdle: (() => void) | null = null
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
   * 网关还有几句排队没轮到：期间「你说」必须锁在当前句，
   * 中间识别结果、播完回执都不能把文字顶掉。
   * 用 ref 暴露给页面，在「你说」卡片右上角显示排队数量。
   */
  const queuePending = ref(0)

  const stateLabel = computed(() => t(STATE_LABEL[state.value]))
  const phaseLabel = computed(() => t(PHASE_LABEL[phase.value]))
  const enabled = computed(() => state.value !== 'idle')
  // 唤醒改为网关本地 ASR（SenseVoice）识别，不依赖浏览器/Google 的语音服务
  const wakeSupported = true
  const wakeProviderName = '网关语音（本地 ASR）'

  // 订阅必须保存反订阅函数并在 onUnmounted 清理：transport 是模块级单例、跨 HMR 存活，
  // 若热更新重挂载时旧监听不移除，会往同一个 transport 上叠加多份 handleServerEvent，
  // 导致每条服务器事件被处理两遍（打招呼 / 还在吗 / TTS 全「放两遍」）。这正是在 H5 调试时
  // 反复改代码触发 HMR 后出现的双音频根因。
  const offEvent = transport.onEvent(handleServerEvent)
  const offAudio = transport.onAudio((chunk) => playPcm(chunk, 24000))
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
      // 原则：网关恢复后若处于待机，按待唤醒语义重武装会话（掉线时已退回待机）
      if (enabled.value && state.value === 'standby') transport.startSession('wake')
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
  const { health } = useHealth(wsConnected)
  // 设备权限只读检测（不弹授权框）：麦克风未授权要出声提示，定位只显示状态。
  const { permissions, refreshPermissions } = usePermissions(wsConnected)
  // 能力不可用播报以客户端健康报告为唯一来源：连上后 useHealth 主动拉 /api/health，时序确定、每次连接都会跑。
  // 首次报告把「一开始就 down」的能力（ASR/TTS/LLM）**逐条独立定时**播报：真机上共享串行队列
  // 只推进第一条就卡住，导致只剩 ASR 一条；改为各自 setTimeout，间隔 > 各 mp3 时长，不叠音也不漏。
  // 之后只在「ok → down」变化时补播。不再依赖网关 client.cue（真机时有时无），避免双份提示音。
  let prevHealthStatus: Partial<Record<HealthItem['key'], HealthStatus>> = {}
  let firstReportHandled = false
  let initialCueTimers: ReturnType<typeof setTimeout>[] = []
  function clearInitialCueTimers(): void {
    initialCueTimers.forEach(clearTimeout)
    initialCueTimers = []
  }
  watch(health, (report) => {
    if (!report) {
      prevHealthStatus = {}
      firstReportHandled = false
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
        initialCueTimers.push(setTimeout(() => playPromptCue(HEALTH_CUE[k]), idx * 4600))
      })
      for (const item of items) prevHealthStatus[item.key] = item.status
      return
    }
    const changed: HealthItem['key'][] = []
    for (const item of items) {
      if (prevHealthStatus[item.key] === 'ok' && item.status === 'down') changed.push(item.key)
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

  function handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'asr.partial':
        // 待唤醒阶段用流式识别结果实时匹配唤醒词，不等整句定稿——
        // 网关 asr.final 要等 VAD 静音 endpointMs(默认 2.5s) 才下发，那样「说完了还得等一下」
        // 才唤醒。asr.partial 在说话过程中就随缓冲重识别下发，命中即唤醒；asr.final 仍作兜底。
        if (mode === 'wake') {
          // 刚播完 TTS 的回声窗口内，ASR 命中的唤醒词是助手自己话里的「小熊小熊」被收回，
          // 当回声忽略，避免「我在」过一会又来一句（回声重新唤醒）。
          if (Date.now() - lastSpokeAt < WAKE_ECHO_MS) break
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
          // 待唤醒阶段只做唤醒词匹配，命中后进入对话；回声窗口内忽略（见 asr.partial 说明）
          if (Date.now() - lastSpokeAt < WAKE_ECHO_MS) break
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
        // 抗重复：同一句 TTS 若因任何原因被重复下发（传输层/重连竞态/未知双发），
        // 已经在播报中（isSpeaking）又来一个 tts.start 视为重复，直接忽略，避免「放两遍」。
        // 合法的下一句/下一轮总在 tts.end/stop 之后才来，此时 isSpeaking 已复位，不受影响。
        if (isSpeaking.value) break
        cancelPendingIdle()
        // 不再 resetPlayback()：网关已等上一句播完才下发这一句，
        // 清空队列会把「上一句」的尾音掐掉，正是用户听到的中断。
        answerHasTts = true
        isSpeaking.value = true
        lastSpokeAt = Date.now()
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
          // 真正播完这一刻记为「最近一次说话」，覆盖其后的回声窗口：
          // 助手话里若带「小熊小熊」，被麦收回后 2s 内的唤醒词识别当回声忽略。
          lastSpokeAt = Date.now()
          phase.value = 'done'
          markAnswerDone()
          // 播完回执：网关等它才消费排队的下一句，保证上一句完整播完
          transport.notifyPlaybackDone()
        })
        break
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
        playMusic(
          playUrl,
          event.title,
          event.loop != null ? { loop: event.loop } : undefined
        )
        // 封面与音频同源（歌曲宝详情页），每次新播放覆盖，无封面时清空避免显示上一首
        musicCover.value = event.cover ?? ''
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
      case 'client.cue':
        // 能力不可用提示音统一由本地 health 报告驱动（watch health 里的 playPromptCueSequence）。
        // 网关这条 client.cue 在真机上时有时无，不能作为唯一触发源；此处刻意不播，避免与 health 双份叠音。
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
    } catch {
      // 建连失败交给自动重连；确认连不上由「重连耗尽」统一播报，此处静默
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
    } catch {
      // 切到对话时建连失败：自动重连兜底，静默；连不上由「重连耗尽」统一播报
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
    subtitle.value = null
    musicCover.value = ''
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
      gatewayPreparing.value = true
      errorMessage.value = ''
      const ready = await waitForEmbeddedGateway()
      gatewayPreparing.value = false
      if (!ready) {
        // 等待网关启动超时＝确认连不上，才播报一次（带去重），不显示文字
        announceGatewayDown()
        return
      }
      // 网关进程就绪 ≠ WS 已连通。必须先确认 WS 真的连上，才允许进入「待唤醒」；
      // 连不上就当场播报并停在「未开启」，绝不进 standby 让用户以为可以点球/喊唤醒词。
      if (!transport.isConnected()) {
        try {
          await transport.connect('wake')
        } catch {
          // 首次连不上：交给自动重连；连不上由「重连耗尽」统一播报，此处静默
          return
        }
      }
      // connect 返回却仍未连通（如还在握手中）：同样不进 standby
      if (!transport.isConnected()) return
      dispatch({ type: 'ENABLE' })
    } finally {
      enabling = false
    }
  }

  function disable(): void {
    dispatch({ type: 'DISABLE' })
  }

  function interrupt(): void {
    dispatch({ type: 'CANCEL' })
  }

  /** 点中间圆球手动开始一轮：等同说「小熊小熊」唤醒，仅待唤醒(standby)态有效。
   * 原则：网关正常才允许唤醒——没连上网关就不放行 WAKE（连不上则 ASR/TTS 都不工作，
   * 「唤醒了但说不了话」是不诚实的状态），此时诚实提示并顺手触发重连。 */
  function wake(): void {
    if (state.value !== 'standby') return
    if (!canWake()) {
      // 原则：网关/ASR 没好时手动点球不放行；但要提示，不静默——播对应原因的提示音
      playPromptCue(wakeBlockedCue())
      return
    }
    dispatch({ type: 'WAKE' })
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
    dispatch({ type: 'REWAKE' })
    phase.value = 'listening'
  }

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
   * 当前应高亮的字幕行下标：按播放进度（秒）匹配最后一行 time <= currentTime 的行。
   * onTimeUpdate 是采样回调（非实时），加上解码/缓冲，进度读数常略滞后于实际听感，
   * 高亮会「慢半拍」；这里给约 1 秒的提前量抵消滞后，让当前行跟上正在唱的内容。
   * 字幕与音频同源、时间相对音轨开头；无字幕/未播放时为 -1。
   */
  const SUBTITLE_LEAD_SEC = 1.0
  const activeSubtitleIndex = computed(() => {
    const lines = subtitle.value?.lines
    if (!lines?.length) return -1
    const cur = musicState.currentTime.value + SUBTITLE_LEAD_SEC
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
    const lines = subtitle.value?.lines
    if (idx < 0 || !lines || !lines[idx]) return ''
    return lines[idx].text
  })

  /**
   * 近似逐字高亮：把当前行切成「已唱 / 未唱」两段文本。来源只给行级时间，故按字数平分该行时长，
   * 再按播放进度算出已唱字数。中文每字时长较均匀，歌曲观感好；评书/口语语速不均会略有偏移（属近似）。
   * 用 Array.from 切分以兼容代理对（emoji 等），避免 String.slice 按码元计数错位。最后一行用整曲时长作结束。
   */
  const activeSubtitleSplit = computed(() => {
    const lines = subtitle.value?.lines
    const idx = activeSubtitleIndex.value
    if (!lines || idx < 0 || !lines[idx]) return { sung: '', rest: '' }
    const chars = Array.from(lines[idx].text)
    if (chars.length === 0) return { sung: '', rest: '' }
    const start = lines[idx].time
    const end = idx + 1 < lines.length ? lines[idx + 1].time : (musicState.duration.value || start + 4)
    const span = Math.max(end - start, 0.1)
    const cur = musicState.currentTime.value + SUBTITLE_LEAD_SEC
    const prog = Math.min(Math.max((cur - start) / span, 0), 1)
    const n = Math.min(Math.round(prog * chars.length), chars.length)
    return { sung: chars.slice(0, n).join(''), rest: chars.slice(n).join('') }
  })

  onUnmounted(() => {
    clearT1()
    clearT2()
    clearClosing()
    cancelPendingIdle()
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
    musicCover,
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
