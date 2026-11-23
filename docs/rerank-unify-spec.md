# 重排（Rerank）统一规范（讨论稿）

> 状态：规范草案，**未实施**。日期 2026-11-22。
> 背景：Java 权威源 `fw-plus-ai-native` 的 `ModelType` 有 LLM / EMBEDDING / RERANK 三端口；本项目（语音代理）的 `ModelType` 是 LLM / EMBED / TTS / STT，没有 RERANK，也没有 rerank 接口/协议。
> 已定（2026-11-22 确认）：
> ① 范围=先定规范、不写代码；
> ② 请求/响应格式以 **Cohere 事实标准**为准（OpenAI 无官方 rerank 规范）；
> ③ token 限流维度**一起考虑**：加 `rerank_tokens_per_min`，与现有 `embed_tokens_per_min` 对称（见 §5.1）；
> ④ 上游厂商**先不锁定**，规范写通用形状，具体出站翻译变体等实施时按实际上游补；
> ⑤ Java 权威源已核对（`/Users/xiongxiao/Workspace/Idea/codes/java-framework`）：`RerankPort.score(query,documents)` 返回**与 documents 下标对齐的稠密分数数组** `List<Double>`（0~1、等长，缺失补 0、失败全 0 降级）；对下游厂商用两种 Style：`TEI`({query,texts}→[{index,score}])、`COHERE`({model,query,documents,top_n}→{results:[{index,relevance_score}]})。本项目对外契约仍取 §3 的 Cohere 风格（用户定、多厂商兼容），与 Java 稠密数组口径的调和见 §6。
> 目的：为将来把 rerank 纳入本项目统一框架（模型目录 + 线协议 + 上游池 + 接口 + 面板）提供一份可执行的契约，避免各家格式漂移。

## 1. 为什么需要规范

- OpenAI 官方 API **没有** rerank 端点（只有 `/v1/embeddings`），不存在"OpenAI rerank 规范"可直接照抄。
- 社区与主流厂商（Cohere、DashScope、Infinity 等）形成了事实标准：`POST /v1/rerank`（本项目对外统一暴露为 `POST /rerank/v1/rerank`，独立 `/rerank` 前缀，与 `/llm`、`/embed` 并列），但字段名/响应结构各自有差异。
- 本项目已有统一抽象：`model_catalog.ModelType`、`upstream_pool`（按 cap 分池）、`llm_protocols`（线协议翻译）。rerank 要纳入就得定清楚：用哪个 cap、哪个线协议、请求/响应长什么样。

## 2. 统一目标（三端口对齐）

| 层 | Java 权威 | 本项目现状 | 目标 |
|---|---|---|---|
| 模型目录 | LLM / EMBEDDING / RERANK | LLM / EMBED / TTS / STT | `ModelType` 加 `RERANK`（与 EMBED 并列，不替换 TTS/STT） |
| 线协议 | 有 RERANK | 无 | `llm_protocols` 加 rerank 线协议（见 §4） |
| 上游池 | — | LLM / EMBED 两个 cap | 加 `RERANK` cap（`RERANK_UPSTREAM_POOL`），复用 `upstream_pool` |
| 接口 | — | `/llm/v1/chat/completions`、`/embed/v1` | 加 `/rerank/v1`（见 §3） |
| 面板 | — | LLM / Embed / ASR / TTS 四个 tab | 加 Rerank 配置 tab（将来实施时） |

## 3. HTTP 接口（Cohere 风格事实标准）

### 3.1 端点

```
POST /rerank/v1
Content-Type: application/json
```

### 3.2 请求体

