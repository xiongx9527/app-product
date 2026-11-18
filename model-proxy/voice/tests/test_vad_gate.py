"""验证 SenseVoice 前的声学门控 looks_like_non_speech 能区分真人讲话与非语音噪声。

背景：SenseVoice 对纯静音/白噪声会脑补出文本（静音→「没。」、白噪声→「嗯。」），
导致咳嗽/吸鼻涕被识别成「我/对/同意/对呀」触发无意义回答。门控用 ZCR 从源头挡掉
非语音：真人浊音 ZCR≈0.1，宽带噪声≈0.5，阈值 0.28 分开（实测 5 倍差距）。

运行：~/.app-product/voice/venv/bin/python tests/test_vad_gate.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from openai_voice_server import looks_like_non_speech  # noqa: E402

SR = 16000


def human_voice_like(duration_s=1.0, zcr=0.10, amplitude=0.05):
    """合成低过零率的准周期信号，模拟真人浊音（过零稀疏、波形平滑）。"""
    n = int(SR * duration_s)
    t = np.arange(n) / SR
    f0 = 140.0  # 基频 140Hz（成人男声量级）
    # 基频 + 谐波，过零率约为 2*f0/SR ≈ 0.0175，远低于阈值
    x = amplitude * (np.sin(2 * np.pi * f0 * t) + 0.3 * np.sin(2 * np.pi * 2 * f0 * t))
    return x.astype("float32")


def broadband_noise(duration_s=1.0, amplitude=0.05, seed=0):
    """白噪声：过零率≈0.5，模拟咳嗽/吸鼻涕/静电。"""
    rng = np.random.default_rng(seed)
    return (rng.normal(0, amplitude, int(SR * duration_s))).astype("float32")


def main():
    cases = [
        ("真人浊音(140Hz)", human_voice_like(), False),
        ("真人大振幅浊音", human_voice_like(amplitude=0.3), False),
        ("白噪声(低能量)", broadband_noise(amplitude=0.02), True),
        ("白噪声(高能量)", broadband_noise(amplitude=0.3, seed=1), True),
        ("静音", np.zeros(SR, dtype="float32"), True),
    ]
    failed = 0
    for name, x, expected in cases:
        got = looks_like_non_speech(x)
        ok = got == expected
        print(f"{'OK ' if ok else 'FAIL'} {name:20} 非语音={got} 期望={expected}")
        failed += 0 if ok else 1
    if failed:
        print(f"\n{failed} 个用例失败")
        sys.exit(1)
    print("\n全部通过：真人讲话放行、噪声/静音拦截")


if __name__ == "__main__":
    main()
