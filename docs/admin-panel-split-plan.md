# admin_panel.py 拆分计划（讨论稿）

> 状态：待确认，未实施。日期 2026-11-21。
> 背景：`model-proxy/voice/admin_panel.py` 已涨到 **5389 行 / 307KB**，单文件过大、难维护。
> 用户拍板：**HTML + 路由都拆**；拆出的文件**放进 `voice/` 下新建的子目录**，不平铺根目录。

## 一、现状

| 区段 | 行范围 | 内容 | 行数 |
|---|---|---|---|
| Python 逻辑 | 1–587 | 鉴权/会话、配置读写、系统概览、日志、启停 | ~590 |
| 内嵌 HTML | 588–4651 | `ADMIN_HTML`（HTML/CSS/JS 整页） | ~4070 |
| 路由注册 | 4664–5389 | `register_admin_routes()` 内约 45 个端点 | ~720 |

HTML 占 **75%**，是最该先拆、风险最低的部分。

## 二、目录结构（目标）

```
model-proxy/voice/
├── admin_panel.py        # 保留在根：对外入口 + 模块级状态（tests/主程序 import 不变）
└── admin/                # 新建子目录（包）
    ├── __init__.py
    ├── panel.html        # Phase 1：从 ADMIN_HTML 抽出
    ├── auth.py           # （可选）require_* 与共享鉴权辅助
    ├── routes_users.py   # Phase 2：账号 / API Key / 限流
    ├── routes_config.py  # Phase 2：配置 / 纠错词 / 同步 / schema
    └── routes_ops.py     # Phase 2：连通测试 / 模型下拉 / 上游池 / 启停
```

**为什么 `admin_panel.py` 必须留在 voice 根**：tests 通过 `import admin_panel` 访问
`VOICE_HOME_DIR` / `VOICE_CONF_PATH` / `valid_session` 等**可变模块状态**；`init_admin()` 会改写这些值。
若把入口整体搬进子目录，re-export 只是值拷贝，子模块更新后主模块读到的是旧值，测试与运行时都会出错。
所以：**入口与状态留在根，实现文件进子目录**。

## 三、拆分方案

### Phase 1：HTML 独立（低风险，先做）
- 新建子目录 `model-proxy/voice/admin/`，HTML 放 `admin/panel.html`，内容即现 `ADMIN_HTML` 正文。
- `admin_panel.py` 改为模块加载时读子目录文件：
  ```python
  _ADMIN_HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin", "panel.html")
  with open(_ADMIN_HTML_PATH, encoding="utf-8") as _f:
      ADMIN_HTML = _f.read()
  ```
- 保留 `__ASR_B64__` 占位符 replace 与 `asr_sample.b64` 读取逻辑不变。
- 效果：`admin_panel.py` 从 5389 行降到约 1300 行。

### Phase 2：路由按域拆成 APIRouter（放进 `admin/` 子目录）
- `admin/routes_users.py`：账号 / API Key / 限流策略与绑定。
- `admin/routes_config.py`：配置读写、纠错词、同步、schema 历史、启停动作。
- `admin/routes_ops.py`：连通测试、模型/音色下拉、上游池、speech-secrets。
- `admin_panel.py` 保留：会话/鉴权、`_system_overview`、`voice_status/logs/action`、
  `register_admin_routes()` 汇总（内部 `include_router`）。
- 新增 `admin/__init__.py` 让子目录成为包；子目录内用绝对导入 `import voice_db` 等
  （voice 已在 sys.path，现有测试即如此）。

### 依赖处理（关键）
- 路由用 `Depends(require_admin/viewer/operator)` → 由 `register_admin_routes` 作为参数传入各 router 工厂，
  或放 `admin/auth.py`。
- 全局回调 `_STT_BUILTIN_CHECK` / `_TTS_BUILTIN_CHECK` / `_STT_UPSTREAM_TEST` / `_TTS_UPSTREAM_TEST` →
  通过**参数/闭包**传入各 router 工厂函数，避免模块级可变全局与循环 import。
- 共享辅助（`_pseg_cut`、`_validate_hotword`、`read_voice_config_masked`、`write_voice_config`、
  `voice_port`、`voice_status`、`_system_overview`、`voice_logs`、`voice_action`）→
  视引用情况放 `admin/common.py` 或保留主模块由 router import。
- 各 router 用工厂函数 `def build_router(deps...) -> APIRouter`，避免 import 期依赖未初始化。

## 四、验证

- `python -m py_compile` 检查所有新/改文件语法。
- `python model-proxy/voice/tests/run_all.py` 全量测试。
- `node model-proxy/voice/tests/test_admin_ui.mjs`（headless Chrome + CDP 真实点击，抓 JS 异常、检查页面内容）。
- 手动起服务访问 `/admin`，确认 7 个页面、登录、各 CRUD、连通测试正常。
- 检查打包/部署是否包含 `admin/panel.html`（9529 若走打包需一并带上）。