```json
{
  "model": "bge-reranker-v2-m3",
  "query": "什么是重排模型",
  "documents": ["文档一内容", "文档二内容", "文档三内容"],
  "top_n": 2,
  "return_documents": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 重排模型名；留空用该提供商在该 cap 下的默认模型 |
| `query` | string | 是 | 查询文本 |
| `documents` | string[] | 是 | 待重排的文档列表 |
| `top_n` | int | 否 | 返回前 N 条；缺省返回全部，按相关性降序 |
| `return_documents` | bool | 否 | 结果里是否回带原文，默认 false |

### 3.3 响应体

```json
{
  "model": "bge-reranker-v2-m3",
  "results": [
    {"index": 1, "relevance_score": 0.9123, "document": "文档二内容"},
    {"index": 0, "relevance_score": 0.7611, "document": "文档一内容"}
  ],
  "usage": {"total_tokens": 128, "prompt_tokens": 128}
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 实际使用的模型名 |
| `results` | array | 按 `relevance_score` 降序；`index` 为原 `documents` 下标 |
| `results[].index` | int | 原文档索引（从 0 开始） |
| `results[].relevance_score` | float | 相关性分数，越大越相关 |
| `results[].document` | string | 仅 `return_documents=true` 时回带 |
| `usage` | object | token 计量（统计口径，与现有 `X-Usage-*` 一致） |

### 3.4 错误

沿用现有 `error_response` 约定：400 参数错误（query/documents 缺失或 documents 为空）、404 模型不存在、501 线协议不支持 rerank、502 上游失败。

### 3.5 主流厂商格式对照（调研结论，2026-11-22）

调研 Cohere 官方文档、阿里云百炼文档、本机 ragflow / mem0 实现，对照如下：

| 厂商 | 端点 | 请求形状 | 响应形状 |
|---|---|---|---|
| **Cohere v2** | `POST /v2/rerank` | `{model, query, documents[], top_n, max_tokens_per_doc, relevant_spans}` | `{results:[{index, relevance_score, relevant_spans?}], id, meta:{api_version, billed_units}}` |
| **DashScope qwen3-rerank**（OpenAI 兼容端点） | `POST /compatible-api/v1/reranks` | `{model, query, documents[], top_n, return_documents}`（扁平） | `{object:"list", results:[{document:{text}, index, relevance_score}], model, id, usage:{total_tokens}}` |
| **DashScope 其它**（gte/qwen3.7） | `POST /api/v1/services/rerank/text-rerank/text-rerank` | `{model, input:{query, documents}, parameters:{top_n, return_documents}}`（嵌套） | `{output:{results:[{document:{text}, index, relevance_score}]}, usage}` |
| **Jina**（ragflow 用法） | `POST /v1/rerank` | `{model, query, documents, top_n, return_documents}` | `{results:[{index, relevance_score, document}]}` |
| **mem0 Cohere** | SDK `cohere.Client` | `rerank(query, documents, top_k)` | 转成 `{memory, rerank_score}` |

**关键结论**：
- §3 定的形状（扁平 `query/documents/top_n/return_documents` → `results:[{index,relevance_score,document}]`）与 **Cohere v1 风格 / Jina / DashScope qwen3-rerank OpenAI 兼容端点**三家天然一致——按此定，入站零翻译即可对接多数厂商。
- **Cohere v2** 把 `document` 去掉（只回 `index`）、token 计量从 `usage` 移到 `meta.billed_units`；**DashScope 原生端点**用 `input`/`parameters` 嵌套。这些差异由 §4 出站翻译层吸收。
- token 字段各家不一：`usage.total_tokens`（DashScope OpenAI 兼容）/ `meta.billed_units`（Cohere v2）/ 无（Jina）。§3.3 统一成 `usage`，出站时按厂商映射。

## 4. 线协议（llm_protocols）

- 新增线协议名：`rerank`（或具体厂商变体如 `cohere_rerank`）；归入 `WIRE_PROTOCOLS`。
- 新增 `prepare_rerank(protocol, base, api_key, model, body) -> (UpstreamRequest, resp_transform)`：
  - **入站固定**为 §3 的 Cohere 风格形状；**出站**按线协议翻译（不同厂商路径/字段不同）。
  - Cohere v2 原生：`POST /v2/rerank`，出参 `meta.billed_units` → 归一化成 §3.3 `usage`。
  - DashScope OpenAI 兼容：`POST /compatible-api/v1/reranks`，扁平字段，原生几乎就是 §3 形状（仅 `document` 为 `{text}` 对象，需拍平成字符串）。
  - DashScope 原生端点：`POST /api/v1/services/rerank/text-rerank/text-rerank`，入站 §3 扁平形状 → 出站转 `input`/`parameters` 嵌套，出参 `output.results` → §3.3。
  - Jina / 通用 Cohere v1：`POST /v1/rerank`，字段同名，直接透传。
  - 不支持 rerank 的线协议（anthropic/gemini/ollama/responses）→ 501。
- 响应翻译统一成 §3.3 形状：`relevance_score`/`index`/`document`；厂商返回的 `score`/`relevance`/`text` 等做归一化。

## 5. 配置与模型目录

- 上游池：`RERANK_UPSTREAM_POOL`（与 `LLM_UPSTREAM_POOL` / `EMBED_UPSTREAM_POOL` 同构），字段 `vendor` / `protocol` / `model` / `base_url` / `api_key`。
- 默认模型：`RERANK_UPSTREAM_VENDOR` / `RERANK_UPSTREAM_MODEL` / `RERANK_UPSTREAM_DEFAULT_MODELS`（按提供商维度）。
- 模型目录：`rerank_catalog()` 仿 `embed_catalog()`，从 `RERANK` 池合成 `ModelInfo(type=RERANK)`，`/llm/v1/models` 并集展示（对话校验仍只用 `llm_catalog()`）。
- 名称口径：本项目统一用「RERANK」大写（与 ModelType 一致），面板显示 `Rerank`；与 Java `RERANK` 对齐，`ModelType.RERANK` 常量值取 `"RERANK"`。

### 5.1 token 限流维度（已定：一起考虑）

- 新增限流维度 `rerank_tokens_per_min`，与现有 `embed_tokens_per_min` 对称：
  - `rate_store.KINDS` 加 `"rerank_tokens"`；
  - `voice_db.rate_policies` 加列 `rerank_tokens_per_min`（schema v16，默认 0）+ 内置策略播种默认值（建议 `RATE_LIMIT_DEFAULT_RERANK_TOKENS`，默认 50000）+ `rate_binding_effective` 合并；
  - 面板限流策略表格/表单加 Rerank 列与输入。
- 埋点：`/rerank/v1` 按入站 `query` + `documents` 估算 token（复用 `_estimate_tokens_chars`），`check_and_consume(key_id, "rerank_tokens", limit, cost=est)`，超限 429（kind=`rerank_tokens`）；鉴权关闭无 key_id 时放行（与 Embed 一致）。
- 计量口径：用**入站估算**（请求尚未发出），与 Embedding 限流同策略；不依赖上游 `usage` 字段，避免各家字段漂移（见 §3.5）。

## 6. 与 Java 权威源的关系（已核对源码）

Java 权威源路径：`/Users/xiongxiao/Workspace/Idea/codes/java-framework`。核心契约：

- `RerankPort.score(query, documents)` → `List<Double>`：**与 documents 下标对齐的稠密分数数组**（0~1、等长），不是 `{index, score}` 列表；缺失下标补 0、失败返回全 0 数组降级（让检索链路可继续）。
- `RerankModelPort` 对下游厂商两种 Style（枚举 `RerankProtocol` / `RerankVendor` 均含 `TEI` / `COHERE`）：
  - `TEI`：`{query, texts, return_text}` → `[{index, score}]`（HuggingFace text-embeddings-inference `/rerank`）
  - `COHERE`：`{model, query, documents, top_n}` → `{results:[{index, relevance_score}]}`（Cohere / Jina `/v1/rerank`、`/v2/rerank`）
  - 两者都把厂商的稀疏降序结果**回填成与输入顺序对齐的稠密数组**。

**口径差异与调和**：

- §3 对外契约采用 Cohere 风格（**稀疏** `results:[{index, relevance_score}]`）——这是用户定的、且被 Cohere/Jina/DashScope OpenAI 兼容端点多方天然兼容的形状。
- Java 内部口径是**稠密分数数组**。两者本质等价（稀疏列表按下标回填即得稠密数组），且 Java `RerankModelPort` 本身就在做这个回填。
- 将来本项目若要把结果交给 Java 侧，桥接方式明确：**按下标回填成等长数组、缺失补 0**——与 Java `scoreWith()` 的实现完全一致，无需额外转换设计。
- 因此 §3 与 Java 权威源**不冲突**，只是表达粒度不同；实施时对外出 §3 形状、对内（对接 Java 时）按下标回填即可。

**结论**：规范维持 Cohere 风格对外，不需要因 Java 源码而修改 §3；Java 稠密数组作为"内部/下游对接口径"记录于此。

## 7. 不在本次范围

- 不改任何代码（model_catalog / llm_protocols / upstream_pool / openai_voice_server / 面板 / rate_store / voice_db）。
- 不实现 `/rerank/v1` 端点、线协议、面板 tab、限流列。
- 不接具体厂商上游——§3.5 的厂商对照是调研结论，供实施时写出站翻译，本次不落地。

## 8. 待确认项（已全部确认，2026-11-22）

1. ~~Java 权威源 RERANK 契约~~ → **已核对**（见 §6）：`RerankPort` 稠密数组口径，与 §3 稀疏列表按下标回填等价，不冲突，无需改 §3。
2. 具体 rerank 上游 → **先不锁定**：§3 形状与 Cohere v1 / Jina / DashScope qwen3-rerank OpenAI 兼容端点天然一致；具体变体实施时按实际上游补（§4 已列出各变体映射）。
3. token 限流维度 → **加 `rerank_tokens_per_min`**，与 embed 对称（见 §5.1）。

以上三项已定，规范定稿。后续实施以本文档为依据；若接入的实际上游契约与本规范有出入，按 §6 的"以 Java 为权威、差异在出站翻译层吸收"原则处理。
