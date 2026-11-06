"""Runtime configuration for KnoWeave, loaded from ``config.toml``.

Every integration is a port: storage, embeddings, rerank and the LLM runtime can
be swapped without touching business services.
"""
from __future__ import annotations

import os
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config.toml"
WEB_DIR = BASE_DIR / "web"


def _read_config(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _resolve_path(value: str, fallback: Path) -> Path:
    if not value:
        return fallback
    path = Path(value).expanduser()
    return path if path.is_absolute() else BASE_DIR / path


@dataclass
class Settings:
    database_url: str = ""
    seed_demo: bool = True
    timezone: str = "Asia/Shanghai"

    harness_enabled: bool = True
    dsh_repo: Path = Path.home() / "projects" / "deepseek-harness"
    dsh_profile: str = "headless"
    dsh_command: str = "pnpm"
    dsh_timeout_seconds: int = 120
    model: str = "deepseek-v4.1-flash"
    provider: str = "volcengine-ark"
    model_api_key: str = ""
    model_base_url: str = "https://api.deepseek.com"
    fallback_model: str = "deepseek-chat"

    embedding_provider: str = "volcengine-ark"
    embedding_model: str = "doubao-embedding-vision-251215"
    embedding_dim: int = 1024
    embedding_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    embedding_api_key: str = ""
    embedding_path: str = "/embeddings/multimodal"
    embedding_instructions: str = ""
    embedding_batch_size: int = 32
    embedding_timeout_seconds: int = 30

    rerank_threshold: float = 0.36
    reflection_enabled: bool = True
    reflection_interval_seconds: int = 21600
    default_tenant_id: str = "tn_knowweave"
    prices: dict[str, tuple[float, float, str]] = field(default_factory=dict)

    @classmethod
    def from_file(cls, path: Path = CONFIG_PATH) -> "Settings":
        raw = _read_config(path)
        settings = cls()

        storage = raw.get("storage", {})
        database = raw.get("database", {})
        data_dir = _resolve_path(storage.get("data_dir", ""), BASE_DIR / "data")
        settings.database_url = (
            database.get("url")
            or f"sqlite:///{(data_dir / 'knowweave.db').as_posix()}"
        )
        settings.seed_demo = bool(database.get("seed", True))

        time_cfg = raw.get("time", {})
        settings.timezone = time_cfg.get("timezone", settings.timezone)

        model = raw.get("model", {})
        settings.provider = model.get("provider", settings.provider)
        settings.model = model.get("model", settings.model)
        settings.harness_enabled = bool(model.get("harness_enabled", True))
        settings.dsh_repo = _resolve_path(model.get("dsh_repo", ""), settings.dsh_repo)
        settings.dsh_profile = model.get("dsh_profile", settings.dsh_profile)
        settings.dsh_command = model.get("dsh_command", settings.dsh_command)
        settings.dsh_timeout_seconds = int(
            model.get("dsh_timeout_seconds", settings.dsh_timeout_seconds)
        )
        settings.model_api_key = model.get("api_key", "")
        settings.model_base_url = model.get("base_url", settings.model_base_url)
        settings.fallback_model = model.get("fallback_model", settings.fallback_model)

        embedding = raw.get("embedding", {})
        settings.embedding_provider = embedding.get("provider", settings.embedding_provider)
        settings.embedding_model = embedding.get("model", settings.embedding_model)
        settings.embedding_dim = int(embedding.get("dim", settings.embedding_dim))
        settings.embedding_base_url = embedding.get("base_url", settings.embedding_base_url)
        settings.embedding_api_key = embedding.get("api_key", "")
        settings.embedding_path = embedding.get("path", settings.embedding_path)
        settings.embedding_instructions = embedding.get("instructions", "")
        settings.embedding_batch_size = int(
            embedding.get("batch_size", settings.embedding_batch_size)
        )
        settings.embedding_timeout_seconds = int(
            embedding.get("timeout_seconds", settings.embedding_timeout_seconds)
        )

        retrieval = raw.get("retrieval", {})
        settings.rerank_threshold = float(
            retrieval.get("rerank_threshold", settings.rerank_threshold)
        )

        reflection = raw.get("reflection", {})
        settings.reflection_enabled = bool(reflection.get("enabled", True))
        settings.reflection_interval_seconds = int(
            reflection.get("interval_seconds", settings.reflection_interval_seconds)
        )

        tenant = raw.get("tenant", {})
        settings.default_tenant_id = tenant.get("default_id", settings.default_tenant_id)

        settings.prices = {
            name: (
                float(values.get("input_per_1m", 0.0)),
                float(values.get("output_per_1m", 0.0)),
                values.get("currency", "CNY"),
            )
            for name, values in raw.get("prices", {}).items()
        }
        return settings


settings = Settings.from_file()

# 进程时区以配置为准，保证日志、date.today() 等本地时间与业务日历一致。
# 容器部署时仍建议显式设置 TZ 环境变量，二者需保持一致。
os.environ["TZ"] = settings.timezone
if hasattr(time, "tzset"):
    time.tzset()
