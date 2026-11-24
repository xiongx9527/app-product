"""OCR 工作进程：从 stdin 读请求 JSON，stdout 输出识别结果 JSON。

输入：{"image": "<base64>", "max_pages": N}
  类型按魔数自动识别：%PDF- 开头走 PDF（pypdfium2 逐页渲染后 OCR），否则按图片。
  调用方无需传 kind 参数。

由 builtin_ocr.recognize() 用主服务同 venv 的 python 拉起，短生命周期、不开端口。
PaddleOCR 在本独立进程里初始化，避免与父进程的 torch（内置重排）C++ 扩展冲突 segfault。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from typing import Any


def _texts_from_result(result) -> list[dict[str, Any]]:
    texts: list[dict[str, Any]] = []
    for res in (result or []):
        data = (res.json or {}).get("res", {})
        rec_texts = data.get("rec_texts") or []
        rec_scores = data.get("rec_scores") or []
        rec_boxes = data.get("rec_boxes") or []
        for i, txt in enumerate(rec_texts):
            box = rec_boxes[i] if i < len(rec_boxes) else []
            texts.append({
                "text": str(txt),
                "score": round(float(rec_scores[i]), 4) if i < len(rec_scores) else 0.0,
                "box": box.tolist() if hasattr(box, "tolist") else box,
            })
    return texts


def main() -> int:
    try:
        req = json.loads(sys.stdin.read())
        raw = req.get("image", "")
        if not isinstance(raw, str) or not raw.strip():
            print(json.dumps({"ok": False, "error": "image 为空"}))
            return 1
        data = base64.b64decode(raw, validate=True)
        is_pdf = (req.get("kind") == "pdf") or data[:5] == b"%PDF-"

        from paddleocr import PaddleOCR

        version = os.environ.get("OCR_BUILTIN_MODEL") or os.environ.get("OCR_MODEL_VERSION") or "PP-OCRv5"
        ocr = PaddleOCR(
            ocr_version=version,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        import numpy as np
        from PIL import Image

        max_pages = int(req.get("max_pages") or 20)

        if is_pdf:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(data)
            pages = []
            n = min(len(pdf), max_pages)
            for i in range(n):
                page = pdf[i]
                bitmap = page.render(scale=2.0)  # 2x 提升小字识别率
                pil = bitmap.to_pil().convert("RGB")
                texts = _texts_from_result(ocr.predict(np.array(pil)))
                pages.append({"page": i + 1, "texts": texts,
                              "full_text": "\n".join(t["text"] for t in texts)})
            pdf.close()
            all_texts = [t for p in pages for t in p["texts"]]
            out = {"ok": True, "kind": "pdf", "page_count": len(pages), "pages": pages,
                   "texts": all_texts, "full_text": "\n".join(p["full_text"] for p in pages)}
        else:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            texts = _texts_from_result(ocr.predict(np.array(img)))
            out = {"ok": True, "kind": "image", "texts": texts,
                   "full_text": "\n".join(t["text"] for t in texts)}

        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
