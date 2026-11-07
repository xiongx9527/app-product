import { computed, onUnmounted, ref } from 'vue'
import { playPromptCue, isPromptCuePlaying } from '@/core/audio/promptPlayer'
import {
  playMusic,
  stopMusic,
  pauseMusic,
  resumeMusic,
  duckMusic,
  seekMusic,
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
import { transition } from '@/core/assistant/stateMachine'
import {
  DEFAULT_ASSISTANT_CONFIG,
  STATE_LABEL,
  type AssistantConfig,
  type AssistantEvent,
  type AssistantState,
  type AssistantEffect,
} from '@/core/assistant/types'
import { createTransport } from '@/core/transport'
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

  const transport = createTransport()

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

  function handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'asr.partial':
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
        playMusic(event.url, event.title)
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
    phase.value = 'idle'
    assistantBusy = false
    answerHasTts = false
    await ensureCapture()
    // 网关可能刚重启过，本地标志会过期；一律以传输层的真实连接状态为准
    if (transport.isConnected()) {
      transport.startSession('wake')
      return
    }
    try {
      await transport.connect('wake')
    } catch (err) {
      errorMessage.value = (err as Error).message
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
    }
  }

  /** 关闭助手：停采集、关连接，并停掉音乐。 */
  function leaveWake(): void {
    if (capturing) {
      stopCapture()
      capturing = false
    }
    stopPlayback()
    stopMusic()
    lyrics.value = null
    transport.close()
  }

  async function ensureCapture(): Promise<void> {
    if (capturing || !isH5AudioSupported()) return
    try {
      // 播报期间继续保持上行：用户插话要能识别并排队，不能掐掉麦克风。
      // 回声由浏览器 AEC + 网关 strict VAD / 文本比对 / 半双工兜底处理。
      // 只有本地提示音（扬声器外放的固定短音）期间把上行帧清零。
      await startCapture((pcm) => {
        transport.sendAudioChunk(isPromptCuePlaying() ? new ArrayBuffer(pcm.byteLength) : pcm)
      })
      capturing = true
    } catch (err) {
      errorMessage.value = `麦克风不可用：${(err as Error).message}`
    }
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

  function enable(): void {
    dispatch({ type: 'ENABLE' })
  }

  function disable(): void {
    dispatch({ type: 'DISABLE' })
  }

  function interrupt(): void {
    dispatch({ type: 'CANCEL' })
  }

  /** 客户端点「换一首 / 换个风格」：直接让网关解析下一首，绕开 LLM。 */
  function nextMusic(): void {
    transport.requestMusicNext()
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
    enable,
    disable,
    interrupt,
    // 音乐播放 / 歌词
    musicPlaying: musicState.playing,
    musicPaused: musicState.paused,
    musicError: musicState.musicError,
    musicTitle: musicState.title,
    musicCurrent: musicState.currentTime,
    musicDuration: musicState.duration,
    musicLive: musicState.live,
    lyrics,
    stopMusic,
    pauseMusic,
    resumeMusic,
    nextMusic,
    seekMusic,
    closeLyrics,
  }
}
