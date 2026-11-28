# model-proxy

本仓库的**本地 AI 服务与开发辅助脚本**（与 `xiaoxiong-app` 同级）。负责：

- 本地 AI 服务（默认 `19529`）：STT / TTS / LLM 代理 / Embeddings，OpenAI 兼容接口 + 管理面板；
- 本机开发服务的统一启停与状态查看（macOS / Linux，`services.sh`）；
- Ollama 的安装与模型下载（LLM 的可选上游）。

所有能力都是**原生 Python 进程**，不使用 Docker。macOS / Linux 用 `.sh`，Windows 用同目录下的 `.cmd` / `.ps1`。

数据库表结构（SQLite 真相源 / Postgres / Redis 三套存储、版本变更、纠错词表）见 [`DB_SCHEMA.md`](DB_SCHEMA.md)。

## 目录

```
model-proxy/
├── install-voice.sh / .cmd / .ps1     # 安装本地 AI 服务（venv + 依赖 + 模型）
├── start-voice.sh / .cmd / .ps1       # 前台启动
├── voice.sh / .cmd / .ps1             # 后台管理：start/stop/restart/status/check/log/run
├── services.sh                        # 统一编排 ollama / voice / gateway / uniapp（仅 bash）
├── install-ollama.sh / .cmd / .ps1    # 安装 Ollama
├── pull-ollama-models.sh / .cmd / .ps1# 按 ollama-models.txt 下载模型
├── ollama-models.txt                  # Ollama 模型清单
└── voice/
    ├── openai_voice_server.py         # 服务主进程（FastAPI）
    ├── admin_panel.py                 # 管理面板 /admin
    ├── voice_db.py                    # 本地 SQLite（配置真相源）
    ├── config_store.py                # 本地库 + 远程库 + Redis 的统一门面
    ├── voice_sync.py                  # Postgres / Redis 同步
    ├── llm_protocols.py               # 5 种 LLM 线协议适配
    ├── upstream_pool.py               # LLM / Embedding 上游地址池
    ├── catalog.py / model_catalog.py  # 音色 / ASR-TTS 模型目录
    ├── init_catalog.py                # 把 seed/*.json 幂等灌入 voice.db
    ├── seed/*.json                    # 目录种子（音色、语音模型）
    ├── preflight.py                   # 启动前依赖检查
    ├── voice.conf.example             # 基础设施配置模板
    └── tests/run_all.py               # 回归测试统一入口
```

## 一键启停开发服务（services.sh，macOS / Linux）

按下面各节完成安装后，用 `services.sh` 一条命令启停本机所有开发服务。它是编排层，
不替代安装脚本：`voice` 仍由 `voice.sh` 管理，`gateway` / `uniapp` 仍由
`xiaoxiong-app/scripts/dev-server.mjs` 管理。

| 名称 | 说明 |
|---|---|
| `ollama` | Ollama 本地模型服务（默认 11434；LLM 以本机 Ollama 为上游时可选） |
| `voice` | 本地 AI 服务，STT / TTS / LLM 代理 / Embeddings（默认 19529） |
| `gateway` | Node 网关（默认 8787，热重载） |
| `uniapp` | uni-app 前端开发服务 |
| `backend` | `ollama` + `voice` + `gateway`（不含前端） |
| `all` | 全部，默认 |

```bash
./model-proxy/services.sh                       # 等同 start all
./model-proxy/services.sh start                 # 启动全部
./model-proxy/services.sh start voice           # 只启动本地 AI 服务
./model-proxy/services.sh start ollama voice    # 启动多个指定服务
./model-proxy/services.sh stop all              # 按相反顺序停止
./model-proxy/services.sh restart voice         # 重启指定服务
./model-proxy/services.sh status                # 查看全部服务状态
./model-proxy/services.sh check                 # 只检查依赖，不启动
./model-proxy/services.sh log                   # 各服务日志尾部（默认 80 行）
./model-proxy/services.sh log voice -f          # 持续跟踪单个服务日志
./model-proxy/services.sh log gateway -n 200    # 查看最近 200 行
./model-proxy/services.sh --help                # 完整用法
```

行为说明：

- `status` 是只读查询，「未运行」属正常状态，不会报错或返回失败；`check` 在依赖
  缺失时会明确失败并给出安装命令。
- 启动 / 重启**不会自动安装依赖**；缺什么按提示先执行 `install-ollama.sh` /
  `install-voice.sh`，或到 `gateway` / `uni_app` 目录执行 `npm install`。
- Ollama 若由 Ollama.app 等外部进程启动，`stop` 不会结束它；`OLLAMA_HOST` 指向
  远端时本机不启动 Ollama，只检查连通性。LLM 走远程上游时不需要本机 Ollama，
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

> `services.sh` 只有 bash 版（macOS / Linux）。Windows 用各服务自己的 `.cmd`，
> 网关 / 前端用 `node xiaoxiong-app\scripts\dev-server.mjs ...` 分别管理。

## 本地 AI 服务（19529）

一个 FastAPI 进程同时提供四类能力：

