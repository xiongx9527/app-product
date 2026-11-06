# 本地提示音

唤醒招呼、退出提示都必须断网可用，因此使用本地音频文件，不走在线 TTS。

放入以下文件（mp3，1 秒左右即可）：

- `greeting.mp3`：唤醒后的第一声招呼，例如“我在”
- `still-there.mp3`：对话静默超时后的提示，例如“还在吗？”
- `farewell.mp3`：无回应后的结束语，例如“那我先退下了，需要时再叫我。”

H5 端使用 WebAudio 生成提示音 + Toast 兜底，不依赖这些文件；
App 端通过 `uni.createInnerAudioContext()` 播放。
文件缺失时只少一声提示，不影响状态机。

重新生成（edge-tts，音色与网关 `edge` 厂商 / `192.168.1.100:9529` 默认一致）：
- 安装：`python3 -m venv etts-venv && etts-venv/bin/pip install edge-tts`
- 生成：`etts-venv/bin/python -c "import asyncio,edge_tts; asyncio.run(edge_tts.Communicate('我在','zh-CN-XiaoxiaoNeural').save('greeting.mp3'))"`
- 其余两个文案同上，替换文字与输出文件名即可。
- 注：`192.168.1.100:9529` 当前把默认音色路由到 kokoro 引擎且未加载音色，会报 `unknown kokoro voice`；本地直连 edge-tts 可得到相同音色，待该服务修好引擎路由后自动一致。
