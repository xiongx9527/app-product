# scripts

仓库根目录的开发辅助脚本（与 `xiaoxiong-app` 同级），负责 **macOS / Windows** 上：

- Ollama 的安装与模型下载；
- 本地 AI 服务（LLM 纯转发代理 + STT / TTS）的安装、启动与后台管理，支持本地推理或代理远程 OpenAI 兼容服务，原生 Python 运行，不使用 Docker；
- 本机所有开发服务的统一启停与状态查看（macOS / Linux，见下）。

Linux 也顺带可用（见文末）。

## 统一服务管理（services.sh，macOS / Linux）

按下面各节完成安装后，用 `services.sh` 一条命令启停本机所有开发服务。它是编排层，
不替代安装脚本：`voice` 仍由 `voice.sh` 管理，`gateway` / `uniapp` 仍由
`xiaoxiong-app/scripts/dev-server.mjs` 管理。

> 目前只提供 bash 版（macOS / Linux）。Windows 上仍按下面各节用 `install-*.cmd` /
> `voice.cmd` 和 `node xiaoxiong-app/scripts/dev-server.mjs ...` 分别管理各服务。

服务：

| 名称 | 说明 |
|---|---|
| `ollama` | Ollama 本地模型服务（默认 11434；LLM 以本机 Ollama 为上游时可选） |
| `voice` | 本地 AI 服务，LLM 代理 + STT / TTS（默认 9529） |
| `gateway` | Node 网关（默认 8787，热重载） |
| `uniapp` | uni-app 前端开发服务 |
| `backend` | `ollama` + `voice` + `gateway`（不含前端） |
| `all` | 全部，默认 |

命令：

```bash
./scripts/services.sh                       # 等同 start all
./scripts/services.sh start                 # 启动全部
./scripts/services.sh start voice           # 只启动本地 AI 服务
./scripts/services.sh start ollama voice    # 启动多个指定服务
./scripts/services.sh stop all              # 按相反顺序停止
./scripts/services.sh restart voice         # 重启指定服务
./scripts/services.sh status                # 查看全部服务状态
./scripts/services.sh check                 # 只检查依赖，不启动
./scripts/services.sh log                   # 各服务日志尾部（默认 80 行）
./scripts/services.sh log voice -f          # 持续跟踪单个服务日志
./scripts/services.sh log gateway -n 200    # 查看最近 200 行
./scripts/services.sh --help                # 完整用法
```

`--help` 直接由脚本头部注释生成，改用法只需改注释。

行为说明：

- `status` 是只读查询，「未运行」属正常状态，不会报错或返回失败；`check` 在依赖
  缺失时会明确失败并给出安装命令。
- 启动 / 重启**不会自动安装依赖**；缺什么按提示先执行 `install-ollama.sh` /
  `install-voice.sh`，或到 `gateway` / `uni_app` 目录执行 `npm install`。
- Ollama 若由 Ollama.app 等外部进程启动，`stop` 不会结束它；`OLLAMA_HOST` 指向
  远端时本机不启动 Ollama，只检查连通性。LLM 走远程代理时不需要本机 Ollama，
  可以只 `start voice gateway uniapp`。
- `stop` / `restart` 按与启动相反的顺序逐个执行，某个服务失败不影响其它服务，
  最后统一汇总。