| 能力 | 接口 | 说明 |
|---|---|---|
| STT | `POST /voice/v1/audio/transcriptions` | OpenAI 兼容转写；内置 SenseVoice-small（sherpa-onnx，离线），也可路由到 DashScope / OpenAI 兼容上游 |
| STT | `POST /voice/v1/audio/translations` | 语音翻译：任意语言音频 → 目标语言文本 |
| TTS | `POST /voice/v1/audio/speech` | OpenAI 兼容合成；内置 edge-tts，也可路由到 DashScope / DeepSeek TTS 等上游 |
| TTS | `GET /voice/v1/audio/voices` | 音色目录（按 provider / model 过滤） |
| 实时 WS | `WS /voice/ws/inference` | ASR / TTS 共用的 DashScope 形状实时接口：`run-task` / `continue-task` / `finish-task` + 二进制音频帧，事件 `task-started` / `result-generated` / `task-finished` / `task-failed` |
| LLM | `POST /llm/v1/chat/completions` | 入站固定 OpenAI 格式，出站按模型声明的线协议翻译到上游（含 SSE 流式） |
| LLM | `POST /llm/v1/embeddings` | OpenAI 兼容向量接口（Anthropic / Responses 线协议无向量接口，返回 501） |
| 目录 | `GET /voice/v1/providers`、`/voice/v1/models`、`/llm/v1/providers`、`/llm/v1/models` | 提供商 / 模型目录（脱敏，不含密钥） |
| 热词纠错 | 对外 `GET/POST /voice/v1/corrections`、管理 `GET/POST /admin/api/corrections` | ASR 同音错词→正确词词表；对外只做下载/上传，管理端做分页/启用/审核（需鉴权）。三库对等 + Redis 缓存，见下节 |
| 健康 | `GET /`、`/health`、`/voice/health`、`/llm/health` | 后端、模型、ffmpeg、鉴权、缓存、远程同步状态 |
| 文档 | `GET /docs`、`/docs/ws` | Swagger（HTTP）与 WS 实时接口文档 |
| 管理 | `GET /admin` | 管理面板（独立账号，见下） |

> 语音接口前缀是 `/voice`，LLM 是 `/llm/v1`。网关侧 `ASR_BASE_URL` /
> `TTS_BASE_URL` 必须带 `/voice` 前缀，`LLM_BASE_URL` 必须带 `/llm/v1`。
>
> `/docs/ws` 的正文从 `xiaoxiong-app/contracts/README.md` 的
> 「对外 WS 实时接口」章节抽取，改 WS 契约时保持该标题稳定即可自动同步。

### 热词纠错词表

把语音识别的同音错词纠正为正确词（如"若神父"→"洛神赋"）。19529 是词表权威源，从空表起步，
由客户端 `learn_correction` 学习上传或管理面板添加；各客户端增量同步，本地先存、择机上传。
存储层三库对等（SQLite / MySQL / PostgreSQL），可选 Redis 缓存。

**对外接口**（`/voice/v1/corrections`，客户端网关用，无鉴权）—— 只有两个：

- **GET 下载**：`GET /voice/v1/corrections?since=<毫秒时间戳>`（`since=0` 首次全量），返回
  `updated_at > since` 的变更，**只下发 enabled=1 的**，附 `max_updated_at`（客户端记下作水位）。
- **POST 上传**：`{"correct":"洛神赋","wrong":"若神父","correct_pinyin":"...","wrong_pinyin":"..."}`。
  客户端学习到的纠错词，标记 `uploaded=1`，**默认不启用**，等管理端审核通过后自动启用下发。
  拼音缺省由 pypinyin 补算；返回 `{ok, main_id, variant_id, is_new, updated_at}`。

**管理端接口**（`/admin/api/corrections`，需 admin Cookie 鉴权）—— 与管理面板配套：

- **GET 列表**：`GET /admin/api/corrections?page=1&page_size=10`，**主表（正确词）分页**，每条带
  `variants[]`（其下错词明细），返回 `items` / `total` / `page` / `pages`。
- **POST 管理操作**（body 带 `op`）：
  - `{op:"set_enabled", main_id:3, value:true}` 启用/禁用整组（也兼容 `variant_id`）
  - `{op:"set_reviewed", main_id:3, value:true}` 审核标记
  - `{op:"approve", variant_id:7}` 审核通过子表：置 reviewed+enabled 并自动启用主表（仅 uploaded=1 的可审）
  - 不带 `op`：`{"correct":"洛神赋"}` 只建主表（默认禁用，需启用后才能加明细）；
    `{"correct":"洛神赋","wrong":"滕王格式"}` 加子表错词（本地添加，默认禁用）

字段：`main_id` / `variant_id`（id）、`correct`（正确词）、`correct_pinyin`（正确词拼音）、`wrong`（错词）、
`pinyin`（错词拼音，匹配用）、`source`（`local` 本地 / `synced` 同步）、`uploaded`（1=客户端上传）、
`reviewed`（审核标记）、`enabled`（启用，控制是否同步）、`updated_at`（毫秒，任何变更都前移）。

来源显示：管理面板把 `uploaded=1` 显示为"客户端上传"，否则"本地添加"。本地添加默认禁用，
启用后才能加错词明细；客户端上传的错词需审核，审核后自动启用。不提供删除（热词只增不删）。

配置（环境变量）：`VOICE_CORRECTION_DB`（`sqlite`/`mysql`/`postgresql`，不配按 DSN 推断，默认 sqlite）、
`VOICE_DB_PATH`、`VOICE_MYSQL_DSN`、`VOICE_REMOTE_DSN`/`VOICE_PG_DSN`、`REDIS_URL`（缓存）。
驱动按需装：sqlite 标准库、mysql `pip install pymysql`、pg `pip install "psycopg[binary]"`。

### 提供商、模型与协议

配置模型是 **能力 → 提供商 → 模型 → 协议**：

