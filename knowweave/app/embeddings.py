"""Embedding port and the dependency-free local implementation.

Production deployments can swap in a cloud BGE-M3 / Qwen3-Embedding adapter.
The local adapter uses signed feature hashing over character n-grams and words,
plus a sparse lexical vector. It is deterministic, fast, needs no GPU and keeps
the index rebuildable.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Protocol

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


def _signed_hash(token: str) -> tuple[int, float]:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    value = int.from_bytes(digest, "big")
    index = value % settings.embedding_dim
    sign = 1.0 if (value >> 63) & 1 else -1.0
    return index, sign


def dense_vector(tokens: list[str]) -> list[float]:
    vec = np.zeros(settings.embedding_dim, dtype=np.float32)
    for token in tokens:
        index, sign = _signed_hash(token)
        vec[index] += sign
    norm = float(np.linalg.norm(vec))
    if norm == 0:
        return vec.tolist()
    vec /= norm
    return vec.astype(np.float32).tolist()


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


class Embedder(Protocol):
    model: str
    dim: int

    def embed(self, text: str) -> Embedding: ...

    def embed_query(self, text: str) -> Embedding: ...


class LocalHashEmbedder:
    """BGE-M3-shaped port implemented with hashing (dense + sparse)."""

    model = settings.embedding_model
    dim = settings.embedding_dim

    def embed(self, text: str) -> Embedding:
        tokens = tokenize(text)
        return Embedding(dense_vector(tokens), sparse_vector(tokens), self.model, self.dim)

    def embed_query(self, text: str) -> Embedding:
        return self.embed(text)


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
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


embedder: Embedder = LocalHashEmbedder()