运行目录与环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SERVICES_HOME` | `~/.app-product/services` | 本脚本的 PID / 日志目录 |
| `VOICE_HOME` | `~/.app-product/voice` | 本地 AI 服务运行目录（与 `voice.sh` 共用） |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 地址；指向远端时本机不启动 |

日志位于 `SERVICES_HOME/ollama.log`、`VOICE_HOME/voice.log`、
`xiaoxiong-app/logs/dev-gateway.log` 与 `xiaoxiong-app/logs/dev-uniapp.log`。

## 本地 AI 服务（LLM 代理 + STT / TTS）

一个进程在 **9529** 端口按能力分前缀提供 OpenAI 兼容接口：

| 能力 | 接口 | 本地后端 | 代理后端 |
|---|---|---|---|
| LLM | `POST /llm/v1/chat/completions` | 不提供（无本地模型） | 任意 OpenAI 兼容 LLM，原样转发 |
| LLM | `GET /llm/v1/models` | 不提供 | 原样转发上游模型列表 |
| STT | `POST /voide/v1/audio/transcriptions` | SenseVoice-small（sherpa-onnx，离线） | 任意 OpenAI 兼容 STT |
| TTS | `POST /voide/v1/audio/speech` | edge-tts（微软在线神经音色） | 任意 OpenAI 兼容 TTS |
| 健康检查 | `GET /health`、`/llm/health`、`/voide/health` | 返回后端、模型、ffmpeg、鉴权、缓存状态 | 同左 |

> 语音相关接口的前缀是 `/voide`（仓库历史命名），网关的 `ASR_BASE_URL` /
> `TTS_BASE_URL` 要带上它；LLM 接口前缀是 `/llm/v1`。

服务脚本 `voice/openai_voice_server.py` 参照 Orca 本地语音服务里的
`openai-voice-server.py` 整理，去掉了 Docker 与 faster-whisper 回退，
只保留网关实际用到的 SenseVoice 和 edge-tts，并增加了配置文件、可选 API Key
和远程代理模式。LLM 部分是一个**纯转发代理**，见下节。

### LLM 纯转发代理

`/llm/v1` 不加载任何本地模型，只把请求**原样转发**到 `LLM_UPSTREAM_BASE_URL`
指向的 OpenAI 兼容上游：

- `POST /llm/v1/chat/completions`：请求体原样转发（可选按 `LLM_UPSTREAM_MODEL`
  覆盖模型名），流式请求的 SSE 字节直接透传，不做缓冲或格式转换；
- `GET /llm/v1/models`：原样转发上游 `/models`；
- 不提供 Ollama 原生 `/api/chat` / `/api/tags`，也不做 Ollama↔OpenAI 翻译；
- 上游忽略 `stream=true` 直接返回完整 JSON 时，按上游响应原样返回，
  **不会**把它聚合伪装成流（没有非流式兜底）。

上游可以是任意 OpenAI 兼容服务：云端 API（OpenAI / DeepSeek / 通义等），
或者本机 Ollama 的兼容端点 `http://127.0.0.1:11434/v1`。LLM 不再绑定
Ollama；要用本机模型就把 Ollama 当普通上游填进去，需要时由
`services.sh start ollama` 把它拉起来。

在 `$VOICE_HOME/voice.conf` 配置（地址带不带 `/v1` 都行）：

```dotenv
LLM_ENABLED=auto                              # 配了上游就启用；off 关闭
LLM_UPSTREAM_BASE_URL=https://api.openai.com/v1
LLM_UPSTREAM_API_KEY=sk-...
LLM_UPSTREAM_MODEL=gpt-4o-mini                 # 可选，覆盖请求里的 model
```

`LLM_ENABLED=auto` 时只要填了上游地址，`/llm/v1` 就自动可用；没填则只跑
STT / TTS。`on` 强制启用但没配上时，启动前的 `preflight.py` 检查会明确报错，
不会静默失败。代理不要求本机安装 Ollama，也不下载任何模型。如果网关本来就
支持该上游，也可以跳过本代理，直接把 `LLM_BASE_URL` 指向远程地址。

开启 API Key 鉴权时，`/llm/v1/chat/completions` 需要
`Authorization: Bearer <key>`，`/llm/v1/models` 与 `/llm/health` 保持开放，
方便网关做健康探测。

### macOS / Linux

安装（默认 STT + TTS，会下载约 240MB 的 SenseVoice 模型）：

```bash
./scripts/install-voice.sh
```

按需裁剪：

