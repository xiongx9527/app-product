# 目标

新增「语音听新闻」直连能力：用户说「播放新闻 / 最新消息 / 科技新闻 / headlines」时，网关识别为新闻播报意图，绕开大模型，从百度新闻频道抓取当日头条或话题新闻标题，直接口播「标题 + 来源」。抓取失败或没查到就诚实说明，绝不编造新闻。引导语与兜底文案按 `lang` 本地化，新闻标题保持原文。

本 change 同时接手工作区中已存在但未提交的新闻实现、补完缺失的测试与文档，并把上一 change 遗留的网关 `type-check` 报错清零，使验收可以按项目约定（`test` + `type-check` 全绿）完成。

# 范围

## 目录结构

### 新建（工作区已存在，未提交）

- `xiaoxiong-app/gateway/src/service/control/newsControl.ts`：新闻意图的确定性识别。触发词 `新闻 / 消息 / 头条 / 热点 / 快讯 / news / headlines`；`歌曲 / 音乐 / 评书 / 电影 / 综艺` 等其它内容强特征命中时让回下游；从触发词前的片段提取话题词，剥掉「播放 / 放 / 来点 / 今天 / 最新 / 的」等口语噪声，泛词或无话题时 `keyword=null` 泛播头条。
- `xiaoxiong-app/gateway/src/service/control/newsControl.test.ts`：泛播、带话题、反例、与音乐互斥的识别用例。
- `xiaoxiong-app/gateway/src/service/news/types.ts`：`NewsHeadline` / `NewsSource` / `NewsFetcher` / `NewsOptions` / `NewsResult` 抽象，以及纯函数 `formatNews`（本地化引导、无结果、不可用三种口播）。
- `xiaoxiong-app/gateway/src/service/news/baiduNewsSource.ts`：百度新闻频道默认源。`headlinesUrl` 泛播走新闻首页、带话题走站内新闻搜索；`parseNewsHtml` 用多级选择器阶梯解析标题，去重、过滤导航词、限制标题长度，来源能定位到容器才带上，取不到就省略。
- `xiaoxiong-app/gateway/src/service/news/index.ts`：新闻模块桶导出。
- `xiaoxiong-app/gateway/src/service/tools/newsTool.ts`：新闻查询工具。注入 `NewsFetcher`、6s 超时、按 URL 的 60s TTL 内存缓存（并发复用同一 Promise）、失败不进缓存；识别「百度安全验证 / 请输入验证码 / 网络不给力」反爬页并降级为不可用；默认最多播 5 条（限制在 1–10）。
- `xiaoxiong-app/gateway/src/service/tools/newsTool.test.ts`：解析、话题 URL、HTTP 失败/验证页、TTL 并发复用、换源注入用例。

### 修改（工作区已存在，未提交）

- `xiaoxiong-app/gateway/src/service/voiceSessionService.ts`：新增 `newsQuery` 测试注入点与 `runNewsCommand`；新闻检测放在播放模式之后、音乐指令之前（否则「播放新闻」被 `musicControl` 的裸「播放」当点歌）；播报失败由 `formatNews` / `catch` 出诚实兜底。
- `xiaoxiong-app/gateway/src/i18n.ts`：新增 `news.intro / news.none / news.unavailable` 的中英文案；标题原文不进 i18n。

### 修改（本 change 补完）

- `xiaoxiong-app/gateway/src/service/voiceSessionService.test.ts`：补新闻直连的会话级用例——注入 `newsQuery` 验证口播与不进 LLM、验证「播放新闻」不被当点歌、点歌/天气等既有直连不回归。
- `xiaoxiong-app/gateway/src/service/news/newsFormat.test.ts`（或并入现有新闻测试）：补 `formatNews` 的引导语、话题、0 条、不可用、条数上限与中英文案用例。
- `README.md`：在「内容与工具」与「当前状态」补新闻播报能力；不夸大（无卡片、无选号、无推送）。
- `AGENTS.md`：补一条新闻直连的长期约定（触发词、排在音乐之前、诚实兜底、源地址只在网关、目录 `service/news` + `service/control`），便于后续维护。
- `xiaoxiong-app/gateway/src/service/echoCanceller.ts` / `echoCanceller.test.ts`：删除两个未使用的变量/参数（`frozen`、`rms`），恢复网关 `type-check` 全绿。这是 HEAD 上已提交的遗留报错，无行为变化，仅作为本 change 的验收前置修复。

