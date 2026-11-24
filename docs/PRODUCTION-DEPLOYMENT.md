# 模型代理 · 生产部署 Runbook

面向把 `model-proxy` 跑在生产环境的运维/开发者。覆盖部署、安全、备份恢复、监控、故障排查与已知限制。

## 1. 端口与组件

| 组件 | 端口 | 说明 |
|---|---|---|
| model-proxy（FastAPI） | 19529 | 管理面板 `/admin`、数据接口 `/llm` `/voice` `/embed` `/rerank` `/ocr` `/mcp` |
| Redis | 容器内部 6379 | 纠错缓存 + 限流计数（可选，未配降级内存） |
| MySQL/PostgreSQL | 容器内部 3306/5432 | 纠错词表库（可选，默认 SQLite） |

> 注意：早期文档写的是 9529，**实际默认端口是 19529**。

## 2. Docker 部署（推荐）

在 `model-proxy/` 目录：

```bash
docker compose up -d --build          # 首次或代码更新后（务必带 --build 重建镜像）
docker compose ps                     # 查看状态
docker compose logs -f model-proxy    # 跟日志
docker compose down                   # 停止（数据卷保留）
```

### 数据目录
- 宿主：`~/.app-product/voice`（可用环境变量 `VOICE_HOME` 覆盖）
- 容器：`/data`（`voice.conf` / `voice.db` / `voice.log` / `models` / `api-key`）
- Redis / MySQL 用 Docker 命名卷（`redis-data`、`mysql-data`），`down` 不丢。

### 容器加固（已配置）
`docker-compose.yml` 里 model-proxy 服务已启用：
- `security_opt: no-new-privileges:true`
- `cap_drop: ALL`
- `read_only: true` + `tmpfs: /tmp`（根文件系统只读，仅 `/data` 可写，临时文件走内存盘）
- `docker.sock` 只读挂载（仅用于概览页读取宿主机 Docker 版本；不需要时可删此行并改用 `DOCKER_VERSION` 环境变量）

## 3. 生产安全配置（必做）

**默认配置是"本地开发"级别：无鉴权、无 IP 白名单、监听 0.0.0.0。直接暴露到公网等于把付费上游接口送人。**

### 3.1 生产模式强制校验
设置环境变量 `ENV=production`，服务启动时会校验：
- `VOICE_API_KEY_AUTH=on`（数据接口必须 API Key 鉴权）
- `VOICE_IP_ALLOW` 非空（来源 IP/CIDR 白名单）

任一不满足则**拒绝启动**并打印原因。若已在外部（反代/WAF/VPN）完成鉴权，可显式豁免：
```
ENV=production ALLOW_INSECURE_PRODUCTION=1
```
（豁免仅跳过本地校验，仍建议尽快补齐本地配置。）

### 3.2 关键配置
| 项 | 生产建议 |
|---|---|
| `VOICE_API_KEY_AUTH` | `on`，并在管理面板「访问控制」为每个 Key 绑定限流策略 |
| `VOICE_IP_ALLOW` | 只允许可信 IP/CIDR；环回地址恒放行 |
| 管理面板 | 不要直接暴露公网；走内网/VPN/带鉴权的反向代理 |
| 登录验证码 | 保持 `ADMIN_CAPTCHA=on`（默认开） |
| 请求详情日志 | 敏感信息已打码；如需降低日志量设 `LOG_REQUEST_DETAIL=off` |

 modifying 配置后管理面板即时生效（无需重启），但 `ENV` 等环境变量需重启容器。

## 4. 备份与恢复

### 4.1 自动备份
- 数据库 schema 升级前自动做 SQLite 在线备份：`voice.db.bak-v<版本>-<时间戳>`（权限 600）。
- 日志按 `LOG_ROTATE_*` 轮转：`LOG_ROTATE_DAYS`(保留天数) / `LOG_ROTATE_MAX_MB`(单文件大小) / `LOG_ROTATE_MAX_FILES`(最多归档数) / `LOG_ROTATE_BY`(day/size/both)。

### 4.2 手动备份 / 权限收紧
```bash
./model-proxy/voice.sh backup          # 备份 voice.db + voice.conf + api-key
                                       # 保留最近 BACKUP_KEEP 份（默认 7），存到 ~/.app-product/voice/backups/
BACKUP_KEEP=14 ./model-proxy/voice.sh backup
./model-proxy/voice.sh secure          # 把 voice.db / voice.conf / api-key 权限收紧到 600
```

备份是 SQLite `backup()` API 在线备份，不锁库，服务运行中可执行。恢复时停服、替换 `voice.db`、再启动。

## 5. 监控（指标端点）

代理暴露标准指标端点供外部监控抓取（**告警规则/通知渠道需在 Prometheus / Alertmanager / Grafana 侧配置**）：
- `GET /admin/api/metrics`（Prometheus 文本格式）：请求量/错误率/延迟、上游健康、缓存命中率、限流状态、资源使用（需 viewer 权限的会话）。
- `GET /health`：服务与上游健康快照，适合做存活探针。
- `GET /admin/api/overview-cache-stats`：概览缓存命中率诊断。

建议告警：磁盘使用率、上游全挂、Redis 断连、5xx 错误率、进程存活。

## 6. 故障排查

| 现象 | 排查 |
|---|---|
| 登录 400「验证码错误」 | 密码错或验证码过期；点验证码图片刷新；确认 `ADMIN_CAPTCHA` 配置 |
| 数据接口 401 | 未带 API Key 或 Key 无效/过期/被禁用；检查 `VOICE_API_KEY_AUTH` |
| 数据接口 429 | 触发限流，看 `Retry-After`；检查 Key 绑定的限流策略 |
| 上游 502/504 | 看概览「应用运行情况」的上游健康；`voice.sh log` 查上游错误 |
| 概览某能力显示 `—` | 该能力未配置或无健康上游；检查模型配置页 |
| 容器起不来 | `docker compose logs model-proxy`；确认 `ENV=production` 时安全配置是否合格 |

所有请求有 `[REQ_DETAIL]` 日志（请求头/query/body 脱敏+截断），按时间 grep 即可定位单次请求。

## 7. 已知限制

- **OCR（内置 PaddleOCR）在 Docker 里不可用**：CPU 指令集不兼容会触发 `Illegal instruction`。Docker 部署请使用 **DeepSeek OCR**（配 `OCR_DEEPSEEK_API_KEY`）；内置 OCR 仅在宿主机直接运行（install-ocr.sh）时可用。DeepSeek OCR 暂不支持 PDF，PDF 请用宿主机内置 OCR。
- **限流后端**：Redis 令牌桶已实现并支持多实例共享；Redis 运行时故障会自动降级到进程内存（此时多实例计数不共享，但业务不中断）。
- **日志轮转**需手动执行 `voice.sh rotate` 或加入 cron；无内置定时器。

## 8. 升级与回滚

1. 升级前：`./model-proxy/voice.sh backup`。
2. 拉代码：`git pull`，然后 `docker compose up -d --build`（务必 `--build`）。
3. 验证：`curl http://127.0.0.1:19529/health`、登录管理面板看「应用运行情况」。
4. 回滚：`git checkout <上一个 commit>`，`docker compose up -d --build`，必要时用第 4 节备份恢复 `voice.db`。