```bash
./scripts/install-voice.sh --tts-only    # 只装 TTS，不下载模型
./scripts/install-voice.sh --stt-only    # 只装 STT，不装 edge-tts / ffmpeg
./scripts/install-voice.sh --proxy-only  # 只装基础依赖，代理远程 OpenAI 兼容服务
./scripts/install-voice.sh --skip-model  # 装 STT 依赖但先不下载模型
./scripts/install-voice.sh --dry-run     # 只打印步骤，不实际安装或下载
```

启动与管理（后台常驻，推荐）：

```bash
./scripts/voice.sh start                 # 后台启动，默认 0.0.0.0:9529
./scripts/voice.sh start --port 9531     # 附加参数原样传给 start-voice.sh
./scripts/voice.sh status                # 是否在运行、监听端口、最近一行日志
./scripts/voice.sh check                 # 只做启动前依赖检查
./scripts/voice.sh log                   # 日志尾部（默认 80 行）
./scripts/voice.sh log -f                # 持续跟踪日志
./scripts/voice.sh restart               # 重新读取配置并重启
./scripts/voice.sh stop                  # 停止
./scripts/voice.sh run                   # 前台运行，Ctrl+C 停止
```

启动参数（`start` 后面可跟）：

```bash
--port 9531          # 换端口
--ip 127.0.0.1       # 只监听本机
--config /path/to/voice.conf
--require-api-key    # 启用鉴权，等价于 --api-key auto
--api-key off        # 关闭鉴权（默认）
```

也可以跳过管理器直接前台运行：`./scripts/start-voice.sh`。
日志和 PID 在 `$VOICE_HOME/voice.log` / `$VOICE_HOME/voice.pid`。

### Windows

在 CMD 中执行：

```bat
scripts\install-voice.cmd
scripts\voice.cmd start
scripts\voice.cmd status
scripts\voice.cmd log
scripts\voice.cmd stop
```

`scripts\voice.cmd` 支持 `start / stop / restart / status / check / log / run`，
参数与 macOS 版本一致，例如 `scripts\voice.cmd start -Port 9531`、
`scripts\voice.cmd log -f`。需要前台运行时用 `scripts\start-voice.cmd`。

也可以直接调用 PowerShell 脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -TtsOnly
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -SttOnly
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -ProxyOnly
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\voice.ps1 start
powershell -ExecutionPolicy Bypass -File .\scripts\voice.ps1 start -Port 9531
powershell -ExecutionPolicy Bypass -File .\scripts\voice.ps1 status
powershell -ExecutionPolicy Bypass -File .\scripts\voice.ps1 log -f
powershell -ExecutionPolicy Bypass -File .\scripts\voice.ps1 check
powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1 -Port 9531
```

### 启动前依赖检查

`start` / `restart` / `check` 会先运行 `voice/preflight.py`。检查只读，不会安装、
下载或修改任何依赖；缺少依赖时服务不会启动，终端和 `voice.log` 里会打印
“缺什么 + 用哪条命令安装”，例如：

```text
[check] 缺少 / 异常：STT: SenseVoice 模型未就绪：.../models/sensevoice
[check] 启动脚本只检查依赖，不会自动安装；请手动执行下面的命令：
  ./scripts/install-voice.sh                # 本地 STT + TTS（含模型）
  ./scripts/install-voice.sh --proxy-only   # 只装代理模式基础依赖
```

检查内容：

- 所有模式：Python 3.10+、`fastapi` / `uvicorn` / `python-multipart` / `httpx` / `pydantic`；
- 本地 STT：`sherpa-onnx`、`numpy`、SenseVoice 的 `model.int8.onnx` / `tokens.txt`；
- 本地 TTS：`edge-tts`、可执行的 `ffmpeg`；
- 代理模式：上游地址必须是 `http://` 或 `https://`，并跳过对应能力的本地模型 / ffmpeg 检查；
- LLM 纯转发代理：启用时 `LLM_UPSTREAM_BASE_URL` 必须是 `http(s)://`；不检查本机 Ollama，也不需要本地模型；
- `proxy-only` 安装会要求 STT 和 TTS 都能解析出可用的上游地址（或本机依赖已补齐）。

