# 后端 REST 接口契约（网关）

网关（`apps/gateway`）是客户端**唯一**允许通信的后端。前端不得直接调用第三方服务，
所有数据读写都走这里。接口同时提供 Swagger 文档：`/docs`（可视化）、`/api/openapi.json`。

> 语音 WebSocket 协议见 `README.md`，本文件只覆盖 REST 数据接口。

## 通用约定

- Base：网关地址，如 `http://<host>:<port>`。
- 数据格式：`application/json`。
- 参数加密：由网关开关 `PARAM_ENCRYPT` 控制。开启时，请求体/响应体为密文（见下文），关闭时为明文 JSON。
- 数据库只在网关落地（SQLite），客户端经这些接口读写，不直接写业务数据。

## 端点

### GET /api/health
健康检查。

- 响应 `200`：`{ "ok": true }`

### 会话记录 sessions

- `POST /api/sessions`：新建一条会话记录。
  - body：`{ "deviceId": string?, "startedAt": number? }`
  - 响应 `201`：`{ "id": number }`
- `GET /api/sessions?deviceId=xxx`：列出会话（按 id 倒序，最多 100）。
  - 响应 `200`：数组，元素含 `id / device_id / started_at / ended_at / created_at`。

### 设备数据 device-data

- `POST /api/device-data`：写入一条设备数据。
  - body：`{ "type": string, "payload": object }`
  - 响应 `201`：`{ "id": number }`
- `GET /api/device-data?deviceId=xxx`：列出（倒序，最多 200）。

### 命令日志 command-logs

- `POST /api/command-logs`：写入一条命令日志。
  - body：`{ "command": string, "result": string }`
  - 响应 `201`：`{ "id": number }`
- `GET /api/command-logs?deviceId=xxx`：列出（倒序，最多 200）。

## 参数加密（PARAM_ENCRYPT=true）

开启后：

- 请求：HTTP body 直接是 base64 密文（AES-256-GCM，密钥 `ENCRYPTION_KEY`），不再包 JSON。
- 响应：`{ "encrypted": true, "data": "<base64 密文>" }`，解密后得到原本的 JSON body。

关闭时均为明文 JSON，便于开发与调试。

## 错误码

REST 层失败返回对应 HTTP 状态；语音链路错误见 `README.md` 的 `error` 事件。
