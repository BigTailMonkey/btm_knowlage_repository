"""LLMHarness adapter.

Business code only knows this interface: complete / stream / health. The
DeepSeek Harness is invoked as a headless runtime; no internal DSH module is
imported. A direct DeepSeek-compatible adapter exists only as a graceful
fallback, and an extractive answer keeps the product usable when no model is
reachable.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Protocol

import httpx

from .chunking import estimate_tokens
from .config import settings

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


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
    def complete(self, prompt: str, system: str | None = None, max_tokens: int = 2048) -> HarnessResult: ...
    def stream(self, prompt: str, system: str | None = None) -> Iterator[str]: ...
    def health(self) -> dict: ...


def _clean_output(raw: str) -> str:
    raw = ANSI.sub("", raw)
    lines = raw.splitlines()
    cleaned: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("$ node --import") or stripped.startswith("$ pnpm"):
            continue
        if stripped.startswith("[dsh]") or stripped.startswith("dsh:"):
            continue
        cleaned.append(line.rstrip())
    text = "\n".join(cleaned).strip()
    text = re.sub(r"^⏺\s*", "", text)
    return text.strip()


class DshHarness:
    provider = settings.provider
    model = settings.model

    def __init__(self):
        self.repo = settings.dsh_repo
        self.profile = settings.dsh_profile
        self.command = settings.dsh_command
        self.last_error: str | None = None

    def _binary(self) -> str | None:
        return shutil.which(self.command)

    def _argv(self, prompt: str) -> list[str]:
        return [self._binary() or self.command, "dsh", "--profile", self.profile, prompt]

    def available(self) -> bool:
        return (
            settings.harness_enabled
            and self.repo.exists()
            and (Path(self.repo) / "apps" / "cli" / "src" / "bin.ts").exists()
            and self._binary() is not None
        )

    def complete(self, prompt: str, system: str | None = None, max_tokens: int = 2048) -> HarnessResult:
        started = time.time()
        full = f"{system.strip()}\n\n{prompt}" if system else prompt
        if not self.available():
            self.last_error = "DSH 运行时不可用"
            return HarnessResult("", error=self.last_error, provider=self.provider, model=self.model)
        try:
            process = subprocess.run(
                self._argv(full),
                cwd=str(self.repo),
                capture_output=True,
                text=True,
                timeout=settings.dsh_timeout_seconds,
                env=os.environ.copy(),
            )
            text = _clean_output(process.stdout or "")
            if process.returncode != 0 or not text:
                detail = _clean_output(process.stderr or "")[-800:]
                self.last_error = detail or f"DSH 退出码 {process.returncode}"
                return HarnessResult(
                    "",
                    latency_ms=int((time.time() - started) * 1000),
                    error=self.last_error,
                    provider=self.provider,
                    model=self.model,
                )
            self.last_error = None
            return HarnessResult(
                text=text,
                tokens_in=estimate_tokens(full),
                tokens_out=estimate_tokens(text),
                latency_ms=int((time.time() - started) * 1000),
                model=self.model,
                provider=self.provider,
            )
        except subprocess.TimeoutExpired:
            self.last_error = "DSH 调用超时"
        except Exception as exc:  # noqa: BLE001 - adapter boundary
            self.last_error = str(exc)
        return HarnessResult(
            "",
            latency_ms=int((time.time() - started) * 1000),
            error=self.last_error,
            provider=self.provider,
            model=self.model,
        )

    def stream(self, prompt: str, system: str | None = None) -> Iterator[str]:
        """Streaming is intentionally conservative: yield complete text in one
        chunk if the runtime cannot provide token-level output."""
        result = self.complete(prompt, system=system)
        if result.ok:
            yield result.text

    def health(self) -> dict:
        return {
            "adapter": "deepseek-harness",
            "enabled": settings.harness_enabled,
            "available": self.available(),
            "repo": str(self.repo),
            "profile": self.profile,
            "command": self.command,
            "provider": self.provider,
            "model": self.model,
            "last_error": self.last_error,
            "mode": "subprocess/headless",
        }


def _load_api_key() -> str:
    return settings.model_api_key


class DeepSeekApiHarness:
    """Fallback adapter for an OpenAI-compatible DeepSeek endpoint."""

    provider = "deepseek-official"
    model = settings.fallback_model

    def available(self) -> bool:
        return bool(_load_api_key())

    def complete(self, prompt: str, system: str | None = None, max_tokens: int = 2048) -> HarnessResult:
        started = time.time()
        key = _load_api_key()
        if not key:
            return HarnessResult("", error="未配置 model.api_key", model=self.model)
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
                    "max_tokens": max_tokens,
                    "temperature": 0.1,
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
        result = self.complete(prompt, system=system)
        if result.ok:
            yield result.text

    def health(self) -> dict:
        return {
            "adapter": "deepseek-api",
            "enabled": True,
            "available": self.available(),
            "model": self.model,
            "mode": "http",
        }


class FallbackHarness:
    """Composite adapter: DSH first, direct API second, never raises."""

    def __init__(self):
        self.primary = DshHarness()
        self.fallback = DeepSeekApiHarness()
        self.last_used = "none"

    def _chain(self):
        if self.primary.available():
            yield self.primary
        if self.fallback.available():
            yield self.fallback

    def complete(self, prompt: str, system: str | None = None, max_tokens: int = 2048) -> HarnessResult:
        errors = []
        for adapter in self._chain():
            result = adapter.complete(prompt, system=system, max_tokens=max_tokens)
            if result.ok:
                self.last_used = adapter.provider
                return result
            errors.append(result.error or "unknown")
        self.last_used = "none"
        return HarnessResult("", error="; ".join(errors) or "没有可用的模型适配器")

    def stream(self, prompt: str, system: str | None = None) -> Iterator[str]:
        result = self.complete(prompt, system=system)
        if result.ok:
            yield result.text

    def health(self) -> dict:
        return {
            "adapter": "composite",
            "last_used": self.last_used,
            "primary": self.primary.health(),
            "fallback": self.fallback.health(),
        }


def parse_json_array(text: str) -> list[dict]:
    text = text.strip()
    if not text:
        return []
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < start:
        return []
    try:
        payload = json.loads(text[start : end + 1])
        return [item for item in payload if isinstance(item, dict)]
    except json.JSONDecodeError:
        return []


harness: LLMHarness = FallbackHarness()