安装脚本会把当前模式写入 `$VOICE_HOME/install-mode`
（`full` / `tts-only` / `stt-only` / `proxy-only`）。`--tts-only` 或
`--stt-only` 装出来的服务，检查时会跳过未安装的那一类能力，不会因为
“本来就没装”而拒绝启动。

依赖缺失时，按日志里的命令手动安装即可；安装完成后重新执行
`./scripts/voice.sh start`（Windows 用 `scripts\voice.cmd start`）。
排查依赖问题可直接运行 `./scripts/voice.sh check` / `scripts\voice.cmd check`。

### 配置文件

首次安装会把 `voice/voice.conf.example` 复制成 `$VOICE_HOME/voice.conf`，
之后启动都读取这个文件。安装脚本不会覆盖已有配置。

- macOS / Linux：`~/.app-product/voice/voice.conf`
- Windows：`%LOCALAPPDATA%\app-product\voice\voice.conf`
- 可用 `VOICE_CONFIG` 环境变量或 `--config` / `-Config` 指定其它文件。

配置优先级：**命令行参数 > 环境变量 > 配置文件 > 内置默认值**。

常用配置项：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `VOICE_HOST` | `0.0.0.0` | 监听地址；只允许本机访问时改 `127.0.0.1` |
| `VOICE_PORT` | `9529` | 监听端口 |
| `SENSEVOICE_DIR` | `$VOICE_HOME/models/sensevoice` | 本地 STT 模型目录 |
| `TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | 本地 TTS 默认音色 |
| `TTS_TIMEOUT` | `20` | edge-tts 单个音频块超时秒数 |
| `FFMPEG_BIN` | `ffmpeg` | ffmpeg 路径；本地 WAV 转码需要 |
| `VOICE_API_KEY` | `off` | 鉴权模式，见下 |
| `VOICE_API_KEY_FILE` | `$VOICE_HOME/api-key` | Key 文件，`auto` 模式读写 |
| `LLM_ENABLED` | `auto` | `auto` 配了上游即启用；`on` / `off` 强制开关 |
| `LLM_UPSTREAM_BASE_URL` | 空 | LLM 纯转发代理的上游；空则只跑 STT / TTS |

配置文件支持 `~` 和 `$VOICE_HOME` 展开，语法就是一行一个 `KEY=VALUE`，
完整注释见 `scripts/voice/voice.conf.example`。

### API Key（默认关闭）

`VOICE_API_KEY` 有三种用法：

- `off` / `none` / `false`：不校验，默认行为。
- `auto`：读取 `VOICE_API_KEY_FILE`；文件不存在或为空时随机生成并写入
  （POSIX 下权限设为 `600`）。启动脚本的 `--require-api-key` /
  `-RequireApiKey` 就是这种模式。
- 其它任意字符串：直接作为 Key 使用。

开启后，只有 `POST /v1/audio/transcriptions` 和 `POST /v1/audio/speech`
需要 `Authorization: Bearer <key>`；`/`、`/health`、`/v1/models` 保持开放，
避免网关健康探测因为鉴权被误判为不可达。网关 `.env` 同时补上：

```dotenv
ASR_API_KEY=<与 VOICE_API_KEY 相同>
TTS_API_KEY=<与 VOICE_API_KEY 相同>
```

### 代理远程 OpenAI 兼容服务（免本地安装）

不想下载 SenseVoice、也不想装 ffmpeg 时，可以把请求转发到远程 OpenAI
兼容服务。安装时用：

```bash
./scripts/install-voice.sh --proxy-only
```

Windows 用 `scripts\install-voice.cmd -ProxyOnly`。代理模式只安装
FastAPI / uvicorn / httpx 等基础依赖，不下载模型、不安装 ffmpeg，并把
`install-mode` 记为 `proxy-only`。

启动前必须在 `voice.conf` 里填上游地址和 Key，否则依赖检查会明确拒绝启动：

```dotenv
# 通用上游：STT + TTS 都走它
VOICE_UPSTREAM_BASE_URL=https://api.openai.com/v1
VOICE_UPSTREAM_API_KEY=sk-...

