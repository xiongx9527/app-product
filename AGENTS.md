# AGENTS.md

给在本仓库工作的 AI Agent / 协作者的约定。读代码前先读这里。

## 项目是什么

语音助手客户端。一套 uni-app（Vue3 + TypeScript + Vite）代码，目标端**只有 Android / iOS App（自定义基座 + 原生插件）**。

主链路：**本地唤醒「小熊小熊」→ 本地招呼「我在」→ 语音对话 → T1 静默提示 → T2 退出本轮 → 回到待唤醒**。

H5 **仅开发阶段调试用**（当前在 `:5173` 上验证 UI 与链路），保留可编译与最小降级即可。微信小程序与 HarmonyOS **确定不支持**，不要为它们增加分支或降级逻辑。

## 常用命令

```bash
cd xiaoxiong-app/uni_app
npm run test        # vitest，必须全绿
npm run type-check  # vue-tsc，必须零报错
npm run dev:app     # App，需要 HBuilderX / 自定义基座
npm run dev:app-harmony
```

真机联调（USB 联网：设备借用电脑网络，前提是 adb 在 PATH、设备已授权 USB 调试）：

```bash
cd xiaoxiong-app
./scripts/usb-net.sh up       # 默认对所有 USB 在线设备生效；Windows 用 scripts\usb-net.bat
./scripts/usb-net.sh status   # 逐台看设备代理 / adb reverse / 本机代理
./scripts/usb-net.sh down     # 清除设备代理 + 反代，恢复原状
```

提交前至少跑 `test` + `type-check`。不要在没跑的情况下声称“已完成/已通过”。

## 目录与依赖方向

```
xiaoxiong-app/uni_app/src/
├── core/            # 与业务无关，禁止依赖 features / pages
│   ├── assistant/   # 纯状态机 + 单测
│   ├── audio/       # 本地提示音、后续采集与播放
│   ├── config/      # 配置类型、厂商模板、本地存储、连接测试
│   ├── database/    # SQLite 抽象（App: plus.sqlite）
│   ├── transport/   # Mock / WebSocket 客户端
│   ├── wake/        # 唤醒 provider（H5 / 原生 / 不支持）
│   └── adaptation/  # 断点、安全区
├── features/        # 业务编排，可以依赖 core
├── pages/           # 路由页面，只做展示与事件转发
└── static/          # 本地资源
```

- `core` 不依赖 `features`，`features/*` 之间不互相依赖。
- 状态机保持纯函数：输入旧状态 + 事件，输出新状态 + effects，副作用留在 `useAssistant`。
- 新增业务复用 `core`，不要复制状态机、配置、存储代码。

## 硬性约定

### 条件编译

- uni-app 的 `APP-PLUS` 命中 Android / iOS，即本项目的目标端；鸿蒙与小程序确定不支持，不写它们的条件编译分支。
- 条件编译只影响构建产物，**不要依赖预处理来消除 import**。provider 的导入在函数内做能力保护。
- 新增平台能力时，先判断 `isSupported()`，再决定是否降级，禁止直接抛到 UI。

### App 逻辑层的 JS 引擎能力

- App 端逻辑层（`app-service.js`）跑在**独立 JS 引擎**里，不是浏览器内核，对 Web API 的支持与 H5 不一致。**H5 正常不代表 App 正常**：同一段代码在 H5（浏览器内核）没问题、在 App 逻辑层可能直接抛错。
- 已实测：`new URLSearchParams(...)` 在 App 逻辑层抛异常。拼 URL 查询串一律用 `encodeURIComponent` + 字符串拼接，**不要用 `URLSearchParams`**、不要依赖其它未被确认的 Web API。
- 请求前的参数构造要放进 `try`；在 `try` 外抛错会让 `catch` 兜不住、函数静默中断、状态停在初始值（曾导致设置页四个下拉 forever `disabled`，而请求根本没发出去）。任何异步 load 都要让失败分支自己也给出可用状态，而不是让数组停在 `[]`。
- 排查「App 有、H5 没有」或「界面停在初始态」这类问题时，先怀疑逻辑层 API 差异，别急着归咎于旧代码/缓存。可 CDP 直连真机 WebView 验证：`adb forward tcp:9222 localabstract:webview_devtools_remote_<主进程PID>`，用 `curl http://127.0.0.1:9222/json/list` 拿 `webSocketDebuggerUrl`，再 `Runtime.evaluate({returnByValue:true})` 读 `document.body.innerText` / DOM；必要时在页面放可见 debug 打点区分「没调用」与「调用后抛错」，定位后删除。

### 语言与国际化

- 默认中文 `zh-CN`，语言可配置（`core/config` 的 `language`）。
- **前端（uni-app）与后端（网关 `xiaoxiong-app/gateway`）都必须支持国际化（i18n）**，禁止在代码里硬编码中文用户文案。
- 前端：文案走 `core/i18n` 消息目录，按 `language` 取值；不引入 `vue-i18n`。
- 后端：智能体系统提示、下发给客户端的 `error` 文案等都按 `session.start` 的 `lang` 本地化，文案进 `xiaoxiong-app/gateway/src/i18n.ts` 的目录，按 `lang` 取值。
- 唤醒词、ASR、TTS 的默认语言跟随全局配置；厂商参数留空即继承。
- **ASR 识别语言走通用参数 `voice.params.language`**（2026-11-17 按用户要求从独立 `asrLanguage` 顶层字段改为走 params）：前端 `activeVoiceConfig()` 把 `appConfig.language`（zh-CN/en-US）规范化成基础码（zh/en）写进 `params.language`（无论有没有选音色都下发 params）；网关 `sharedParams` 把它带进 `asr.params.language`，`asr/http.ts` 的 `form.append('language', String(this.params.language || 'zh'))` 据此下发。**注意**：`params` 是 ASR/LLM/TTS 共用通道，`language` 会同时流进 LLM（`agentService` 作 `presetGenParams`，且 `llmKey=JSON.stringify(resolved.llm)`，改语言会触发 agent 重建丢对话历史）与 TTS 参数——这是用户明确接受的取舍；若日后要隔离，只能在网关 `sharedParams` 之外单独给 LLM 剥掉 language，不要再恢复独立顶层字段。没带 language 时由网关 env `ASR_PARAMS` 或 `HttpVoiceAsr` 的 zh 兜底继续生效。服务端 9529 SenseVoice 另有模型加载级 `SENSEVOICE_LANGUAGE`（默认 zh）锁定。
- **咳嗽/吸鼻涕误识别从源头挡：SenseVoice 前的 ZCR 声学门控**（2026-11-18）：SenseVoice 对纯静音/白噪声会稳定脑补出文本（实测静音→「没。」、白噪声→「嗯。」），导致咳嗽/吸鼻涕被识别成「我/对/同意/对呀」触发无意义回答。**逐字加黑名单是死路**（这些是正常口语，会误伤真人），必须从音频层判断「是不是真人讲话」。`model-proxy/voice/openai_voice_server.py` 的 `looks_like_non_speech(x)` 在 `transcribe_sensevoice` 送模型前算过零率 ZCR：真人浊音 ZCR≈0.09~0.14、吸鼻涕/咳嗽/宽带噪声≈0.31~0.44（真机日志校准），阈值 0.22（两组中点）+ 能量下限 peak≥0.01，命中或非语音返回空文本。只对有声帧（RMS>峰值8%）算，避免静音拉低。服务对 <2s 音频打 `[ZCR-GATE] zcr=.. block=..` 日志，真机校准阈值就靠它。测试 `tests/test_vad_gate.py`（stdlib，`venv/bin/python tests/test_vad_gate.py`）。**改 9529 服务代码后必须用 venv python 重启服务才生效**；ZCR 阈值 0.28 是按已验证样本定的，调阈值前先用真机音频测人声/噪声的 ZCR 分布。网关侧 `asr/noiseFilter.ts`：**语气词/拟声叠字在无语义时拦，但绝不在文本层堆「我/你/数字」等字**——2026-11-18 真机证实 ZCR 门控拦不住低频打嗝（ZCR≈0.086 与真人浊音同区间），SenseVoice 把打嗝/吸鼻子/回声脑补成单字「我/你/8」。曾往 `FILLERS` 加「我/你/8」但撞上选号（`isNoise('9')` 必须放行）且会误杀真人，已撤销——**打嗝/吸鼻子这类短语音幻觉最终由 VAD 二级判断根治**（见下条）。`FILLERS` 只保留无语义语气词（嗯/啊/嗝/哎…，单字，`isNoise` 仅在 `core.length===1` 时查），叠字拟声（嗯嗯/咳咳/嗯哼）由 `COUGH_FILLER_CHARS` 拦；「对/好/是」等真人会单独说的应答字**不**加。
- **ASR 近音错字纠错词表：两表 + 拼音匹配**（2026-11-18）：ZCR 挡的是「非语音」，这个词表挡的是「真人说了但 SenseVoice 识成近音错字」（滕王格世→滕王阁序、周杰轮→周杰伦、李存序→李存勖）。**逐字黑名单/纯拼音模糊匹配都走过弯路会误伤**（天气→天津、一路向北→一路刘备），最终方案是 SQLite 两表：`gateway/src/db/schema.ts` 的 `asr_corrections`（主表：correct 热词 + pinyin + note，correct 唯一）+ `asr_correction_variants`（字表：correction_id 外键 + wrong 错词 + 错词 pinyin + note，一热词多错词）。匹配在 `service/asr/asrCorrector.ts`：输入片段转无声调拼音 → 字表同拼音的 correct 全一致才纠（`Map<pinyin,Set<correct>>`，size>1 不纠，防「shi li」歧义），2~5 字滑窗最长优先。词表来源：`gateway/seed/asr_corrections.json`（主表）+ `asr_correction_variants.json`（字表），启动时 `service/asrCorrectionSeed.ts` 幂等灌入 + 加载进内存 corrector；管理接口 `/api/admin/asr-corrections` GET 列主表+字表、POST 批量加 `{items:[{correct,wrong,note?}]}`、DELETE `?correct=X&wrong=Y`，改后即时刷新。打包脚本整目录拷 seed/ 到 assets/gateway/seed/，运行时 GatewayNodeService 递归拷到 GATEWAY_HOME。维护词表改 seed JSON 或调管理接口，别改代码。拼音由 pinyin-pro 统一 `toneType:none`+空格分隔+小写（seed/接口都自动算，格式必须一致）。SenseVoice 不支持 hotwords（`set_option` 无效），解码阶段热词注入做不了，只能后处理。
- **ASR 统一经 9529 + 上游切换 + partial 不堆积（2026-11-19）**：网关对外**只走 HTTP 到 9529**（`/voice/v1/audio/transcriptions`），第三方 ASR/LLM/TTS 上游由 9529 的 `STT_PROVIDER`/`LLM_*` 决定（builtin / dashscope / deepseek，协议 WS 或 HTTP 均可）。**不让设备直连 DashScope**——虽有 `DashScopeWsAsr`（`createAsr` 在 provider=dashscope 时走它直连 wss），但用户明确不走 App 设置页直连路。SenseVoice-small（234M）精度到头（"李存勖"→"李存旭"、清嗓→"对/嗯/走"），工程旋钮（锁zh/ITN/VAD/ZCR/噪声词表/拼音纠错表）全拧过仍治不了模型容量，且 SenseVoice 不支持 hotwords；提精度走云端——DeepSeek ASR（api.deepseek.com `/v1/tools/asr`，非流式整段、¥0.78/h、无VAD）真机验证把"李存旭"纠成"李存勖"。LLM 同理切 deepseek-flash（官方 API 支持 function calling，本地 deepseek-r1:1.5b 不支持会把工具名当文本吐）。**关键 bug 修复**：切慢云端上游（往返~2s）后长句"今天天气怎么样"被截断/FINAL空/延后错位——根因是 `asr/http.ts` 的 `PARTIAL_INTERVAL_MS=600ms`（为本毫秒级本地设计）每次把新 partial `.then` 排进 inflight 队列致请求堆积；修复加 `partialBusy` 标志：上次 partial 没回来就跳过本次不排队，finalize 不受限（await inflight 必拿最终整段），reset 也清标志——自适应快/慢上游，真机验证长句完整无截断。详忆 `project_asr_provider_and_partial.md`。
- **通用自动学习引擎（纠错只是其中一类规则，2026-11-18）**：自动学习 = 助手从「系统以为 A、实际是 B」的偏差里自动积累知识，全程确定性、零 LLM、零网络。架构：`gateway/src/service/autoLearn.ts` 的 `createAutoLearnEngine()` 是**可插拔规则链**——`register(rule)` 加规则、`learn(from,to,ctx)` 统一入口（依次问规则，命中即止）、`learnFromTexts(wrongText,correctText,ctx)` 从两段文本提取中文词两两比对。**同音纠错只是第一条规则**（`homophone-correction`，注册在 `asrCorrectionSync.ts`），将来别的业务（新词/偏好/简称↔全称等）只需 register 新规则，不改调用方。发音归一化也做成可扩展表 `PRON_NORMALIZERS`（autoLearn.ts）：现在是平翘舌 zh/z,ch/c,sh/s（SenseVoice 高频把是→四、山→三、世→事），加前后鼻音/n-l/r-l 只往表里加项。学习信号来源三处：① 工具层——`service/tools/toolAutoLearn.ts` 的 `withAutoLearn` 统一包装**所有工具**（createToolkit 里 `allTools.map`），拦截 call 入参/返回交给引擎，ctx.source='tool'；② 数据源直连——百科/诗词拿「识别词→数据源规范词」(李存旭→李存勖、滕王格世→滕王阁序)，`voiceSessionService.autoLearnCorrection` 调引擎，ctx.source='tool'；③ LLM 回复——`reply()` 拿到 full 后 `learnFromAnchors(text,full,{source:'llm'})`，按锚点（《》/播放：）从回复里取规范词，识别"李存旭"而 LLM 回复用"李存勖"时学。CorrectionSyncer 暴露 `autoLearn/learnFromTexts/learnFromAnchors/registerRule`。**锚点提取是关键**（`extractAnchoredWords` in autoLearn.ts）：不要用滑动窗口切全文——那会把"背诵《洛神赋》"的"背"当正确词，实测误学"神父→神赋""贝洛神父→背洛神赋"三次。两条规则都有公共子串≥2护栏（挡子串误学）。注意：learn 走 `data.upsertAsrCorrection/Variant` 本地存（source=local）+ 刷新内存 corrector，**不上传 9529**；一次调用最多学一条，防污染。此外 `learn_correction` 工具仍注册（LLM 显式传 wrong/correct），deepseek-flash（官方 API）支持 function calling 能真正调它——本地 deepseek-r1:1.5b 不支持才需靠直连/包装器这些非模型路径。**依赖边界（重要）**：agent 侧（`agentService.ts`、`tools/index.ts`、`learnCorrectionTool.ts`、`toolAutoLearn.ts`）**只依赖 `AutoLearnEngine` 抽象**，不知道里面是纠错同步器、不碰 sync/stop/拼音存储等细节；只有编排层 `voiceSessionService.ts` 持有 `CorrectionSyncer`，负责取 `.engine` 传给 agent、自己用 learnFromTexts。`createAgentService`/`createToolkit`/agentFactory 的末参都是 `AutoLearnEngine`（不是 CorrectionSyncer）。
- **短语音幻觉根治：Silero VAD 二级判断**（2026-11-18，方案 A 落地）：声学上打嗝/吸鼻子和真人说「嗯/好」的 ZCR/能量/时长**完全重叠、分不开**（实测数据），文本层堆字会误杀选号，所以改用**信号+语义两级判断**。9529 `openai_voice_server.py` 的 `vad_speech_duration(x)` 用 sherpa-onnx Silero VAD（`silero_vad.onnx` 放 `models/sensevoice/`，随 `install-voice.sh` 下载，**默认必需依赖**，`--skip-vad` 可跳过）量出语音秒数，随识别 json 的 `speech_duration` 字段下发；网关 `asr/http.ts` 解析存 `HttpVoiceAsr.speechDuration`，`voiceSessionService.ts` 的 `isHallucinationShort(text, vd, hasSelectionContext)`：**vd∈[0,0.6) 且文本非有效意图、非真人单字应答（EFFECTIVE_SHORT_WORDS）、非选号上下文的数字 → 判幻觉丢弃**。实测铁证：真人「李存勖的百科」vd=1.448s、打嗝「我」vd=0.328s/0s、白噪声 vd=-1（已拦）。上游 ASR（DeepSeek 等）无 VAD 字段 → 跳过此判断、行为不变。别再回退到「往 FILLERS 堆字」或「调 ZCR 阈值」——声学信号本身分不开，这两条都是死路。
- **ASR 模型家族与选型**（2026-11-18 查 FunASR 官网，详见项目记忆 `reference_sensevoice_model_family.md`）：SenseVoice-**Small** 234M（非自回归、~70ms、CPU 可跑、5语言）——**本项目当前用，也是设备端唯一可行的，精度上限就在这**（李存勖→李存旭这类同音错字是小模型能力边界）。SenseVoice-**Large** 1587M（自回归、50+语言）10秒音频延迟 **1623ms**（Small 的20倍）+ 需 GPU，实时对话体验灾难，**不推荐**。Fun-ASR-**Nano** 800M（旗舰 LLM-ASR=SenseVoice编码器+Qwen3-0.6B，专攻专有名词/热词/代码混排，正好治本项目的错字痛点）但需 vLLM+GPU，设备端跑不动、要架 GPU 服务器，**不推荐**。要提精度只能走云端：DeepSeek ASR（¥0.78/小时、改动小，见下）比自建 Nano GPU 服务划算。**路线：本地 Small 保离线/低延迟，云端 DeepSeek 保精度**；别在设备端折腾 Large/Nano。

