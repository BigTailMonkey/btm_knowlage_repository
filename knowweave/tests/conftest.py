"""Test bootstrap: isolated SQLite database and an offline model harness."""
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

_TEST_DIR = Path(tempfile.mkdtemp(prefix="knowweave-tests-"))

from app.config import settings  # noqa: E402

settings.database_url = f"sqlite:///{(_TEST_DIR / 'test.db').as_posix()}"
settings.seed_demo = True
settings.harness_enabled = False
settings.reflection_enabled = False

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


class StubEmbedder:
    """Deterministic offline stand-in for the remote embedding service."""

    model = "test-hash"
    dim = 384

    def embed(self, text: str):
        from app.embeddings import Embedding, sparse_vector, tokenize

        tokens = tokenize(text)
        vec = [0.0] * self.dim
        for token in tokens:
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            value = int.from_bytes(digest, "big")
            vec[value % self.dim] += 1.0 if (value >> 63) & 1 else -1.0
        norm = sum(item * item for item in vec) ** 0.5
        if norm:
            vec = [item / norm for item in vec]
        return Embedding(vec, sparse_vector(tokens), self.model, self.dim)

    def embed_many(self, texts: list[str]):
        return [self.embed(text) for text in texts]

    def embed_query(self, text: str):
        return self.embed(text)


@pytest.fixture(scope="session", autouse=True)
def offline_harness():
    from app import answering, embeddings, ingestion, learning, retrieval

    harness = DisabledHarness()
    answering.harness = harness
    learning.harness = harness
    stub = StubEmbedder()
    embeddings.embedder = stub
    ingestion.embedder = stub
    retrieval.embedder = stub
    yield harness


@pytest.fixture(scope="session")
def client():
    from app.db import SessionLocal
    from app.main import app
    from demo_data import seed_demo

    with TestClient(app) as test_client:
        with SessionLocal() as db:
            seed_demo(db)
        yield test_client
