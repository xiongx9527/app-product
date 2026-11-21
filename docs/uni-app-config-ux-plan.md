# uni-app 配置人性化方案（讨论稿）

> 状态：讨论，未实施。日期 2026-11-21。
> 目标：消除 uni-app 手动配置负担——用户不用填 URL/Key/模型/MCP server，开箱即用。
> 用户拍板：①App 不自己加 MCP server，默认连 9529 的 MCP server（前提是 MCP 开关开了）；
> ②首次启动自动、不打扰用户；③先讨论方案，暂不动手；
> ④App 连 9529 MCP **需要 API-Key**（2026-11-21 确认）；
> ⑤自动加入的 MCP server **用户完全看不到**，用户后续也不手动加 MCP server，
>   **删除手动添加 MCP server 的页面**（2026-11-21 确认）；
> ⑥用户侧 MCP 交互**只要一个开关**（`settings.vue` 的 MCP 开关），无其它 MCP 相关 UI（2026-11-21 确认）。

## 一、需求理解（请确认）

用户说「uni-app 都是手动自己配置、不人性化」，结合 MCP 网关讨论，核心诉求是：

- **MCP server 不用手填**：现在 `mcpservers.vue` 要纯手动填 name/transport/url/headers，普通人不会配。
  改成——**保留 settings.vue 里唯一一个 MCP 开关**：打开则 App 内部自动接入 9529 MCP，
  用户完全看不到这个 server，也无需手动加 MCP server；删除 MCP server 管理页，零输入。
- 这样 App 通过 9529 网关（中转 Java 问数）就能用上问数能力，全程无感。
- 语音配置（LLM/ASR/TTS 的 url/key/模型）是否也要自动拉网关配置——**待确认**（见第六节）。

## 二、现状（探索结论）

- 设置页 `settings.vue` 1331 行，6 个折叠组，配置项多。
- 技术参数（普通人不会填）：`url`、`apiKey` 纯手输；模型/音色下拉要先填对 url/key 才能拉到。
- 已有自动能力：模型/音色从网关下拉、builtin 有公网默认值 `https://25946kt718.goho.co`、
  密钥由网关托管、网关地址自动发现（`gatewayBootstrap.ts` 的 `getGatewayWsUrl()`）。
- **缺口**：网关有 `GET /api/admin/config` 能下发，App 却从没调用（`onSave` 只 POST 不 GET），
  没有配置下发闭环；`runDetection` 只检测不配置；无首次引导向导；无配置导入导出。
- MCP 页 `mcpservers.vue`：纯手填，存 `appConfig.mcp.servers`，经 `session.start` 下发网关——**本期删除该页面**。
- 存储：`core/config/storage.ts`，key `app-product.config.v1`，`normalizeConfig()` 补默认。

## 三、方案

### Part A：MCP server 自动接入（本次核心）
1. **默认 MCP server**：MCP 开关（`settings.vue` L845）打开时，内部自动接入 9529 MCP——
   `name=app-product-gateway`、`transport=sse`、`url=<9529 MCP endpoint>`、
   headers 带 9529 的 API-Key（需要鉴权；Key 来源见第六节衍生待定）。
   - **工具授权走网关「默认工具」**：9529 MCP 网关按 Key 隔离工具（单工具粒度，详见
     `docs/mcp-gateway-plan.md`）。App 内部这个 Key **不单独配置专属工具授权**——
     只要管理员在网关侧把问数等工具勾选为「默认工具」（支持多个，对所有 Key 自动生效），
     App 一连上就自动拿到这些工具，开箱即用；无需 App 侧或用户再做任何工具配置。
2. **地址推导**：用现有网关地址发现能力（`gatewayBootstrap.ts` 的 `getGatewayWsUrl()`）拿到
   网关 host/port，拼出 `/mcp` 的 SSE URL；不写死 IP。