- STT / TTS 提供商：`builtin`（SenseVoice / edge-tts）、`dashscope`、`deepseek`；
- 语音协议：`http`（同步）、`ws`（实时流式）、`http-async`（录音文件异步转写）；
- LLM 线协议（对齐 Java 工程 `fw-plus-ai-native` 的 `LlmProtocol`）：
  - `openai_chat_completions`（OpenAI / DeepSeek / DashScope / Ollama 的 `/v1` 兼容端点都走它）
  - `azure_openai_chat_completions`
  - `openai_responses`
  - `anthropic_messages`
  - `gemini`
  - `ollama`（Ollama 原生 `/api/chat`，NDJSON；支持 `think:false` 真正关闭思考、
    并支持 `tools` 工具调用。需要可控思考 / 工具调用时用它，而不是 `/v1` 兼容端点）

**协议是「线协议」，与厂商严格分开**：厂商由 `vendor` 表达，协议只写调用形态。
模型目录（STT / TTS 的模型 + 协议、各家音色）存放在 `voice/seed/*.json`，
由 `init_catalog.py` 幂等灌入本地 SQLite，不硬编码在业务代码里：

```bash
python3 model-proxy/voice/init_catalog.py              # 补齐缺失项（幂等）
python3 model-proxy/voice/init_catalog.py --force      # 用种子覆盖已有项
python3 model-proxy/voice/init_catalog.py --reset      # 先删该提供商目录再灌
python3 model-proxy/voice/init_catalog.py --provider dashscope
python3 model-proxy/voice/init_catalog.py --dry-run --json
```

当前种子内容：

| 文件 | 提供商 / 模型 | 条目 |
|---|---|---|
| `seed/speech_models.json` | 各提供商的 STT / TTS 模型 + 协议 | 16 |
| `seed/voices_builtin.json` | `builtin` / `edge-tts` | 20 个音色 |
| `seed/voices_dashscope.json` | `dashscope` / `cosyvoice-v3-flash` | 74 个音色 |
| `seed/voices_deepseek.json` | `deepseek` / `deepseek-tts` | 2 个音色（stella / tide） |

### 配置：本地 SQLite 是真相源

**`voice.conf` 只放基础设施**（监听端口、数据库目录、日志、远程 DSN、Redis），
所有业务配置（上游地址、密钥、模型、音色、鉴权开关、上游池）都在本地 SQLite
`voice.db` 里，由管理面板或首次播种写入。

配置优先级：

```
命令行参数 > 环境变量 > 本地 SQLite（真相源） > voice.conf > 内置默认值
```

`voice.conf` 支持的键（完整注释见 `voice/voice.conf.example`）：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `VOICE_PORT` | `19529` | 监听端口 |
| `VOICE_HOST` | `0.0.0.0` | 监听地址（也可用 `--host` / `--ip` 覆盖） |
| `VOICE_DB_DIR` | `$VOICE_HOME` | `voice.db` 所在目录 |
| `VOICE_LOG_FILE` | `$VOICE_HOME/voice.log` | 日志文件 |
| `VOICE_REMOTE_DSN` | 空 | 远程 Postgres DSN；配置后本地与远端同步 |
| `REDIS_URL` | 空 | 远程配置缓存（cache-aside） |

路径支持 `~` 与 `$VOICE_HOME` 展开。运行目录默认：

- macOS / Linux：`~/.app-product/voice`
- Windows：`%LOCALAPPDATA%\app-product\voice`

### 远程同步（可选）

本地 SQLite 是运行时真相源。配置 `VOICE_REMOTE_DSN` 后，保存配置与服务启动时会
与远程 Postgres 同步；配置 `REDIS_URL` 后，远程配置读取先走 Redis（未命中再查
Postgres 并回填），写入后写穿。两者都没配 / 连不上时**优雅降级为纯本地**，
不影响服务启动与请求处理。同步结果在管理面板与 `/health` 里可见。

### 管理面板（/admin）

浏览器打开 `http://<host>:19529/admin`。鉴权用**独立的 `admin.conf`**（与 `voice.conf`
互不干扰）：

```ini
ADMIN_USER=admin
ADMIN_PASSWORD=改成一个强密码
```

缺失时回落到默认 `admin / admin` 并提示修改——只用于本地首次登录，正式使用前必须改掉。
登录成功后发 Cookie 会话；`/admin/api/*` 全部要求该会话，与对外接口的 API-Key
鉴权是两套东西。

面板可做的事：

- LLM / Embedding：上游地址池（多地址 / 多账号）、全局默认 provider 与默认模型
  （**按提供商维度各自有默认模型**，与默认提供商解耦）、协议、密钥；
- ASR / TTS：内置 / DashScope / DeepSeek 的地址、密钥、默认模型、默认音色；
- 安全：`VOICE_IP_ALLOW`（IP / CIDR 白名单）、`VOICE_API_KEY_AUTH`、API Key 列表，
  以及**请求大小限制**（见下）；
- 模型测试：LLM 对话、Embeddings、ASR（录音 / 恢复 / 识别）、TTS（合成）四个页签；
- 运行日志、远程同步（推 / 拉）、schema 历史。

面板里的「测试」可以显式带 `provider` / `model` / `protocol` 覆盖默认路由，不影响
已保存配置；也就是说同一份配置可以先测完再保存。

### 鉴权（默认关闭）

