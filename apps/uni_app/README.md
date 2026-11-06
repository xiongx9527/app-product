# app-product uni-app 客户端

一套代码覆盖 Android / iOS / HarmonyOS / H5 / 微信小程序。

## 开发

```bash
npm install
npm run dev:h5          # 浏览器，最快
npm run test            # 状态机单测
npm run type-check
npm run dev:mp-weixin   # 微信开发者工具导入 dist/dev/mp-weixin
npm run dev:app         # App（需 HBuilderX / 自定义基座）
npm run dev:app-harmony # 鸿蒙（需 DevEco Studio）
```

## 目录

```
src/
├── core/
│   ├── assistant/    # 纯状态机 + 单测
│   ├── audio/        # 本地提示音
│   ├── transport/    # Mock / WebSocket
│   ├── wake/         # 唤醒服务（原生插件桥接）
│   └── adaptation/   # 断点与安全区
├── features/
│   └── assistant/    # 语音助手页面与会话编排
├── pages/            # 路由页面
├── static/audio/     # still-there.mp3 / farewell.mp3
└── manifest.json     # 各端权限
```

## 当前状态

- H5：可用浏览器语音真实唤醒（说「小熊小熊」），跑通“唤醒 → 打招呼 → 对话 → 静默提示 → 退出 → 再唤醒”；后端仍为 Mock。
- 浏览器语音依赖 Chrome / Edge 的 Web Speech API，需联网且授权麦克风，不是离线 KWS。
- 原生 App：唤醒桥接已实现（`core/wake/providers/native.ts`），装上 `app-product-wake` 插件即可用；插件本身待实现（Android 先行）。
- 小程序：按设计降级为按住/点击说话。
- 语言：先只支持中文（`zh-CN`），界面、唤醒、ASR、TTS 都不做多语言。
- 鸿蒙：`@dcloudio/uni-app-harmony` 已接入，权限与打包配置见设计文档。