### 配置

- 配置模型：`运行模式 → 厂商 → 参数`。
  - `mode`: `byok`（自带服务，当前唯一可用）/ `platform`（平台托管，登录 + 计费后开放）。
  - 每类能力（asr / llm / tts）存 `provider` 与 `byProvider`，切换厂商不丢参数。
- 存储 key：`app-product.config.v1`，只存本机，不同步云端。
- 新增厂商：只改 `core/config/providers.ts` 的模板（vendor、默认值、fields），不要改设置页的渲染逻辑。
- 参数值必须经 `coerceFieldValue` 收敛（数字范围、单选合法性、布尔），脏配置不能带崩运行时。
- API Key 只在本机；平台模式上线后由网关持有，客户端不落 Key。

### 本地数据

- 小、同步读的配置：`uni.setStorageSync` / `getStorageSync`。
- **设备数据、会话记录、命令日志的权威存储移到 Node 网关（`xiaoxiong-app/gateway` 的 SQLite），客户端经 REST 接口读写**；`core/database` 仅作离线缓存或降级，不直接写业务数据。
- SQL（网关侧 Node 端）必须用参数化查询，禁止把外部字符串直接拼进 SQL。
- H5 开发阶段没有 `plus.sqlite`，`isSupported()` 为 false，调用方需降级。
- 设备数据默认存本地；付费用户后续可同步云端，云端不是当前实现。

#### 网关 SQLite 表结构（权威定义：`gateway/src/db/schema.ts` + `gateway/src/db/client.ts` 的 BOOTSTRAP_SQL）

库文件默认 `gateway/data/app.db`（`config.db.path`，`:memory:` 为测试内存库）。Node 内置 `node:sqlite`，无原生编译依赖。建表走 `BOOTSTRAP_SQL` 的 `CREATE TABLE IF NOT EXISTS`（drizzle-kit 的 generate/push 在 node:sqlite rc 工具有 bug，暂不用 migrations），业务查询全走 Drizzle mapper（`gateway/src/mapper/*`），不写行级 SQL。新增表/字段须同时改 schema.ts 和 BOOTSTRAP_SQL；旧库加列因 IF NOT EXISTS 不生效，需像 `user_memory.created_at` 那样在 createDb 里显式 ALTER 补列。

| 表 | 列 | 索引/约束 | mapper | 用途 |
|---|---|---|---|---|
| `sessions` | id PK自增, device_id, started_at, ended_at, created_at | 无 | sessionMapper.create/listByDevice | 语音会话记录 |
| `command_logs` | id PK自增, device_id, command NOT NULL, result NOT NULL, created_at | 无 | commandLogMapper.create/listByDevice(200) | 命令日志 |
| `user_memory` | id PK自增, device_id, key NOT NULL, value NOT NULL, created_at, updated_at | UNIQUE(device_id,key) `uq_user_memory_device_key` | memoryMapper.save/list/listPage/forget | 用户长期记忆，按设备隔离、同 key 覆盖 |
| `app_config` | id PK自增, device_id, config NOT NULL(JSON字符串), updated_at | UNIQUE(device_id) `uq_app_config_device` | configMapper.save/get | 设置页保存配置的本机副本（真相源仍是客户端 setStorageSync） |

时间列默认 `strftime('%s','now')`（秒级）。client.ts 对旧库缺 `user_memory.created_at` 做了 ALTER 补列 + 用 updated_at 兜底。`device_id` 维度全部按设备隔离，见下方生成规则。

#### device_id 生成规则（`uni_app/src/core/config/deviceId.ts`）

- 格式 UUID v4：优先 `crypto.randomUUID()`，回退 `Math.random()` 按 v4 格式拼。
- 首次生成后存 `uni.setStorageSync('app-product.deviceId', id)` + 内存缓存，之后恒复用；非 App 环境（浏览器/测试）回退进程内内存态、不持久化。
- **卸载重装会变**（storage 清空 → 新 UUID），旧记忆/配置成孤儿（数据还在库里但新 id 读不到）。覆盖安装/重启/重连/重唤醒不变。
- 用途：WS 连接 `?deviceId=`（网关据此复用会话、保留记忆/待选歌单）、原生 PCM 直连、`/api/admin/memories`、`/api/admin/config` 的设备维度。
- **Android 正在改**：原生插件 `app-product-wake` 加 `getStableDeviceId()` 读 `ANDROID_ID`（Settings.Secure，卸载重装不变、无需权限）；前端优先调原生、失败回退 storage UUID。iOS 待做（方案：Keychain 存 UUID，卸载重装保留；IDFV 单 App 场景会变，不够可靠）。注意 Node.js 网关侧做不到跨卸载持久化——它的 home 是 App 私有 `no_backup` 目录，卸载必删；稳定标识必须从系统级 API（ANDROID_ID/Keychain）读，只能走原生层。

### 协议

- 客户端 ↔ 服务端消息以 `contracts/README.md` 为准，先改契约再改代码。
- 上行音频：16kHz / 16bit / 单声道 PCM。
- 下行事件：`asr.partial` / `asr.final` / `llm.delta` / `tts.*`，新增类型必须同步契约文档。

### 网关（后端 Node.js）

- 后端是独立 Node 服务 `xiaoxiong-app/gateway`，是客户端**唯一**允许的通信对象：语音走 WebSocket，数据走 REST，第三方能力（ASR / LLM / TTS / 数据库）只在网关这一侧落地。
- **前端不得直接调用任何第三方服务**，一律经 Node 网关转发；客户端只与网关通信。
- **第三方地址只由网关持有**：`VOICE_BUILTIN_URL` / `VOICE_DASHSCOPE_URL` 等来源地址写在网关配置（或 `.env`）里，前端**绝不**把来源地址（如 `http://127.0.0.1:9529`）传给后端当 fetch 目标。前端调 `/api/*` 时只传业务参数（如 `provider`），由网关用自身配置去中转拉取；api-key 这类只落本机的密钥可从前端带来，但地址不行。
- **每次新增前端→后端的取数/调用**，先确认它只打到网关、且目标地址来自网关配置，而不是前端拼出来的 URL。
- 数据库只在 Node 端落地（SQLite via `node:sqlite`）；客户端经 REST 读写，不再直接写业务数据到 `plus.sqlite`（`core/database` 仅作离线缓存/降级）。
- 所有后端接口需提供 Swagger / OpenAPI 文档（网关 `/docs`），新增或修改接口先更文档。
- 后端文案按 `lang` 本地化（见「语言与国际化」）。
- **设置接口免登录**：`/api/admin/*`（长期记忆、语音服务配置、LLM 模型目录、TTS 音色目录）是语音助手设置页自身使用的接口，**永远不需要登录、不做任何鉴权**。不要为这些端点加登录开关或 Bearer 拦截——它们面向本机设置页，登录只属于未来的平台托管模式（届时由不同入口承载）。详见 `xiaoxiong-app/contracts/README.md` 的「设置接口」小节与 `gateway/src/controller/apiController.ts`。其它模块若需要这些能力，不要复用 `/api/admin/*`，应新开接口。

