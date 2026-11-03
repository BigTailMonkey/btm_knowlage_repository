"""Runtime configuration for KnoWeave.

Every integration is a port: storage, embeddings, rerank and the LLM runtime can
be swapped without touching business services.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("KNOWWEAVE_DATA", BASE_DIR / "data"))
WEB_DIR = BASE_DIR / "web"

DEFAULT_DSH_REPO = Path.home() / "projects" / "deepseek-harness"


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


@dataclass
class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL", f"sqlite:///{(DATA_DIR / 'knowweave.db').as_posix()}"
    )
    # DeepSeek Harness is used only as the model interaction runtime.
    harness_enabled: bool = _bool("DSH_ENABLED", True)
    dsh_repo: Path = Path(os.getenv("DSH_REPO", str(DEFAULT_DSH_REPO)))
    dsh_profile: str = os.getenv("DSH_PROFILE", "headless")
    dsh_command: str = os.getenv("DSH_COMMAND", "pnpm")
    dsh_timeout_seconds: int = int(os.getenv("DSH_TIMEOUT_SECONDS", "120"))
    model: str = os.getenv("KNOWWEAVE_MODEL", "deepseek-v4.1-flash")
    provider: str = os.getenv("KNOWWEAVE_PROVIDER", "volcengine-ark")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "bge-m3-local-hash")
    embedding_dim: int = int(os.getenv("EMBEDDING_DIM", "384"))
    rerank_threshold: float = float(os.getenv("RERANK_THRESHOLD", "0.36"))
    reflection_enabled: bool = _bool("REFLECTION_ENABLED", True)
    reflection_interval_seconds: int = int(
        os.getenv("REFLECTION_INTERVAL_SECONDS", str(6 * 3600))
    )
    seed_demo: bool = _bool("SEED_DEMO", True)
    default_tenant_id: str = "tn_knowweave"
    prices: dict[str, tuple[float, float, str]] = field(
        default_factory=lambda: {
            # provider/model: (input per 1M, output per 1M, currency)
            "deepseek-v4.1-flash": (2.0, 8.0, "CNY"),
            "deepseek-chat": (2.0, 8.0, "CNY"),
            "bge-m3-local-hash": (0.0, 0.0, "CNY"),
        }
    )


settings = Settings()
