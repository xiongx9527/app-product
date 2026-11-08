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

后五个文件同时也复制到了网关侧 `gateway/static/cues/`，由网关经 HTTP（`/static/cues/<name>.mp3`）
下发给客户端播放（见 `contracts/README.md`）。客户端优先从网关拉取，拉取失败才回退到本目录的打包文件。

H5 端使用 WebAudio 生成提示音 + Toast 兜底，不依赖这些文件；
App 端通过 `uni.createInnerAudioContext()` 播放。
文件缺失时只少一声提示，不影响状态机。

重新生成（edge-tts，音色与网关 `edge` 厂商 / `192.168.1.100:9529` 默认一致）：
- 安装：`python3 -m venv etts-venv && etts-venv/bin/pip install edge-tts`
- 生成：`etts-venv/bin/python -c "import asyncio,edge_tts; asyncio.run(edge_tts.Communicate('我在','zh-CN-XiaoxiaoNeural').save('greeting.mp3'))"`
- 其余两个文案同上，替换文字与输出文件名即可。
- 注：`192.168.1.100:9529` 当前把默认音色路由到 kokoro 引擎且未加载音色，会报 `unknown kokoro voice`；本地直连 edge-tts 可得到相同音色，待该服务修好引擎路由后自动一致。
