"""启动前依赖检查：只检查、不安装。

start-voice.sh / start-voice.ps1 在启动服务前调用本脚本。检查不通过时以
非零退出码结束，并把“缺什么、怎么装”写进标准输出；通过 voice.sh /
voice.ps1 后台启动时，这些内容会进入 voice.log。

为什么要先检查基础包再导入服务：
    openai_voice_server.py 在模块顶层 import fastapi / uvicorn / httpx，
    缺包时只会抛一个 ModuleNotFoundError，看不到其它缺失项。这里先用
    importlib.util.find_spec 做无副作用的检查，基础包装齐后再导入服务模块，
    复用它已有的配置解析和路径解析逻辑，避免维护两套规则。

检查项：
    - Python >= 3.10；
    - 基础包：fastapi / uvicorn / python-multipart / httpx / pydantic；
    - LLM：纯转发代理；启用时 LLM_UPSTREAM_BASE_URL 必须是 http(s)；
      不检查本机 ollama，也不需要任何本地模型；
    - 本地 STT：sherpa-onnx / numpy / SenseVoice 模型文件；
    - 本地 TTS：edge-tts / ffmpeg；
    - 代理模式：上游地址必须是 http(s)，并跳过对应能力的本地依赖检查。

安装模式（$VOICE_HOME/install-mode，由 install-voice 写入）：
    full       本地 STT + TTS，两者都要检查
    tts-only   只装了 TTS，STT 未安装属于预期，跳过 STT 检查
    stt-only   只装了 STT，TTS 未安装属于预期，跳过 TTS 检查
    proxy-only 两类都走代理；未配置上游时必须给出明确提示

本脚本只使用标准库，缺依赖时也能运行并给出完整提示。
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from urllib.parse import urlparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REQ_DIR = SCRIPT_DIR

# 提示里有中文；固定输出编码，避免 LANG=C / POSIX locale 下编码失败。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# (展示名, import 名)；python-multipart 的 import 名是 multipart。
BASE_MODULES = (
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("python-multipart", "multipart"),
    ("httpx", "httpx"),
    ("pydantic", "pydantic"),
)
STT_MODULES = (
    ("sherpa-onnx", "sherpa_onnx"),
    ("numpy", "numpy"),
)
TTS_MODULES = (("edge-tts", "edge_tts"),)

problems: list[str] = []
hints: list[str] = []


def line(text: str) -> None:
    print(f"[check] {text}", flush=True)


def problem(text: str) -> None:
    problems.append(text)
    line(f"缺少 / 异常：{text}")


def has_module(name: str) -> bool:
    """只查模块是否存在，不真正 import，避免缺依赖时直接抛异常。"""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def load_server():
    """基础包装齐后再导入服务模块，复用它的配置解析。"""
    sys.path.insert(0, SCRIPT_DIR)
    import openai_voice_server  # type: ignore[import-not-found]

    return openai_voice_server


def install_mode(voice_home: str) -> str:
    """读取安装脚本写入的模式；文件不存在时按 full 处理。"""
    path = os.path.join(voice_home, "install-mode")
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip().lower()
    except OSError:
        return ""


def check_upstream(name: str, url: str) -> None:
    """上游地址只做格式检查；网络是否可达留给真正请求时判断。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        problem(
            f"{name} 上游地址无效：{url}"
            f"（需要 http:// 或 https:// 开头，例如 https://api.openai.com/v1）"
        )


