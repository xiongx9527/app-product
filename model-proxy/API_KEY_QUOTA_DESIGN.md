# 19529 按 API-Key 用量统计 + 配额限制设计（C 方式）

> 状态：设计稿，未实施（2026-11-20）。目标：按 api-key 统计 LLM / TTS / ASR 使用量，并对超配额的 key 限流/拒绝。
> 适用：`model-proxy/voice/`（19529 本地语音/LLM 代理）。

## 一、现状与前提

当前鉴权（`openai_voice_server.py`）：

- `VOICE_API_KEY_AUTH=on` 开启鉴权；`VOICE_API_KEY` 支持多 key（逗号/换行/空格分隔），**任一命中即通过**；`auto` 模式生成单把随机 key 写到 `$VOICE_HOME/api-key`。
- `security_middleware`（`:758-775`）只判断"token 在不在集合里"，**不区分是哪一把**——没有身份维度。
- 现有存储：`config_kv`（配置真相源）、`events` / `audit`（事件/审计）、`schema_version`（版本留痕），均在 `voice_db.py`；另有可选 Postgres/Redis（`voice_sync.py`）。
- 三个计量接口：`/llm/v1/chat/completions`（`:3084`）、`/voice/v1/audio/speech`（`:2234`）、`/voice/v1/audio/transcriptions`（`:2416`）；WS `/voice/ws/inference`（`:2636`）也有鉴权。

**核心前提**：要做"按 key + 配额"，必须给每把 key 一个**身份标识 + 独立限额**。现在是一把/一组共享钥匙，统计只能到全局总量。本设计把 key 从"明文集合"升级为"带属性的对象"。

## 二、数据模型

### 1. API Key 配置（替代/并存于 VOICE_API_KEY）

新增配置（真相源仍走 SQLite `config_kv`，key 名 `api_keys_json`，值为 JSON 数组）。每项：

```json
{
  "key": "sk-xxxx",              // 实际 token（鉴权用）；auto 模式下也存这里
  "name": "小熊App-iOS",          // 备注/身份名，统计展示用
  "enabled": true,               // 是否启用
  "quota": {                     // 每周期配额；null=不限
    "period": "month",           // month | day | total（total=累计不清零）
    "llm_tokens": 1000000,       // LLM token 上限
    "tts_chars": 500000,         // TTS 字符上限
    "asr_seconds": 18000         // ASR 音频秒上限
  }
}
```

- 兼容：`api_keys_json` 为空时，沿用现有 `VOICE_API_KEY` / auto 单 key 行为（无配额、不区分身份），**升级不 breaking**。
- key 不明文落审计日志：统计里只存 `key_hash`（`sha256(key)[:16]`）或配置里的 `name`，不存 token 原文。

### 2. 用量记录表 `usage_records`（SQLite，新表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTO | |
| ts | INTEGER NOT NULL | 毫秒时间戳 |
| key_hash | TEXT NOT NULL | key 身份（sha256 前 16 位） |
| key_name | TEXT | 配置里的备注名（冗余，便于展示） |
| kind | TEXT NOT NULL | `llm` / `tts` / `asr` |
| amount | REAL NOT NULL | 计量值：token / 字符 / 秒 |
| unit | TEXT NOT NULL | `token` / `char` / `second` |
| upstream_ok | INTEGER NOT NULL DEFAULT 1 | 上游调用是否成功（失败是否计费见第七节） |
| meta | TEXT | JSON：模型名、路由分组等 |

索引：`idx_usage_key_ts(key_hash, ts)`、`idx_usage_kind_ts(kind, ts)`。

按 `SCHEMA_CHANGES` 登记新版本（当前 `SCHEMA_VERSION=7` 但变更表到 v8，见 `DB_SCHEMA.md` 注意项——本次要顺手修正这个不一致），version +1，加 `CREATE TABLE usage_records` 到 `ensure_schema()`。