### 移动（工作区已存在，未提交）

- 既有直连控制模块从 `xiaoxiong-app/gateway/src/service/*.ts` 移到 `service/control/*.ts`（含同名测试），并更新 `voiceSessionService.ts` 引用。纯目录整理，不改变识别与行为；新闻控制模块一并落在 `service/control/`。

### 明确不改

- 客户端与协议：新闻播报走现有 `llm.delta` + TTS 链路，不新增事件、字段或卡片，`xiaoxiong-app/contracts/README.md` 无需修改；若 Build 中发现必须扩展协议，先改契约再实现。
- `model-proxy/` 与 9529 语音代理：本 change 不涉及。
- 新闻源地址只由网关持有（`news.baidu.com`），前端不出现，也不接受前端传入地址。

# 非目标

- 不做新闻详情页、列表卡片、编号选择、收藏或朗读正文；只口播标题与来源。
- 不做新闻订阅、定时播报、推送、去重归档或跨天追踪。
- 不引入第二个新闻源或付费新闻 API；`NewsSource` 抽象只为后续换源留口，不在本 change 实现。
- 不改大模型系统提示或工具注册；新闻是确定性直连，不进 LLM。
- 不处理「消息」作为即时通讯/提醒的语义边界（用户明确要求「消息」也触发新闻）；只在句中出现歌曲/影视等其它内容强特征时让回下游。
- 不调整既有直连的优先级（时间/天气/记忆/音量/字幕/播放模式），仅新增新闻并排在音乐之前。

# 验收示例

- 说「播放新闻 / 新闻 / 最新消息 / 今天的新闻 / 今天有什么新闻 / 头条 / 有什么热点 / 看看快讯 / news / headlines」→ 走新闻直连：口播「为你播报今天的 N 条新闻：标题，来源。」（英文为对应英文引导）；不调用大模型，不被当作点歌。
- 说「科技新闻 / 科技最新消息 / 关于科技的新闻 / 播放体育新闻 / 财经头条 / 来点汽车的消息 / 再放个科技新闻」→ 带话题词抓该话题新闻，口播「查到 N 条与「科技」相关的新闻」；「再」按全新请求处理，不沿用上一轮话题。
- 抓取失败（超时 / HTTP 非 200 / 反爬验证页）→ 口播「现在查不了新闻，稍后再试。」；抓到 0 条 →「暂时没查到新闻。」/「暂时没查到与「XX」相关的新闻。」；两种情况都不编造标题、不抛错卡住会话。
- 说「播放新闻歌曲 / 新闻里的那首歌」→ 不命中新闻，交回音乐/下游；「播放周杰伦的稻香」「今天天气怎么样」「音量调到30%」「查询商品」等既有直连全部保持原行为。
- 同一 URL 在 TTL 内重复查询只抓取一次；抓取失败不写缓存，下一次请求可立即重试。
- 新闻模块可换源：注入自定义 `NewsSource`（`headlinesUrl` + `parse`）即可工作，`newsTool` 与 `voiceSessionService` 不改。
- 英文会话（`en-US`）说 `news` / `headlines` → 英文引导与英文兜底，不混入中文文案；标题原文保持抓取到的语言。
- 提交前网关 `npm run test` 全绿、`npm run type-check` 零错误（含清理 HEAD 上 `echoCanceller` 的 2 个未使用变量报错）；客户端未改动，不要求重跑客户端测试。

# 关键决定

- **直连而非 LLM 工具**：新闻意图确定、数据源单一，直连避免模型编造新闻标题，失败文案可测试。
- **诚实兜底分三态**：抓取失败（`ok:false`）、抓到 0 条、正常结果分别给不同文案；失败不缓存，避免把一次网络抖动固化 60 秒。
- **源抽象 + 可注入 fetcher**：`NewsSource` 隔离百度实现，测试不联网；地址只在网关配置中。
- **优先级**：新闻检测放在播放模式之后、音乐之前，解决「播放新闻」被音乐正则抢走；记忆「忘了/记住」更靠前，不受影响。
- **缓存**：按最终 URL 的 60s TTL + 并发 Promise 复用；不按话题词二次归一化，行为简单可预期。
- **用户决定**：继续现有未提交的新闻实现；工作区隔离方式为 `current`（沿用 main 与当前目录，现有改动纳入本 change）。

# Open questions

- 无阻塞问题。