### 音频与唤醒

- 唤醒后立即播本地招呼，不等 WebSocket 建连；提示音、结束语都走本地文件（H5 用 WebAudio）。
- 播报时不能自唤醒、不能把播报当成用户说话。
- 原生唤醒插件名固定 `app-product-wake`。JS 接口：`start / stop / onWake / onError`（唤醒），以及 `startPcm / stopPcm / onPcmFrame / onPcmError`（App 端实时 PCM 采集，见 `xiaoxiong-app/uni_app/src/core/audio/appCapture.ts`）。App 端**不用** `uni.getRecorderManager` 做对话采集：它只能录成文件、App 不支持 `onFrameRecorded`，拿不到网关要求的实时 PCM 分片。
- **本地提示音音色要自然、且与 App 在线 TTS 统一**：`static/audio/*.mp3`（greeting / still-there / farewell）用自然中文神经 TTS 音色（`edge-tts` 的 `zh-CN-XiaoxiaoNeural`），**不要**用 macOS `say` 的默认机器人嗓音（用户觉得不好听）。重新生成提示音或改网关 TTS 音色时保持同一嗓音。具体地址 / 模型名从配置读，不写死在代码里。

### 代码风格

- TypeScript strict 通过；不要用 `any` 绕过类型，必要时用 `unknown` + 收窄。
- 注释写“为什么”，不写“是什么”；中文注释，与现有代码一致。
- 单个文件保持聚焦；新能力优先加文件，不把逻辑堆进页面。
- 单测覆盖纯逻辑：状态机、唤醒词、配置收敛、SQL 转义。UI 与原生插件不做单测。

## 实践约定与踩坑（长期有效）

### 用户交互与内容意图

- **页面可见文案全部走 i18n**（见「语言与国际化」），唯一例外是识别出的语音原文，按原样显示。
- **用户说了内容类型就按类型办**：说"评书 / 相声 / 有声书"当内容播放，不要当点歌，措辞也别说"这首歌"。
- **视频类内容要能播放音频**：电视 / 电影 / 动画走 B 站音轨抽取播放，不能回复"无法播放视频 / 没有这个能力"；找不到只说"没找到"。
- **音乐 / 字幕同源**：点歌优先从歌曲宝详情页一次拿齐同源音频 / 封面 / LRC，拿不到再走 B 站 + 百度兜底。音频与字幕必须同源同曲，跨源宁可显示"暂无字幕"，绝不配第三方歌词库（第三方源已删）。
- **字幕只展示不播报**：同源字幕只在界面显示，绝不经 TTS 朗读，也不让 LLM 复述原文。
- **"再"字表示全新请求**：语音指令含"再"（再放 / 再减…）时关掉跨轮上下文，不沿用上一轮的歌手 / 状态。
- **少调 LLM**：高置信控制指令（音乐 / 音量 / 记忆 / 新闻等）直连绕开大模型，不进 LLM。
- **新闻播报直连**：识别在 `service/control/newsControl.ts`（触发词 新闻 / 消息 / 头条 / 热点 / 快讯 / news / headlines，话题词从触发词前提取，含歌曲 / 影视等其它内容强特征则让回下游）；检测在 `voiceSessionService.handleDirectCommand` 中**排在音乐指令之前**（否则「播放新闻」被裸「播放」当点歌）。抓取走 `service/news`（`NewsSource` 抽象，默认百度新闻频道）+ `service/tools/newsTool`（6s 超时、按 URL 60s TTL、并发复用 Promise、失败不缓存），源地址只在网关侧、前端不出现也不接受传入。只口播「标题 + 来源」、不发卡片 / 不编号 / 不进 LLM；失败 / 0 条 / 正常三态分别走 `formatNews` 的诚实文案，绝不编造新闻。引导与兜底按 `lang` 本地化（网关 `i18n.ts` 的 `news.*`），标题保持原文。
- **百科播报用百度百科自己的 TTS 音频，不自己文字转语音**（2026-11-17）：百科词条直连命中后，网关 `runBaikeCommand` 调**百度百科 getaudio 接口**拿 mp3 直链（`service/baike/baikeTts.ts`），`media.play` 下发让客户端边下边播（和音乐同一套 InnerAudioContext）。sign 算法 `md5(text+"9"+per+time+once+固定盐)` 逆向自百度 `lemma_*.js`、多组真机样本验证；接口是百度非公开、可能失效，**失败就静默不播（只发 `llm.done` 收尾），绝不用网关文字转语音兜底**（用户明令「播不了就算了」）。mp3 直链约一百多分钟有效，即用即取不缓存。
  - **必须落盘成本地短链下发，不能下发第三方直链**（2026-11-18 真机踩坑）：之前以为"CDP WebView Audio 能播直链"就直接用，但 App 实际走 InnerAudioContext 直拉第三方 HTTP 流**无声（-99、不发请求）**——音乐/新闻都靠 `audioPath` 本地短链才稳。现在网关 `service/mediaCache.ts` 在 media.play 前把外部 mp3 下载落盘到独立 `cache/media/<md5>.mp3`（不参与 ADTS 的 LRU=2，否则会被音乐挤掉），下发 `audioPath=/media/s/<key>.mp3`，客户端下载本地播。server.ts 注册 `/media/s/` 独立短链路由（Range/CORS）。百科 `runBaikeCommand` 和诗词 `runPoemCommand` 都走这条。下载失败回退原始 url。测试 `service/mediaCache.test.ts`。
  - **助手框只显示简短播报确认，全文进字幕面板**：百科播报时 `llm.delta` 只发一句「正在为你播报：XX。」（i18n `baike.playing`，同音乐 playing 风格），百科全文**不进助手框**。新闻单条播放同理（`news.playing`，新闻无字幕）。
  - **字幕转成歌词格式 + 自动换行**：百科摘要经 `splitSummaryToLines`（`baikeTts.ts`）按中文句末标点切行、短句并入前句、按字数/4.5字每秒分配每行 time → `media.subtitle`；前端 `activeSubtitleIndex`/`activeSubtitleSplit` 按播放进度逐句高亮「边读边转」。悬浮歌词 `disc-lyric` **必须自动换行**（`white-space:normal` + `word-break:break-all`，固定 200px 宽内折行），字号按 190/w 微缩——**不要用旧的 `nowrap`+`overflow:visible`**（长句横向溢出、左右被截断看不全，真机截图实锤）。
  - **封面用词条配图**：百度搜索页百科卡片的 `poster` 里 `gimg3.baidu.com/.../src=<编码的 bkimg URL>` 解码成稳定 `bkimg.cdn.bcebos.com` 直链（`baiduBaikeSource.ts` 的 `extractBaikeImage`），随 `media.play.cover` 下发（同源展示）。`media.play` 新增 `source?: 'music'|'tts'` 来源方式区分音乐 / 第三方 TTS。
- **诗词/古文朗读走百度汉语 edu 源，不让 LLM 背全文**（2026-11-17）：用户说「背诵/朗诵/念一下/读一下 XX」+ 作品名（`control/poemControl.ts` 识别，含「歌/歌曲/音乐」等点歌句式排除，避免劫持「念出3首周杰伦的歌」），`runPoemCommand` 调 `service/edu`（按作品名→百度搜索页 aladdin 卡片提 32 位 sid → `hanyuapp.baidu.com/dictapp/swan/poemdetail?sid` 拿逐句原文 + `voiceInfo.url` 百度朗读 mp3）。字幕显示全文、mp3 经 `media.play(source:tts)`、助手框只播一句确认。两个关键约束：
  - **作品名在第一个中文标点处截断**：ASR 常把多句连成一句（「背诵回乡偶书，给我回答没有书的好价」→ 作品名只取「回乡偶书」），截断避免把后续指令当书名；超 15 字也截断。
  - **查不到就诚实提示、不回退**：查不到 sid（部分作品百度搜索无 aladdin 卡片，如回乡偶书/滕王阁序纯搜）时播「暂时没找到《X》的诗词内容」并 return true，**绝不能返回 false 往下走**——否则后面的好价分支会被句里的「好价」命中、答非所问（「背诵回乡偶书」回答「没有书的好价」）。也不交 LLM 自己背全文。
  edu 源按"一个源一个子目录"放 `edu/baidu/`，经 `edu/index.ts` 汇聚。`query_poem` 工具也注册进了 toolkit（LLM 点名诗词时可主动调）。
- **长文本不经过 LLM/我们的 TTS**：LLM 自由回答在 `runAgent` 流式 delta 累计 `MAX_LLM_SPOKEN_CHARS=100`，超限停止下发（助手框+TTS 同步截断、句子边界），i18n systemPrompt 也加 ≤100 字约束；**工具结果（百科摘要/商品/歌词/诗词原文）不受限**。起因：用户「王勃的滕王阁序」被 LLM 背全文、太长没人听。
- **好价多源自动降级 + 反爬冷却**（2026-11-17）：smzdm 被腾讯云 WAF 普遍拦截（本机+设备都拦，换 WiFi 无效），默认主源换成值值值 `zhizhizhi.com`（`deals/zhizhizhi/`，设备网络可访问，分类页+本地关键词过滤；标题兼容 PC 版 `ht3` 和 WAP 版 `h3`）。`createDealsAllSources()` 给主源+备用源，某源没结果/被反爬就冷却（`deals/sourceCooldown.ts`，默认 10 分钟）自动换下一个；**只有确认反爬页才冷却，空结果只换源不冷却**。`media.detail` 只在有商品时下发，没找到下发 `close:true` 清掉空「为你找到」框。
- **回复要诚实**：关闭字幕 / 暂停 / 停止等确认必须反映真实状态；没字幕、没在播放就别说"已显示 / 已暂停 / 已关闭"；保存配置连不上或写失败要如实报错，不谎报成功。
- **媒体控制命令不能被 `musicSource` 门槛挡住**（2026-11-18）：`handleDirectCommand` 曾用 `if (action && this.musicSource)` 统一拦截、`runMusicCommand` 入口也 `if (!source) return`，导致**没配音乐源时** stop/pause/resume/replay 被跳过交 LLM 乱答（「停止播放」→「没在播放」、「重新播放」→「没有这首歌」）。但百科/诗词(tts)播放根本不需要音乐源。约定：只有找歌类（play/next/recommend/loop）才要求 musicSource；pause/resume/stop/replay 操作当前/上次媒体，一律放行。百科/诗词 media.play 时置 `ttsMediaActive`（独立标志，不碰 musicActive，避免污染同歌手选歌/nowPlaying），pause/stop 认它并清掉。
- **「重新播放」= 重播最后播放的内容，不是找歌**（2026-11-18）：新增 `replay` 动作（`musicControl.ts`），正则含 重新播放/重播/重放/再来一遍，必须排在 play 之前（「重新播放」含「播放」否则被当点歌）。网关 `lastTtsMedia`（百科/诗词）+ `lastTrack`（音乐）记住最后播的 url/audioPath/封面/字幕，`replay` 原样重新下发 media.subtitle + media.play，不重新检索、不进 LLM。「再放一遍」语义是循环当前曲，仍归 loop，不归 replay。「关闭播放」等同「停止播放」（stop 正则）。
- **百科/诗词字幕对齐：前端用播放器真实 duration 重铺，别信网关 durationSec**（2026-11-18，详见项目记忆 `project_tts_subtitle_timing_pitfalls.md`）：设备端 `mp3DurationSec` 对真机实际音频会算错（滕王阁序真实 411s 被算 ~489s），字幕 time 铺过大→慢于声音。`useAssistant.ts` 的 `effectiveSubtitleLines` 用 `musicState.duration`（解码器读的，准）+「均匀句间隔 + 前奏补偿」重铺 tts 字幕（字数占比铺会把 TTS「读一句停一秒」的停顿均摊、字幕匀速跑到声音前），tts 偏移 `subtitleLeadSec=-1.0s`；music 走网关原始 lines 一字不动。**精确逐句对齐受限于设备端 NodeMobile 无法解码 mp3/跑 ffmpeg，拿不到每句真实起止时间**，均匀铺是设备端能做到的最好近似（残差 2~5s）。采样验证用 CDP 读 `.subtitle-line--active`（当前高亮句，不是 `disc-lyric`，后者是悬浮单行歌词、字幕面板展开时不在 DOM）+ `.music-time`（播放进度文本）。别再用本机 ffmpeg 音频当「标准答案」对照真机——设备下载的是另一个 URL/录音，对照不可靠，已因此误判多轮。
- **详情卡片**：编号同行最前、列表显示字段、缺值占位、来源显示站点名、选号跨轮保留且量词通用、关详情回列表、无朋友圈入口、各 kind 共用同一协议。
- **展示信息克制**：面板别默认加语义重复的状态列。
- **思考/播报期间插话排队、只有「小熊小熊」打断**：思考与播报期间用户说的话都排进队列（最多 3 句），当前句播完后按序处理；网关不认识唤醒词，把识别原文随 `asr.queued` / `asr.rejected` 透传回客户端，由客户端 `matchWakeWord` 匹配。命中「小熊小熊」= 用户嫌当前这句长想打断：播一声本地「我在」招呼，回 `session.skip_current`（带 `dropText` 让网关把这句唤醒词从队列删掉），**只跳过当前句、不清空队列**，队列里的句子继续播。这与 `session.cancel`（`REWAKE` 用的整轮重来、清队列）严格区分：旧实现重新喊唤醒词走 `REWAKE = session.cancel + session.start` 会把排队全清掉，正是「重新说小熊小熊排队也被干掉」的根因。客户端唤醒词分支**不累加** `queuePending`，否则删句后徽标会卡住（靠 `asr.final(queueRemaining)` 权威同步）。
- **点语音球 ≡ 说「小熊小熊」，只打断 TTS、不停媒体播放器**：两者语义完全等价——播报中（`isSpeaking`）点球与唤醒词走同一个 `interruptSpeech(dropText?)`：本地立即 `stopTts()` + 复位播报态 + `transport.sendSkipCurrent(dropText)`，**绝不调用 `stopMusic`**，音乐 / 新闻音轨（`media.play` → `InnerAudioContext`）照常继续放。踩坑：`onOrbTap` 原判断只在 `state=listening/confirming` 才 `interrupt()`（整轮 CANCEL），而文字播报常发生在 standby 空闲直连场景（百科 / 天气 / 时间 / 新闻确认句），此时点球落到 `wake()` 只是重新唤醒、停不掉正在播的文字——所以 `isSpeaking` 判断必须放在 `onOrbTap` 的 state 分支**最前面**。媒体播放器停止只由 `media.stop` / `stopMusic` 负责，两条打断路径都不碰。
- **语音球防重复快速点击**：`onOrbTap` 入口做时间戳节流（`ORB_TAP_GUARD_MS = 400` + `lastOrbTapAt`），间隔内连点直接丢弃，避免双击 / 误触重复触发 `enable`（重复建连）/ `wake`（重复唤醒）/ `interrupt`（重复打断）。用时间戳而非定时器加锁，不阻塞正常节奏、也不把后续点击吞掉；系统时间回拨（`elapsed < 0`）时不拦截，避免误锁死。
- **队列满提示在「我说」右上角**：超过最大队列的拒收话术显示在「我说」卡片右上角，与排队数量徽标同位置同款式，不用页面顶部横幅、不进正文、不用浮层。

