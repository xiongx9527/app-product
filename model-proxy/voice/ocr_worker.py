"""OCR 工作进程：从 stdin 读 {"image": "<base64>"}，stdout 输出识别结果 JSON。

由 builtin_ocr.recognize() 用主服务同 venv 的 python 拉起，短生命周期、不开端口。
PaddleOCR 在本独立进程里初始化，避免与父进程的 torch（内置重排）C++ 扩展冲突 segfault。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys


def main() -> int:
    try:
        req = json.loads(sys.stdin.read())
        raw = req.get("image", "")
        if not isinstance(raw, str) or not raw.strip():
            print(json.dumps({"ok": False, "error": "image 为空"}))
            return 1
        image_bytes = base64.b64decode(raw, validate=True)

        from paddleocr import PaddleOCR

        version = os.environ.get("OCR_MODEL_VERSION", "PP-OCRv5")
        ocr = PaddleOCR(
            ocr_version=version,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        import numpy as np
        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        result = ocr.predict(np.array(img))

        texts = []
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
        print(json.dumps({"ok": True, "texts": texts,
                          "full_text": "\n".join(t["text"] for t in texts)}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
