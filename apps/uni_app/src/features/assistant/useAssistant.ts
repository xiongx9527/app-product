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
import type { ServerEvent } from '@/core/transport/types'
import { createWakeService } from '@/core/wake/wakeService'
import { getLanguage } from '@/core/config'

export function useAssistant(config: AssistantConfig = DEFAULT_ASSISTANT_CONFIG) {
  const state = ref<AssistantState>('idle')
  const transcript = ref('')
  const reply = ref('')
  const isSpeaking = ref(false)
  const errorMessage = ref('')

  const transport = createTransport()
  const wake = createWakeService({
    onWake: () => dispatch({ type: 'WAKE' }),
    onError: (message) => {
      errorMessage.value = message
    },
    lang: getLanguage(),
  })

  let t1Timer: ReturnType<typeof setTimeout> | null = null
  let t2Timer: ReturnType<typeof setTimeout> | null = null
  let closingTimer: ReturnType<typeof setTimeout> | null = null
  // 招呼语先占住“助手”卡片，等模型第一个字到了再换成真实回复
  let assistantTextStarted = false
  let capturing = false

  const stateLabel = computed(() => STATE_LABEL[state.value])
  const enabled = computed(() => state.value !== 'idle')
  const wakeSupported = wake.isSupported()
  const wakeProviderName = wake.providerName

  transport.onEvent(handleServerEvent)
  transport.onAudio((chunk) => playPcm(chunk, 24000))

  function handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'asr.partial':
        transcript.value = event.text
        break
      case 'asr.final':
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
        wake.start()
        break
      case 'stopWake':
        wake.stop()
        break
      case 'startSession':
        transcript.value = ''
        reply.value = ''
        errorMessage.value = ''
        assistantTextStarted = false
        void beginSession()
        break
      case 'endSession':
        endAudio()
        transport.close()
        isSpeaking.value = false
        assistantTextStarted = false
        break
      case 'cancelSession':
        endAudio()
        transport.sendCancel()
        transport.close()
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

  /** 连网关并开启麦克风上行；TTS 播放期间不发送，避免把助手自己的声音再识别一遍。 */
  async function beginSession(): Promise<void> {
    try {
      await transport.connect()
    } catch (err) {
      errorMessage.value = (err as Error).message
      dispatch({ type: 'ERROR' })
      return
    }
    if (!isH5AudioSupported()) return
    try {
      await startCapture((pcm) => {
        if (!isSpeaking.value) transport.sendAudioChunk(pcm)
      })
      capturing = true
    } catch (err) {
      errorMessage.value = `麦克风不可用：${(err as Error).message}`
    }
  }

  function endAudio(): void {
    if (capturing) {
      stopCapture()
      capturing = false
    }
    stopPlayback()
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

  function wakeNow(): void {
    dispatch({ type: 'WAKE' })
  }

  function interrupt(): void {
    dispatch({ type: 'CANCEL' })
  }

  onUnmounted(() => {
    clearT1()
    clearT2()
    clearClosing()
    endAudio()
    transport.close()
    wake.stop()
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
    wakeNow,
    interrupt,
  }
}
