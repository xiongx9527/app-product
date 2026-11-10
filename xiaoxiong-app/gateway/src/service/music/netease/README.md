# 网易云音乐播放源（netease）

> 状态：**占位空实现**。当前已注册到 `VALID_SOURCES`，客户端设置页可选择，
> 但 `resolve` / `next` 尚未实现，调用会抛出「网易云音乐播放源尚未实现」。

## 路由入口

客户端通过 `session.start.playback.source = 'netease'` 选择本播放源，
网关 `service/music/index.ts` 的 `createMusicSource` 据此构造 `createNeteaseMusicSource(fetcher)`。

## 待实现内容

- 网易云搜索：`POST /weapi/cloudsearch/get/web`（weapi 加密）。
- 播放直链：`/song/url/v1` 或更优的 `/weapi/song/enhance/player/url`。
- weapi 请求加密（AES-128 + RSA 公钥）。

## 约定（与百度源一致）

- 风格 / 氛围请求走 SomaFM 免费电台兜底。
- 具体歌名 / 歌手走网易云搜索，严格匹配歌手与歌名，绝不放宽。
- 两边都搜不到时由上层工具明确告知「没找到」，绝不退回随机电台（避免乱播放）。
- 直链带防盗链，由网关 `/music/stream` 代理转发给客户端。

## 文件结构

```
netease/
├── index.ts   # createNeteaseMusicSource（当前为空实现占位）
└── README.md  # 本文件
```
