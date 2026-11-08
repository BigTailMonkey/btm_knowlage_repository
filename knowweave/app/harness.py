"""Use the configured OpenAI-compatible model for generation."""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Iterator, Protocol

import httpx

from .chunking import estimate_tokens
from .config import settings


@dataclass
class HarnessResult:
    text: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0
    model: str = ""
    provider: str = ""
    error: str | None = None

    @property
    def ok(self) -> bool:
        return not self.error and bool(self.text.strip())


class LLMHarness(Protocol):
    def complete(self, prompt: str, system: str | None = None) -> HarnessResult: ...
    def stream(self, prompt: str, system: str | None = None) -> Iterator[str]: ...
    def health(self) -> dict: ...


class ModelUnavailable(RuntimeError):
    pass


def require_model_text(result: HarnessResult, operation: str) -> str:
    if not result.ok:
        raise ModelUnavailable(f"{operation}失败：{result.error or '模型返回空响应'}")
    return result.text.strip()


class ConfiguredModel:
    provider = settings.provider
    model = settings.model

    def available(self) -> bool:
        return bool(self.model and settings.model_base_url and settings.model_api_key)

    def complete(self, prompt: str, system: str | None = None) -> HarnessResult:
        started = time.time()
        if not self.available():
            return HarnessResult("", error="请配置 [model] 的 model、base_url 和 api_key", model=self.model, provider=self.provider)
        key = settings.model_api_key
        base = settings.model_base_url
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        try:
            response = httpx.post(
                f"{base.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": 0.1,
                    **({"max_tokens": settings.model_max_tokens} if settings.model_max_tokens is not None else {}),
                },
                timeout=60,
            )
            response.raise_for_status()
            payload = response.json()
            text = payload["choices"][0]["message"]["content"]
            usage = payload.get("usage", {})
            return HarnessResult(
                text=text,
                tokens_in=int(usage.get("prompt_tokens") or estimate_tokens(prompt)),
                tokens_out=int(usage.get("completion_tokens") or estimate_tokens(text)),
                latency_ms=int((time.time() - started) * 1000),
                model=self.model,
                provider=self.provider,
            )
        except Exception as exc:  # noqa: BLE001
            return HarnessResult("", error=str(exc), model=self.model, provider=self.provider)

    def stream(self, prompt: str, system: str | None = None) -> Iterator[str]:
        yield require_model_text(self.complete(prompt, system=system), "模型生成")

    def health(self) -> dict:
        return {
            "adapter": "openai-compatible",
            "enabled": True,
            "available": self.available(),
            "model": self.model,
            "mode": "http",
        }


def parse_json_array(text: str) -> list[dict] | None:
    text = text.strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < start:
        return None
    try:
        payload = json.loads(text[start : end + 1])
        return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else None
    except json.JSONDecodeError:
        return None


harness: LLMHarness = ConfiguredModel()


def assert_model_ready() -> None:
    result = harness.complete("Reply with OK.")
    require_model_text(result, f"启动前模型检查（{result.model or '未配置模型'}）")
