# 本地提示音

唤醒招呼、退出提示都必须断网可用，因此使用本地音频文件，不走在线 TTS。

放入以下文件（mp3，1 秒左右即可）：

- `greeting.mp3`：唤醒后的第一声招呼，例如“我在”
- `still-there.mp3`：对话静默超时后的提示，例如“还在吗？”
- `farewell.mp3`：无回应后的结束语，例如“那我先退下了，需要时再叫我。”
- `network-down.mp3`：开启助手时若外网不通，提示“无法连上网络，请检查网络后重试”
- `gateway-down.mp3`：网关连接失败时（WS 连不上 / 自动重连耗尽）提示“无法连上网关，请检查网关后重试”。
  与 network-down 区分：网关本身连不上，不可能从网关拉取，因此该文件是**打包内本地文件**、不进网关 `/static/cues/`，
  由 `announceGatewayDown()` 直接播放，断网也能出声。
- `asr-down.mp3`：开启助手时若语音识别未就绪，提示“语音识别没连好，我暂时听不见你说话”
- `tts-down.mp3`：开启助手时若语音合成未就绪，提示“语音播报没接好，我没法念出来”
- `llm-down.mp3`：开启助手时若大模型未就绪，提示“大模型没接好，我暂时没法回答”
- `mic-denied.mp3`：麦克风未授权（或尚未申请）时，提示“麦克风没授权，语音唤醒和对话都用不了，请到设置里开启”。
  只有麦克风这种核心能力才播提示音；定位是非必须能力，只显示状态、绝不播报。

后五个在 `useAssistant` 连上网关后由 `speakCapabilityProblems()` 检查 `/api/health` 与设备权限，
先播麦克风权限，再对未就绪的能力按顺序（ASR → TTS → LLM → 网络）逐条播报，给出听得见的失效反馈。

提示音文件**只在客户端打包内存一份**（本目录），不再复制到网关侧、也不经网关 HTTP 下发——
断网 / 网关异常 / App 离线时照样能播（App 端原生 playCue 从 apk assets 直读）。网关侧旧的
`gateway/static/cues/` 与 `/static/cues/*` 端点已移除（见 `contracts/README.md`）。
`client.cue` 事件只传提示音名，客户端按名播本目录文件。

另外三个运行中瞬时提示：
- `asr-error.mp3`：语音识别失败/超时（网关在 ASR 定稿异常时节流下发 `client.cue('asr-error')`），文案「不好意思，我没听清，你再说一遍好吗」
- `thinking.mp3`：「正在思考」超过 10s 仍未开始播报时由客户端本地播放，安抚用户不是卡死，文案「稍等一下，我还在想哈」
- `queue-full.mp3`：插话队列已满（网关下发 `asr.rejected` / `reason=queue-full` 时客户端播放），文案与网关 `queue.full()` 一致「你说的太多了，我记不住」；与「我说」卡片右上角话术同时给出听得见的反馈

H5 端使用 WebAudio 生成提示音 + Toast 兜底，不依赖这些文件；
App 端通过 `uni.createInnerAudioContext()` 播放。
文件缺失时只少一声提示，不影响状态机。

重新生成（edge-tts，音色与网关 `edge` 厂商 / `192.168.1.100:9529` 默认一致）：
提示音是打包内的现成 mp3，平时无需重新生成；如需重做，edge-tts 工具已挪出 static、
放在仓库的 `xiaoxiong-app/audio-tool/`（Python venv，避免被整目录拷进包）：
- 生成（在 `xiaoxiong-app/` 下执行）：`audio-tool/bin/python -c "import asyncio,edge_tts; asyncio.run(edge_tts.Communicate('我在','zh-CN-XiaoxiaoNeural').save('uni_app/src/static/audio/greeting.mp3'))"`
- 其余两个文案同上，替换文字与输出文件名即可。
- 注：`192.168.1.100:9529` 当前把默认音色路由到 kokoro 引擎且未加载音色，会报 `unknown kokoro voice`；本地直连 edge-tts 可得到相同音色，待该服务修好引擎路由后自动一致。
