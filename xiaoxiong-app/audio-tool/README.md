# audio-tool（提示音生成工具）

一个轻量开发脚本，只用于在**开发时重新生成 App 的本地提示音 mp3**。它不是 App 的运行时依赖——提示音一旦生成好，就作为现成文件打包进 APK，离线可播，平时完全用不到本目录。

## 生成方式

文案 → mp3 统一走 **9529 的 OpenAI 兼容 TTS 接口**（`POST /voice/v1/audio/speech`），不再直接调 edge-tts / 微软在线合成。所以本目录只需要一个 shell 脚本 + curl，**不需要 Python venv**（原 edge-tts venv 已删除）。

| 项 | 值 |
| --- | --- |
| 核心脚本 | `generate-cues.sh` |
| 配置 | `.env`（从 `.env.example` 复制） |
| 接口 | `POST {VOICE_BASE_URL}/v1/audio/speech` |
| 位置 | `xiaoxiong-app/audio-tool/` |

## 配置（.env）

5 个参数，从 `.env.example` 复制一份为 `.env` 后按需修改：

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `TTS_PROVIDER` | 提供商，传给 9529 的 `provider` 字段 | `builtin` |
| `VOICE_BASE_URL` | 9529 服务地址（含 `/voice` 前缀） | `http://127.0.0.1:9529/voice` |
| `TTS_API_KEY` | 9529 开鉴权时的 key，作为 `Authorization: Bearer` 发送；本机未开则留空 | 空 |
| `TTS_MODEL` | 模型，传给 9529 的 `model` 字段（builtin 下 `edge-tts` / `kokoro`） | `edge-tts` |
| `TTS_VOICE` | 音色（与网关 edge 厂商默认一致） | `zh-CN-XiaoxiaoNeural` |

> `.env` 含实际 key，已被 `.gitignore` 忽略、不入库；`.env.example` 入库作模板。

## 怎么生成提示音

在任意目录执行（脚本自定位输出目录）：

```bash
xiaoxiong-app/audio-tool/generate-cues.sh             # 生成全部 16 个
xiaoxiong-app/audio-tool/generate-cues.sh greeting    # 只生成指定（可多个名字）
```

输出目录：`xiaoxiong-app/uni_app/src/static/audio/`。脚本会先探测 9529 健康，再逐条合成；单条失败只报该条、不影响其它。

前提：9529 语音服务已启动（`model-proxy/voice.sh start voice`），且 `TTS_MODEL` / `TTS_VOICE` 组合可用（kokoro 模型需配 kokoro 音色，不能填 XiaoxiaoNeural）。

## 提示音清单与文案

文案定义在 `generate-cues.sh` 的 `CUES` 数组，与 `../uni_app/src/static/audio/README.md` 保持一致。16 个提示音：

| 文件 | 文案 |
| --- | --- |
| greeting.mp3 | 我在 |
| still-there.mp3 | 还在吗？ |
| farewell.mp3 | 那我先退下了，需要时再叫我。 |
| network-down.mp3 | 无法连上网络，请检查网络后重试 |
| gateway-down.mp3 | 无法连上网关，请检查网关后重试 |
| asr-down.mp3 | 语音识别没连好，我暂时听不见你说话 |
| tts-down.mp3 | 语音播报没接好，我没法念出来 |
| llm-down.mp3 | 大模型没接好，我暂时没法回答 |
| mic-denied.mp3 | 麦克风没授权，语音唤醒和对话都用不了，请到设置里开启 |
| asr-error.mp3 | 不好意思，我没听清，你再说一遍好吗 |
| thinking.mp3 | 稍等一下，我还在想哈 |
| queue-full.mp3 | 你说的太多了，我记不住 |
| gateway-preparing.mp3 | 网关启动中，请稍等一下。 |
| gateway-ready.mp3 | 网关已就绪。 |
| llm-error.mp3 | 回答出了问题，请稍后再问我一次。 |
| tts-error.mp3 | 播报出了问题，这一段没能念出来。 |

后四个文案是从原 mp3 经 9529 ASR 转录还原的（原文案未入库），重新生成后已覆盖。

各提示音的触发时机与状态机语义见 [`../uni_app/src/static/audio/README.md`](../uni_app/src/static/audio/README.md)。

## 维护说明

- 修改提示音文案后：同步更新 `generate-cues.sh` 的 `CUES`、`uni_app/src/static/audio/README.md`，重跑脚本，再重新打包 APK 才生效。
- 若提示音时长变化较大，同步校准 `uni_app/src/core/audio/promptPlayer.ts` 的 `CUE_MUTE_MS`（本地提示音外放被麦克风收回期间的静音窗口）。
- `.gitignore` 放行 `README.md` / `generate-cues.sh` / `.env.example`，其余（含 `.env` 和任何 venv 残留）忽略。
