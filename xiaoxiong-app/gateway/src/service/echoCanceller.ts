/**
 * 网关侧软件回声消除（AEC）。
 *
 * 为什么需要：客户端 TTS 经扬声器外放，被麦克风收回成为回声，和真人插话混在一起送 ASR，
 * 导致播报期插话识别成 TTS 内容（「现在在播报」）或乱码。原生硬件 AEC 在这套方案上消不干净。
 * 网关同时握着两路信号——下发的 TTS（远端参考）和上行的采集（近端含回声），
 * 可以在送 ASR 前用 NLMS 自适应滤波把回声从采集里减掉，只留真人声。
 *
 * 采样率：参考 TTS 是 24k，采集是 16k；pushReference 内部重采样到 16k 再入缓冲。
 * 帧：process 按 16k 处理，每帧 chunk 为 16bit mono PCM（采集契约 32ms/512 sample，但不限帧长）。
 */

export class EchoCanceller {
  // 滤波器阶数（16k 采样）。【2026-11-23 iOS CPU 根治】原 2048（128ms）时 process() 每帧
  // 三重循环 512×2048×3 ≈ 314 万次浮点运算，播报期在 iOS 单进程 V8 上满速跑 → CPU 93% 被系统
  // task_exceeded_cpulimit 杀进程（CPU 报告符号化最热栈 Builtins_InterpreterEntryTrampoline，
  // 37/37 命中=JS 字节码解释器满速执行这些循环）。回声延迟（缓冲+硬件+空气）<100ms，
  // 主要由环形参考缓冲的延迟补偿余量（4000 样本=250ms）覆盖，滤波器只需补残余。
  // 降到 256（16ms）：① 根因已单独修复（handleBinary 加 playbackPending 守卫），
  // ② 2026-11-23 恢复 iOS 播报期上行真实帧（修插话只识别半句）后播报期会持续跑 AEC，
  // 每帧三重循环 n×M×3，M 越小 CPU 越可控。回声延迟主要由 refBuf 4000 样本余量覆盖，
  // 滤波器只需补残余延迟，256 够用。
  // 【2026-11-23 二次调整·修"能duck但不能插话】M=256(16ms)太短，消不掉 TTS 从扬声器到麦克风
  // 的回声（延迟 100ms+），导致播报声 rms≈0.045 被 ASR 识别成播报内容、压过真人插话。
  // 调回 1024（64ms）覆盖大部分回声延迟；CPU 死循环真凶已用 playbackPending 守卫根治
  // （只在播报期跑、不残留），播报期正常负载可控。
  // 【2026-11-23 回退到256·网关可用优先】M=2048 时播报期 AEC 运算量把 Node 事件循环堵死
  // （网关 health 12s 超时）。KWS 唤醒词识别单独修（KWS 喂帧改用 kKwsGain 温和我放大）。
  // 插话的回声问题暂由 duck+能量判据兜底，AEC 用 256 保网关不卡。
  private readonly M = 256
  private readonly mu = 0.08 // NLMS 步长：稳态小步长(0.004)真机验证会让 AEC 跟不上、回声消不掉，回退到固定大步长
  private readonly w = new Float32Array(this.M)
  // 参考信号环形缓冲（16k），容量 = 滤波器阶数 + 延迟补偿余量（~250ms = 4000 sample）
  private readonly refBuf = new Float32Array(this.M + 4000)
  private refWrite = 0
  // 24k→16k 重采样相位累加（简单的线性抽取，语音足够）
  private rsPhase = 0
  private readonly xFrame = new Float32Array(this.M) // 当前帧对应的参考窗口（倒序，供卷积）
  // 【2026-11-23 修 AEC 完全不生效】扬声器→麦克风的回声延迟实测 100ms+，换算 16k ≈ 1600 样本。
  // 原 winEnd=refWrite-n+k 只取最近 M 个样本、没用上 refBuf 多分配的 4000 余量 → 滤波器窗口
  // 覆盖不到回声所在的旧样本 → w 永远不收敛 → clean==raw（诊断铁证）。这里把窗口往回移
  // ECHO_DELAY 样本，让参考窗口对齐到"当前麦克风声音对应的、100ms 前播放的 TTS"。
  private readonly ECHO_DELAY = 1600

  /** 推入一帧 TTS 参考（24k / 16bit mono PCM），内部重采样到 16k 存入环形缓冲。 */
  pushReference(pcm24k: Uint8Array): void {
    const n = Math.floor(pcm24k.byteLength / 2)
    const dv = new DataView(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength)
    for (let i = 0; i < n; i += 1) {
      const v = dv.getInt16(i * 2, true) / 32768
      // 24k→16k：每 3 个输入取 2 个（2/3 抽取），用相位累加避免累积误差
      this.rsPhase += 2
      while (this.rsPhase >= 3) {
        this.rsPhase -= 3
        this.refBuf[this.refWrite] = v
        this.refWrite = (this.refWrite + 1) % this.refBuf.length
      }
    }
  }

  /**
   * 对一帧近端采集（16k / 16bit mono PCM）做回声消除，返回消除后的 PCM（同格式）。
   * 未推入过参考（非播报期）时原样返回，零开销。
   */
  process(pcm16k: Uint8Array): Uint8Array {
    const n = Math.floor(pcm16k.byteLength / 2)
    const out = new Uint8Array(pcm16k.byteLength)
    const dvIn = new DataView(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength)
    const dvOut = new DataView(out.buffer, out.byteOffset, out.byteLength)
    for (let k = 0; k < n; k += 1) {
      const d = dvIn.getInt16(k * 2, true) / 32768 // 近端 = 人声 + 回声
      // 参考窗口末端要对齐到"本帧内第 k 个样本对应的时刻"，而非帧末。
      // 近端帧 processing 时整帧参考已推入(refWrite 在帧末)，若窗口末端固定取 refWrite，
      // 帧内每个样本都错开 (n-1-k) 个样本 → NLMS 无法收敛。改为 refWrite - n + k。
      const winEnd = this.refWrite - n + k - this.ECHO_DELAY
      for (let j = 0; j < this.M; j += 1) {
        const idx = (winEnd - this.M + j + this.refBuf.length) % this.refBuf.length
        this.xFrame[j] = this.refBuf[idx]
      }
      let pw = 1e-6 // 参考功率
      let dot = 0 // 滤波器输出 y
      for (let j = 0; j < this.M; j += 1) {
        pw += this.xFrame[j] * this.xFrame[j]
        dot += this.w[j] * this.xFrame[j]
      }
      const e = d - dot // 残余 = 近端 - 估计回声（应≈真人声）
      if (pw > 1e-4) {
        const step = this.mu / pw
        for (let j = 0; j < this.M; j += 1) this.w[j] += step * e * this.xFrame[j]
      }
      let s = Math.max(-1, Math.min(1, e))
      dvOut.setInt16(k * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return out
  }

  /** 播报开始/新句时重置自适应状态，避免上一句的残留系数污染。 */
  reset(): void {
    this.w.fill(0)
    this.refBuf.fill(0)
    this.refWrite = 0
    this.rsPhase = 0
  }
}
