# 百度播放源（Baidu Music Source）

本目录是「播放设置」里 **播放源 = 百度** 的落地实现，由 `index.ts` 导出 `createBaiduMusicSource(fetcher)`。

网关当前仅此一种播放源：`music/index.ts` 的 `createMusicSource()` 一律构造本源（`session.start.playback.source` 缺省/未知值也回退到这里）。新增来源时再在 `music/index.ts` 按 source 分支即可。

## 分流规则

百度播放源内部按关键词类型自动分流：

- **风格 / 氛围请求**（轻音乐、电子、爵士、放松……）→ **SomaFM** 免费网络电台（直接 mp3 流，无需 Key）。
- **具体歌名 / 歌手请求** → 先试 **歌曲宝（gequbao）**：一次详情页拿到同源的音频直链、封面与带时间轴 LRC；拿不到再走 **B 站搜索兜底**，命中视频后抽取音轨返回可播放直链（电视/电影/动画等视频内容也走这条，抽音轨播放，不回复"无法播放视频"）。
  - 若 B 站原生搜索召回不足，再用**百度 web 搜索**找回 B 站视频页的 BVID（仅做检索，音轨仍从 B 站抽）。
  - 标题始终过严格匹配，绝不因为走了百度就放松「歌手、歌名要一致」。
- 两边都搜不到时，由上层音乐工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。

## 字幕同源原则

**字幕必须与当前播放音频来自同一来源、同一条目**，绝不跨源去配第三方歌词库（如歌曲宝的 mp3 配网易/酷狗的词，必然对不上）：

- 歌曲宝音频 → 同一详情页的 LRC（resolve 时缓存，零二次检索、100% 同曲）；
- B 站音轨 → 该视频自带字幕；
- 电台 → 无字幕。

取不到同源字幕时返回空，客户端显示「暂无字幕」。

## 关键行为

- **`genreToKeyword` 先收敛口语**：把"随便放点 / 播放个音乐"这类泛化请求收敛成风格词，再判 `isGenreRequest` 分流，避免被误送进视频搜索而播到不相关视频。
- **记住上一次用的子源（电台 / B 站）与音频同源标记**：bare「换一首 / 下一首」（不带新风格）沿用上次来源；字幕据此只从同源取。
- **`joinArtistTitle` 拼接歌手+歌名时去重**：直接指令路径里 track.title 已是「歌手 歌名」，又单独带 artist，去重避免「周杰伦 周杰伦 一路向北」这类重复词搜不到。
- **直链带防盗链**：由网关 `/music/stream` 代理转发给客户端，客户端用独立播放器，不与 TTS 冲突。

## 文件

- `index.ts` — `createBaiduMusicSource(fetcher)`：聚合 SomaFM 与 B 站两个子源，实现 `resolve / next` 分流、"沿用上次来源"与字幕同源缓存。
- `gequbao.ts` — 歌曲宝详情页解析（搜索 / play_id 音频直链 / mp3_cover 封面 / #content-lrc 字幕），`resolveGequbaoTrack` 一次拿全同源资源。
- `somaSource.ts` — SomaFM 电台源（依赖 `musicChannels.ts` 的频道表）。
- `bilibiliSearchSource.ts` — B 站搜索兜底源（含百度 web 搜索找回 BVID），抽音轨复用 `bilibiliAudio.ts`。
- `bilibiliAudio.ts` — B 站音轨抽取（wbi 签名 / playurl 取直链）。
- `musicChannels.ts` — SomaFM 频道表（`SOMA_CHANNELS` 等），仅本目录内的 somaSource 使用。
- `../lyrics/parseLrc.ts`、`../lyrics/query.ts` — LRC 行解析与「歌手+歌名」检索词拼接去重。
- `../types.ts` — `MusicSource` / `MusicFetcher` 类型与 `genreToKeyword` / `isGenreRequest` 收敛函数（各播放源共用，留在上一级）。