### 权限与位置

- **定位等敏感权限懒加载**：只在问到天气 / 附近时才 `client.location.request`，绝不在建连 / 冷启动就取位置、弹权限框。
- **权限提醒按必要性分级**：麦克风未授权要播 mp3 提示音；定位非必须，只显示状态、不播报；用三色状态区分。

### UI 与展示验证

- **不用文字浮层**：任何提示都不用 `uni.showToast`，只放页面固定区域的行内文字。
- **横竖屏与跨机型一致**：UI 改动横屏竖屏都要适配、所有机型一致；状态栏高度用 JS 读系统值，别依赖 CSS env/var。
- **首页统一单列**：`pages/index/index.vue` 横竖屏都单列，不做左右分栏；横屏要铺满不留黑边（黑边根因在 `App.vue` 的全局限宽规则，不在首页 scoped）。
- **UI 改动必须在真机 / 真实页面点击验证**：用 Playwright 驱动真实 WebView / Chrome 点击看效果，或截图 + PIL 像素差分；代码层"等价验证"不算数。本项目 `console.log` / `pageerror` 收不到日志，别指望它们。
- **音量面板点外部收起要用全屏遮罩，别依赖事件冒泡**（2026-11-18）：App 端 `@tap` 冒泡到页面根不可靠，曾在根绑 `@tap="onPageTap"` 收起面板但真机"打开后关不掉"。正解：`index.vue` 加 `.vol-backdrop`（fixed 全屏透明，z-index 低于 `.vol-group`）+ 面板 `@tap.stop`，点遮罩即收起；喇叭分组 z-index 抬高保证面板内拖动/再点喇叭仍可用。面板在喇叭**上方**弹出（`bottom: calc(100%+10px)`），不压进度行。

### 配置、协议与目录数据

- **配置值来自用户设置**：LLM 模型、音色等默认留空，由设置页提供并统一保存落盘；网关不硬编码字面量、不读 env、不运行时调接口解析。
- **不硬编码服务地址**（见「网关」）：自请求 / 拼 URL 别写死 `127.0.0.1:端口`，调内部分支或从配置读。"语音设置 / 模型字段 / 保存配置"指 uni-app 客户端设置页（内置 + dashscope 两源都要覆盖），不是 9529 管理面板。
- **LLM 默认模型按提供商维度**：每个提供商分组各有自己的默认模型，真相源 `*_UPSTREAM_DEFAULT_MODELS`（`{vendor: model}` map），与"默认供应商"解耦；`*_UPSTREAM_VENDOR` 与默认模型是两个独立维度。
- **协议是模型级字段、只写调用形态**：协议值只能 `http` / `ws` / `http-async`，不带厂商 / 引擎名 / 端点路径；跟在模型行上，不在提供商行旁单列；厂商由 `provider` 表达；内置 ASR / TTS 就是 `http`。
- **协议 / 模型目录权威源**：9529 代理的协议 / 模型目录对齐 Java 工程 `fw-plus-ai-native`（`LlmProtocol` / `LlmVendor` / `ModelType`），其 LLM / EMBEDDING / RERANK 三端口映射到 9529 的 LLM / TTS / STT。
- **目录数据必须放 seed 文件 + 初始化脚本**：音色、ASR / TTS 模型等静态目录放 `scripts/voice/seed/*.json`，由 `scripts/voice/init_catalog.py` 幂等灌库，禁止硬编码在业务代码里。
- **控制类参数须真下发**：思考开关要真到上游让模型生效，不能只隐藏 UI；对外固定用 `think`，代理按厂商翻译。
- **外网检测覆盖全部实际依赖的外网源**：`health.ts` 的 `EXTERNAL_HOSTS` 探测百度（搜索）/ B站（点歌）/ gequbao（歌曲宝）/ smzdm（好价）/ somafm.com（电台，用主站别用 ice6 流节点——根路径不给 2xx），任一可达即外网正常；加新外网源时同步 `health.test.ts` 的 `isExternalHost` 桩与 openapi 描述。曾因只探百度，用户纠正「不光是百度，还有 gequbao、smzdm、soma、bilibili」。
- **一键检测不可达文案统一、模型非必填**：LLM / ASR / TTS 地址不可达统一报「已配置但地址不可达（endpoint）」，不许造"内置语音服务地址不可达"这类能力混用文案（曾在大模型行显示"内置语音…"被用户抓包）。模型不是必选项：运行时回退网关默认模型，deep 检测未选模型一律按地址可达性给状态、不报「未选择模型」红（builtin 源可先 `listLlmModels` 解析默认模型真调验证）。cors.test.ts 的 health 用例依赖真实外网探测，已放宽 timeout=15000。

### 代理服务与存储架构（9529）

- 9529 语音代理：本地 SQLite 作配置真相源 + Redis 远程缓存 + Postgres 远程库，统一收口到 `config_store` 门面（调用方无感）。
- 对外当前只有 HTTP 语音接口；对外 WS 接口待测试页完善后再加。
- DeepSeek 官方语音：ASR `/v1/tools/asr`、TTS `/v1/tools/tts`，音色 stella / tide，调用协议 `http`，密钥走 `STT_DEEPSEEK_API_KEY` / `TTS_DEEPSEEK_API_KEY`。
- **本地真实服务联调的网关实现坑**（地址 / 模型名一律从配置读，不写死）：语音服务接口可能在**根路径**（`/v1/audio/transcriptions`、`/v1/audio/speech`）而非某个前缀，接错路径会 404；ASR 服务常要求 **RIFF/WAV**，纯 PCM 上报 `does not start with RIFF id`——`asr/http.ts` 要把上行 16k PCM 补 44 字节 WAV 头再 multipart 提交；TTS 返回的 24k/16bit/单声道 WAV 直接剥头下发 PCM、无需重采样。上游 LLM 曾因余额耗尽返回 402，联调 LLM 可改走本机 Ollama 绕开付费代理。排查「对不了话」先分清是地址、接口路径、WAV 头还是上游余额问题，别急着改前端。
- **SenseVoice 识别语言必须显式锁 zh，不能走 auto**（2026-11-17）：本机 9529（`model-proxy/voice/openai_voice_server.py`）用 sherpa-onnx SenseVoice-small，`from_sense_voice(language=...)` 与 stream `set_option("language", ...)` 都支持 auto/zh/en/ja/ko/yue。**auto 检测在短句/带噪时把中文摇成拼音式碎片**（真机「李存勖」→「Li chnx.」「Byaiike Li Sian.」、高频冒 The/Yeah）。两级锁定：服务端 `sensevoice_language()`（读 `SENSEVOICE_LANGUAGE`，默认 zh）在模型加载和 stream 都传；网关 `asr/http.ts` 未配 language 时默认补 `zh`。SenseVoice **没有热词支持**（hotwords 只属 FunASR-nano/Paraformer），**同音字（勖→旭、事迹→四纪）是模型词表/声学上限，锁 language 也救不回**——要根治只能换更强引擎或加领域热词引擎，别在 language/音量/AEC 上空耗。验证：verbose_json 的 `language` 返回 `<|zh|>` 即锁定生效。9549/9529 服务是本机 Mac 进程，改完要重启且用能常驻的方式（本环境普通后台启动会被 shell 回收），重启后确认 adb reverse tcp:9529 隧道与设备网关 health。
- **启动 9529 语音服务必须用 venv**（2026-11-17）：`model-proxy/voice/openai_voice_server.py` 依赖 `websockets` / `fastapi` / `uvicorn`，**系统 python 没装这些，直接 `python openai_voice_server.py` 会失败**。启动固定用项目 venv：
  ```bash
  cd model-proxy/voice
  ~/.app-product/voice/venv/bin/python openai_voice_server.py
  ```
  启动前先确认 venv 依赖齐全（`~/.app-product/voice/venv/bin/python -c "import websockets, fastapi, uvicorn"`）。服务是本机 Mac 进程，要**常驻**（普通 `&` 后台启动会被 shell 回收，用能保持进程的方式如终端常驻 / 任务管理器）。起来后本机 `curl http://127.0.0.1:9529/` 应返回 `{"service":"app-product-local-ai",...}`，真机再确认 `adb reverse tcp:9529 tcp:9529` 隧道 + 设备侧 `adb shell 'curl http://127.0.0.1:9529/'` 拿到 200。卡死（CPU 空转、ASR 返回幻觉碎片但 health 仍 200）时 `kill -9` 掉旧进程再用 venv 重启。
- **SenseVoice 句尾重复词清洗**（2026-11-17）：真机「今天天几怎么样？」被 SenseVoice 输出成「今天天气怎么样？天气。」（主体收在问号处、尾部又多吐一次「天气」）——**项目没有「纠正词/热词/词表替换」功能，网关和前端都原样透传 ASR 文本**，这是模型自己的尾部重复，别去找不存在的替换逻辑。清洗放在 `asr/noiseFilter.ts` 的 `stripTrailingEcho()`：摘掉收尾标点后，若「最后一个句末标点之后的核心（≥2 字）」已在主体出现过，就删到该标点为止。在 `voiceSessionService.ts` 的 partial 下发与 `finalizeUtterance` 定稿（噪声过滤之前）两处调用，保证「我说」框与 LLM 看到同一份干净文本；诊断 FINAL 行附 `raw=` 记原文。尾巴是全新内容（「去北京？上海也行」）、单字尾巴、无句末标点都保留，避免误伤。