## 五、风险

- **tests 依赖模块状态**：`admin_panel.VOICE_HOME_DIR/VOICE_CONF_PATH` 会被 `init_admin` 改写，tests 直接读取；
  入口模块必须留在根、状态仍由它持有，不能整体搬进子目录。
- **循环 import**：router 模块 import 主模块会循环 → 用工厂函数 + 参数注入打破。
- **全局回调**：`_STT_BUILTIN_CHECK` 等在 `register_admin_routes` 里赋值，拆后要确保 router 拿得到。
- **HTML 加载时机**：改运行时读文件，文件缺失会启动即崩 → 确保随代码分发。
- **UI 回归**：HTML 只是换位置不改内容，但必须用 CDP 实测确认没坏。
- **未提交改动**：当前 `admin_panel.py` 有未提交改动，拆分基于当前工作区，注意不要覆盖。

## 六、实施顺序

1. Phase 1 抽 HTML 到 `admin/panel.html` → `py_compile` + `test_admin_ui.mjs` 验证。
2. Phase 2 拆路由（先建 `admin/__init__.py` 与共享，再逐个搬 router）→ 每搬一个跑一次测试。
3. 全量 `run_all.py` + 真实页面点检。

## 七、Phase 1 详细执行步骤（抽 panel.html）

> 原则：用脚本提取，绝不手抄 4000 行；先备份、后校验，改动最小。

### Step 0 备份当前文件
```bash
cd model-proxy/voice
cp admin_panel.py /tmp/admin_panel.py.bak
```

### Step 1 建子目录与包
```bash
mkdir -p model-proxy/voice/admin
touch model-proxy/voice/admin/__init__.py
```

### Step 2 提取 HTML 到 admin/panel.html
```bash
cd model-proxy/voice
python3 - <<'PY'
import re
src = open("admin_panel.py", encoding="utf-8").read()
m = re.search(r'ADMIN_HTML = r"""(.*?)\n"""', src, re.S)
assert m, "未找到 ADMIN_HTML raw string"
html = m.group(1)
assert html.lstrip().startswith("<!DOCTYPE html>"), "HTML 起始异常"
assert html.rstrip().endswith("</html>"), "HTML 结尾异常"
open("admin/panel.html", "w", encoding="utf-8").write(html + "\n")
print("提取完成:", len(html), "字符,", html.count("\n") + 1, "行")
PY
```

### Step 3 校验提取结果
```bash
head -3 admin/panel.html                 # 应含 <!DOCTYPE html>
tail -3 admin/panel.html                 # 应含 </html>
grep -c '__ASR_B64__' admin/panel.html   # 应为 1（占位符保留）
wc -l admin/panel.html                   # 约 4063 行
```

### Step 4 改 admin_panel.py 为读文件
把整段 `ADMIN_HTML = r"""..."""` 替换为：
```python
# HTML 单独放 admin/panel.html，避免把 4000 行页面塞进 Python 源码。
_ADMIN_HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin", "panel.html")
with open(_ADMIN_HTML_PATH, encoding="utf-8") as _f:
    ADMIN_HTML = _f.read()
```
保留其后的 `asr_sample.b64` 读取与
`ADMIN_HTML = ADMIN_HTML.replace("__ASR_B64__", _ASR_SAMPLE_B64)` 不变。

### Step 5 语法检查
```bash
python3 -m py_compile model-proxy/voice/admin_panel.py
```

### Step 6 内容一致性校验（推荐）
```bash
cd model-proxy/voice
python3 - <<'PY'
import re
old = re.search(r'ADMIN_HTML = r"""(.*?)\n"""',
                open("/tmp/admin_panel.py.bak", encoding="utf-8").read(), re.S).group(1)
new = open("admin/panel.html", encoding="utf-8").read().rstrip("\n")
print("一致" if old == new else "不一致：内容有偏差")
PY
```

### Step 7 重启服务 + 回归
- **重启 9529**（改了 `admin_panel.py` 必须 restart，否则仍跑旧代码）。
- `node model-proxy/voice/tests/test_admin_ui.mjs`
- `python model-proxy/voice/tests/run_all.py`

### Step 8 检查分发/打包
- 确认部署或打包流程包含 `admin/panel.html`（否则运行时读文件失败、启动即崩）。

### 注意
- HTML 一律用 UTF-8 读写。
- `__ASR_B64__` 占位符保留在 html 里、运行时 replace，不要把 base64 直接塞进 html。
- 只换存放位置、不改 HTML 内容本身，确保零 UI 变化。
