# app-product 客户端工程设计

日期：2026-11-06
状态：已确认（uni-app 一套代码 + 原生唤醒插件）

## 1. 背景

要做一个语音助手 App：持续监听、唤醒词唤醒、语音转文字、与 AI 对话并语音回答，长时间无对话后提示并退出本轮，退出后仍可继续唤醒。

工程后续还会承载其他业务产品，且客户端要覆盖多端，因此按“一套代码 + 可扩展模块”设计。

本工程**只做客户端**，后端/语音服务作为外部依赖，通过 WebSocket 对接。

## 2. 目标

- 一套 uni-app（Vue3 + TypeScript + Vite）代码，覆盖：
  - Android App
  - iOS App
  - HarmonyOS App
  - H5
  - 微信小程序
- 原生 App（含 uni-app 打包出的 App）必须具备语音唤醒。
- 语音助手主流程：待唤醒 → 对话 → 静默提示 → 退出本轮 → 继续待唤醒。
- 机型适配覆盖：分辨率、宽高比、刘海/挖孔、折叠屏、平板、横竖屏、字体缩放、深色模式、Android 版本与国产 ROM 差异、鸿蒙权限模型。
- 后续新增业务产品时复用基础模块，不重复造轮子。

## 3. 非目标

- 不实现后端 ASR / LLM / TTS 编排。
- 不做端侧大模型；端侧只保留唤醒、VAD。
- 暂不做多语言，先只支持中文：界面文案、唤醒词、ASR、TTS 全部固定 `zh-CN`。
- iOS 锁屏/后台唤醒不做（第三方 App 无此权限）。
- 微信小程序、H5 不做常听唤醒（平台限制），采用按住说话/点击说话。

## 4. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 应用框架 | uni-app（Vue3 + TS + Vite） | 一套代码出 App / H5 / 小程序 / 鸿蒙 |
| 状态管理 | Pinia | 轻量，适合多业务模块 |
| 唤醒 | sherpa-onnx KWS（本地） | Apache-2.0，Android/iOS/鸿蒙均有构建 |
| VAD | Silero VAD（本地） | 判断说话/静音，驱动打断与退出 |
| 对话链路 | WebSocket → 后端 | 上行音频流，下行文字增量 + TTS 音频流 |
| 音频格式 | 16kHz / 16bit / 单声道 PCM | 兼顾 ASR 与唤醒 |
| 原生桥接 | uni_modules 原生插件 | Android Kotlin、iOS Swift、鸿蒙 ArkTS/NAPI |
| 构建 | HBuilderX / CLI + DevEco Studio + Xcode | 客户端不使用 Maven |

## 5. 多端能力矩阵

| 能力 | Android | iOS | HarmonyOS | H5 | 微信小程序 |
|---|---|---|---|---|---|
| 常听唤醒 | ✅ | ✅（前台） | ✅（前台） | ❌ | ❌ |
| 按住说话 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 后台/锁屏唤醒 | ✅ 前台服务 | ❌ | 受限 | ❌ | ❌ |
| 语音对话 | ✅ | ✅ | ✅ | ✅ | ✅ |

唤醒依赖各平台的原生插件，JS 层只负责开关与回调；H5/小程序降级为按钮触发。

## 6. 工程结构

```
app-product/
├── apps/
│   └── uni_app/                    # 主客户端：Android / iOS / HarmonyOS / H5 / 微信小程序
│       ├── src/
│       │   ├── app/                # 应用壳：入口、主题、装配
│       │   ├── core/               # 与业务无关的基础能力
│       │   │   ├── assistant/      # 状态机（纯函数，可单测）
│       │   │   ├── audio/          # 提示音、播放、后续采集
│       │   │   ├── wake/           # 唤醒服务（原生插件桥接）
│       │   │   ├── transport/      # WebSocket / Mock
│       │   │   └── adaptation/     # 断点、安全区、字体缩放
│       │   ├── features/
│       │   │   └── assistant/      # 语音助手页面与会话编排
│       │   ├── pages/
│       │   ├── static/audio/       # 本地提示音
│       │   ├── manifest.json       # 各端权限与配置
│       │   └── pages.json
│       ├── harmony-configs/        # 鸿蒙原生配置（HBuilderX 生成/维护）
│       └── package.json
├── packages_uni/                   # 后续可复用的 uni_modules / npm 包
├── contracts/                      # 跨端接口契约
└── docs/superpowers/specs/
```