# 可选：分别覆盖模型 / 音色
STT_UPSTREAM_MODEL=whisper-1
TTS_UPSTREAM_MODEL=tts-1
TTS_UPSTREAM_VOICE=alloy
```

也可以只代理其中一类能力：

```dotenv
STT_UPSTREAM_BASE_URL=https://your-stt.example.com/v1
STT_UPSTREAM_API_KEY=...
TTS_UPSTREAM_BASE_URL=https://your-tts.example.com/v1
TTS_UPSTREAM_API_KEY=...
TTS_UPSTREAM_VOICE=zh-CN-XiaoxiaoNeural
```

上游地址带不带 `/v1` 都可以；`STT_UPSTREAM_BASE_URL` / `TTS_UPSTREAM_BASE_URL`
优先于通用的 `VOICE_UPSTREAM_BASE_URL`。本地与远程可以混用：只配置 STT
上游时，TTS 继续走本地 edge-tts，反过来也一样。

如果网关本来就支持该上游，也可以跳过这个代理，直接把网关的
`ASR_BASE_URL` / `TTS_BASE_URL` 指向远程地址，并在网关 `.env` 里填
`ASR_API_KEY` / `TTS_API_KEY`。保留本代理的好处是：客户端和网关始终只连
一个固定的本机地址，同时可以混用本地与远程、统一管理 Key 和端口。

注意：网关按 **24kHz / 16bit / 单声道 WAV** 解析 TTS 响应，代理的上游
TTS 也需要返回这种格式；OpenAI 官方 `tts-1` 的 wav 输出符合要求。
STT 上游返回 OpenAI 风格的 `{"text": "..."}` 即可。

### 运行目录与依赖

- 运行目录默认：
  - macOS / Linux：`~/.app-product/voice`
  - Windows：`%LOCALAPPDATA%\app-product\voice`
  - 可用 `VOICE_HOME` 环境变量或 `-VoiceHome` 参数覆盖。
- Python 虚拟环境在 `运行目录/venv`，模型在 `运行目录/models/sensevoice`。
- 需要 Python 3.10+。
- 本地 TTS 使用 edge-tts，需要联网；把 edge-tts 的 MP3 转成网关要求的 WAV
  需要 `ffmpeg`。安装脚本会尝试用 Homebrew / winget 安装；装不上时只影响
  本地 TTS，STT 不受影响。
- 本地 STT 下载完模型后完全离线，输入只接受 WAV（网关上行会自动补 WAV 头）。
- 代理模式不加载 sherpa-onnx / edge-tts，也不需要 ffmpeg 和模型。
- `运行目录/install-mode` 记录安装脚本最后一次选择的模式，启动检查据此判断
  哪些依赖是预期缺失的；不要手动伪造，除非你清楚当前装了哪些能力。
- 安装脚本本身只在用户显式执行时安装依赖；`voice.sh` / `voice.cmd` 的启动、
  重启、检查命令都不会自动安装任何东西。

### 与网关配置对应

网关（`xiaoxiong-app/gateway/.env`）：

```dotenv
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:9529/llm/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=

ASR_PROVIDER=whisper
ASR_BASE_URL=http://127.0.0.1:9529/voide
ASR_PARAMS={"language":"zh","sampleRate":16000}