### 打包、真机调试与环境坑

- **⚠️ 头号教训：真机「播报中途停止/没播完/自动退出/卡死」先查是不是上滑手势清后台，别急着改代码**（2026-11-17 实锤）：logcat 出现 `ActivityManager: Killing <pid>:com.xiaoxiong.assistant ... iAwareF[SystemManagerSwipeUp]` / `signal 9 (Killed)` = 荣耀系统「上滑清除后台应用」手势 forceStop 了整个 App（含 :gateway），播报瞬间中断、PID 变化，表现为「只播了几秒就停」「界面提前完成」「卡死」。**排查第一步永远 `grep -aE "Killing.*xiaoxiong|SystemManagerSwipeUp|signal 6|signal 9|Runtime aborting" logcat`**：signal 9 + SystemManagerSwipeUp=手势杀（不改代码，测试时手别碰上滑）；signal 6 + Runtime aborting=native 崩溃（如 AudioTrack 多线程并发，需给 create/play/write/stop/release/setVolume/getPosition 加同一把锁）；都不是才查业务逻辑。Doze 白名单只防后台冻结、不防用户上滑清除。
- **⚠️ 一定是拿到了确定的证据才改业务代码，绝不靠猜；唯一允许先写的是埋点/诊断日志代码**（用户明令，2026-11-17）。改动前必须先用日志/CDP/MD5 等拿到铁证，指出断点在哪一行、什么事件、什么时刻。猜一个假设就改一版业务代码、打一次包，是这轮大事故的根因（连改十几轮、越改越乱、最后全部回退）。如果证据不足，就只加埋点日志（如 `session.diag.trace`、`IDLE-DIAG`），拿真机数据后再动业务代码。埋点定位完要清理掉。
- **网关侧软件 AEC（2026-11-17，已实现+真机验证，保留）**：`gateway/src/service/echoCanceller.ts` 纯 JS NLMS，把下发 TTS(24k→16k重采样)作参考、从采集(16k)里消扬声器回声，VAD/ASR 用消除后的帧（frameRms/duck 仍用原始帧以检测真人开口）。设备 NodeMobile 跑 1 秒音频仅 45-62ms，无 wasm 依赖。真机验证：播报期普通插话「喂喂」「今天天气怎么样？」能正确识别并入队（之前全是 TTS 回声碎片）。**关键坑：NLMS 参考窗口末端必须对齐到帧内第 k 样本(refWrite-n+k)，固定用帧末 refWrite 会因帧内样本错位而不收敛；双讲冻结不能用 |e|>|d|（收敛初期误冻结）。** 剩余：播报期喊「小熊小熊」仍识别不到，待定位。
  - **⚠️ 这批软件 AEC + 诊断代码当前是从未 commit 的工作区残留（2026-11-17 归档时实锤）**：`gateway/src/service/echoCanceller.ts` 及其 `.test.ts`、`voiceSessionService.ts` 的 AEC 接入与 `session.diag` 埋点、`server.ts` 的 `/api/diag`、前端 `useAssistant.ts` 的 trace 埋点，`git log -- <file>` 全为空、从未提交，不属于已归档的 `fix-speech-noise-interrupt-playback` change。**副作用：工作区 `npm run type-check`（gateway）会报 2 个未使用变量错误（`echoCanceller.ts:26 frozen`、`echoCanceller.test.ts:13 rms`）**——这不是本 change 的问题（其提交时 gateway type-check 0 错误）。下次在这个工作区开发前先决定：把软件 AEC 定稿提交（顺手清掉这两个未使用变量），或 `git checkout`/删除清理掉这批残留，别让脏工作区污染新 change。
- **端到端问题先分段定位断点，再改代码——不要"改一个假设就打包一次"**：曾为「播报期插话识别不到」连续打包 15+ 轮、每轮都基于一个新"高置信度"假设改下游（VAD 门槛→音量→清零逻辑→AEC→duck→队列标志），全部无效，因为真断点在最上游（JS `onPcm` 播报期停止发帧）。链路 `原生采集 → JS 发送 → WS → 网关 VAD/ASR → 事件下发 → 界面` 出问题时，**先加分段埋点确认断点在哪一环**，一处确认后再动手；不要在未定位时反复全量打包验证猜测（每轮全量构建+装机成本高，且会消耗信任）。诊断埋点的完整结论见项目记忆 `project_barge_in_direct_pcm_fix.md`。
- **播报期插话识别不到的真凶（20+ 轮后确认）：weex 原生→JS 的 PCM keepAlive 回调在播报期失效**。用 `session.diag` 客户端文本消息经 WS 上报 JS `onPcm` 真实状态到网关落盘（这是唯一能观测 App 逻辑层的通道：CDP 只能连视图层、`uni` 视图层无 getStorageSync、logcat 收不到 JS console、`uni.setStorageSync` 在高频回调不落盘），拿到铁证：播报期原生 `pcm frames` 持续正常涨（每秒 31 帧、`WakeModule.java` 一直在 `pcmFrameCb.invokeAndKeepAlive`），但 JS `onPcm` 每 2 秒收帧数从 63 骤降到 1，且 `muted=false`、`connected=true`。断点 100% 在**原生回调 → JS 接收**这一段（DCloud weex keepAlive 回调被大量 TTS 下行音频冲击丢弃，同类于 connectSocket promisify 坑）。VAD/ASR/AEC/音量/duck/掐麦/队列等所有下游改动全无效，因为帧在上游就没到 JS。
  - **已实现并真机验证（2026-11-16）的修复：原生 PCM 直连网关，绕开 weex 回调**。新增 `native/android/app/src/main/java/com/xiaoxiong/assistant/wake/PcmUploader.java`：单例 OkHttp WebSocket，从 `context.getNoBackupFilesDir()/.gateway_port` 读动态端口，连 `ws://127.0.0.1:<port>/ws?deviceId=<id>&role=pcm`，失败静默 + 限频(1s)自动重连。`WakeModule.java` 的 `configureDirectUpload(deviceId)`（`@UniJSMethod(uiThread=false)`）由 JS 在 `startPcm` 前调用；采集循环里 `pcmFrameCb` 保留（非播报期正常、降级双保险），**仅 `playRunning` 时**额外 `pcmUploader.upload()`。网关 `voiceController.ts` 开头判 `queryParam(req,'role')==='pcm'` → `createPcmUploadConnection`，这类连接**只喂 `session.handleBinary`、不建 session、不 `bindTransport`**（否则会把事件下发抢到原生连接、JS 收不到 asr.partial/tts.start）。前端 `core/audio/appCapture.ts` 在 try 里调 `instance.configureDirectUpload?.(getDeviceId())`，旧基座无此方法时降级回 weex 回调。
  - **验证铁证**：直连建立 ~27ms（`PcmUploader connected`）；网关收帧速率 = 原生采集速率 31 帧/秒（`TOTAL frames` 每 50 帧约 1.6s），而 `CLIENT frames` 播报期仍 1/2s——证明播报期到网关的帧几乎全来自 role=pcm 直连；播报期 ASR 从乱码变为正确中文（`停一下。`/`小熊小熊。`/`截一下。` FINAL 均 `noise=false foreign=false echo=false`），`DUCK duck=true` 说话时压低播报、说完恢复。
  - **诊断通道 `session.diag`/`CLIENT` 日志、`barge-diag.log`、`TOTAL`/`FRAME`/`DUCK` 埋点是定位工具**，确认修复后可移除。完整根因与验证记录见项目记忆 `project_barge_in_direct_pcm_fix.md`。
  - **播报音量 duck 必须放原生做，别走 weex 下行**（2026-11-16 实锤）：网关 `audio.duck` 事件经 weex 下行回 JS 再调原生 `setPlaybackVolume`，播报期同样被 TTS 冲击丢弃——铁证：网关打 `DUCK duck=true`，但原生音量日志全程只有 `setPlaybackVolume percent=70`、从无 25。而 TTS 音频/tts.start 走同一条 socket 却正常，故不能简单归为"下行 socket 丢失"，是 weex 回调链路本身在播报期不可靠。**修复：原生 `WakeModule` 采集循环本来就有每帧 rms 和 `playRunning`，直接据此压/放 AudioTrack 音量**（`LOCAL-DUCK on/off`：rms>0.02 压到 DUCK_VOLUME、静音 800ms 恢复），零依赖 weex、零延迟，真机 on/off 与人声完全吻合。JS 侧 `audio.duck` 事件仍保留作兜底，但不再依赖它。
  - **音量大小影响识别质量，duck 目标要够低**：用户嫌 0.2 小→正常音量提到 0.7，但 duck 若也跟着抬到 0.25，残余 TTS 回声会盖住用户说话，ASR 把中文「停一下」识别成 `Yeah/Okay/The` 英文碎片并被 `isNoise/isForeignNoise` 过滤 → 网关不 `send asr.partial`。正常音量可大（0.7），但 **duck 目标必须够低（0.05）**——duck 低不是为"声音小"，是为让 ASR 听清中文。判断识别好坏先看 `barge-diag.log` 的 PARTIAL 是 `noise=false` 中文还是 `noise=true` 英文碎片。
  - **⚠️ 播报期文字不显示的最终根因（session.diag trace 铁证，2026-11-16 晚）：weex socket 文本下行回调整体失效**。加 `session.diag.trace` 字段，客户端收到 asr.* 事件就回报 `RECV <type> text=<原文>` 到网关日志。铁证：非播报期（pb=false，`CLIENT frames=63`）RECV 正常到达；**播报期（pb=true，`frames=1`）网关疯狂下发 PARTIAL「停一下」×十几条 + FINAL，客户端一条 RECV 都没有**。即 asr.partial/queued/final 在播报期全丢，不是网关没发、不是识别成噪声（duck 压到 0.05 后已是 noise=false 中文）、不是客户端显示逻辑。**根因同上：播报期 JS 线程被海量 TTS PCM 处理（每帧 base64 解码 + AudioTrack 写入走 JS）占满，weex 所有回调排不上队**。`asr.queued` 显示 `event.text` 的兜底无效——因为 queued 同样丢。排查「事件到没到客户端」用 trace，别猜显示逻辑。
  - **已实施的治本方案：TTS 音频走 role=pcm 原生直连，不经 JS**（2026-11-17，已 commit 在 HEAD）。对称于上行 PCM 直连：网关 `voiceController.ts` 维护 `pcmConnections: Map<deviceId, ws>`，`sendAudio` 优先走原生直连；原生 `PcmUploader` 加 `onMessage(ByteString)` 收 TTS 帧 → `TtsFrameListener` → `WakeModule.playPcmBytes()` 直接写 AudioTrack（不经 JS base64）。**播报期 JS 线程空载 → weex socket 回调恢复 → asr.partial 文字能实时显示（真机验证）**。这条是有效的核心修复，务必保留。
  - **⚠️ 曾基于误判加了一大堆补丁，已全部回退（别再加回来）**：为治「播报没播完就显示本轮完成/队列卡死」，我曾错误归因并加了 `tts.idle` 事件、llm.done 延迟 5000ms、tts.end 兜底 90s、单句 TTS 容错、播空回执经直连、IDLE-DIAG/RECV/FINAL 诊断埋点等——这些**全是误判补丁，已 git checkout 回退**。真凶是上滑手势清后台（见前面 `SystemManagerSwipeUp` 条目），不是这些代码逻辑。诊断这些用的是临时 `session.diag.trace` 通道。
  - **⚠️ role=pcm 原生直连的心跳(ping)会导致断线重连→假播空回执→提前显示「本轮完成」并停播（2026-11-17 铁证，最终真凶）**：`PcmUploader` 的 `OkHttpClient.pingInterval(10s)` 在网关没及时回 pong 时触发 `onFailure` → 每 ~10 秒断线重连一次（logcat：`PcmUploader failure: sent ping but didn't receive pong` → `connecting/connected`）。重连瞬间 TTS 音频帧发不到原生 → AudioTrack 无新数据 → head 追上 written → 误判播空 → `sendText(session.playback_done)` → 网关下发 `tts.idle` → 客户端提前 phase='done' 并停播，而实际声音还想继续播。**修复：本地 127.0.0.1 连接不需要心跳，`PcmUploader` 的 OkHttpClient 不设 `pingInterval`**。真机验证：去掉 ping 后长播报连续播 125 秒无 `tts.idle`/无 PHASE-DONE/无 stopPlayback，不再提前完成。排查此类问题先看 `grep PcmUploader` 有没有周期性 failure/connecting。