约束：

- `core` 不依赖 `features`；`features/*` 之间不直接互相依赖。
- 业务状态机保持纯函数，与 UI、音频、网络解耦，方便复用和测试。
- 协议变更先改 `contracts/`，再改客户端。

## 7. 交互状态机

```
idle（总开关关闭 / 无权限）
  │ ENABLE
  ▼
standby（待唤醒，本地常听，音频不上传）
  │ WAKE
  ▼
listening（先播本地招呼「我在」，再上行音频、收文字与 TTS）
  │ 连续静默 T1（默认 10s）
  ▼
confirming（播本地提示音“还在吗？”）
  ├─ 用户开口 ───────────────► listening
  └─ T2（默认 10s）无响应
        ▼
     closing（播结束语，关闭会话）
        ▼
     standby（继续待唤醒，可再次唤醒）
```

规则：

- `standby` 不自动关闭，麦克风持续监听；只有关闭总开关或 App 退到后台/关闭才停止。
- 唤醒后立即播本地招呼「我在」，不等 WebSocket 建连，确保断网也有反馈；服务端个性化问候随后作为正常回复叠加。
- 提示音与结束语用本地音频，断网也能正常退出。
- 播报期间开启 AEC/VAD 抑制，避免自唤醒。
- T1 / T2 / 文案 / 唤醒词均可配置。
- 会话异常（断线、权限丢失）→ 提示 → 回到 `standby`。

## 8. 唤醒插件设计

JS 侧统一接口 `start() / stop() / onWake() / onError()`，按端选择实现：

| 端 | JS 实现 | 现状 |
|---|---|---|
| H5 | Web Speech API（连续识别 + 唤醒词匹配） | 已接，Chrome / Edge 可跑通；依赖浏览器识别，非离线 |
| App | 原生插件 `app-product-wake` | 桥接已留，插件待实现（sherpa-onnx） |
| 微信小程序 | 不支持常听 | 降级为按住/点击说话 |

三种原生实现，暴露同一套 JS 接口：

```
start(config) / stop() / onWake(callback) / onError(callback)
```

| 平台 | 实现 | 要点 |
|---|---|---|
| Android | Kotlin + sherpa-onnx AAR | 前台服务（`microphone` 类型）、电池白名单引导、音频焦点 |
| iOS | Swift + sherpa-onnx xcframework | 麦克风权限、`AVAudioSession`、仅前台 |
| HarmonyOS | ArkTS/NAPI + sherpa-onnx | `ohos.permission.MICROPHONE`、`KEEP_BACKGROUND_RUNNING`、后台能力受限 |

如果自研成本过高，可替换为讯飞/思必驰的离线唤醒 SDK，接口保持不变。

## 9. 机型与平台适配

**屏幕**

- 断点：`compact`（<600px）/ `medium`（600–1024px）/ `expanded`（>1024px）。
- `safe-area-inset-*`、`textScaler`、横竖屏、折叠屏展开/折叠。
- 平板/折叠屏展开时限宽并切双栏。

**系统**

- Android：前台服务类型、运行时麦克风权限、电池优化白名单、国产 ROM 自启动、耳机/来电中断。
- iOS：麦克风权限文案、音频会话中断恢复、静音开关。
- HarmonyOS：权限在 `harmony-configs/entry/src/main/module.json5` 声明；后台常听受系统限制。
- 深色模式、大字体、无障碍。

**验证矩阵（最低）**

- 低端 Android、中端 Android、旗舰 Android。
- iPhone 小屏、iPhone 大屏、iPad。
- HarmonyOS 手机 / 平板。
- 刘海/挖孔、折叠屏、横屏、大字体、深色、无网、弱网。

## 10. 接口契约（客户端视角，待后端确认）

- WebSocket 长连接，心跳 + 断线重连 + 会话内取消。
- 上行：16kHz / 16bit / mono PCM，20–40ms 分片。
- 下行：JSON 控制帧 + 二进制 TTS 音频帧。

