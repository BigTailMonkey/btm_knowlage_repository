"""Test bootstrap: isolated SQLite database and an offline model harness."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TEST_DIR = Path(tempfile.mkdtemp(prefix="knowweave-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TEST_DIR / 'test.db').as_posix()}"
os.environ["DSH_ENABLED"] = "0"
os.environ["REFLECTION_ENABLED"] = "0"
os.environ["SEED_DEMO"] = "1"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

OWNER = {"Authorization": "Bearer owner-token"}
VIEWER = {"Authorization": "Bearer viewer-token"}
OUTSIDER = {"Authorization": "Bearer outsider-token"}
AGENT = {"Authorization": "Bearer agent-token"}


class DisabledHarness:
    """Deterministic offline harness: forces extractive answers and rule facts."""

    def complete(self, prompt: str, system: str | None = None, max_tokens: int = 2048):
        from app.harness import HarnessResult

        return HarnessResult("", error="model disabled in tests")

    def stream(self, prompt: str, system: str | None = None):
        return iter(())

    def health(self) -> dict:
        return {"adapter": "test-offline", "available": False}


@pytest.fixture(scope="session", autouse=True)
def offline_harness():
    from app import answering, learning

    harness = DisabledHarness()
    answering.harness = harness
    learning.harness = harness
    yield harness


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