TTS_PROVIDER=edge
TTS_BASE_URL=http://127.0.0.1:9529/voide
TTS_PARAMS={"voice":"zh-CN-XiaoxiaoNeural"}
```

`LLM_PROVIDER=openai` 走 `/llm/v1` 的纯转发代理；若要用本机 Ollama 原生
`/api/chat`（保留 thinking），把 `LLM_PROVIDER` 改成 `ollama`、`LLM_BASE_URL`
直接指向 `http://127.0.0.1:11434`，不经本服务。ASR / TTS 的 `BASE_URL`
必须带 `/voide` 前缀。

服务默认监听 `0.0.0.0`，如果跑在另一台机器，把 `127.0.0.1` 换成那台机器的局域网 IP；
只在本机使用就把 `VOICE_HOST` 改成 `127.0.0.1`。
网关的 ASR 会滚动重识别并自己产生 `asr.partial` / `asr.final`，这里的 STT 接口不需要流式。

## Ollama

### macOS

安装：

```bash
./scripts/install-ollama.sh
```

- 有 Homebrew 时用 `brew install ollama`。
- 没有 Homebrew 时走 Ollama 官方 `install.sh`，不需要先装 Homebrew。
- 都没有时会提示下载官方 `Ollama.dmg`。

下载模型：

```bash
./scripts/pull-ollama-models.sh                  # 按 scripts/ollama-models.txt 下载
./scripts/pull-ollama-models.sh gpt-oss:20b      # 只下载指定模型
./scripts/pull-ollama-models.sh --dry-run        # 只打印清单，不联网
```

安装完成后打开 Ollama.app（或运行 `ollama serve`），下载脚本会自动检测服务。

### Windows

在 CMD / PowerShell 中执行：

```bat
scripts\install-ollama.cmd
scripts\pull-ollama-models.cmd
```

也可以直接调用 PowerShell 脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-ollama.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\pull-ollama-models.ps1 -DryRun
```

- 安装优先用 winget（`Ollama.Ollama`）；没有 winget 时下载官方 `OllamaSetup.exe` 静默安装。
- 安装后如果当前终端找不到 `ollama`，新开一个终端刷新 PATH。
- 安装包通常会随托盘程序自动启动服务。

### 模型清单

`scripts/ollama-models.txt` 一行一个模型，`#` 开头为注释，空行忽略。默认是
`gpt-oss:20b`（约 13GB），与网关默认模型 `gpt-oss:120b-cloud` 同族但可在本机运行；
内存较小的机器可改用清单里的 `qwen3:8b`。云端模型（如 `gpt-oss:120b-cloud`）不占
本地磁盘，但需要先执行 `ollama login`。

下载脚本在服务未启动时会自动后台拉起 `ollama serve`；`OLLAMA_HOST` 指向远端时不
会本地启动，只检查连通性。

### 与网关配置对应

默认不直连：网关走本地 AI 服务的 `/llm/v1` 纯转发代理（见上文「与网关配置对应」），
Ollama 只是可选上游之一——在 `voice.conf` 把 `LLM_UPSTREAM_BASE_URL` 填成
`http://127.0.0.1:11434/v1` 即可，不必改 `LLM_PROVIDER`。

若要用 Ollama 原生 `/api/chat`（保留 thinking），才让网关直连它，在
`xiaoxiong-app/gateway/.env` 配置：

```dotenv
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434
LLM_MODEL=gpt-oss:120b-cloud
```

本地跑 `gpt-oss:20b` 时把 `LLM_MODEL` 改成 `gpt-oss:20b`；如果 Ollama 在另一台机器，
把 `LLM_BASE_URL` 指向那台机器，并确保其 11434 端口可达。

## Linux

所有 `.sh` 脚本同样可用：

- Ollama 安装走官方 `install.sh`，其余流程一致。
- 本地 AI 服务的安装、`voice.sh start / stop / restart / status / check / log` 与 macOS 一致。
- 统一服务管理 `services.sh start / stop / restart / status / check / log` 与 macOS 一致。
- 语音服务依赖 Python 3.10+ 与 ffmpeg（用系统包管理器安装），模型/虚拟环境目录与 macOS 相同。
