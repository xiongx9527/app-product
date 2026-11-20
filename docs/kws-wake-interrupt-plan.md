# 唤醒与打断统一方案（KWS 接管）

> 状态：方案待拍板（2026-11-20 整理）
> 适用：`xiaoxiong-app`（uni_app + gateway + 原生插件 app-product-wake）
> 性质：设计文档，未实施。拍板第八节的 4 个点后再进入实施。

## 一、目标

把散落在多个 ASR 事件分支里的"文本匹配唤醒词"收敛成一个**端侧 KWS 常驻检测**，统一驱动「唤醒」和「播报期打断」两个动作。

收益：

- 唤醒前不跑 ASR、不联网——端侧 3.3M KWS 常驻，断网也能唤醒，省电。
- 打断不等 ASR 流式识别出的 token，更快、更稳。

需要注意：KWS 与 ASR 不是替代关系。KWS 决定"什么时候醒"，ASR 决定"听懂说了什么"（自然语言指令）。KWS 只认 `DEFAULT_WAKE_WORDS` 这类预定义短词，控制命令仍走 ASR + 意图识别。

## 二、现状：唤醒词检测的 6 条路径

当前项目**没有本地 KWS**，唤醒完全靠网关 ASR 把整段话转成文字，再由客户端 `matchWakeWord` 匹配那三个词（`小熊小熊 / 小熊熊 / 小小熊`，`core/wake/types.ts`）。

| 场景 | 触发点 | 现有动作 |
|---|---|---|
| 待唤醒·partial | `useAssistant.ts:504` | 命中 → `dispatch(WAKE)`，带 `WAKE_ECHO_MS=2000` 回声窗 |
| 待唤醒·final | `useAssistant.ts:582` | 兜底，同上 |
| 播报中·partial | `useAssistant.ts:515-522` | `isSpeaking` + `PARTIAL_SKIP_MS` 节流 → `skipCurrentAndGreet(text)` |
| 忙·asr.queued | `useAssistant.ts:541` | 命中 → `skipCurrentAndGreet(text)` |
| 队列满·asr.rejected | `useAssistant.ts:561` | 命中 → `skipCurrentAndGreet()` |
| 对话·final | `useAssistant.ts:590-593` | 忙→skip；空闲→`reWake()` |

网关侧配合：

- 播报/思考期插话经 `enqueueDuringBusy`（`voiceSessionService.ts:1124`）发 `asr.queued` / `asr.rejected`，带原文透传给客户端做唤醒词匹配。
- `session.skip_current`（`protocol.ts:148` / `skipCurrent` `voiceSessionService.ts:1712`）跳过当前句、按 `dropText` 删队首唤醒词、发 `tts.stop` + 回声复位。

现存问题：

- 240MB 的 ASR 一直听，只为等三个字。
- 播报期 AEC 双讲畸变会把叠词识别成"有有"（真机踩坑，见 `project_barge_in_direct_pcm_fix` 记忆），打断不稳。

## 三、总体设计

职责分层：

- **KWS**（原生 `app-product-wake`，sherpa-onnx 3.3M）：常驻听 `DEFAULT_WAKE_WORDS`，只输出「命中 / 未命中」事件，不产文本。
- **客户端**（`createNativeWakeProvider` 的 `onWake` 回调，接口现成）：按当前状态把命中路由成「唤醒」或「打断」。
- **网关**：保留 `session.skip_current` 不动，作为打断的权威执行端。新增一条 `wake.hit` 上行事件让网关知道是 KWS 触发（可选，见第六节）。

**关键：统一打断入口。** KWS 命中必须走和现有文本匹配**同一个节流点**（`lastPartialSkipAt` / `PARTIAL_SKIP_MS`），否则用户喊一次"小熊小熊"，KWS 和 ASR 文本各触发一次 → 双重招呼、双跳。做法：KWS 命中回调里调同一个 `skipCurrentAndGreet()`，由它内部统一节流。

## 四、命中后行为矩阵

| 当前状态 | KWS 命中动作 | 复用现有 |
|---|---|---|
| `wake` 待唤醒 | 过 `canWake()` 后 `dispatch(WAKE)` | `WAKE_ECHO_MS` 回声窗保留 |
| `dialog` 空闲对听 | `reWake()`（整轮重来） | 现有 final 分支逻辑 |
| `dialog` 播报中 | `skipCurrentAndGreet()`（跳当前句、播招呼） | 现成，含 dropText |
| `dialog` 思考/排队 | `skipCurrentAndGreet()` | 现成 |
| 队列满 | `skipCurrentAndGreet()`，不被 `rejected` 吞掉 | 现成 |