| 配置 | 默认 | 作用 |
|---|---|---|
| `VOICE_IP_ALLOW` | 空 | IP / CIDR 白名单（逗号 / 换行 / 空格分隔）。非空时白名单外的请求（**含 `/admin`**）直接 403；本机环回恒定放行，配错也不会把自己锁在面板外 |
| `VOICE_API_KEY_AUTH` | `off` | `on` 开启 API-Key 鉴权；`off` 显式关闭；留空时向后兼容旧语义（`VOICE_API_KEY` 非 off 即开启） |
| `VOICE_API_KEY` | `off` | `off` / `none` / `false` 关闭；`auto` 读取或随机生成 Key 文件；其它值作为显式 Key（支持逗号 / 换行分隔多个） |

**请求大小限制**（面板「安全设置 → 配置」里配置，`0` 或留空 = 不限，超限返回 `413`）：

| 配置 | 单位 | 作用接口 |
|---|---|---|
| `MAX_LLM_TOKENS` | tokens | `/llm/v1/chat/completions` |
| `MAX_ASR_MB` | MB | `/voice/v1/audio/transcriptions` |
| `MAX_TTS_CHARS` | 字符 | `/voice/v1/audio/speech` |
| `MAX_OCR_MB` | MB | `/ocr/v1/ocr`（图片/PDF 解码后大小） |
| `MAX_EMBED_TOKENS` | tokens | `/embed/v1/embeddings` |
| `MAX_RERANK_TOKENS` | tokens | `/rerank/v1/rerank` |

token 数用字符估算（CJK 1 字≈1 token、其它 4 字符≈1 token），与限流口径一致，不用于计费。

开启 API-Key 后，除下列路径外的 HTTP 接口都需要 `Authorization: Bearer <key>`：
`/`、`/health`、`/voice`、`/voice/health`、`/llm`、`/llm/health` 与文档
（`/docs`、`/redoc`、`/openapi.json`）。模型 / 音色目录属于数据接口，开启鉴权后
同样要带 Key；已登录的管理面板会话走 Cookie 放行。WS `/voice/ws/inference`
也受白名单 / API-Key 约束（鉴权失败以 `4401` 关闭连接）。

启动脚本的 `--require-api-key` / `-RequireApiKey` 等价于开启鉴权并使用 auto Key；
`--api-key off` 显式关闭。Key 文件默认 `$VOICE_HOME/api-key`。

### 用户管理（多账号 + 角色）

管理面板账号存本地 SQLite 的 `admin_users` 表（`$VOICE_HOME/voice.db`，v10），**不再是
`admin.conf` 或单行的 admin_credentials**。首次启动若表为空，按以下优先级播种一个
**内置管理员**（`is_builtin=1`，role=admin）：

1. `voice.conf` 的 `ADMIN_USER` / `ADMIN_PASSWORD`；
2. 存量 `admin.conf` 的账号密码（老用户平滑迁移，原文件保留）；
3. 存量 `admin_credentials` 单行表（v9 老库自动迁入）；
4. 都没有则随机生成一把密码，启动日志打印一次。

角色三档：**viewer**（只读状态/日志/目录）、**operator**（+连通性测试）、**admin**（+配置/密钥/同步/用户管理）。
后端每个 `/admin/api/*` 按角色强制拦截，前端只是辅助隐藏。内置管理员不可删/改角色/禁用/被重置密码，
只能自己改；禁用账号后其会话立即失效。所有账号变更写 `audit`，不记密码明文。

- 改自己密码：面板顶部「修改密码」。
- 重置内置管理员 / 修复异常：`./model-proxy/reset-admin.sh`（`--password` 指定、`--fix` 修复、
  `--list` 查看），可在服务运行时执行，会清除该账号所有会话。
- 登录失败写 `audit`（`admin_login_failed`，只记账号不记密码），**不做失败锁定**；Cookie 带
  `HttpOnly` + `SameSite=Lax`、HTTPS 下自动 `Secure`；`/admin` 响应另带安全头。

### API Key 管理

`/llm`、`/voice` 数据接口的 Bearer Key 也改为 SQLite 表管理（`admin_api_keys`，v10）：

- **只存哈希**（`sha256(key)[:16]`），明文只在创建时返回一次；面板「安全」tab 内管理，可启停、
  改备注名、生效开始/失效时间、绑定 IP（单 IP 或 CIDR，多个逗号分隔）。
- 两层 IP 叠加：全局 `VOICE_IP_ALLOW` 与该 key 的绑定 IP **都过才放行**；key 级留空=不额外限制。
- 鉴权开关三态：`VOICE_API_KEY_AUTH=on` 强制开、`off` 强制关（逃生口）、未设置时**表内有启用 key 即开**。
- 旧 `VOICE_API_KEY` 配置与 auto key 文件在首次启动时**一次性迁移进表**（哈希），之后不再读旧配置；
  改表即时生效，无需重启。WS `/voice/ws/inference` 同样查表鉴权。
- `owner_type` / `owner_id` 字段为将来外部用户自助管理 key 预留，本期未启用。

### 日志轮转

日志由 `voice.sh` 写到 `$VOICE_HOME/voice.log`。`voice.sh rotate` 手动轮转（copytruncate，不影响运行中的服务），
参数在 `voice.conf` 可配置：`LOG_ROTATE_DAYS`（保留天数，默认 7）、`LOG_ROTATE_MAX_MB`（单文件上限，默认 10）、
`LOG_ROTATE_BY`（`day`/`size`/`both`，默认 both）。可加入 cron 定时执行。数据库 `events`/`audit` 表沿用 5000 条上限。

### 对外监听安全建议

