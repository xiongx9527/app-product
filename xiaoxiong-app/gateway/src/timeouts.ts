/**
 * 全链路时间预算总表（毫秒）。唯一来源：改默认值只改这里。
 * 链路顺序：采集 → 中间识别(partial) → 定稿识别(finalize) → LLM → TTS 合成 → 播报回执。
 * 内容源（好价/音乐/百科/新闻）的抓取超时仍由各自源文件持有，与语音链路预算无关。
 */

/** 客户端可配置项（经 session.start.timeouts 下发）；缺省用本表默认值。 */
export interface SessionTimeouts {
  /** 定稿识别超时 */
  asrFinalizeMs?: number
  /** 中间识别（实时字幕）间隔 */
  asrPartialIntervalMs?: number
  /** 单轮 LLM 超时 */
  llmMs?: number
  /** 单次 TTS 合成超时（两次重试共享此总预算） */
  ttsMs?: number
  /** TTS 帧间看门狗 */
  ttsFrameGapMs?: number
}

export const TIMEOUT_DEFAULTS = {
  // ASR
  /** 中间识别提交间隔：太密打满上游，太疏界面卡顿。 */
  asrPartialIntervalMs: 600,
  /** 中间识别超时：失败静默跳过、下轮重来，必须快速失败。 */
  asrPartialMs: 6000,
  /** 定稿识别超时：失败等于整轮白说；实测上游一次 4–5s，定稿音频更长。 */
  asrFinalizeMs: 12000,
  /** ASR 失败提示音同轮节流。 */
  asrFailNoticeThrottleMs: 30000,

  // LLM
  llmMs: 15000,
  /** 深度思考：思考链实测可达 88s。 */
  llmThinkMs: 120000,

  // TTS
  /** 单句合成超时：单句 <100 字约 7–16s。 */
  ttsMs: 25000,
  /** 帧间看门狗：必须大于 ttsMs（合成期间没有帧），否则正常合成就被误判卡死。 */
  ttsFrameGapMs: 30000,

  // 播报回执
  /** 等客户端播完回执的兜底上限：回执丢了也要推进状态机。 */
  playbackAckMs: 30000,

  // 诊断 / 健康探测
  diagFlushMs: 200,
  diagHeartbeatMs: 500,
  healthProbeMs: 3000,
  healthProbeTtlMs: 15000,

  // 其它语音链路
  asrWsStartMs: 8000,
  asrWsFinishMs: 8000,
  asrWsReconnectCooldownMs: 3000,
  ttsWsIdleMs: 15000,
  catalogFetchMs: 5000,
  /** 设备定位等待：拿不到按「无位置」继续。 */
  locationRequestMs: 8000,
} as const

/** 用户可配项的取值范围：前端校验与网关兜底共用。 */
export const TIMEOUT_RANGES = {
  asrFinalizeMs: [3000, 60000],
  asrPartialIntervalMs: [300, 5000],
  llmMs: [3000, 120000],
  ttsMs: [5000, 120000],
  ttsFrameGapMs: [5000, 180000],
} as const satisfies Record<keyof SessionTimeouts, readonly [number, number]>

/** 收敛成合法毫秒值：非法/越界回落到 fallback 或边界。 */
export function clampMs(value: unknown, range: readonly [number, number], fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  const [min, max] = range
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 会话级时间预算（字段齐全，可直接使用）。 */
export type ResolvedTimeouts = Required<SessionTimeouts> & {
  /** 中间识别超时：不对外暴露，内部同样走这份预算。 */
  asrPartialMs: number
}

/** 把 session.start.timeouts 收敛成完整预算。 */
export function resolveSessionTimeouts(raw?: SessionTimeouts | null): ResolvedTimeouts {
  return {
    asrFinalizeMs: clampMs(raw?.asrFinalizeMs, TIMEOUT_RANGES.asrFinalizeMs, TIMEOUT_DEFAULTS.asrFinalizeMs),
    asrPartialIntervalMs: clampMs(
      raw?.asrPartialIntervalMs,
      TIMEOUT_RANGES.asrPartialIntervalMs,
      TIMEOUT_DEFAULTS.asrPartialIntervalMs,
    ),
    asrPartialMs: TIMEOUT_DEFAULTS.asrPartialMs,
    llmMs: clampMs(raw?.llmMs, TIMEOUT_RANGES.llmMs, TIMEOUT_DEFAULTS.llmMs),
    ttsMs: clampMs(raw?.ttsMs, TIMEOUT_RANGES.ttsMs, TIMEOUT_DEFAULTS.ttsMs),
    ttsFrameGapMs: clampMs(raw?.ttsFrameGapMs, TIMEOUT_RANGES.ttsFrameGapMs, TIMEOUT_DEFAULTS.ttsFrameGapMs),
  }
}
