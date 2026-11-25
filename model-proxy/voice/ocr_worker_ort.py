"""OCR 工作进程（onnxruntime 版）：stdin 读请求 JSON，stdout 输出识别结果 JSON。

与 ocr_worker.py 协议完全一致：
  输入：{"image": "<base64>", "max_pages": N, "kind": "pdf"?(可选)}
  输出：{"ok": true, "kind": "image|pdf", "texts": [...], "full_text": "..."}
       或 {"ok": false, "error": "..."}

为什么独立进程：onnxruntime 自带模型，不依赖 paddle（paddle 需要 AVX2，
Docker Desktop 的 Linux VM 只暴露 AVX，会 SIGILL）；子进程隔离也避免影响主服务。

依赖：rapidocr_onnxruntime（含 onnxruntime 与自带 PP-OCR 模型），
安装到可写目录（容器根文件系统只读），由 builtin_ocr.py 通过 PYTHONPATH 注入。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from typing import Any


def _engine():
    """惰性加载 RapidOCR（首次调用加载模型，约 1s）。"""
    from rapidocr_onnxruntime import RapidOCR
    # 模型随包自带；缓存写可写目录，避免只读根导致失败。
    return RapidOCR()


def _norm_result(result, elapse=None) -> dict[str, Any]:
    """把 RapidOCR 的 (points, text, score) 三元组列表转成统一 texts 结构。"""
    texts: list[dict[str, Any]] = []
    for item in (result or []):
        try:
            box, txt, score = item[0], item[1], item[2]
        except (IndexError, TypeError):
            continue
        pts = []
        try:
            for p in (box or []):
                pts.append([round(float(p[0]), 1), round(float(p[1]), 1)])
        except (IndexError, TypeError, ValueError):
            pts = []
        texts.append({"text": str(txt), "score": round(float(score), 4), "box": pts})
    return {"texts": texts, "full_text": "\n".join(t["text"] for t in texts)}


def main() -> int:
    try:
        req = json.loads(sys.stdin.read())
        raw = req.get("image", "")
        if not isinstance(raw, str) or not raw.strip():
            print(json.dumps({"ok": False, "error": "image 为空"}, ensure_ascii=False))
            return 1
        data = base64.b64decode(raw, validate=True)
        is_pdf = (req.get("kind") == "pdf") or data[:5] == b"%PDF-"

        engine = _engine()
        from PIL import Image

        max_pages = int(req.get("max_pages") or 20)

        if is_pdf:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(data)
            pages = []
            n = min(len(pdf), max_pages)
            for i in range(n):
                page = pdf[i]
                bitmap = page.render(scale=2.0)
                pil = bitmap.to_pil().convert("RGB")
                result, _ = engine(pil)
                r = _norm_result(result)
                pages.append({"page": i + 1, "texts": r["texts"], "full_text": r["full_text"]})
            pdf.close()
            all_texts = [t for p in pages for t in p["texts"]]
            out = {"ok": True, "kind": "pdf", "page_count": len(pages), "pages": pages,
                   "texts": all_texts, "full_text": "\n".join(p["full_text"] for p in pages)}
        else:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            result, _ = engine(img)
            r = _norm_result(result)
            out = {"ok": True, "kind": "image", "texts": r["texts"], "full_text": r["full_text"]}

        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
