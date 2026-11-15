# 应用品牌资源（logo / 启动图）

按环境放置品牌图片，构建时由 `build.sh` 自动接入对应原生工程，**无需改代码**。

## 目录约定

```
native/branding/
├── dev/      # 开发环境
├── test/     # 测试环境
└── pro/      # 生产环境
```

每个环境目录下放这三个固定文件名的 PNG（缺哪个就沿用平台默认图标）：

| 文件          | 用途                | 接入位置（Android）        |
| ------------- | ------------------- | -------------------------- |
| `icon.png`    | 桌面图标            | `res/drawable/icon.png`     |
| `splash.png`  | 启动图              | `res/drawable/splash.png`   |
| `push.png`    | 推送小图标          | `res/drawable/push.png`     |

## 不用此目录也行

在 `scripts/.build_env.<env>` 里用 `APP_ICON_DIR=/绝对/路径` 显式指向任意目录（优先级高于上面的按环境目录）。

## 应用名称（文字）

不在这里配，在 `scripts/.build_env.<env>` 的 `APP_DISPLAY_NAME` 里配（如 `小熊助手`），
构建时改写 Android `strings.xml` 的 `app_name` 与 iOS `Info.plist` 的 `CFBundleDisplayName`。

## 说明

- 图标是二进制 PNG，无法纯文本 env 配置，只能「env 指向目录 + 构建拷贝」。
- iOS 的应用图标是 `Assets.xcassets/AppIcon.appiconset` 多尺寸合集，不在本机制内；
  目前走 Xcode 手动替换（见 `GATEWAY_INTEGRATION.md`），显示名仍由 `APP_DISPLAY_NAME` 统一覆盖。
- 这些 PNG 是各环境品牌素材，按需放置，不强制入库（可加进 `.gitignore` 或正常提交均可）。