服务默认监听 `0.0.0.0:19529`（保留真机 `adb reverse`、iOS USB 隧道、局域网联调链路），
启动时若检测到对外监听且 IP 白名单或 API-Key 未配置，会打 `[安全警告]` 提示。生产/长期
运行时二选一：

- **只在本机用**：启动加 `--ip 127.0.0.1`（或 `VOICE_HOST=127.0.0.1`），端口不对局域网开放；
- **需要对外**：务必同时配 `VOICE_IP_ALLOW` 白名单 + `VOICE_API_KEY_AUTH=on`，并确认管理面板
  密码已改（首次随机密码见启动日志）。本机环回始终放行，白名单配错也进得了面板自救。

完整表结构见 `model-proxy/schema.sql`（本地 SQLite / 远端 Postgres / Redis KEY 三段）。

### LLM 代理

`/llm/v1` 不加载本地模型，只做协议翻译与转发：

- 入站固定 OpenAI Chat Completions / Embeddings 格式；
- 出站按模型或请求里声明的 `protocol` 翻译到 5 种线协议之一；
- 请求可用 `vendor` 路由到对应上游分组，组内多账号轮询；
- 流式请求逐块翻译为 OpenAI SSE；
- 思考开关对外固定用请求头 `X-Proxy-Think: 1|0`，代理按厂商翻译成上游原生参数
  （不落库、不透传）；
- 混合推理模型（qwen3 / deepseek 等）把思考链以 `<think>...</think>` 嵌在正文
  `content` 时，代理在响应侧自动把它移到标准 `reasoning_content` 字段，正文只留
  回答；上游原生就返回 `reasoning_content` 的（如 deepseek-reasoner）原样透传。
  内容驱动，不依赖 vendor / 端口 / think 开关判断；没有 `<think>` 的响应字节级透传。
- 工具调用：`tools` / `tool_choice` 对 OpenAI 兼容端点原样透传；对 Ollama 原生
  `/api/chat` 协议也会透传，并把上游 `tool_calls` 转成 OpenAI 格式
  （`arguments` 对象转 JSON 字符串、`finish_reason=tool_calls`）。
- 上游可以是任意 OpenAI 兼容服务（OpenAI / DeepSeek / 通义 / Ollama 的 `/v1` 等），
  或 Ollama 原生 `/api/chat`（见「Ollama」章节）。

上游地址与密钥在管理面板的 LLM / Embedding 池里配置，或首次播种进 `voice.db`；
`voice.conf` 不写任何 `*_UPSTREAM_*` 业务配置。

### 语音链路约定

- 网关上行音频：16kHz / 16bit / 单声道 PCM。ASR 上游通常要求 WAV，网关会补
  44 字节 WAV 头再提交；TTS 返回的 24k WAV 由网关剥头下发 PCM。
- 内置 STT 下载完模型后完全离线；内置 TTS 用 edge-tts（需要联网）并用 ffmpeg
  把 MP3 转成网关要求的 WAV。
- 语音接口的 `provider` / `model` / `protocol` 都是可选覆盖项，不传就完全沿用配置。

### 安装与启动

安装（默认 STT + TTS，会下载约 240MB 的 SenseVoice 模型）：

```bash
./model-proxy/install-voice.sh
```

按需裁剪：

```bash
./model-proxy/install-voice.sh --tts-only    # 只装 TTS，不下载模型
./model-proxy/install-voice.sh --stt-only    # 只装 STT，不装 edge-tts / ffmpeg
./model-proxy/install-voice.sh --proxy-only  # 只装基础依赖（仅用 LLM / 上游语音时）
./model-proxy/install-voice.sh --skip-model  # 装 STT 依赖但先不下载模型
./model-proxy/install-voice.sh --dry-run     # 只打印步骤，不实际安装或下载
```

后台管理：

```bash
./model-proxy/voice.sh start                 # 后台启动，默认 0.0.0.0:19529
./model-proxy/voice.sh start --port 9531     # 附加参数原样传给 start-voice.sh
./model-proxy/voice.sh status                # 是否在运行、监听端口、最近一行日志
./model-proxy/voice.sh check                 # 只做启动前依赖检查
./model-proxy/voice.sh log                   # 日志尾部（默认 80 行）
./model-proxy/voice.sh log -f                # 持续跟踪日志
./model-proxy/voice.sh restart               # 重新读取配置并重启
./model-proxy/voice.sh stop                  # 停止
./model-proxy/voice.sh run                   # 前台运行，Ctrl+C 停止
```

启动参数（`start` 后面可跟）：

```bash
--port 9531          # 换端口
--ip 127.0.0.1       # 只监听本机
--config /path/to/voice.conf
--require-api-key    # 启用鉴权（auto Key）
--api-key off        # 关闭鉴权（默认）
```

也可以跳过管理器直接前台运行：`./model-proxy/start-voice.sh`。
日志和 PID 在 `$VOICE_HOME/voice.log` / `$VOICE_HOME/voice.pid`。

### Windows