- **AudioTrack 并发锁（真实修复，保留）**：TTS 走原生直连后 `playPcmBytes` 跑在 OkHttp 线程，与 idle polling / stop 线程并发访问 AudioTrack（非线程安全）导致 native abort（signal 6 / Runtime aborting）。修复：给 `WakeModule` 的 create/play/write/stop/release/setVolume/getPlaybackHeadPosition 全部加同一把 `playLock`（synchronized 可重入，startPlayback 内调 stopPlaybackInternal/applyPlaybackVolume 不会死锁）。压缩备份在 `/tmp/backup-worktree.patch`（含被回退的误判补丁，仅供追溯，勿应用）。
  - **⚠️ 本机 9529 语音服务会卡死（CPU 158% 空转）**：表现为 ASR 返回「（ASR 服务暂不可用）」+ 一堆英文碎片（Yeah/The/Okay），但 `/api/health` 仍探测 reachable（TCP 通不代表识别可用）。重启：`kill -9 <pid>` 后用 venv 启动 `~/.app-product/voice/venv/bin/python model-proxy/voice/openai_voice_server.py`（**系统 python 缺 websockets/fastapi，必须用 venv**）。重启 adb server/重装包后，App 可能连不上网关：force-stop 再启动 App 重连；设备重启后 `adb reverse tcp:9529 tcp:9529` 要重建。
  - **本设备 ADB 静默安装不稳**：`adb install`/install 脚本常报 `INSTALL_FAILED_ABORTED: User rejected permissions` 或 `DELETE_FAILED_INTERNAL_ERROR`（非屏幕弹窗，是设备包管理器僵死）。可靠做法：`adb push apk /data/local/tmp/new.apk` + `adb shell pm install -r /data/local/tmp/new.apk`（Success），再手动 `pm grant RECORD_AUDIO` + `cmd deviceidle whitelist +pkg` + force-stop/启动。若 pm install 也卡，先 `adb kill-server && adb start-server`。
  - **构建卡死处理**：`build.sh` 被中断（Ctrl-C / turn abort）后，gradle daemon 可能仍在 170% CPU 空转且子构建已被杀、`apk/debug/` 被 `:app:clean` 清空但无新产物。此时 `ps aux | grep gradle` 找到该 daemon 直接 `kill`，别以为还在正常打包；设备上仍是上一版 APK，源码改动未进任何包，需重新完整打包。
- **真机诊断工具的三个坑（曾导致误判，别再踩）**：① **grep app-service.js 必须加 `-a`**——它被识别成二进制，普通 `grep` 返回空会让你误判「设备跑旧代码」，实际用 MD5 比对 APK 才是最可靠的「新代码有没有进设备」判据；② **macOS 没有 GNU `timeout`**，`timeout 40 adb logcat ...` 会瞬间失败且 stderr 被吞，看似"没抓到日志"，用 `perl -e 'alarm 40; exec "adb logcat ..."'` 代替；③ **逻辑层高频回调里 `uni.setStorageSync` 埋点不落盘**（全盘搜不到写出的 key），不能据此断定函数没执行——验证 JS 是否执行要用能从外部读到的通道（logcat、网关落盘日志），别用 storage。
- **每次打包网关必须一起打**：网关是 App 同包内嵌组件，出 iOS / Android 包时网关 bundle 必须同步 `npm run build:bundle` 并打入，绝不留旧 / 缺网关；`package-*-offline.mjs` 已自动先构建再拷，不要改成"只拷不构建"。
- **打包必须全量重编译（原则，已固化进 build.sh / build.bat，iOS / Android 都覆盖）**：每次出包必须先清 `uni_app/dist/build/app` + `node_modules/.vite` 与 `gateway/dist` 再编译——uni/vite 有缓存，曾产出「时间戳新、内容旧」的前端产物（设备 grep 关键新代码全为 0 实锤），设备跑旧代码导致所有修复"看起来都没生效"。已在 build.sh 的 [1/3][2/3] 前加清理步骤，**不要删掉**；iOS 原生侧同样跟进：package-ios-offline.mjs 构建 framework 前清 `native/ios/app/.build`，build.sh iOS 分支出包后清壳工程 `build/` 并 `xcodebuild clean`（或 `-showBuildSettings` 找到的 DerivedData）。Android 装机后用 `run-as … grep -c <新代码字符串> …/www/app-service.js` 验证新代码真的进了设备；iOS 出包后可对 `.app` 产物里的 `www/app-service.js` 做同样 grep。注意 `src/static` 会被整目录拷进包：edge-tts 提示音生成用的 Python venv 已挪出 static、放在 `xiaoxiong-app/audio-tool/`（20MB，原先叫 `static/audio/etts-venv`），不在 static 内自然不会被拷入；下列三层排除规则仍保留作兜底、规则等价——①`package-*-offline.mjs` 的 copyDir：`cpSync + verbatimSymlinks + 名字 filter`（软链**原样拷、不解引用**：statSync 跟随软链曾实测把 venv 内容整个拷入；解引用又会破坏框架包 `Versions/Headers` 结构性软链）；②build.sh [1/3] 的 `find`（`*-venv` + `*_venv` + `.venv` + `__pycache__`，与 copyDir 逐字等价，曾漏 `*_venv`）；③产物实测（iOS `.app`/IPA、Android APK 均 0 残留）。不要往 static 放任何非资源文件；改排除规则时三层同步改。iOS 增量构建还有两个「删了却残留」的坑：①「文件夹引用」（Pandora/）增量拷贝不会从产物删除已移除的文件，只 `xcodebuild clean` 不够，必须连 DerivedData 一起删；②`reprovision.sh` 重打 IPA 的 `zip -qry` 是追加模式，必须先删旧 IPA（曾缝出 1431 个 venv 条目的混合档）——两处都已固化，不要改回去。
- **Android 出包链**：`npm run build:app` → `node scripts/package-android-offline.mjs --appid __UNI__145C29C`（自动重建并放置网关 bundle）→ SDK 壳目录 `./gradlew :app:clean :app:assembleDebug` → `node scripts/install-android-offline.mjs` 干净安装（先卸载再装以强制刷新 www，别用裸 `adb install -r`）。改完前端必须 force-stop 再启动，否则可能跑旧包。
- **干净安装必须补回运行时权限**：`adb uninstall` 重装会清掉麦克风等所有运行时权限，而 ADB 静默安装不弹授权框——结果就是「显示待唤醒但喊小熊小熊没反应 / 对话采不到音」。`install-android-offline.mjs` 已在安装后 `pm grant RECORD_AUDIO`（连同 Doze 白名单一起补）；改动安装流程时别漏掉这步，排查唤醒失效也先查 `dumpsys package <pkg> | grep RECORD_AUDIO` 的 granted 状态。
- **唤醒架构是网关 ASR，不是本地 KWS**：前端采集 PCM 上行、网关 ASR 识别成文本后前端 `matchWakeWord` 匹配「小熊小熊」；所以唤醒前提是 `canWake() = 网关可用 + ASR reachable`，且麦克风权限已授予。`core/wake/wakeService.ts` 的原生 KWS provider 目前未接入主流程，别误以为唤醒靠它。
- **`fix-speech-noise-interrupt-playback` change 已归档完成（2026-11-17）**：验收 5/5 通过（A1 英文虚词碎片 / A2 插话排队+小熊小熊跳过 / A3 队列不卡死 / A4 播放失败如实提示 / A5 竖屏播放条），Run status=completed。本轮独立复核：gateway 513 tests、frontend 197 tests 全绿，前端 type-check 0 错误；A4/A5 因设备物理掉线未做本轮真机复验，按代码层+历史真机记录判定。**没解决、另开的是播报期 ASR 识别准确率**（普通插话偶有 The/Yeah/Okay 碎片；「小熊小熊」播报期被识别成「有有」致打断不灵）——不要把它算进这个已归档 change。
  - **下一步方向：9529 已支持流式 ASR**（`WS /voice/ws/inference`，实时 ASR/TTS 统一入口），用来替换整句 HTTP ASR，目标是改善播报期 partial 的实时性与准确性。注意 9529 端口是 **9529**（不是 9527）。启动新 change 处理识别准确率前，先按上面那条清理/定稿工作区未提交的 AEC 诊断残留。
- **App 端 `uni.connectSocket` 必须传回调拿同步 SocketTask（唤醒失效根因，血泪）**：DCloud 的 `uni.connectSocket` 被 `promisify` 包装。不传 `success/fail` 时返回的是 Promise，`resolve()` 出来只有 `{errMsg}`、**拿不到 SocketTask**；若此时退回 `uni.onSocketMessage` 全局回调，运行时（`uni-app-plus` 的 `socketStateChange`）**只把消息投递给 `socketTasks[0]`**，且 `sendSocketMessage` 也只发 `socketTasks[0]`——反复建连后归属错乱，网关的 `asr.partial/final` 下行全部丢失，表现就是「PCM 在采、网关 health 正常、但喊小熊小熊永远唤不醒」。解法（见 `core/transport/webSocketTransport.ts` 的 `createSocket`）：`connect({ url, success: () => {}, fail: () => {} })`，让 promisify 走 `hasCallback` 分支**同步返回真正的 SocketTask**，用 `likeFromTask` 注册每条连接自己的 `onOpen/onMessage/onClose/onError` 局部回调。别再走全局回调或靠返回值 Promise。排查法：`/api/sessions` 看是否一个 deviceId 建了多条 active session（重复建连特征）；页面可见打点看是否出现 `task.onMessage`（通）还是只有 `GLOBAL onSocketOpen`（错）。
- **App 逻辑层无 `new URLSearchParams`**：设置页四个下拉曾全空/disabled，真因是 App 独立 JS 引擎里 `new URLSearchParams(...)` 抛异常，且参数构造在 `try` 外导致静默中断（H5 正常）；改用 `encodeURIComponent` + 字符串拼接并把参数构造放进 `try`。禁止再用"旧代码/缓存"解释——hint 消失即证明新代码已生效，要用 CDP/截图/MD5 自证。
- **设备端 NodeMobile 是 small-ICU，`Intl.DateTimeFormat('zh-CN')` 静默出英文**：网关跑在设备 `:gateway` 进程的 NodeMobile 里，其 ICU 只带英文 locale——`new Intl.DateTimeFormat('zh-CN', {...})` 不会报错，而是**静默 fallback 成英文**（「今天星期几」报出 "November 16, 2026"；本机 Mac Node 是 full-ICU 所以本地验证发现不了，必须真机验证）。历法/本地化格式化（日期、星期、农历等中文表述）**不要依赖 Intl 的中文 locale**：数字用 `en-GB` formatToParts 拿（数字格式无 locale 问题），中文「年月日」自己拼、星期用固定映射表（Sun→星期一…）。农历用 `lunar-javascript` 算法库（权威农历数据，非编造；无官方 @types，`gateway/src/types/lunar-javascript.d.ts` 有最小声明）。
- **时间/日期直连按意图分三态，日期必须报全阳历+星期+农历**：`timeControl.detectTimeCommandKind` 返回 `time | date | both`——问「几点」只报时分；问「星期几 / 几月几号 / 今天是什么日子」必须报「今天是2026年11月16日，星期一，农历十月初八。」；一句里两样都问就都报。曾因问星期几只报时分被用户纠正「给我报个具体时间不对吧」「几月几号也是」「日子要包括农历阳历」。**历法表述固定中文、不随语言英化**（用户明确「不要出英文的几月几日」，英文语言下也直接引用中文日期串）。
- **择吉日/黄历直连（推荐好日子/吉日）**：`auspiciousControl.detectAuspiciousQuery` 识别「推荐个搬家吉日 / 黄道吉日 / 好日子」→ `runAuspiciousCommand` 用 lunar-javascript 内置的**权威黄历宜忌数据**（`getDayYi/getDayJi`，非编造）扫未来 30 天，报前 3 个吉日（阳历+星期+农历，固定中文，与日期直连同口径）；带事项（结婚/搬家/开业…映射到黄历标准宜词）按宜匹配，没说事项推荐宜较多的日子。识别触发词 `吉日|黄道吉日|良辰|好日子|黄历|宜忌|择日`，必须排在时间直连之前；「今天是什么日子」是问日期、不命中择日。曾用外部黄历 API 方案被搁置——库内置数据即可，无需联网。
- **自定义 `UniModule` 必须代码注册**：`uni.requireNativePlugin('app-product-wake')` 查的是 `WXSDKEngine.registerModule` 表，`dcloud_properties.xml` 的 `<feature>` 是老式 `plus.bridge.exec` 机制、对 `UniModule`/`@UniJSMethod` 无效。必须在 `App.java` main 进程 `onCreate` 调 `UniSDKEngine.registerUniModule("app-product-wake", WakeModule.class, false)`，否则 requireNativePlugin 返回 `undefined`，`isAppCaptureSupported` 访问其方法抛错中断唤醒链。loadPcmModule 要处理 `undefined`（不是只有 null）。
- **DCloud/weex callback 回传 `byte[]` 到前端会变成普通 `number[]`**：`WakeModule` 的 `pcmFrameCb.invokeAndKeepAlive(frame.clone())` 出来的不是 ArrayBuffer 也不是 Uint8Array，而是 `ctor=Array keys=0,1,...`。`appCapture.ts` 的 `toArrayBuffer()` 必须兼容 `Array.isArray(frame)` 逐字节转 Uint8Array，否则每帧被丢弃、网关收不到任何音频。
- **App 端「文字不播报」= TTS 走了 WebAudio，必须改原生 AudioTrack**：App 逻辑层没有 WebAudio，`useAssistant.ts` 若直接用 `core/audio/h5Audio.ts` 的 `playPcm`（AudioContext），网关下发的 TTS PCM 帧到达却静默失败——AI 有文字、没声音。正解：新建 `core/audio/appPlayback.ts`（`appPlayPcm` / `onAppPlaybackIdle` / `stopAppPlayback` / `isAppPlaybackSupported`）走 `app-product-wake` 原生插件的 AudioTrack，`useAssistant.ts` 用 `playTts` / `waitPlaybackIdle` / `stopTts` 门面按能力探测分流（App→原生，H5→WebAudio）。原生 `WakeModule.java` 提供 `startPlayback(int)` / `playPcm(base64字符串)` / `stopPlayback` / `onPlaybackIdle`，24k/mono/16bit MODE_STREAM 顺序写，起线程用 `getPlaybackHeadPosition() >= writtenFrames` 判播空回调。三个坑：

