/**
 * 送进 TTS 之前的文本清洗：只保留能「念」出来的内容。
 *
 * LLM 回复里常带 markdown 强调符、emoji、装饰符号（** & …… % ¥ # @ 等），
 * 直接交给 TTS 会被逐个念成「星星星星」「井号」，非常刺耳。
 * 界面仍然展示原文，这里只影响合成用的字符串。
 */

/** 允许送进 TTS 的字符：中日韩文字、字母、数字、常用中英标点、空格。 */
const SPEAKABLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}，。！？、；：「」『』（）,.!?;:'"() -]/u

export function sanitizeForSpeech(text: string): string {
  let out = ''
  for (const ch of text) {
    if (SPEAKABLE.test(ch)) out += ch
  }
  // 连续空白收敛成一个空格，避免 TTS 把一大段空白念成异常停顿
  return out.replace(/\s+/g, ' ').trim()
}
