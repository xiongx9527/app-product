"""语音服务（model-proxy/voice）回归测试统一入口。

自动发现 tests/test_*.py 并逐个以独立进程运行，汇总 PASS/FAIL 与耗时，
任一用例失败则整体退出码为 1。新增用例只要按 test_*.py 命名即自动纳入，
不用改本脚本。

两类用例，判定方式不同：
  - 断言型：脚本打印 `== SUMMARY` 且 sys.exit(main())，以退出码为准。
  - 冒烟型（如 test_ws_inference.py）：连真实 9529 服务的演示脚本，没有断言、
    退出码恒为 0。仅看退出码会假绿，所以额外扫描输出里的 `[异常]` /
    `Traceback` 判定，并标注需要本地服务已启动。

运行（任意平台；用哪个 python 跑，子用例就继承哪个解释器，无需硬编码 venv 路径）：
    cd model-proxy/voice
    /Users/xiongxiao/.app-product/voice/venv/bin/python tests/run_all.py

    # 只跑文件名含该子串的用例
    ... tests/run_all.py --only concurrency
    # 纯离线回归：跳过依赖运行中服务的冒烟用例
    ... tests/run_all.py --skip-smoke
    # 只列出发现的用例（不运行）
    ... tests/run_all.py --list
    # 打印每个用例完整输出
    ... tests/run_all.py -v
    # 单用例超时秒数（默认 180）
    ... tests/run_all.py --timeout 60
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_VOICE_DIR = _TESTS_DIR.parent

SUMMARY_MARK = "== SUMMARY"
ERROR_MARKS = ("[异常]", "Traceback (most recent call last)")


def discover() -> list[Path]:
    """按文件名排序，保证每次汇总顺序稳定。"""
    return sorted(p for p in _TESTS_DIR.glob("test_*.py") if p.is_file())


def is_smoke(path: Path) -> bool:
    """无 `== SUMMARY` 汇总行的脚本视为冒烟/演示脚本（不做断言、退出码恒 0）。"""
    try:
        return SUMMARY_MARK not in path.read_text(encoding="utf-8")
    except OSError:
        return False


def run_one(path: Path, timeout: float) -> dict:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"   # 跨平台统一中文输出编码
    env["PYTHONUNBUFFERED"] = "1"       # 超时前也能拿到已产生的输出
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [sys.executable, str(path)],
            cwd=str(_VOICE_DIR),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        rc = proc.returncode
        out = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired as e:
        rc = 124
        out = ""
        for chunk in (e.stdout, e.stderr):
            if isinstance(chunk, bytes):
                out += chunk.decode("utf-8", "replace")
            elif chunk:
                out += chunk
        out += f"\n[runner] 超时：超过 {timeout:g}s 未结束\n"

    elapsed = time.monotonic() - started
    smoke = is_smoke(path)
    summary = ""
    for line in out.splitlines():
        if SUMMARY_MARK in line:
            summary = line.strip()      # 取最后一条汇总
    if not summary:
        summary = "（冒烟脚本：无断言汇总）" if smoke else "（无汇总行）"

    markers = [m for m in ERROR_MARKS if m in out]
    ok = rc == 0 and not markers
    return {
        "path": path, "smoke": smoke, "ok": ok, "rc": rc,
        "elapsed": elapsed, "out": out, "summary": summary,
        "markers": markers,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="语音服务回归测试统一入口")
    ap.add_argument("--only", default="", help="只运行文件名含该子串的用例")
    ap.add_argument("--timeout", type=float, default=180.0,
                    help="单个用例超时秒数（默认 180）")
    ap.add_argument("--skip-smoke", action="store_true",
                    help="跳过依赖运行中服务的冒烟用例（纯离线回归）")
    ap.add_argument("--list", action="store_true", help="只列出发现的用例，不运行")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="打印每个用例的完整输出（默认仅失败时打印）")
    args = ap.parse_args()

    cases = discover()
    if args.only:
        cases = [p for p in cases if args.only in p.name]
    if args.skip_smoke:
        cases = [p for p in cases if not is_smoke(p)]
    kinds = {p: is_smoke(p) for p in cases}

    print("== 语音服务回归测试 / 统一入口 ==")
    print(f"解释器: {sys.executable}")
    print(f"用例数: {len(cases)} (断言 {sum(1 for k in kinds.values() if not k)} / "
          f"冒烟 {sum(1 for k in kinds.values() if k)})")
    if args.list:
        for p in cases:
            print(f"  [{'冒烟' if kinds[p] else '断言'}] {p.name}")
        return 0
    if not cases:
        print("没有匹配的用例（检查 --only / --skip-smoke）")
        return 2
    print()

    results = [run_one(p, args.timeout) for p in cases]
    for r in results:
        status = "PASS" if r["ok"] else "FAIL"
        tag = "冒烟" if r["smoke"] else "断言"
        print(f"[{status}] {r['path'].name:<40} {tag}  {r['elapsed']:5.1f}s  {r['summary']}")
        if args.verbose or not r["ok"]:
            print("  ---- 输出 ----")
            for line in r["out"].rstrip().splitlines():
                print("  " + line)
            print("  ----------------")
            if not r["ok"]:
                if r["markers"]:
                    print(f"  [runner] 输出含异常标记: {', '.join(r['markers'])}")
                if r["rc"] != 0:
                    print(f"  [runner] 退出码: {r['rc']}")
                if r["smoke"]:
                    print("  [runner] 提示：冒烟用例通常需要本地语音服务已启动")

    passed = sum(1 for r in results if r["ok"])
    total = len(results)
    print()
    print(f"== 汇总: {passed}/{total} 通过，耗时 "
          f"{sum(r['elapsed'] for r in results):.1f}s ==")
    failed = [r["path"].name for r in results if not r["ok"]]
    if failed:
        print("失败用例: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