① **（血泪四层坑，最终结论）`playPcm` 必须传标量字符串，绝不能传对象或数组**：DCloud/weex 的 `UniJSMethod` 在这台设备的基座上**只可靠传递标量参数（String/int），JSONObject 对象参数的字段会被整个丢成空对象 `{}`**。演进：裸 `number[]` → fastjson 把 `[` 开头当 JSONObject 解析抛 `com.alibaba.fastjson.JSONException: syntax error, expect {, actual [`；包成 `{data:[...]}` → 原生收到 `arg={}`（数组字段丢）；包成 `{pcm:"base64"}` → 仍是 `arg={}`（连字符串字段也丢）；**正解＝JS 把 PCM 编成 base64 字符串直接作为唯一参数 `mod.playPcm(b64)`，原生 `playPcm(String b64)` + `Base64.decode`**。JS 侧用纯位运算手写 base64（`appPlayback.ts` 的 `toBase64`），不依赖 App 逻辑层未必有的 `btoa/Buffer`。**别照抄 `startPcm(JSONObject)`**——它从没读 options 内容，看起来"能用"只是假象。② `app-product-wake` 是非单例模块（注册第三参 `false`），appPlayback 必须缓存 `requireNativePlugin` 结果，否则每帧投给不同实例、播放不连贯；③ `onAppPlaybackIdle` 必须用 `playbackInFlight` 标志——PCM 短时原生 idle 会早于 `tts.end` 到达，注册等待者时若已播完要立即兑现，否则网关收不到播完回执、排队句卡死（对齐 h5Audio.onPlaybackIdle 的语义）。
   - **症状**：AI 有文字、没声音、界面卡「正在播报…」。根因是 `playPcm` 每帧静默 return → 从不 `startPlayback` → 原生 idle 不回调 → `tts.end` 等待挂起。
   - **真机验证（缺一不可）**：`adb logcat | grep WakeModule` 应依次见 `playPcm first frame: b64len=... bytes=...` → `startPlayback called` → `AudioTrack started` → `idle polling started`；CDP 读首页 innerText 应回到「我在听 / 已完成」而非「正在播报…」。若只有 `onPlaybackIdle registered` 而无 `startPlayback`，就是参数没过桥。
- **App 端「我在 / 还在吗 提示音暂停音乐」= InnerAudioContext 抢音频焦点（不是网关 media.pause，也不是 AEC 回声）**：真机复现 logcat 铁证——`MediaFocusControl: abandonAudioFocus() ... io.dcloud.feature.audio.AudioPlayer$1`（音乐 InnerAudioContext 失焦被系统 pause）+ `requestAudioFocus ... AudioPlayer$1 req=1(AUDIOFOCUS_GAIN)`（提示音 InnerAudioContext 抢焦点）。`core/audio/promptPlayer.ts` 的 `playOneCue` 用 `uni.createInnerAudioContext()` 播提示音，App 端该 API 底层（`io.dcloud.feature.audio.AudioPlayer`）会 `requestAudioFocus(GAIN)`，抢走音乐的焦点 → 音乐被系统 pause 且**不自动恢复**。排除项：网关 wake 模式不下发 `media.pause`；提示音期间上行被 `isPromptCuePlaying()` 清零、ASR 识别不到提示音；客户端 `pauseMusic()` 只有 UI 按钮和 `media.pause` 两个调用点。TTS 播报之所以只 duck 不打断，是因它走原生 AudioTrack（`appPlayback.ts`）、**不申请音频焦点**。**已修复（2026-11-15 真机验证通过）**：对标 H5，提示音改走**不申请音频焦点**的原生 MediaPlayer——`WakeModule.java` 新增 `playCue(String file)` / `onCueEnd(cb)` / `stopCue()`，裸 MediaPlayer 从 apk assets（`apps/__UNI__145C29C/www/static/audio/`，mp3 是 Stored 未压缩可用 openFd）播放、不调 requestAudioFocus；JS 新建 `core/audio/appCue.ts` 门面，`promptPlayer.playAppCue` 优先走它、提示音期间 `duckMusic(true)` / onCueEnd 或超时恢复，失败/旧基座降级回 InnerAudioContext。验证：提示音全走原生（`cue started/still-there.mp3`+`cue completed`），`abandonAudioFocus` 从每次提示音必现降为 **0**，仅音乐自身起播有 1 次正常 `requestAudioFocus`；用户确认音乐持续播放不再被打断。**别靠「结束时 resume」糊弄**（有可感停顿），也别在网关抑制 media.pause（治标且误伤）。
- **App 端「播放的音乐被识别 / 点歌误触发」= 采集无 AEC 的回声**：App 采集原来用 `AudioSource.VOICE_RECOGNITION` 无 AEC，扬声器外放的音乐/本地提示音（greeting「我在」/stillThere「还在吗」）/TTS 被麦克风收回，ASR 识别成「暂停/播放/播放一首周杰伦的ys」等指令 → 误操作。H5 靠 `getUserMedia({echoCancellation:true})` 抵消，App 必须靠原生 AEC：`WakeModule.java` 采集源改 `VOICE_COMMUNICATION` + `AcousticEchoCanceler.create(audioSessionId).setEnabled(true)`（带 `isAvailable()` 降级、stopCapture 时 release）。真机验证法：logcat `grep WakeModule` 应见 `WakeModule: AcousticEchoCanceler enabled`。**不要粗暴全程静音麦克风，也不要在网关加文本规则拦幻觉/歌词回声**——用户要求对标 H5 的 ducking（助手说话时音乐变小、说完恢复），纯文本无法可靠区分回声与正常点歌、易误伤，从采集源用 AEC 治理。
- **App 端「播报时插话难、播放音乐时插话顺」= TTS AudioTrack 满音量外放**：音乐走 InnerAudioContext 默认音量 0.5（TTS 播报时再被 `duckMusic` 压到 0.2 倍），插话很顺；TTS 走原生 `WakeModule.java` 的 AudioTrack 用 `STREAM_MUSIC` 满音量 1.0 外放，回声强 → 采集端 AEC 双讲抑制时把用户插话一起压掉、ASR 识别困难，体感「播报时插话很难」。**降播报音量治本**：`WakeModule.java` 的 `startPlayback` 里 `playTrack.setVolume(PLAYBACK_VOLUME)`（本项目 SDK 的 AudioTrack 只有单参数 `setVolume(float)`，mono 正好适用；双参数版本会编译失败），`PLAYBACK_VOLUME = 0.2f`（音乐 duck 后是 0.5×0.2=0.1；0.5 真机诊断仍有回声混进采集致 ASR 出乱码，降到 0.2 才够低；再低听不清）。这比调 VAD 门槛更对症——用户真机 A/B 对比明确「播放音乐插话很顺」。注意只压 TTS AudioTrack（`STREAM_MUSIC`），本地提示音 cuePlayer 保持 1.0（短、播时上行清零，不干扰插话）。真机验证：logcat `AudioTrack started: ... volume=0.2` 确认生效。**⚠️ 此条已被后续真机诊断推翻——降音量、关 AEC 后采集端确实有人声（rms 0.13），但网关播报期仍只收到 0.2 帧/秒；真根因见下面「播报插话 15 轮未解决」条。音量 0.2 的改动本身无害、保留，但它不是插话识别不到的解药。**
- **B站音轨：dash 纯音轨 + 网关转封装 ADTS，短链下发（非歌曲宝音频没声音的完整解法）**：`bilibiliAudio.ts` 用 `fnval=16&qn=16` 拿 dash 纯音轨（`.m4s`，无 moov 头的 fMP4 片段）；设备 NuPlayer 的 MPEG4Extractor 对 dash brand 嗅探失败（`cannot create extractor` → `MEDIA_ERROR(100)`，DCloud AudioPlayer 还不回调 `onError`）→ 无声。所以 `/music/stream` 对 `.m4s` 走 `serveDashAudioAsAdts`：全量拉取 → `fmp4BufferToAdts` 转成 ADTS 裸 AAC 落盘缓存 → 按客户端 Range 切片响应。`media.play` / `nextMusic` 只下发短链 `/music/s/<md5前16hex>.aac`（完整代理 URL ~1000 字符会被 DCloud 下载器截断在 936 字节）。
  - **`esds` 里 DecoderSpecificInfo 的两种长度写法都要认**：`05 80 80 80 <len>`（扩展长度）和 `05 <len>`（单字节，如真实评书音轨的 `05 02 12 10`）。只认前者会让 `parseAscFromMoov` 返回 null → 整轨转封装输出 **0 字节**，表现为「评书没声音」，且 Mac 上同样复现（不是 NodeMobile 差异）。解析时必须扫描整个 esds box 并排除 `aot===0` 的误命中。
  - wbi 签名参数全集要按字母序参与（bvid,cid,fnval,high_quality,platform,qn,wts），少一个或乱序报 -403。防盗链不变：仍需 Referer，走网关 `/music/stream` 代理。