def ffmpeg_works(path: str) -> bool:
    """只找到文件还不够，真正执行一次 -version，排除坏路径 / 无执行权限。"""
    try:
        result = subprocess.run(
            [path, "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def ffmpeg_install_hint() -> str:
    if os.name == "nt":
        return (
            "安装 ffmpeg：winget install --id Gyan.FFmpeg -e"
            "（或手动下载后把 FFMPEG_BIN 指向 ffmpeg.exe）"
        )
    return (
        "安装 ffmpeg：macOS 用 brew install ffmpeg；"
        "Linux 用系统包管理器（如 sudo apt install ffmpeg）"
    )


def pip_install_hint(requirements: str) -> str:
    """给出与当前虚拟环境完全对应的 pip 命令，用户可直接复制执行。"""
    req_path = os.path.join(REQ_DIR, requirements)
    return f'补装 Python 包："{sys.executable}" -m pip install -r "{req_path}"'


def check_llm(server) -> None:
    """检查 LLM 纯转发代理：启用时上游地址必须是 http(s)。

    代理不加载任何本地模型，也不要求本机安装 Ollama；上游可以是任意
    OpenAI 兼容服务（含本机 Ollama 的 /v1）。支持多个上游（地址池），
    每个条目自带 protocol，因此不同上游可走不同协议。
    """
    if not server.llm_enabled():
        line("LLM : 未启用（配置 LLM_UPSTREAM_POOL 或 LLM_UPSTREAM_BASE_URL 后启用纯转发代理）")
        return

    entries = server.upstream_pool.load_pool("LLM")
    if not entries:
        problem("LLM: 已启用但未配置 LLM 上游地址")
        hints.append(
            "在 voice.conf 配置 LLM_UPSTREAM_POOL 或 LLM_UPSTREAM_BASE_URL"
            "（OpenAI 兼容上游地址）"
        )
        return
    for e in entries:
        check_upstream("LLM", e["base_url"])
    if len(entries) > 1:
        line(
            f"LLM : 转发 {entries[0]['base_url']} 等 {len(entries)} 个上游"
            "（健康优先 + 轮询）"
        )
    else:
        line(f"LLM : 转发 {entries[0]['base_url']}")


def local_stt_issues(server) -> list[str]:
    issues = [
        f"Python 包 {label}"
        for label, module in STT_MODULES
        if not has_module(module)
    ]
    if not server.sensevoice_ready():
        issues.append(
            f"SenseVoice 模型未就绪：{server.sensevoice_dir()}"
            "（需要 model.int8.onnx 和 tokens.txt）"
        )
    return issues


def local_tts_issues(server) -> tuple[list[str], str | None]:
    issues = [
        f"Python 包 {label}" for label, module in TTS_MODULES if not has_module(module)
    ]
    ffmpeg = server.ffmpeg_path()
    if not ffmpeg:
        issues.append("ffmpeg 未找到（本地 TTS 需要它把 MP3 转成 WAV）")
    elif not ffmpeg_works(ffmpeg):
        issues.append(f"ffmpeg 无法执行：{ffmpeg}")
    return issues, ffmpeg


def check_capability(
    name: str,
    upstream: str,
    mode: str,
    skipped_mode: str,
    local_issues: list[str],
    local_ready: str,
) -> None:
    """按“上游 > 本地 > 安装模式”的顺序检查一类能力。"""
    if upstream:
        check_upstream(name, upstream)
        line(f"{name:<4}: 代理 {upstream}")
        return

    # proxy-only 没有装本地依赖；如果用户后来手动补齐了本地环境，也允许继续用本地。
    if mode == "proxy-only":
        if not local_issues:
            line(f"{name:<4}: 本地（未配置上游，但本机依赖完整）")
            return
        for issue in local_issues:
            problem(f"{name}: {issue}")
        hints.append(
            f"{name}: 代理模式需要配置 {name}_UPSTREAM_BASE_URL 或 "
            f"VOICE_UPSTREAM_BASE_URL（地址需带 http:// 或 https://）"
        )
        return

    # --tts-only / --stt-only 明确表示另一类能力不安装，启动时不应因此失败。
    if mode == skipped_mode:
        if not local_issues:
            line(local_ready)
        else:
            line(f"{name:<4}: 未安装（安装模式 {mode}，这类请求会失败）")
        return

    if local_issues:
        for issue in local_issues:
            problem(f"{name}: {issue}")
        if name == "STT":
            hints.append(pip_install_hint("requirements-stt.txt"))
            hints.append(
                "下载 SenseVoice 模型：重新运行安装脚本（脚本会下载约 240MB 模型）"
            )
        else:
            hints.append(pip_install_hint("requirements-tts.txt"))
            hints.append(ffmpeg_install_hint())
        return
    line(local_ready)


def check_backends(server) -> None:
    # preflight 在 server.main() 之前运行，config_store 还没被 configure；
    # 这里临时按 voice.conf 播种一次，让地址池 / 配置读取和正式运行一致。
    try:
        db_path = os.path.join(server.VOICE_HOME, "voice.db")
        server.config_store.configure(db_path, None, None)
        server.config_store.instance().seed_from_conf(server._file_values())
    except Exception:  # noqa: BLE001
        pass

    config_path = getattr(server, "_config_path", "")
    exists = os.path.isfile(config_path)
    line(
        f"配置  : {config_path}"
        f"{'' if exists else '（不存在，使用内置默认值）'}"
    )

    mode = install_mode(server.VOICE_HOME)
    if mode:
        line(f"安装  : {mode}")

    # 上游地址池（多地址 + 账号池）；取第一个用于能力检查展示，并逐个校验格式。
    stt_entries = server.upstream_pool.load_pool("STT")
    tts_entries = server.upstream_pool.load_pool("TTS")
    for e in stt_entries:
        check_upstream("STT", e["base_url"])
    for e in tts_entries:
        check_upstream("TTS", e["base_url"])
    stt_upstream = stt_entries[0]["base_url"] if stt_entries else ""
    tts_upstream = tts_entries[0]["base_url"] if tts_entries else ""

    check_capability(
        "STT",
        stt_upstream,
        mode,
        "tts-only",
        local_stt_issues(server),
        f"STT : 本地 SenseVoice-small @ {server.sensevoice_dir()}",
    )
    tts_issues, ffmpeg = local_tts_issues(server)
    check_capability(
        "TTS",
        tts_upstream,
        mode,
        "stt-only",
        tts_issues,
        f"TTS : 本地 edge-tts（音色 {server.tts_voice()}，ffmpeg {ffmpeg}）",
    )

    check_llm(server)

    if problems and not stt_upstream and not tts_upstream:
        hints.append(
            "如果不想在本机安装模型 / ffmpeg，可在 voice.conf 配置 "
            "VOICE_UPSTREAM_BASE_URL（STT/TTS）和 LLM_UPSTREAM_POOL / "
            "LLM_UPSTREAM_BASE_URL（LLM）后走代理模式。"
        )


def install_script_hint() -> list[str]:
    if os.name == "nt":
        return [
            r"  scripts\install-voice.cmd                 # 本地 STT + TTS（含模型）",
            r"  scripts\install-voice.cmd -ProxyOnly      # 只装代理模式基础依赖",
            r"  scripts\install-voice.cmd -TtsOnly        # 只装本地 TTS",
            r"  scripts\install-voice.cmd -SttOnly        # 只装本地 STT",
        ]
    return [
        "  ./scripts/install-voice.sh                # 本地 STT + TTS（含模型）",
        "  ./scripts/install-voice.sh --proxy-only   # 只装代理模式基础依赖",
        "  ./scripts/install-voice.sh --tts-only     # 只装本地 TTS",
        "  ./scripts/install-voice.sh --stt-only     # 只装本地 STT",
    ]


def finish() -> int:
    if not problems:
        line("环境检查通过")
        return 0

    print("", flush=True)
    line("环境检查未通过，服务不会启动。")
    line("启动脚本只检查依赖，不会自动安装；请手动执行下面的命令：")
    print("", flush=True)
    line("安装脚本（推荐，一次装齐当前模式所需依赖）：")
    for item in install_script_hint():
        print(item, flush=True)

    if hints:
        print("", flush=True)
        line("也可以只补缺失项：")
        for item in hints:
            print(f"  {item}", flush=True)

    print("", flush=True)
    line("修复后重新运行启动命令；完整说明见 scripts/README.md。")
    return 1


def main() -> int:
    line(f"Python: {sys.version.split()[0]}（{sys.executable}）")
    if sys.version_info < (3, 10):
        problem("Python 版本过低，需要 3.10 或更高版本")
        hints.append("升级 Python 后重新运行 scripts/install-voice 脚本")

    missing_base = [
        label for label, module in BASE_MODULES if not has_module(module)
    ]
    for label in missing_base:
        problem(f"Python 包 {label}（所有模式都需要）")
    if missing_base:
        hints.append(pip_install_hint("requirements-base.txt"))
        hints.append("基础包装好后再启动一次，会继续检查本地模型和 ffmpeg。")
        return finish()

    try:
        server = load_server()
    except Exception as exc:  # noqa: BLE001
        problem(f"基础包已存在，但导入服务模块失败：{exc}")
        hints.append(pip_install_hint("requirements-base.txt"))
        hints.append(
            "依赖可能装到了别的 Python 环境；确认 VOICE_HOME 指向包含 venv 的目录。"
        )
        return finish()

    try:
        check_backends(server)
    except Exception as exc:  # noqa: BLE001
        problem(f"读取配置失败：{exc}")

    return finish()


if __name__ == "__main__":
    raise SystemExit(main())
