# audio-tool（提示音生成工具）

一个独立的 Python 虚拟环境，只用于在**开发时重新生成 App 的本地提示音 mp3**。它不是 App 的运行时依赖——提示音一旦生成好，就作为现成文件打包进 APK，离线可播，平时完全用不到本目录。

## 基本信息

| 项 | 值 |
| --- | --- |
| Python | 3.13.3 |
| 核心包 | `edge-tts` 7.3.1（附带 `edge-playback`） |
| 大小 | 约 20 MB |
| 位置 | `xiaoxiong-app/audio-tool/` |

原目录名是 `uni_app/src/static/audio/etts-venv`。因为 `static/` 会被打包脚本整目录拷进 APK，这个 20 MB 的开发工具不该随包发布，已挪到 `xiaoxiong-app/` 根目录并改名 `audio-tool`（venv 用相对路径，挪位置后仍可正常使用）。

## 为什么放在这里

- App 有一批**断网也要能播**的提示音（唤醒招呼、故障提示等），是打包内的固定 mp3，不走在线 TTS。
- 这些 mp3 用 edge-tts 生成。生成工具（本 venv）只在重做提示音时才需要，运行和打包都用不到。
- 放在 `static/` 里会被 `uni build` 扫描、并有三层打包规则反复排除它，纯属噪音。移到 `static/` 之外后，打包链无需再为它做排除。

## 怎么生成提示音

下面的命令都在 **`xiaoxiong-app/` 目录下执行**。单条示例：

```bash
audio-tool/bin/python -c "import asyncio,edge_tts; asyncio.run(edge_tts.Communicate('我在','zh-CN-XiaoxiaoNeural').save('uni_app/src/static/audio/greeting.mp3'))"
```

把 `我在` 换成文案、`greeting.mp3` 换成目标文件名即可重做其它提示音。音色固定用 `zh-CN-XiaoxiaoNeural`，与网关 `edge` 厂商的默认音色一致。

需要一次重做全部时，用这段脚本（文案与 `uni_app/src/static/audio/README.md` 保持一致）：

```python
# 在 xiaoxiong-app/ 下保存为临时 .py 后用 audio-tool/bin/python 执行
import asyncio
import edge_tts

CUES = {
    "greeting.mp3":     "我在",
    "still-there.mp3":  "还在吗？",
    "farewell.mp3":     "那我先退下了，需要时再叫我。",
    "network-down.mp3": "无法连上网络，请检查网络后重试",
    "gateway-down.mp3": "无法连上网关，请检查网关后重试",
    "asr-down.mp3":     "语音识别没连好，我暂时听不见你说话",
    "tts-down.mp3":     "语音播报没接好，我没法念出来",
    "llm-down.mp3":     "大模型没接好，我暂时没法回答",
    "mic-denied.mp3":   "麦克风没授权，语音唤醒和对话都用不了，请到设置里开启",
    "asr-error.mp3":    "不好意思，我没听清，你再说一遍好吗",
    "thinking.mp3":     "稍等一下，我还在想哈",
    "queue-full.mp3":   "你说的太多了，我记不住",
}
VOICE = "zh-CN-XiaoxiaoNeural"

async def main():
    for name, text in CUES.items():
        path = f"uni_app/src/static/audio/{name}"
        await edge_tts.Communicate(text, VOICE).save(path)
        print("生成", path)

asyncio.run(main())
```

> 生成需要联网（edge-tts 调微软在线合成）。`192.168.1.100:9529` 当前把默认音色路由到 kokoro 引擎且未加载音色，会报 `unknown kokoro voice`；本地直连 edge-tts 可得到相同音色，待该服务修好引擎路由后自动一致。

## 提示音清单与用途

各提示音的触发时机和状态机语义见 [`../uni_app/src/static/audio/README.md`](../uni_app/src/static/audio/README.md)，本目录只负责「把文字变成 mp3」。

## 维护说明

- **不要删除本目录**：重做提示音需要它。删掉后要重新 `python3 -m venv` 并 `pip install edge-tts`。
- 目录自带的 `.gitignore` 内容是 `*`，默认整个被 git 忽略（避免 20 MB 二进制进仓库）；本 `README.md` 已通过 `!README.md` 例外单独纳入版本管理。
- 修改提示音文案后，记得同步更新 `uni_app/src/static/audio/README.md` 和上面的脚本，并重新打包 APK 才能生效。