- **悬浮播放器「偏高」**：`FloatLayer` 顶部锚点原本固定 `FLOAT_INSET=16px`，没让出状态栏，悬浮球顶进状态栏。已加 `topInset` prop，顶部锚点用 `calc(16px + topInset)`；首页 `<FloatLayer id="music-disc">` 传 `:top-inset="isLandscape ? 8 : screen.statusBarHeight"`（横屏不留状态栏余量传 8）。验证法：CDP 读首页 `.page` 的 `padding-top`（=statusBarHeight+2），确认逻辑层 statusBarHeight 有值即可。
- **DCloud**：应用"小熊助手"，AppID `__UNI__145C29C` 已填 manifest；构建前确认账号邮箱已验证 + AppKey 已写入，否则 HBuilderX 登录 / 离线打包会被拦。
- **逻辑层无 `document`**：App 端 `app-service.js` 没有 `document`，直接改 `document.documentElement.style` 是空操作；换主题必须靠 Vue `:style` 响应式绑定把 CSS 变量落到视图层 `.page` 上。
- **真机 CDP 调试**：`adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>`（重开 App 后 PID 会变要重做），`curl http://127.0.0.1:9222/json/list` 拿 `webSocketDebuggerUrl`，用 CDP `Runtime.evaluate({returnByValue:true})` 读 DOM / innerText；必要时在页面放可见 debug 打点区分"没调用"与"调用后抛错"，定位后删除。
- **真机语音全靠 USB 反代（`adb reverse`），掉了一键检测/唤醒就全红**：App 内嵌网关在设备 `:gateway` 进程里跑，它访问的 ASR/LLM/TTS 是本机 `127.0.0.1:9529`（Mac 上的语音代理），**不是设备自己的服务**——两者靠 `adb reverse tcp:9529 tcp:9529` 经 USB 桥接打通。真机要能唤醒 / 对话 / 一键检测变绿，必须先建这条反代。
  - **USB 反代会掉**：重插线、重启设备/adb、重新装机后 `adb reverse` 会失效。表现就是「一键检测全红：大模型/语音识别/语音合成都报 `127.0.0.1:9529` 不可达，只有外网绿」、或「喊小熊小熊唤不醒」。**排查第一步永远是 `adb reverse --list`，空了就 `adb reverse tcp:9529 tcp:9529` 重建**，再用 `adb shell 'curl http://127.0.0.1:9529/'` 确认设备侧能拿到 `{"service":...}` 200。别急着改检测逻辑/网关代码——那不是 bug。
  - 反代是 host→device 的反向端口转发，与 CDP 用的 `adb forward`（device→host，如 `tcp:9222`）方向相反，两个不冲突、按需各自建。
  - 一键检测有 15s 探测缓存（`probeCache` TTL）：重建反代后马上再点，ASR/TTS 可能仍显示旧的红色缓存结果，等 >15s 再点才刷新为绿。
  - **拔线后「界面还红」不等于链路没恢复**：设置页「一键检测」是 `fetchHealthReport` 一次性结果，界面**不会自动刷新**（30s 轮询只喂首页健康胶囊且依赖 WS 连上），拔线瞬间算出的「127.0.0.1:9529 不可达」红字会一直滞留，即使反代已重建。判断链路真通不通用 `adb shell 'curl -s "http://127.0.0.1:8787/api/health?deep=1" -H "x-voice-config: {...}"'`（模拟一键检测，全绿即已恢复），再在真机上**重新点一次「一键检测」**把界面刷成绿即可，不要去改检测逻辑。拔线还会让 App 主进程重启（PID 变）、CDP 的 `adb forward tcp:9222` 失效，要重新 `pidof` 取 PID 再 forward，别复用旧 PID。
  - 9529 真实语音接口带前缀：ASR/TTS 是 `/voice/v1/audio/{transcriptions,speech}`，LLM 是 `/llm/v1/chat/completions`；网关 `resolveCapabilityConfig` 已把 baseUrl 收敛成 `${root}/voice` 和 `${root}/llm/v1`，探测/调用都别自己再拼错前缀。
  - 联调地址 / 模型名从配置读，不要写死；探测设备网关用 `adb forward`。
- **设备访问本机服务连不通**：先排查 macOS 防火墙丢弃 LAN 入站（localhost 200 但 LAN IP 000），以及 WiFi AP 隔离（ping 不通但能上外网，用 adb reverse 或关 AP 隔离）。
- **设备要上网就用 `scripts/usb-net.sh`（USB 联网 / reverse tethering），别靠热点或改 WiFi**：本机起 HTTP 代理（默认 `127.0.0.1:8899`，`--port` 可换）→ `adb reverse tcp:8899` → 写设备全局 `http_proxy`，设备上遵守系统代理的 App（浏览器 / WebView / OkHttp 等）经 USB 走电脑网络。`up` 默认对**所有 USB 在线设备**逐台建链（模拟器 / WiFi adb 不算），`--serial A,B` 只处理指定台；`down` 逐台清代理并停本机代理；`status` 看每台状态。日志 `xiaoxiong-app/logs/usb-net.log`，pid `logs/.usb-net.pid`。
  - **只覆盖读系统代理的 App**：不读代理的原生 socket、以及设备内嵌网关（Node 直连）不走这里——网关访问本机 9529 仍靠 `adb reverse tcp:9529`，它自己发出的外网请求（B站/百度等）仍要设备自身有网；要让网关也走电脑网络得用 gnirehtet 这类 VPN 全量隧道方案。
  - **与 9529 反代互不影响**（端口不同，`down` 只删自己那条 8899）；拔线 / 重启 adb 后 reverse 会掉，重插后重跑 `up`（幂等）。
  - 自检：脚本会用设备 `curl -x http://127.0.0.1:8899` 打 `http(s)://www.baidu.com`；也可看日志里出现设备系统请求（如 `CONNECT metrics1.data.hicloud.com:6447`）证明全局代理真生效。联调结束跑 `down`，别把全局代理留在设备上。
  - **（血泪坑，2026-11-16）系统代理残留会杀死 App 的全部原生网络，而 curl 测不出来**：只 `settings delete global http_proxy` 不够——部分 ROM 会把 `global_http_proxy_host` / `global_http_proxy_port` 残留在系统设置里（值仍指向已退出的 127.0.0.1:8899）。**App 的原生网络栈（OkHttp：`uni.request` / `uni.connectSocket`）会读系统代理** → 所有请求被导向死代理 → 表现「无法连接网关」「保存配置失败」「WS 永远连不上」，而 **curl / adb shell 不读系统代理，所以怎么 curl 网关都是 200，极易误判成网关坏了**。排查任何「App 连不上本机网关」问题，**第一步先查** `settings get global global_http_proxy_host`（以及 port/http_proxy），有残留就置 `null` 或重启设备；别先怀疑网关/代码。`usb-net.mjs` 的 `down` 已修为同时清 host/port/exclusion_list/pac 并回读校验，`up` 对称写 host/port，**不要改回只清 http_proxy**。
  - **（2026-11-16 实锤）usb-net 的全局代理与「App 连内嵌网关」互斥，`exclusion_list` 对 OkHttp 不生效**：`up` 会写 `http_proxy=127.0.0.1:8899`，App 请求 `127.0.0.1:8787`（同包内嵌网关）也被导向本机代理 → 代理去连「电脑的」8787（没服务）→ 报 `Failed to connect to /127.0.0.1:8899`、界面显示「网关没启动 / 配置仅存到本机」。**实测写 `global_http_proxy_exclusion_list="localhost,127.0.0.1,::1"` 也拦不住 OkHttp**。所以：设备有 WiFi 外网时**不要开 usb-net**（网关自己拉 B 站/百度走设备网络，本就不读系统代理，usb-net 对它毫无帮助）；只有「设备完全没网、且只用浏览器类 App」时才用。清代理后必须**重启 App 进程**；若 App 仍读到旧 8899，说明系统代理缓存没刷新，此时才需要 `adb reboot`（清完 `http_proxy` / `global_http_proxy_host` / `global_http_proxy_port` 三项后再重启 App 通常就够）。
- **iOS 原生工厂已工程化（framework + 自动集成，无手动 Xcode 步骤）**：对齐 Android 的「原生工厂 + SDK 壳」分工——`native/ios/app/XiaoxiongGateway.xcodeproj` 是我们的 framework 工程（`GatewayNode.swift` 跑网关 + `GatewayLauncher.swift` 暴露 `@objc startEmbeddedGateway`），**源码 `.swift` 收在 `.xcodeproj` 包内部**（约定：工程的一部分收进工程包，目录里不留零散文件），独立可编译验证（见 `native/ios/app/README.md`）；壳工程集成由 `package-ios-offline.mjs` 自动完成：构建 framework（注意 `-derivedDataPath` 必须空格分隔传两个参数，带 `=` 会被 xcodebuild 静默忽略）→ 拷到壳 `Frameworks/` → `scripts/ios-integrate.rb`（xcodeproj gem，幂等）注入 link + Embed(CodeSignOnCopy)、`FRAMEWORK_SEARCH_PATHS += $(PROJECT_DIR)/Frameworks`（缺了报 `XiaoxiongGateway-Swift.h not found`）、NodeMobile/gateway 资源兜底、清理旧式手动注入的 Swift 文件、patch `AppDelegate.m` 调 `[GatewayLauncher startEmbeddedGateway]`。**不要**再手动拖 Swift 文件进壳工程；`AppDelegate+Gateway.swift` 已删除（Swift extension 编译期必须看到宿主类，无法进 framework，入口一律走 GatewayLauncher）。
- **iOS SDK 壳目录两平台统一为 `HBuilder-SDK`**：`native/{android,ios}/sdk/HBuilder-SDK/`（gitignore，不入库）；iOS 侧官方下载还带**壳旁边的 `SDK/` 引擎目录**（inc/Libs/Bundles）与 `uniapp.podspec`（与 sdk/README 同级，Podfile 的 `pod 'uniapp', :path => '..'` 指向它）——podspec 写死 `SDK/...` 相对路径、Pods 头文件是相对符号链接指到 `SDK/inc/...`，缺了或改名 954 个头悬空、编译直接失败，三者都要放进 `native/ios/sdk/`。**换 SDK 壳/迁移位置后必须重跑 `pod install`**（Pods 工程存绝对路径）：`cd native/ios/sdk/HBuilder-SDK && PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH" pod install`（本机 pod 在用户级 gem、系统 Ruby 2.6，壳脚本已加 `filter_map` 兼容 shim）。打包脚本的目录遍历对悬空 symlink 容错（`safeStat`），不要改回裸 `statSync`。
- **iOS 打包装机链**：`uni_app` 的 `npm run build:app` → `node scripts/package-ios-offline.mjs --sdk native/ios/sdk/HBuilder-SDK --appid __UNI__145C29C --appkey <build.local> --node-ios <build.local 的 NODE_IOS>` → `native/ios/reprovision.sh`（逐台 xcodebuild 注册 UDID + 刷新 7 天 profile + ios-deploy 装机）。设备不可见（USB 在线但 devicectl/ios-deploy 枚举不到）先查 iOS 16+ 开发者模式与「信任此电脑」。
- **iOS 离线包**：`control.xml` 的 appid 别用示例值、Pandora 要进包、网关动态端口要与前端端口一致，否则白屏；Xcode 26.3 配 26.2 SDK 致 ibtool 报 Platform Not Installed，用 `UILaunchScreen` 绕过。
- **iOS 重签脚本容错**：`reprovision.sh` 里设备离线静默忽略、"待信任开发者 / 待开开发者模式"都算正常，汇总三态后 `exit 0` 不报错；只看 `Installed package` 是假成功。bash 里 `$var` 后紧跟全角标点要用 `${var}` 花括号（曾致 set -u 误报 unbound variable）。
- **悬浮层通用架构**：`core/adaptation/floatLayer` + 通用 `FloatLayer` 容器（slot + 统一 z-index），播放器只是第一个使用方，新悬浮内容复用它。
- **协作提醒**：跨轮次可能丢失刚回答的内容，关键决定写入记忆或显式复述确认后再继续。

## 当前阶段与路线

1. 基础：唤醒、会话状态机、本地招呼、配置页（**当前**）。
2. 设备控制：BLE / Wi-Fi 设备发现、配对、语音命令。
3. 设备数据：采集后写 SQLite；付费用户后续同步云端。
4. 登录 + 计费：平台托管模式，付费用户免配置 ASR / LLM / TTS。
5. 设备商城：App 内购买设备，形成「语音 → 设备 → 硬件收入」闭环。

设备控制的架构预留见设计文档第 15 节；不要提前实现设备协议，等真实设备与协议确定。

## 不要做的事

- 不要把 AgentScope 装进客户端：它只能在 Node 网关运行。
- 不要在前端直接调用第三方服务（ASR / LLM / TTS / 数据库等）；客户端只与 Node 网关通信。
- 不要把数据库写逻辑放进客户端；SQLite 只在 Node 网关落地。
- 不要为 H5（仅开发阶段）补复杂降级逻辑，更不要为已确定不支持的小程序 / 鸿蒙写任何分支，除非明确要求。
- 不要引入第二套状态管理或第二个 UI 框架。
- 不要提交密钥、真实用户数据、设备数据。
- 不要在没有验证的情况下修改 `contracts/` 并声称兼容。
