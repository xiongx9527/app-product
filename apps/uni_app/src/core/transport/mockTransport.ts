import type { DemoTransport, ServerEvent } from './types'

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

/**
 * 开发期 Mock：不连后端，按真实时序吐出 asr/llm/tts 事件。
 * 接入后端时替换成 WebSocketTransport 即可，上层不用改。
 */
export class MockTransport implements DemoTransport {
  private listeners = new Set<(event: ServerEvent) => void>()
  private timers: ReturnType<typeof setTimeout>[] = []
  private generation = 0

  async connect(): Promise<void> {
    this.generation += 1
    this.clearTimers()
  }

  sendAudioChunk(_chunk: ArrayBuffer): void {
    // Mock 不消费真实音频；由 speak() 模拟一次完整对话
  }

  sendCancel(): void {
    this.generation += 1
    this.clearTimers()
  }

  close(): void {
    this.generation += 1
    this.clearTimers()
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 模拟用户说一句话，触发一轮 ASR → LLM → TTS */
  speak(text: string): void {
    const generation = ++this.generation
    this.clearTimers()

    const emit = (event: ServerEvent) => {
      if (generation === this.generation) this.emit(event)
    }
    const at = (ms: number, fn: () => void) => {
      this.timers.push(setTimeout(fn, ms))
    }

    at(80, () => emit({ type: 'asr.partial', text: text.slice(0, Math.min(3, text.length)) }))
    at(360, () => emit({ type: 'asr.final', text }))

    const reply = `好的，我听到你说「${text}」。当前是本地模拟回复，接入后端后会返回真实答案。`
    const chunks = chunkText(reply, 6)
    const llmStart = 520
    chunks.forEach((chunk, index) => {
      at(llmStart + index * 110, () => emit({ type: 'llm.delta', text: chunk }))
    })
    const llmEnd = llmStart + chunks.length * 110 + 60
    at(llmEnd, () => emit({ type: 'llm.done' }))
    at(llmEnd + 20, () =>
      emit({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
    )
    at(llmEnd + 900, () => emit({ type: 'tts.end' }))
  }

  private emit(event: ServerEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers = []
  }
}
