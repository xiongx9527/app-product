"""统一模型目录（三端口：LLM / TTS / STT）。

对齐 fw-plus-ai-native 的 ModelInfo / ModelCatalogSupport / ModelValidation：
- 同一份「模型目录」里区分三种能力端口（Java 侧是 LLM / EMBEDDING / RERANK，
  我们这里是 LLM / TTS / STT，因为本服务是语音代理）。
- 只保留跨厂商通用的字段；厂商私有字段不进入契约，避免上层被单一协议绑定。
- 匹配规则：先按 id 精确匹配，再忽略大小写匹配一次（部分厂商返回的 id 大小写不稳定）。
- 目录为空表示厂商不支持枚举（或枚举失败），此时无法判定存在性，由调用方决定下一步。

未知数值用 0 表示（与 Java ModelInfo 约定一致）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence


class ModelType:
    """模型能力端口：与 Java 的 ModelType 一一对应，只是把 EMBEDDING/RERANK 换成 TTS/STT。

    EMBED 是向量（embeddings）端口——本服务的 LLM 代理既做对话也做向量，
    /llm/v1/models 要同时列出两者，故单列 EMBED 类型以区分。
    """

    LLM = "LLM"
    EMBED = "EMBED"
    TTS = "TTS"
    STT = "STT"

    ALL = (LLM, EMBED, TTS, STT)


@dataclass
class ModelInfo:
    """模型目录条目：由各能力端口 list_models() 返回，用于前端选型、配置校验与按能力归类。"""

    id: str
    name: Optional[str] = None
    owned_by: Optional[str] = None
    type: str = ModelType.LLM
    context_length: int = 0  # 未知用 0（与 Java 约定一致）
    dimension: int = 0
    # 厂商单独表达，不混进 protocol（与「协议 = 线协议 ≠ 厂商」的口径一致）。
    provider: Optional[str] = None  # builtin / dashscope / deepseek / openai_audio …
    # 调用形态：http / ws / http-async；内置本地引擎也是走 /voice/v1 的 HTTP，故为 http。
    protocol: Optional[str] = None
    # 该模型是否是其提供商在该能力端口下的默认模型（按提供商维度，见 default_model_for_provider）。
    is_default: bool = False

    def to_openai(self) -> dict:
        """转成 OpenAI /v1/models 的条目形状，并附上端口类型 / 提供商 / 协议等能力字段。"""
        return {
            "id": self.id,
            "object": "model",
            "owned_by": self.owned_by or "local",
            # 扩展字段：让网关 / 测试界面能直接区分端口类型、能力与线协议，不影响 OpenAI 客户端。
            "type": self.type,
            "context_length": self.context_length,
            "dimension": self.dimension,
            "provider": self.provider or "",
            "protocol": self.protocol or "",
            "is_default": self.is_default,
        }


def of_type(models: Sequence[Optional[ModelInfo]], model_type: str) -> list[ModelInfo]:
    """按能力端口过滤目录；models 为 None 或 type 为空时返回空列表。"""
    if not models or not model_type:
        return []
    return [m for m in models if m is not None and m.type == model_type]


def find(models: Sequence[Optional[ModelInfo]], model: str) -> Optional[ModelInfo]:
    """在目录中查找模型；先精确匹配，再忽略大小写匹配一次；找不到返回 None。"""
    if not models or not model:
        return None
    for m in models:
        if m is not None and m.id == model:
            return m
    low = model.lower()
    for m in models:
        if m is not None and m.id and m.id.lower() == low:
            return m
    return None


@dataclass
class ModelValidation:
    """模型校验结果：是否可用、原因、探针耗时（毫秒）。"""

    model: Optional[str]
    valid: bool
    reason: Optional[str]
    latency_ms: int

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "valid": self.valid,
            "reason": self.reason,
            "latency_ms": self.latency_ms,
        }


def validate(
    model_type: str,
    models: Sequence[Optional[ModelInfo]],
    model: str,
    latency_ms: int = 0,
) -> ModelValidation:
    """按目录判定模型是否可用。

    目录为空表示厂商不支持枚举（或枚举失败），此时无法判定存在性，返回失败并说明原因，
    由调用方决定是否改用轻量探测。
    """
    if not model or not model.strip():
        return ModelValidation(model, False, "model id is required", latency_ms)
    if find(models, model) is not None:
        return ModelValidation(model, True, None, latency_ms)
    if not models:
        port = (model_type or "model").lower()
        return ModelValidation(
            model, False, f"no {port} model available from provider", latency_ms
        )
    return ModelValidation(model, False, "model not found in provider catalog", latency_ms)


def empty() -> list[ModelInfo]:
    """空目录常量，避免各 adapter 反复创建空列表。"""
    return []