在 CMD 中执行（脚本就在 `model-proxy\` 下，不是 `scripts\`）：

```bat
model-proxy\install-voice.cmd
model-proxy\voice.cmd start
model-proxy\voice.cmd status
model-proxy\voice.cmd log
model-proxy\voice.cmd stop
```

`voice.cmd` 支持 `start / stop / restart / status / check / log / run`，参数与
macOS 版本语义一致，例如 `model-proxy\voice.cmd start -Port 9531`、
`model-proxy\voice.cmd log -f`；前台运行用 `model-proxy\start-voice.cmd`。

也可以直接调用 PowerShell 脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\model-proxy\install-voice.ps1
powershell -ExecutionPolicy Bypass -File .\model-proxy\install-voice.ps1 -TtsOnly
powershell -ExecutionPolicy Bypass -File .\model-proxy\install-voice.ps1 -SttOnly
powershell -ExecutionPolicy Bypass -File .\model-proxy\install-voice.ps1 -ProxyOnly
powershell -ExecutionPolicy Bypass -File .\model-proxy\install-voice.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\model-proxy\voice.ps1 start
powershell -ExecutionPolicy Bypass -File .\model-proxy\voice.ps1 start -Port 9531
powershell -ExecutionPolicy Bypass -File .\model-proxy\voice.ps1 status
powershell -ExecutionPolicy Bypass -File .\model-proxy\voice.ps1 log -f
powershell -ExecutionPolicy Bypass -File .\model-proxy\voice.ps1 check
powershell -ExecutionPolicy Bypass -File .\model-proxy\start-voice.ps1 -Port 9531
```

### 启动前依赖检查

`start` / `restart` / `check` 会先运行 `voice/preflight.py`。检查只读，不会安装、
下载或修改任何依赖；缺少依赖时服务不会启动，终端和 `voice.log` 里会打印
“缺什么 + 用哪条命令安装”。

检查内容：

- 所有模式：Python 3.10+、`fastapi` / `uvicorn` / `python-multipart` / `httpx`；
- 本地 STT：`sherpa-onnx`、`numpy`、SenseVoice 的 `model.int8.onnx` / `tokens.txt`，以及幻觉拦截用的 `silero_vad.onnx`（三者均由 install-voice 下载至 `models/sensevoice/`）；
- 本地 TTS：`edge-tts`、可执行的 `ffmpeg`；
- LLM 代理：启用时上游地址必须是 `http(s)://`；不检查本机 Ollama，也不需要本地模型；
- 远程同步：配了 `VOICE_REMOTE_DSN` 才会检查 Postgres 驱动，配了 `REDIS_URL`
  才会检查 Redis 客户端；未配置时跳过，不影响启动。

安装脚本会把当前模式写入 `$VOICE_HOME/install-mode`
（`full` / `tts-only` / `stt-only` / `proxy-only`）。`--tts-only` 或
`--stt-only` 装出来的服务，检查时会跳过未安装的那一类能力，不会因为
“本来就没装”而拒绝启动。

### 回归测试

```bash
cd model-proxy/voice
~/.app-product/voice/venv/bin/python tests/run_all.py

# 只跑文件名含指定子串的用例
... tests/run_all.py --only concurrency
# 纯离线回归：跳过依赖运行中服务的冒烟用例
... tests/run_all.py --skip-smoke
# 只列出用例
... tests/run_all.py --list
```

`run_all.py` 自动发现 `tests/test_*.py`，逐个独立进程运行并汇总；任一断言型用例
失败则退出码非 0。`test_ws_inference.py` 是连真实 19529 服务的冒烟脚本，没有断言，
所以额外扫描输出里的 `[异常]` / `Traceback`，避免假绿。

## Ollama（可选）

LLM 的可选上游之一；不装 Ollama 也能只用远程 LLM 与本地 STT / TTS。

### macOS / Linux

```bash
./model-proxy/install-ollama.sh
./model-proxy/pull-ollama-models.sh                  # 按 model-proxy/ollama-models.txt 下载
./model-proxy/pull-ollama-models.sh gpt-oss:20b      # 只下载指定模型
./model-proxy/pull-ollama-models.sh --dry-run        # 只打印清单，不联网
```

安装优先用 Homebrew；没有 Homebrew 时走 Ollama 官方 `install.sh`，都没有时提示
下载官方 `Ollama.dmg`。安装完成后打开 Ollama.app（或运行 `ollama serve`），下载
脚本会自动检测服务。

### Windows

```bat
model-proxy\install-ollama.cmd
model-proxy\pull-ollama-models.cmd
```

```powershell
powershell -ExecutionPolicy Bypass -File .\model-proxy\install-ollama.ps1
powershell -ExecutionPolicy Bypass -File .\model-proxy\pull-ollama-models.ps1 -DryRun
```

安装优先用 winget（`Ollama.Ollama`）；没有 winget 时下载官方 `OllamaSetup.exe`
静默安装。安装后如果当前终端找不到 `ollama`，新开一个终端刷新 PATH。

### 模型清单

`model-proxy/ollama-models.txt` 一行一个模型，`#` 开头为注释，空行忽略。默认是
`gpt-oss:20b`（约 13GB），内存较小的机器可改用清单里的 `qwen3:8b`。云端模型
（如 `gpt-oss:120b-cloud`）不占本地磁盘，但需要先执行 `ollama login`。

> 注意：`qwen3:8b` 官方旧模板不支持思考控制 / 工具调用。需要这两项能力时用
> `qwen3:8b-think`（见下方「模型能力与思考控制」）。

下载脚本在服务未启动时会自动后台拉起 `ollama serve`；`OLLAMA_HOST` 指向远端时
不会本地启动，只检查连通性。

### 接入方式

Ollama 跑在宿主、19529 网关跑在 docker 容器里，容器内的 `127.0.0.1` 指向自己、
连不上宿主 Ollama。地址按运行形态选：

- **容器（默认部署）**：`http://host.docker.internal:11434`（管理面板 LLM 池的地址
  用这个，不要用 `127.0.0.1`）；
