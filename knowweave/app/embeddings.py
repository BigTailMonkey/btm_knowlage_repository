"""Embedding port and the OpenAI-compatible remote implementation.

Dense vectors always come from the configured model service. Sparse lexical
weights are still derived locally from tokens so hybrid retrieval keeps its
keyword path.
"""
from __future__ import annotations

import math
import re
import threading
from collections import Counter
from dataclasses import dataclass
from typing import Protocol

import httpx
import numpy as np

from .config import settings

CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]+")
WORD = re.compile(r"[A-Za-z][A-Za-z0-9_\-]+|\d+(?:\.\d+)?")
STOPWORDS = {
    "的", "了", "和", "与", "及", "是", "在", "对", "也", "就", "都", "而", "被",
    "把", "让", "从", "到", "这", "那", "有", "为", "以", "等", "或", "并", "一个",
    "我们", "你们", "他们", "什么", "如何", "怎么", "为什么",
}


def tokenize(text: str) -> list[str]:
    text = (text or "").lower()
    tokens: list[str] = []
    for run in CJK.findall(text):
        if len(run) == 1:
            if run not in STOPWORDS:
                tokens.append(run)
            continue
        # 单字 + 双字组合，兼顾短查询与专有名词。
        for ch in run:
            if ch not in STOPWORDS:
                tokens.append(ch)
        for i in range(len(run) - 1):
            gram = run[i : i + 2]
            if gram not in STOPWORDS:
                tokens.append(gram)
    for word in WORD.findall(text):
        if len(word) > 1 and word not in STOPWORDS:
            tokens.append(word)
    return tokens


def sparse_vector(tokens: list[str], limit: int = 96) -> dict[str, float]:
    counts = Counter(tokens)
    values = {
        token: round(1.0 + math.log(count), 4) for token, count in counts.items()
    }
    top = sorted(values.items(), key=lambda item: item[1], reverse=True)[:limit]
    return dict(top)


@dataclass
class Embedding:
    dense: list[float]
    sparse: dict[str, float]
    model: str
    dim: int


class EmbeddingError(RuntimeError):
    """Raised when the configured provider cannot produce a usable vector."""


class Embedder(Protocol):
    model: str
    dim: int

    def embed(self, text: str) -> Embedding: ...

    def embed_many(self, texts: list[str]) -> list[Embedding]: ...

    def embed_query(self, text: str) -> Embedding: ...


def _auth_headers() -> dict[str, str]:
    key = settings.embedding_api_key
    return {"Authorization": f"Bearer {key}"} if key else {}


def _post_json(url: str, payload: dict) -> dict:
    try:
        response = httpx.post(
            url,
            headers=_auth_headers(),
            json=payload,
            timeout=settings.embedding_timeout_seconds,
        )
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        raise EmbeddingError(
            f"向量服务返回 {exc.response.status_code}: {exc.response.text[:300]}"
        ) from exc
    except httpx.HTTPError as exc:
        raise EmbeddingError(f"向量服务不可用: {exc}") from exc
    except ValueError as exc:
        raise EmbeddingError("向量服务返回的不是合法 JSON") from exc