### 3. 周期聚合（可选，高频场景）

若请求量大，加 `usage_daily` 按 `(key_hash, kind, day, model)` 预聚合，避免每次配额检查都全表扫描 `usage_records`。低频个人用量直接查 `usage_records` 即可，先不上。

## 三、鉴权中间件改造（识别身份）

`security_middleware`（`:758-775`）：

1. 校验通过后，把**匹配到的那把 key** 记录到 `request.state.api_key_hash` / `request.state.api_key_name`（现在是 `any(...)` 命中即过，改成找到命中的那一项取属性）。
2. auto / 旧 `VOICE_API_KEY` 兼容路径：没有专属配置时，`key_hash = sha256(token)[:16]`、`key_name = "default"`、quota=null（不限）。
3. 鉴权关闭时：不统计（无身份）——或按需统计到 `anonymous`，二选一，默认不统计。

WS 中间件（`:2636-2642`）同样处理：`websocket.state.api_key_hash`，供流式 TTS/ASR 埋点。

## 四、三个 handler 埋点（计量）

统一封装一个 `record_usage(request, kind, amount, meta, upstream_ok)`（内部 `asyncio.to_thread` 写库，不阻塞事件循环，参考 `client_ip_audit_middleware` 的写法）。

| 接口 | 计量值 | 取法 | 备注 |
|---|---|---|---|
| LLM `/llm/v1/chat/completions` | token 数 | ✅ **已打通（2026-11-20）**：非流式读响应 `usage`；流式对 openai/azure 自动注入 `stream_options.include_usage=true`、translator 旁路抓末帧；anthropic/gemini/ollama/responses 各翻译器旁路抓自身 usage；拿不到回退字符估算。日志走 `uvicorn.error` 的 `[llm-usage]`，非流式响应头带 `X-Usage-*`。当前**未落库、未做配额**（按"先只解析+日志/响应头"交付）。后续接配额时从这里读 usage 即可 |
| TTS `/voice/v1/audio/speech` | 输入字符数 | `len(body.input.strip())` | 与 DeepSeek/计费口径一致；缓存命中是否计费见第七节 |
| ASR `/voice/v1/audio/transcriptions` | 音频秒数 | 已有 `duration`（`x.size / SAMPLE_RATE`，`:2185`）或 `speech_duration`（VAD 真语音秒，`:1141`） | 建议用 `duration`（上传音频时长，计费口径），`speech_duration` 仅做幻觉判断 |
| WS `/voice/ws/inference` | TTS 字符 / ASR 秒 | 在 task-finish 事件里按 task 类型取 | 复杂度较高，可二期做 |

LLM token 的关键决策：上游若是 OpenAI 兼容且支持 `stream_options: {include_usage: true}`，在 SSE 末尾能拿到 `usage.prompt_tokens/completion_tokens`；本地 Ollama 也返回 usage。**建议强制向上游请求 usage**，拿不到再回退估算。

## 五、配额检查（C 的核心）

封装 `check_quota(key_hash, kind, amount) -> bool`：

1. 取该 key 的 `quota`（无配置→放行）。
2. 按 `period` 算窗口起点：month=当月 1 号 0 点、day=当天 0 点、total=0。
3. `SELECT SUM(amount) FROM usage_records WHERE key_hash=? AND kind=? AND ts>=?`。
4. 已用 + 本次 > 限额 → 拒绝，返回 `429` + JSON `{detail: "配额超限", kind, used, limit, reset_at}`；否则放行并记账。

检查放在**鉴权之后、业务逻辑之前**（中间件或 handler 入口），避免超限请求还打到上游。注意：
- **原子性**：检查与记账要在同一把锁内（复用 `voice_db._lock` 或新增 `usage_lock`），防止并发下多个请求同时通过检查。
- **先扣后调 vs 先调后扣**：建议"先检查 + 预扣，上游失败则冲正"或"先检查、调用后记账"——简单起见可"检查通过后调用，调用成功后记账"，代价是并发下可能短暂超额（可接受）。精确限流用预扣 + 冲正。
- **超限响应**：TTS/ASR/LLM 统一 429，客户端（19529 网关）已有失败兜底提示音链路，超限表现为"服务拒绝"而非静默。

