/**
 * 唤醒词匹配：纯函数，方便单测。
 *
 * 识别结果常带空格、逗号、句号，直接 includes 会漏匹配，
 * 所以先去掉空白和常见标点再比。
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s,.!?;:'"、，。！？；：“”‘’（）()【】[\]…—-]/g, '')
}

export function matchWakeWord(
  transcript: string,
  wakeWords: readonly string[]
): string | null {
  const normalized = normalizeTranscript(transcript)
  if (!normalized) return null

  for (const word of wakeWords) {
    const target = normalizeTranscript(word)
    if (target && normalized.includes(target)) return word
  }
  return null
}