- **宿主直跑**：`http://127.0.0.1:11434`。

两种协议可选：

- `openai_chat_completions` + 地址带 `/v1`：通用 OpenAI 兼容端点，适合不需要
  思考控制 / 工具调用的模型；
- `ollama`（原生 `/api/chat`）+ 地址**不带** `/v1`：**需要可控思考或工具调用时用它**。
  原生 `think:false` 能真正关闭 qwen3 等混合推理模型的思考（省推理 token、响应快），
  `tools` 工具调用也走这条路径。

在管理面板 LLM 池配置好即可被网关经 `/llm/v1` 使用，不需要改客户端配置。

### 模型能力与思考控制

| 模型 | 能力 | 说明 |
|---|---|---|
| `qwen3:8b`（Ollama 官方旧模板） | completion | 模板无 thinking 分支，`think:false` / `chat_template_kwargs` 都无效，每次都思考、思考链混在正文；**不支持工具调用** |
| `qwen3:8b-think`（本项目用官方新模板创建，复用 qwen3:8b 权重） | completion + thinking + tools | 模板带 `{{ .Thinking }}` 分支，`think:false` 真正关闭思考（只回 2 token），`think:true` 思考内容进 `reasoning_content`；支持 `tools` 工具调用 |

创建 `qwen3:8b-think`（复用已下载权重，不重新下载 5GB）：

```bash
# 模板取 Ollama 官方 qwen3:8b 新版模板（含 .Thinking / .Tools 分支），
# FROM 指向本地 qwen3:8b 的权重 blob，再用 ollama create 覆盖模板。
ollama show qwen3:8b --modelfile | grep '^FROM'   # 取 FROM 那行的 blob 路径
# 用该 blob 路径 + 官方新模板写 Modelfile，然后：
ollama create qwen3:8b-think -f /path/to/Modelfile
ollama show qwen3:8b-think                         # Capabilities 应含 tools + thinking
```

思考控制对外统一用 `X-Proxy-Think: 1|0`：

- 默认（不传或 `0`）：`think:false`，模型不思考，正文干净、响应快；
- `1`：开启思考，思考内容在 `reasoning_content`（OpenAI SSE 为 `delta.reasoning_content`），
  不污染正文。

> 注意：配置页「模型测试」弹窗的协议下拉已包含 `ollama` 原生选项。对 ollama 账号，
> 选中 `ollama` 后测试走原生 `/api/chat`，否则走 `/v1` 兼容端点会因 think 无效而变慢。

## 与网关的配置对应

客户端设置页把「语音来源 + 地址 + Key + 模型」随 `session.start.voice` 下发，
网关据此展开 ASR / LLM / TTS 的真实地址与模型。网关自己的默认地址（真机 / 无客户端
配置时兜底）在 `xiaoxiong-app/gateway/.env`：

```dotenv
# 可选：覆盖内置来源地址（默认就是 http://127.0.0.1:19529）
VOICE_BUILTIN_URL=http://127.0.0.1:19529
# 可选：覆盖 DashScope 官方云端入口；留空时用代码里的官方默认地址
VOICE_DASHSCOPE_URL=https://dashscope.aliyuncs.com
```

- 内置来源：ASR / TTS 打 `/voice/v1/*`，LLM 打 `/llm/v1/*`，Embeddings 打
  `/llm/v1/embeddings`；
- DashScope 来源：网关直接打百炼官方地址，不经过 19529；
- 真机联调时设备上的 `127.0.0.1:19529` 是**电脑**的服务，需要
  `adb reverse tcp:19529 tcp:19529`（见 `AGENTS.md`）。

服务默认监听 `0.0.0.0`；只在本机使用就把 `VOICE_HOST` 改成 `127.0.0.1`（或启动加
`--ip 127.0.0.1`）。需要局域网访问则保持默认并配好 `VOICE_IP_ALLOW` 白名单 +
`VOICE_API_KEY_AUTH=on`，详见上文「对外监听安全建议」。

## Linux

所有 `.sh` 脚本同样可用：

- Ollama 安装走官方 `install.sh`，其余流程一致；
- 本地 AI 服务的安装、`voice.sh start / stop / restart / status / check / log` 与 macOS 一致；
- 统一服务管理 `services.sh start / stop / restart / status / check / log` 与 macOS 一致；
- 语音服务依赖 Python 3.10+ 与 ffmpeg（用系统包管理器安装），模型 / 虚拟环境目录与 macOS 相同。

## OCR 文字识别（内置 PaddleOCR + DeepSeek）

独立能力前缀 `/ocr`（不放在 `/voice` 下），**单端口 19529、不加新端口**。
配置页「OCR」tab 与 ASR/TTS 同款表格，radio 选默认提供商：

| 提供商 | 说明 | 配置 |
|---|---|---|
| 内置引擎 | PaddleOCR / PP-OCRv5 本地识别 | 模型版本 `OCR_MODEL_VERSION`；先跑 install-ocr.sh |
| DeepSeek | 官方 Vision API（`deepseek-v4-flash-vision-exp`） | 填 `OCR_DEEPSEEK_API_KEY` + 模型 `OCR_DEEPSEEK_MODEL`，地址固定 api.deepseek.com |

```bash
./model-proxy/install-ocr.sh          # 装内置 PaddleOCR（paddlepaddle + paddleocr，钉住 numpy1.26 保护内置重排）
./model-proxy/install-ocr.sh --verify # 仅验证环境
# 面板「模型配置 → OCR」：与 ASR/TTS 同款表格，radio 选默认提供商，填对应配置
```

