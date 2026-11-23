# 重排（Rerank）Java 侧对接指南

> 对接对象：本项目（model-proxy）对外 `POST /rerank/v1/rerank`，协议见 `docs/rerank-unify-spec.md` §3。
> 消费方：`java-product`（askdata 问数）经 `java-framework`（fw-plus-ai-native）的 `RerankPort` 调用。
> 结论：**代码层面已兼容，无需再改 Java**；能否连通取决于 DB 里重排模型的配置是否按本文填写。

## 1. 协议对照（为什么能直接用）

| 层 | 本项目对外（规范 §3） | Java 框架 `RerankModelPort` COHERE Style | 一致？ |
|---|---|---|---|
| 端点 | `POST /rerank/v1/rerank` | 需把完整路径填给框架 endpoint（自动补路径按 style 会补 `/v1/rerank`，与实际不符，见 §2 apiDomain） | ✓ |
| 请求 | `{model, query, documents, top_n}` | 同款扁平字段 | ✓ |
| 响应 | `{results:[{index, relevance_score}]}` | 读 `results[].relevance_score`，按下标回填成稠密 `List<Double>` | ✓ |
| 分数 | 越大越相关，0~1 | 回填到等长数组、缺失补 0、失败全 0 降级 | ✓ |

框架 `RerankPort.score(query, documents)` 返回的是**与 documents 下标对齐的稠密数组**，本项目的稀疏 `results` 按下标回填即得——这正是框架 `scoreWith()` 已在做的事，无需额外转换。

## 2. Java 侧配置（关键）

重排模型信息存在 java-product 的模型配置库里，`FrameworkModelBridge.buildRerankPort` 用这些字段构建端口：

| 字段 | 填什么 | 说明 |
|---|---|---|
| `protocol` | **`COHERE`** | 必须是大写枚举名（`RerankProtocol.valueOf`）。填 `builtin`/`dashscope`/`rerank` 会构建失败并被静默跳过 |
| `apiDomain` | `http://<host>:19529` | 填**完整** `http://<host>:19529/rerank/v1/rerank`（框架自动补的 `/v1/rerank` 与新路径不符，必须给全） |
| `apiKey` | 留空 | 本项目默认未开鉴权 |
| `baseModel` | `bge-reranker-v2-m3`（内置） | 作为请求体 `model`；留空则用服务端默认模型 |

> 若走 TEI 兼容端点（与本机 9527 同协议），`protocol` 填 **`TEI`**，`apiDomain` 填**完整** `http://<host>:19529/rerank`（TEI 官方规范路径，不套本项目的 `/v1/{资源}` 格式），发 `{query, texts}` 收 `[{index, score}]`。

**连通探测**：`ChatModelClient.rerankUrls` 依次尝试 `{base}/rerank`、`{base}/v1/rerank`，并对带路径后缀的 base 增加根路径兜底——需确认 rerankUrls 探测能命中 `/rerank/v1`；当前自动补路径基于旧约定，建议直接给全 endpoint。

## 3. 本项目侧前置条件

1. 服务监听端口当前为 **19529**（`VOICE_PORT`，配置以 voice.db 为准）。
2. 配置页 **Rerank** tab 已配上游（当前预置：`内置 bge-reranker` + `DashScope`）。内置走本地 CrossEncoder，无需外部服务。
3. API-Key 鉴权默认关闭；若开启，Java 侧 `apiKey` 要填对应 Key。

## 4. 端到端验证

```bash
# 1) 直接验证对外端点（内置引擎）
curl -s -X POST http://127.0.0.1:19529/rerank/v1/rerank \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-reranker-v2-m3","query":"什么是重排模型",
       "documents":["重排模型对文档重新排序","今天天气很好","rerank 提升搜索相关性"],
       "top_n":3,"return_documents":true}'
# 期望：results 按 relevance_score 降序，相关文档在前、无关文档接近 0

# 2) TEI 兼容端点（与 9527 同协议）
curl -s -X POST http://127.0.0.1:19529/rerank \
  -H 'Content-Type: application/json' \
  -d '{"query":"什么是重排模型","texts":["重排模型对文档重新排序","今天天气很好"]}'
# 期望：[{index,score}, ...] 降序
```