class RemoteEmbedder:
    """OpenAI-compatible ``/embeddings`` client.

    Dense vectors come from the provider. Sparse vectors are still built locally
    from tokens so the hybrid retrieval keeps its lexical path.
    """

    def __init__(self):
        self.model = settings.embedding_model
        self.dim = settings.embedding_dim
        self._lock = threading.Lock()

    def _url(self) -> str:
        return settings.embedding_base_url.rstrip("/") + settings.embedding_path

    def _request(self, texts: list[str]) -> list[list[float]]:
        if not settings.embedding_base_url:
            raise EmbeddingError("未配置 embedding.base_url，无法调用向量服务")
        if not self.model:
            raise EmbeddingError("未配置 embedding.model")
        payload = {"model": self.model, "input": texts, "encoding_format": "float"}
        body = _post_json(self._url(), payload)

        items = body.get("data")
        if items is None:
            items = body.get("embeddings")
        if not isinstance(items, list) or not items:
            raise EmbeddingError(f"向量服务未返回 vectors: {str(body)[:200]}")

        vectors: list[list[float]] = []
        for item in items:
            vector = item.get("embedding") if isinstance(item, dict) else item
            if not isinstance(vector, list) or not vector:
                raise EmbeddingError("向量服务返回的 embedding 格式不正确")
            vectors.append([float(value) for value in vector])
        if len(vectors) != len(texts):
            raise EmbeddingError(f"请求 {len(texts)} 条，返回 {len(vectors)} 条")
        return vectors

    def _lock_dim(self, width: int) -> None:
        with self._lock:
            if self.dim and width != self.dim:
                raise EmbeddingError(
                    f"向量维度不一致：EMBEDDING_DIM={self.dim}，模型返回 {width}"
                )
            self.dim = width

    def embed_many(self, texts: list[str]) -> list[Embedding]:
        if not texts:
            return []
        size = max(1, settings.embedding_batch_size)
        vectors: list[list[float]] = []
        for start in range(0, len(texts), size):
            vectors.extend(self._request(texts[start : start + size]))
        self._lock_dim(len(vectors[0]))
        return [
            Embedding(vector, sparse_vector(tokenize(text)), self.model, len(vector))
            for text, vector in zip(texts, vectors)
        ]

    def embed(self, text: str) -> Embedding:
        return self.embed_many([text])[0]

    def embed_query(self, text: str) -> Embedding:
        return self.embed(text)


class ArkEmbedder:
    """Volcengine Ark multimodal embeddings for ``doubao-embedding-vision``.

    Ark's multimodal endpoint accepts one multimodal input per request and
    returns a single vector, so "batching" here is a loop over texts.
    """

    def __init__(self):
        self.model = settings.embedding_model
        self.dim = settings.embedding_dim
        self._lock = threading.Lock()

    def _url(self) -> str:
        return settings.embedding_base_url.rstrip("/") + settings.embedding_path

    def _request(self, text: str) -> list[float]:
        if not settings.embedding_base_url:
            raise EmbeddingError("未配置 embedding.base_url，无法调用向量服务")
        if not self.model:
            raise EmbeddingError("未配置 embedding.model")
        payload: dict = {
            "model": self.model,
            "encoding_format": "float",
            "input": [{"type": "text", "text": text}],
        }
        if self.dim:
            payload["dimensions"] = self.dim
        if settings.embedding_instructions:
            payload["instructions"] = settings.embedding_instructions
        body = _post_json(self._url(), payload)

        data = body.get("data")
        if isinstance(data, list) and data:
            data = data[0]
        if not isinstance(data, dict):
            raise EmbeddingError(f"向量服务未返回 vectors: {str(body)[:200]}")
        vector = data.get("embedding")
        if not isinstance(vector, list) or not vector:
            raise EmbeddingError("向量服务返回的 embedding 格式不正确")
        return [float(value) for value in vector]

    def _lock_dim(self, width: int) -> None:
        with self._lock:
            if self.dim and width != self.dim:
                raise EmbeddingError(
                    f"向量维度不一致：embedding.dim={self.dim}，模型返回 {width}"
                )
            self.dim = width

    def embed_many(self, texts: list[str]) -> list[Embedding]:
        if not texts:
            return []
        vectors = [self._request(text) for text in texts]
        self._lock_dim(len(vectors[0]))
        return [
            Embedding(vector, sparse_vector(tokenize(text)), self.model, len(vector))
            for text, vector in zip(texts, vectors)
        ]

    def embed(self, text: str) -> Embedding:
        return self.embed_many([text])[0]

    def embed_query(self, text: str) -> Embedding:
        return self.embed(text)


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    va = np.asarray(a, dtype=np.float32)
    vb = np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)


def sparse_dot(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    return float(sum(value * b.get(token, 0.0) for token, value in a.items()))


def keyword_overlap(query_tokens: list[str], text: str) -> float:
    if not query_tokens:
        return 0.0
    q = set(query_tokens)
    d = set(tokenize(text))
    if not q:
        return 0.0
    return len(q & d) / len(q)


def build_embedder() -> Embedder:
    if settings.embedding_provider.strip().lower() == "openai":
        return RemoteEmbedder()
    return ArkEmbedder()


embedder: Embedder = build_embedder()
