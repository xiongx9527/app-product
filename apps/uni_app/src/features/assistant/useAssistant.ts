import { computed, onUnmounted, ref } from 'vue'
import { playPromptCue } from '@/core/audio/promptPlayer'
import {
  isH5AudioSupported,
  playPcm,
  resetPlayback,
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

export function useAssistant(config: AssistantConfig = DEFAULT_ASSISTANT_CONFIG) {
  const state = ref<AssistantState>('idle')
  const transcript = ref('')
  const reply = ref('')
  const isSpeaking = ref(false)
  const errorMessage = ref('')

  const transport = createTransport()

  let t1Timer: ReturnType<typeof setTimeout> | null = null
  let t2Timer: ReturnType<typeof setTimeout> | null = null
  let closingTimer: ReturnType<typeof setTimeout> | null = null
  // 招呼语先占住“助手”卡片，等模型第一个字到了再换成真实回复
  let assistantTextStarted = false
  let capturing = false
  let connected = false
  let mode: SessionMode = 'wake'

  const stateLabel = computed(() => STATE_LABEL[state.value])
  const enabled = computed(() => state.value !== 'idle')
  // 唤醒改为网关本地 ASR（SenseVoice）识别，不依赖浏览器/Google 的语音服务
  const wakeSupported = true
  const wakeProviderName = '网关语音（本地 ASR）'

  transport.onEvent(handleServerEvent)
  transport.onAudio((chunk) => playPcm(chunk, 24000))

  function handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'asr.partial':
        if (mode === 'dialog') transcript.value = event.text
        break
      case 'asr.final':
        if (mode === 'wake') {
          // 待唤醒阶段只做唤醒词匹配，命中后进入对话
          if (matchWakeWord(event.text, DEFAULT_WAKE_WORDS)) dispatch({ type: 'WAKE' })
          break
        }
        transcript.value = event.text
        dispatch({ type: 'USER_SPEECH' })
        break
      case 'llm.delta':
        if (!assistantTextStarted) {
          assistantTextStarted = true
          reply.value = ''
        }
        reply.value += event.text
        break
      case 'tts.start':
        resetPlayback()
        isSpeaking.value = true
        break
      case 'tts.end':
        isSpeaking.value = false
        break
      case 'error':
        errorMessage.value = event.message
        dispatch({ type: 'ERROR' })
        break
    }
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
        errorMessage.value = ''
        assistantTextStarted = false
        enterDialog()
        break
      case 'endSession':
        stopPlayback()
        isSpeaking.value = false
        assistantTextStarted = false
        break
      case 'cancelSession':
        stopPlayback()
        transport.sendCancel()
        isSpeaking.value = false
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
    await ensureCapture()
    try {
      if (!connected) {
        await transport.connect('wake')
        connected = true
      } else {
        transport.startSession('wake')
      }
    } catch (err) {
      errorMessage.value = (err as Error).message
    }
  }

  /** 命中唤醒：在同一条连接上切到 dialog 模式，进入 LLM/TTS。 */
  function enterDialog(): void {
    mode = 'dialog'
    if (connected) transport.startSession('dialog')
  }

  /** 关闭助手：停采集、关连接。 */
  function leaveWake(): void {
    if (capturing) {
      stopCapture()
      capturing = false
    }
    stopPlayback()
    transport.close()
    connected = false
  }

  async function ensureCapture(): Promise<void> {
    if (capturing || !isH5AudioSupported()) return
    try {
      await startCapture((pcm) => {
        if (!isSpeaking.value) transport.sendAudioChunk(pcm)
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

  onUnmounted(() => {
    clearT1()
    clearT2()
    clearClosing()
    leaveWake()
  })

  return {
    state,
    stateLabel,
    enabled,
    transcript,
    reply,
    isSpeaking,
    errorMessage,
    wakeSupported,
    wakeProviderName,
    enable,
    disable,
    interrupt,
  }
}