Java 侧验证：在问数链路配置重排模型（`protocol=COHERE`、`apiDomain=http://host:19529`），跑一次带 rerank 的检索，确认召回文档顺序被正确调整；若框架日志出现"重排模型端口构建失败（跳过）"，先查 `protocol` 是否为大写枚举名。

## 5. 已确认的代码改动（无需再做）

- `java-framework` `RerankModelPort`：endpoint 未以 `/rerank` 结尾时按 Style 自动补 `TEI→/rerank`、`COHERE→/v1/rerank`；测试 `RerankModelPortTest` 5/5 通过。
- `java-product` `ChatModelClient.rerankUrls`：为带路径后缀的 base 增加根路径 `/v1/rerank` 探测兜底。

## 6. 对外契约与上游无关（重要）

**对外永远只有一种形状**（§3 的扁平 Cohere 风格），不管后端上游是谁：

| 上游 | 上游原生形状 | 出站翻译 | 对外形状 |
|---|---|---|---|
| 内置 bge-reranker | 本地 CrossEncoder 打分 | `builtin_rerank.to_cohere()` | §3 规范 |
| Cohere / Jina / 通用 | `{results:[{index,relevance_score}]}` | `rerank_to_cohere()` 直接归一 | §3 规范 |
| **DashScope** | `{results:[{document:{text},index,relevance_score}]}` | `rerank_to_cohere()` 把 `document.text` 拍平、字段归一、按分数降序 | §3 规范 |
| TEI（9527） | `[{index,score}]` | 经 TEI 规范端点 `/rerank` 独立暴露；走 `/rerank/v1/rerank` 时也归一成 §3 | §3 规范 |

即：**不需要为 DashScope 另加"Cohere 规范"或新线协议**——对外规范就是这一份，厂商差异全部在 `llm_protocols.rerank_to_cohere()` / `builtin_rerank.to_cohere()` 吸收。已实测：用模拟 DashScope 原生响应（`document` 为 `{text}` 对象、未排序）请求 `/rerank/v1/rerank`，对外返回的是拍平为字符串、按 `relevance_score` 降序、带 `usage` 的规范形状。

线协议层面：`rerank` 是通用 Cohere 兼容名，`dashscope` 是变体；两者都归一到同一对外形状，无需额外枚举。

## 7. 提供商 / 模型列表接口（type 查询）

对外有两个通用列表接口，用 `type` 参数区分能力类型（与 `/llm/v1/models` 的 `type` 字段一致），**不需要为 rerank 单独建接口**：

每种能力有**独立前缀**的提供商/模型接口（与各自端点前缀一致），也有通用的 `type` 查询接口：

| 接口 | 用途 |
|---|---|
| `GET /rerank/v1/providers` | 列重排提供商（vendor/protocol/model/host，脱敏无密钥） |
| `GET /rerank/v1/models` | 列重排模型（条目 type 字段=RERANK） |
| `GET /embed/v1/providers` | 列向量提供商 |
| `GET /embed/v1/models` | 列向量模型（条目 type 字段=EMBED） |
| `GET /llm/v1/providers` | LLM 提供商（不带 type 参数） |
| `GET /llm/v1/models` | 全集模型（不带 type 参数） |

- 各能力用独立前缀接口，通用 `/llm/v1/*` 接口**无 type 参数**。
- 每个 provider 条目带 `type` 字段。内置引擎条目 `base_url` 为空（走本地 CrossEncoder），已特殊处理使其能被列出。

```bash
curl -s 'http://127.0.0.1:19529/rerank/v1/providers'
# {"providers":[{"vendor":"builtin","protocol":"builtin","model":"bge-reranker-v2-m3","host":"","type":"RERANK"}, ...]}

curl -s 'http://127.0.0.1:19529/rerank/v1/models'
# {"data":[{"id":"bge-reranker-v2-m3","type":"RERANK", ...}]}
```

> 注：`/llm/v1/models` 返回全类型并集（LLM/EMBED/RERANK），客户端可自行按 `type` 字段过滤；独立前缀接口内部复用同一套过滤逻辑。

## 8. 口径差异备忘

Java 内部是**稠密分数数组**，本项目对外是**稀疏 `{index, score}` 列表**；两者按下标回填等价。将来若要把本项目结果交给 Java，按 `results[].index` 回填成等长数组、缺失补 0 即可（与 Java `scoreWith()` 一致）。