接口：
- `POST /ocr/v1/ocr`：`{"image": "<base64 图片或 PDF>", "provider": "builtin|deepseek", "max_pages": 20}`
  （provider 可省略用配置默认值；**图片/PDF 按魔数自动识别，无需 kind 参数**；max_pages 可选，PDF 页数上限 100）
  - 图片 → `{"ok": true, "kind": "image", "texts": [{text,score,box}], "full_text": "..."}`
  - PDF → `{"ok": true, "kind": "pdf", "page_count": N,
    "pages": [{"page": 1, "texts": [...], "full_text": "..."}], "texts": [...], "full_text": "..."}`
    （按页分组 + 顶层合并全文，业界通用结构；PDF 用内置引擎，DeepSeek 暂不支持 PDF）
- `GET /ocr/v1/models`：两个提供商的模型信息与默认项
- 面板「模型配置 → OCR」配置；「连通测试 → 文字识别 OCR」上传图片或 PDF 测试。

**架构说明**（重要）：torch2.2（内置重排）与 paddle3.0 的 C++ 扩展**无法同进程共存**
（同进程调用 OCR 会 segfault）。因此内置 OCR 在**短生命周期子进程**里跑
（`voice/ocr_worker.py`，从 stdin 读 base64、stdout 出 JSON），主服务进程只做调度，
**不监听额外端口**。DeepSeek 提供商走云端 API，不启子进程。
单次内置识别含模型加载约 2-3 秒，模型首次自动下载到 `~/.paddlex/official_models/`。
注意：Docker 镜像内 paddlepaddle 可能有 CPU 指令集问题（`Illegal instruction`），
容器内建议用 DeepSeek 提供商；本机跑内置 OCR 正常。

## Docker Compose（容器部署）

`Dockerfile` + `docker-compose.yml` 提供一键容器化部署（Python 3.12 全量依赖：语音 ASR/TTS +
LLM/Embed/Rerank 代理 + MCP 网关），基于 `python:3.12-slim`，系统层装 ffmpeg。

> 内置重排依赖（torch 2.2.2 + transformers 4.40）重量较大，首次构建会下载约 1GB+；
> 模型权重（SenseVoice）不进镜像，运行时从宿主挂载复用。
>
> **注意**：容器里不装 kokoro-onnx（本地离线 TTS 音色不可用，TTS 走在线 edge-tts）。
> 原因：kokoro 要求 numpy>=2.0.2，与重排的 torch2.2.2+numpy1.26.4 硬冲突；Docker 用
> `requirements-tts-docker.txt` 避开。本机非 Docker 安装仍用原 `requirements-tts.txt`（含 kokoro）。

```bash
cd model-proxy
docker compose up -d --build          # 构建并启动：model-proxy + redis + mysql（默认）
docker compose logs -f model-proxy    # 看启动日志（缓存/纠错库类型/鉴权状态）
docker compose down                   # 停止（数据卷 + 宿主目录都保留，不丢）
```

**默认配套服务**：redis（缓存 + 限流）、mysql（纠错词库）随 model-proxy 一起启动，
DSN 已自动注入容器（redis://redis:6379、mysql://voice:***@mysql:3306/voice）。
回退到纯 sqlite + 不用 Redis 缓存/限流：`CORRECTION_DB=sqlite CORRECTION_CACHE=memory RATE_LIMIT_BACKEND=memory docker compose up -d`。

数据与配置持久化：宿主 `~/.app-product/voice`（可用 `VOICE_HOME` 环境变量覆盖）整体挂到容器
`/data`，包含 `voice.conf` / `voice.db` / `models` / `api-key` / 日志。首次使用前先用
`./install-voice.sh` 在宿主下载好模型（或把已有 `~/.app-product/voice` 直接复用），容器启动即能用。

健康检查：`curl http://127.0.0.1:19529/health`；管理面板 `http://127.0.0.1:19529/admin`；
Swagger `http://127.0.0.1:19529/doc.html`。

### 配套服务与数据库类型

| 服务 | 默认 | 用途 | 配置 |
|---|---|---|---|
| redis | **默认启动** | 纠错缓存 + 限流令牌桶 | `REDIS_URL=redis://redis:6379/0`，连不上自动降级内存 |
| mysql | **默认启动** | 纠错词库 | `VOICE_CORRECTION_DB=mysql` + `VOICE_MYSQL_DSN`（已注入） |
| pgsql | 可选（profile） | 纠错词库可切 postgres | `docker compose --profile pgsql up -d`，再设 `CORRECTION_DB=postgresql` + `VOICE_REMOTE_DSN` |
| sqlite | 回退用 | 纠错词库默认非 docker | `CORRECTION_DB=sqlite` 回退，数据就是挂载目录里的 `voice.db` |

配套服务**不映射宿主端口**（容器间走服务名访问），所以不会占用本机已有的 6379/3306/5432。
需要宿主调试时再手动加 `ports`。密码用环境变量覆盖，不要用默认值上生产：

```bash
MYSQL_PASSWORD=your_pass MYSQL_ROOT_PASSWORD=your_root docker compose up -d
```

SQLite 是嵌入式数据库（就是 `voice.db` 文件），无需独立服务镜像，随宿主目录挂载即可。
注意：**核心数据（配置/API-Key/MCP/审计）始终用 SQLite**，mysql/pgsql 只承载纠错词库。