**硬约束**：所有命中都先过 `canWake()`（`useAssistant.ts:905-909` 的派发拦截）——网关不可用 / ASR 不可达时，KWS 命中也不放行，绝不进假 listening。

## 五、回声门控（核心风险）

播报时喇叭声进麦克风，KWS 可能听到自己播报里的"小熊小熊"自我唤醒。KWS 只输出布尔值，没法用 `resemblesSpoken` 做文本比对，所以门控必须前置到信号层：

1. **原生层 AEC**：KWS 输入用 `VOICE_COMMUNICATION` + `AcousticEchoCanceler` 处理后的 PCM（复用现在 ASR 采集已有的链路，见 `project_app_tts_aec` 记忆）。
2. **时间窗**：沿用 `lastSpokeAt` + `WAKE_ECHO_MS`，播报刚结束时窗口内忽略 KWS 命中。
3. **能量/相关性门控（增强项，非必需）**：播报期间若检测到输出与输入高度相关（喇叭声），临时提高 KWS 命中阈值——需原生插件支持动态阈值。
4. **兜底**：真机实测若仍误触发，退回"播报期 KWS 静音窗口 + 完全依赖 AEC 后 PCM"，或播报期仍用 ASR 文本匹配（混合方案）。

## 六、改造清单

### 原生层（app-product-wake，前提：插件尚未实现）

- Android/iOS 各实现 sherpa-onnx `KeywordSpotter`，加载 3.3M KWS 模型 + `keywords.txt`。
- 通过 `plus.bridge` 暴露 `start/stop/onWake`，`onWake({ word })` 回传命中的词。
- 模型首启下载或随包（仅 ~5–13MB，建议随包保证离线唤醒）。
- 该插件还承载 PCM 采集与网关生命周期（见 `docs/mobile-embedded-gateway.md` §6），KWS 是其新增能力。

### 客户端（uni_app）

- `providers/native.ts`：现有 `start({ words, lang })` 基础上接 `onWake` → 回调 `useAssistant`。
- `useAssistant.ts`：新增 KWS 命中处理，统一走 `skipCurrentAndGreet()` / `dispatch(WAKE)`；接入 `canWake()` 拦截和第五节时间窗。
- 保留全部现有 ASR 文本匹配作为**兜底**（KWS 插件缺失/未就绪时行为不变），便于灰度。

### 网关（gateway，可选）

- 若要让网关精确知道"这次打断来自 KWS 还是普通插话"（影响统计/队列处理），加 `wake.hit` 事件。
- 否则 `session.skip_current` 原样复用，网关零改动。

### 验证

- 单测：`matchWakeWord` 已有；新增 KWS 命中→状态机的路由测试。
- 真机四项必测：待唤醒（断网）、播报中打断、播报内容含"小熊小熊"不自我唤醒、队列满打断。

## 七、分阶段落地

- **P0（无依赖，可立刻做）**：把客户端 6 处文本匹配收敛成单一 `handleWakeHit()` 入口 + 统一节流，KWS 未接入时行为不变。纯重构、降风险。
- **P1（Android 先行）**：实现 `app-product-wake` 的 KWS 能力，待唤醒态切 KWS，验证断网唤醒。
- **P2**：播报期打断切 KWS，接 AEC + 时间窗，真机验证自我唤醒。
- **P3**：iOS 同能力 + 灰度开关（KWS / 纯 ASR 可切）。

## 八、需要拍板的点

1. KWS 模型**随包**还是**首启下载**？（小，建议随包保离线）
2. 播报期打断要不要**保留 ASR 文本匹配兜底**，还是全切 KWS？（建议先双轨灰度）
3. 网关加不加 `wake.hit` 事件？（建议先不加，`session.skip_current` 够用、网关零改动）
4. 是否先做 **P0 纯重构**（不动原生、风险最低），还是直接上 P1 原生 KWS？

## 附：KWS 模型事实（选型参考）

- 典型模型 `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`：参数 330 万，fp32 权重约 12–13MB（量化/int8 后约 4.8MB），运行内存 30–50MB，首词触发 80–200ms。
- sherpa-onnx 官方支持 Android（JNI/AAR）与 iOS（xcframework），Apache-2.0，两端共用同一套 `.onnx` 模型。
- 与 ASR（SenseVoice int8 ~240MB）是两个不同模型文件，不是同一模型复用；KWS 不能替代 ASR 识别自然语言指令。