3. **用户完全不可见 + 唯一开关入口**（2026-11-21 定）：自动加入的 server 不出现在任何 UI 列表里，
   不提供查看/编辑/删除入口；**删除 `mcpservers.vue` 手动添加页面**（含路由/导航入口清理）；
   **用户侧只保留 settings.vue 里唯一一个 MCP 开关**（开=内部接入、关=内部移除），
   不做「问数预置技能/工具」等任何额外 UI；因此也不做「默认项展示/保护」「删除后自动重加」等逻辑，
   全程由 App 内部托管。
4. **开关关闭**：内部移除该 server；不存在用户自定义 server 受影响的问题。
5. **依赖**：**需 9529 的 `/mcp` 端点先实现**（当前 MCP 网关还是讨论稿未实施）→ 实施顺序：
   先做 MCP 网关（`docs/mcp-gateway-plan.md`），再做 App 自动接入。

### Part B：语音配置自动拉网关（待确认是否本期）
- App 首次启动/建连后调 `GET /api/admin/config`，自动填充模型/Key/音色，用户零输入。
- `runDetection` 升级为「一键配置」：检测通过就应用推荐配置。
- 失败才降级到手动（高级设置里展开）。

### Part C：引导（简化）
- 用户选「自动、不打扰用户」——不做首次弹窗向导；自动流程后台跑，仅失败时给行内提示。

## 四、关键文件
- `xiaoxiong-app/uni_app/src/pages/settings/settings.vue`（MCP 开关 + 自动接入触发）
- `xiaoxiong-app/uni_app/src/pages/mcpservers/mcpservers.vue`（**删除**：用户手动添加 MCP server 的页面，含路由/导航清理）
- `xiaoxiong-app/uni_app/src/core/config/storage.ts`（createDefaultMcp / 内部自动加入逻辑）
- `xiaoxiong-app/uni_app/src/core/transport/gatewayBootstrap.ts`（网关地址 → MCP URL）
- `xiaoxiong-app/gateway/src/controller/apiController.ts`（GET /api/admin/config 已有）

## 五、风险与注意
- **依赖顺序**：App 自动连 MCP 依赖 9529 网关 `/mcp` 端点，必须先做网关。
- **唯一入口 = 开关**：用户侧只有 settings.vue 一个 MCP 开关，无其它 MCP 相关 UI（不展示 server、不加 server、不做问数预置技能）。
- **地址来源**：不写死 IP，用网关发现；H5/真机/局域网不同环境下 URL 要正确。
- **鉴权**：App 连 9529 MCP **需要带 API-Key**（已定，2026-11-21）。`/mcp` 走 9529 的
  VOICE_API_KEY + IP 白名单，与 /voice /llm 一致；App 侧如何拿到该 Key 待定（见第六节）。
- **工具可见性**：网关按 Key 隔离工具；App 这个 Key **依赖网关的「默认工具」**（支持多个、对所有 Key
  自动生效），无需单独配专属授权。上线前须确认问数等目标工具已勾选为默认，否则 App 拿到空工具列表。
- **国际化**：新增文案走 i18n（沿用偏好）。

## 六、待确认
1. 语音配置（LLM/ASR/TTS 的 url/key/模型）是否本期也自动拉网关配置？还是只做 MCP 自动接入？
2. ~~自动加入的 MCP server 能否删除？删除后开关开着是否自动重加？~~ **已定：用户看不到、也不手动加 MCP server，手动添加页面删除**，由 App 内部托管，无删除/重加概念（2026-11-21）。
3. ~~App 连 9529 MCP 是否需要 API-Key（同包场景）？~~ **已定：需要**（2026-11-21）。
   - 衍生待定：这个 Key 从哪里来——~~①设置页手填~~（用户看不到 server、也不填，已排除）；②随包内置专用 Key ③网关下发？
   - 该 Key 的**工具授权**：不配专属授权，靠网关「默认工具」（多个、对所有 Key 自动生效）拿到问数等工具；上线前须确认目标工具已设为默认。
4. ~~是否要把「问数」作为 App 的预置工具/技能（而不是仅 MCP server 列表里的一项）？~~ **已定：不做**（用户只要一个开关，无其它 MCP 相关 UI，2026-11-21）。
