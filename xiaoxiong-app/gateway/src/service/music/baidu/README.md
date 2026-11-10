# 百度播放源（Baidu Music Source）

本目录是「播放设置」里 **播放源 = 百度** 的落地实现，由 `index.ts` 导出 `createBaiduMusicSource(fetcher)`。

网关本身不预设播放源，播放源完全来自客户端设置页：会话建立时客户端在 `session.start.playback.source` 带上来源值（当前仅 `baidu`，缺省/未知值回退到百度），`music/index.ts` 按该值分支构造对应来源。新增来源时在 `music/index.ts` 的 `switch` 里加一个 `case` 即可，各来源内部自行决定子源组合，互不影响。

## 分流规则

百度播放源内部聚合两个子源，按关键词类型自动分流：

- **风格 / 氛围请求**（轻音乐、电子、爵士、放松……）→ **SomaFM** 免费网络电台（直接 mp3 流，无需 Key）。
- **具体歌名 / 歌手请求** → **B 站搜索兜底**，命中视频后抽取音轨返回可播放直链（电视/电影/动画等视频内容也走这条，抽音轨播放，不回复"无法播放视频"）。
  - 若 B 站原生搜索召回不足，再用**百度 web 搜索**找回 B 站视频页的 BVID（仅做检索，音轨仍从 B 站抽）。
  - 标题始终过严格匹配，绝不因为走了百度就放松「歌手、歌名要一致」。
- 两边都搜不到时，由上层音乐工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。

## 关键行为

- **`genreToKeyword` 先收敛口语**：把"随便放点 / 播放个音乐"这类泛化请求收敛成风格词，再判 `isGenreRequest` 分流，避免被误送进视频搜索而播到不相关视频。
- **记住上一次用的子源（电台 / B 站）**：bare「换一首 / 下一首」（不带新风格）沿用上次来源——B 站源接着放同歌手的下一首，电台源换台，而不是跳到不相关的电台/歌曲。
- **直链带防盗链**：由网关 `/music/stream` 代理转发给客户端，客户端用独立播放器，不与 TTS 冲突。

## 文件

- `index.ts` — `createBaiduMusicSource(fetcher)`：聚合 SomaFM 与 B 站两个子源，实现 `resolve / next` 分流与"沿用上次来源"逻辑。
- `somaSource.ts` — SomaFM 电台源（依赖 `musicChannels.ts` 的频道表）。
- `bilibiliSearchSource.ts` — B 站搜索兜底源（含百度 web 搜索找回 BVID），抽音轨复用 `bilibiliAudio.ts`。
- `bilibiliAudio.ts` — B 站音轨抽取（wbi 签名 / playurl 取直链）。
- `musicChannels.ts` — SomaFM 频道表（`SOMA_CHANNELS` 等），仅本目录内的 somaSource 使用。
- `../types.ts` — `MusicSource` / `MusicFetcher` 类型与 `genreToKeyword` / `isGenreRequest` 收敛函数（各播放源共用，留在上一级）。

> 只有百度播放源用到 SomaFM / B 站这套实现，因此全部收进本目录；netease / tencent / kugou 是占位空实现，各自独立成目录，不共享这些子源。