```
client → server
  {"type":"session.start","sessionId":"..."}
  {"type":"audio.chunk"} / 二进制帧
  {"type":"session.cancel"}
  {"type":"session.end"}

server → client
  {"type":"asr.partial","text":"..."}
  {"type":"asr.final","text":"..."}
  {"type":"llm.delta","text":"..."}
  {"type":"llm.done"}
  {"type":"tts.start","format":"pcm16","sampleRate":24000}
  {"type":"tts.end"}
  {"type":"error","code":"...","message":"..."}
```

## 11. 构建与打包

| 端 | 工具 | 备注 |
|---|---|---|
| H5 | `npm run dev:h5` / `build:h5` | 本地开发最快 |
| 微信小程序 | `dev:mp-weixin` | 微信开发者工具导入 `dist/dev/mp-weixin` |
| Android | HBuilderX 云打包 / 离线打包 | 需自定义基座以带原生插件 |
| iOS | HBuilderX 云打包 / Xcode 离线打包 | 自定义插件同样需自定义基座 |
| HarmonyOS | HBuilderX + DevEco Studio | 需 DevEco 5.0.3.800+，路径不要含中文 |

本机限制：macOS 12.7.6 + Xcode 14.2 偏旧，iOS 与鸿蒙以云打包/真机为主。

## 12. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 三端唤醒插件工作量 | 进度风险 | 先做 Android，iOS/鸿蒙复用同一 JS 接口；必要时换商用 SDK |
| 鸿蒙后台常听受限 | 体验不一致 | 以前台唤醒为主，提前验证系统策略 |
| 小程序/H5 无法唤醒 | 预期落差 | 产品文案明确“按住说话”，不承诺常听 |
| 唤醒误触发/漏唤醒 | 体验、耗电 | 可调阈值、噪声/方言样本回归 |
| 音频延迟高 | 对话不自然 | 全链路流式，首包/首字延迟埋点 |
| 自定义基座与云打包 | 集成复杂 | 尽早打通最小插件 + 真机 |

## 13. 验收标准

- 一套代码可构建 Android / iOS / HarmonyOS / H5 / 微信小程序。
- 原生 App 端：唤醒 → 对话 → 提示 → 退出 → 再唤醒 全流程可用。
- 断网时能正确提示、退出并回到待唤醒，不崩溃。
- 播报时不自唤醒、不把播报当用户说话。
- 验证矩阵内机型无布局溢出、无安全区遮挡、大字体不截断。
- 新增业务 feature 时，不改 `core`，只新增 `features/<name>` 并注册路由。

## 14. 待确认

1. 后端 WebSocket 接口是否已存在；需提供地址、音频格式与消息格式。
2. 语言先只做中文（`zh-CN`）；T1/T2 默认值待确认，多语言后续再评估。
3. 是否需要账号、历史记录、云端同步。
4. 唤醒插件自研还是采购商用 SDK。

## 15. 设备控制（需求已记录，暂缓实现）

产品诉求：客户端能连接物联网 / 蓝牙设备，并支持用语音控制这些设备。

状态：2026-11-06 提出，用户决定“先记下、后面再说”，本轮不实现、不改 `contracts/`。

已确定的架构预留（实现时按此展开，不必推翻现有分层）：

- 新增 `core/device`：统一 `DeviceTransport` 抽象（连接 / 断开 / 下发命令 / 订阅状态），
  下挂 BLE、Wi-Fi / 云端 IoT 等具体实现。
- 新增 `features/device`：设备发现、配对、设备列表与状态面板。
- 语音控制链路：`ASR → 后端 LLM 意图/函数调用 → 结构化 device.command → 客户端路由到对应 transport 执行`。
  设备怎么控仍由后端决策，客户端只做能力上报与命令执行。
- 协议扩展：`contracts/` 增加 `device.command` / `device.state` / `device.result` 三类消息，
  以及客户端能力声明（支持哪些设备类型）。协议先定，再写代码。

实现前必须回答的问题：

1. 设备类型与协议：BLE / 经典蓝牙 / 私有 2.4G / Wi-Fi 云端 IoT（MQTT、HTTP）？各自占比？
2. 是否需要鸿蒙端蓝牙：uni-app 内置 BLE API 在鸿蒙的支持情况需先验证，不满足则要写原生插件。
3. 离线可控范围：断网时是否要求局域网内直连控制？
4. 设备接入方式：自研固件协议，还是对接涂鸦 / 米家等现有平台？
5. 权限与合规：蓝牙扫描权限、定位权限（Android 12 以下扫描 BLE 需要）、配网流程。
