"""验证 SenseVoice 前的声学门控 looks_like_non_speech 能区分真人讲话与非语音噪声。

背景：SenseVoice 对纯静音/白噪声会脑补出文本（静音→「没。」、白噪声→「嗯。」），
导致咳嗽/吸鼻涕被识别成「我/对/同意/对呀」触发无意义回答。门控从音频层判断
「是不是真人讲话」，挡在识别之前：

1. 过零率（ZCR）：真人浊音有基频、波形平滑（≈0.09~0.14），宽带噪声≈0.5。
2. 频谱平坦度：真人声能量集中在基频与谐波（真机样本 0.037~0.066），冲击/摩擦
   噪声铺满频带（真机咳嗽 0.322~0.348）。补 ZCR 的洞——真机咳嗽 ZCR 仅
   0.178~0.218，低于 0.22 门限，只有平坦度拦得住。

运行：~/.app-product/voice/venv/bin/python tests/test_vad_gate.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from openai_voice_server import looks_like_non_speech  # noqa: E402

SR = 16000


def human_voice_like(duration_s=1.0, amplitude=0.05):
    """合成低过零率、低频谱平坦度的准周期信号，模拟真人浊音。"""
    n = int(SR * duration_s)
    t = np.arange(n) / SR
    f0 = 140.0  # 基频 140Hz（成人男声量级）
    # 基频 + 谐波：过零稀疏、能量集中在谐波线上，两个判据都远低于门限
    x = amplitude * (np.sin(2 * np.pi * f0 * t) + 0.3 * np.sin(2 * np.pi * 2 * f0 * t))
    return x.astype("float32")


def broadband_noise(duration_s=1.0, amplitude=0.05, seed=0):
    """白噪声：过零率≈0.5，模拟宽带静电/强摩擦噪声。"""
    rng = np.random.default_rng(seed)
    return (rng.normal(0, amplitude, int(SR * duration_s))).astype("float32")


def cough_like(duration_s=0.6, bursts=4, amplitude=0.35, seed=3):
    """咳嗽样冲击串：等间隔短促宽带脉冲（衰减很快的噪声块）。

    特征对齐真机咳嗽样本：ZCR 只有 0.1~0.2（低于 0.22 门限），但每帧频谱
    铺满整个频带、平坦度>0.6。专门验证「ZCR 漏掉、平坦度拦住」这条路径。
    """
    rng = np.random.default_rng(seed)
    x = np.zeros(int(SR * duration_s), dtype="float32")
    span = x.size // bursts
    for k in range(bursts):
        wlen = 48  # 3ms 冲击
        seg = rng.normal(0, amplitude, wlen) * np.hanning(wlen)
        start = k * span + span // 3
        end = min(start + wlen, x.size)
        x[start:end] = seg[: end - start].astype("float32")
    return x


def main():
    cases = [
        ("真人浊音(140Hz)", human_voice_like(), False),
        ("真人大振幅浊音", human_voice_like(amplitude=0.3), False),
        ("真人短应答(0.25s)", human_voice_like(duration_s=0.25, amplitude=0.1), False),
        ("白噪声(低能量)", broadband_noise(amplitude=0.02), True),
        ("白噪声(高能量)", broadband_noise(amplitude=0.3, seed=1), True),
        ("咳嗽样冲击串(低ZCR)", cough_like(), True),
        ("静音", np.zeros(SR, dtype="float32"), True),
    ]
    failed = 0
    for name, x, expected in cases:
        got = looks_like_non_speech(x)
        ok = got == expected
        print(f"{'OK ' if ok else 'FAIL'} {name:22} 非语音={got} 期望={expected}")
        failed += 0 if ok else 1
    if failed:
        print(f"\n{failed} 个用例失败")
        sys.exit(1)
    print("\n全部通过：真人讲话（含短应答）放行、噪声/咳嗽/静音拦截")


if __name__ == "__main__":
    main()
