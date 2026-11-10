# 腾讯音乐播放源（tencent）

> 状态：**占位空实现**。当前已注册到 `VALID_SOURCES`，客户端设置页可选择，
> 但 `resolve` / `next` 尚未实现，调用会抛出「腾讯音乐播放源尚未实现」。

## 路由入口

客户端通过 `session.start.playback.source = 'tencent'` 选择本播放源，
网关 `service/music/index.ts` 的 `createMusicSource` 据此构造 `createTencentMusicSource(fetcher)`。

## 待实现内容

- 腾讯音乐搜索：歌名/歌手 → 歌曲 mid。
- 播放直链：按 mid + 音质解析真实音频地址，处理 vkey / 防盗链。
- 失败兜底（歌手、歌名对不上时）由上层工具明确告知「没找到」。

## 约定（与百度源一致）

- 风格 / 氛围请求走 SomaFM 免费电台兜底。
- 具体歌名 / 歌手走腾讯音乐搜索，严格匹配歌手与歌名，绝不放宽。
- 两边都搜不到时由上层工具明确告知「没找到」，绝不退回随机电台（避免乱播放）。
- 直链带防盗链，由网关 `/music/stream` 代理转发给客户端。

## 文件结构

```
tencent/
├── index.ts   # createTencentMusicSource（当前为空实现占位）
└── README.md  # 本文件
```