## 六、管理面板展示

新增一个"用量统计"页面（或并入现有管理面板）：

- 按 key（name）+ 时间范围列出：LLM token / TTS 字符 / ASR 秒、请求次数、最后使用时间。
- 每个 key 显示配额进度条（已用/限额，剩余，重置时间）。
- 支持按 kind 筛选、清空历史（可选）。
- 后端接口：`GET /admin/api/usage?key=&kind=&from=&to=` 返回聚合结果；`GET /admin/api/usage/keys` 返回 key 列表 + 配额。

## 七、口径与边界决策（需拍板）

1. **失败计费**：上游调用失败（LLM 报错 / TTS 合成失败 / ASR 超时）算不算用量？建议 TTS/ASR **只记成功**，LLM 按实际消耗 token 记（即使生成失败也可能已消耗）。
2. **缓存命中**：TTS `tts_cache` 命中不产生上游调用——算不算字符数？建议**算**（按请求量统计），或分开记 `upstream_ok=0` 便于区分。
3. **LLM 无 usage 回退**：拿不到 token 时按字符估算（中文≈1字符≈1token，英文≈4字符≈1token），并在 meta 标 `estimated:true`，避免统计口径不可信。
4. **鉴权关闭时**：是否统计匿名用量？默认不统计（无身份维度，意义不大）。
5. **重置时区**：month/day 按本地时间还是 UTC？按服务器本地时间（用户直觉）。
6. **WS 二期**：流式 TTS/ASR 的统计放二期，一期只覆盖 HTTP 三接口。

## 八、实施步骤

1. `voice_db.py`：`ensure_schema()` 加 `usage_records` 表 + 索引；`SCHEMA_CHANGES` 登记新版本并修正 v7/v8 不一致；加 `record_usage()` / `sum_usage()` 数据访问函数。
2. `openai_voice_server.py`：新增 `api_keys_json` 配置解析（带 name/quota）；改造两个鉴权中间件写 `request.state`；封装 `record_usage` / `check_quota`；三个 handler 埋点 + 配额检查；LLM 强制请求 usage。
3. `admin_panel.py`：key 管理（name / quota 编辑）+ 用量统计页 + 两个 admin API。
4. `voice/seed/*` 或配置模板：`voice.conf.example` 说明 `api_keys_json` 格式（或管理面板引导）。
5. 测试：单测配额边界（刚好等于 / 超 1 / 重置）、并发不超额、三类计量口径、鉴权关闭不统计；集成测试三接口 + 429。
6. 文档：更新 `DB_SCHEMA.md`（新表 + 版本）、`README.md`（api-key 配额用法）。

## 九、工作量评估

| 模块 | 改动量 | 难度 |
|---|---|---|
| SQLite 新表 + 数据访问 | 小 | 低 |
| 鉴权中间件识别身份 | 中 | 低 |
| 三 handler 埋点 | 中（LLM usage 解析是难点） | 中 |
| 配额检查 + 429 | 中（并发原子性） | 中 |
| 管理面板 | 中 | 中 |
| WS 流式（二期） | 大 | 高 |

一期（HTTP 三接口 + 配额 + 面板）可交付；二期补 WS。

## 十、一句话总结

把 api-key 从"共享字符串"升级为"带 name + quota 的对象"，鉴权时识别身份、三个 handler 按 token/字符/秒计量、查 `usage_records` 做周期配额检查、超限 429，管理面板展示进度——基础设施（SQLite/鉴权/事件表）都现成，主要新增是 `usage_records` 表、LLM usage 解析和面板页。
