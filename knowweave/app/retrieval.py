"""Hybrid retrieval: dense + sparse + graph, RRF fusion, local rerank, ACL first."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .embeddings import (
    cosine,
    embedder,
    keyword_overlap,
    sparse_dot,
    tokenize,
)
from .models import Chunk, Document, DocumentVersion, Entity, EntityAlias, Fact, FactEvidence
from .security import Principal, can_read
from .tracing import TraceRecorder

RRF_K = 60


@dataclass
class Hit:
    chunk: Chunk
    document: Document
    dense: float = 0.0
    sparse: float = 0.0
    rrf: float = 0.0
    rerank: float = 0.0
    coverage: float = 0.0
    parent_text: str = ""
    source: str = "chunk"

    def to_dict(self) -> dict:
        return {
            "chunk_id": self.chunk.id,
            "doc_id": self.document.id,
            "doc_title": self.document.title,
            "text": self.chunk.text,
            "quote": _snippet(self.chunk.text),
            "context": self.parent_text or self.chunk.text,
            "heading_path": self.chunk.heading_path,
            "page": self.chunk.page,
            "block_type": self.chunk.block_type,
            "scores": {
                "dense": round(self.dense, 4),
                "sparse": round(self.sparse, 4),
                "rrf": round(self.rrf, 4),
                "rerank": round(self.rerank, 4),
            },
            "acl_version": self.chunk.acl_version,
            "source": self.source,
        }


@dataclass
class RetrievalResult:
    hits: list[Hit] = field(default_factory=list)
    facts: list[dict] = field(default_factory=list)
    entities: list[Entity] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    rejected_candidates: int = 0
    query: str = ""
    as_of: str | None = None


def _snippet(text: str, limit: int = 220) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"


def _load_candidates(db: Session, tenant_id: str) -> list[tuple[Chunk, Document]]:
    rows = db.execute(
        select(Chunk, Document)
        .join(Document, Chunk.doc_id == Document.id)
        .join(DocumentVersion, Chunk.version_id == DocumentVersion.id)
        .where(
            Document.tenant_id == tenant_id,
            Document.status == "active",
            DocumentVersion.version == Document.current_version,
            Chunk.is_parent.is_(False),
        )
    ).all()
    return [(row[0], row[1]) for row in rows]


def _rrf(ranked_lists: list[list[str]]) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for rank, chunk_id in enumerate(ranked, start=1):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (RRF_K + rank)
    return scores


def link_entities(db: Session, principal: Principal, query: str) -> list[Entity]:
    rows = db.execute(select(Entity).where(Entity.tenant_id == principal.tenant_id)).scalars()
    entities = [entity for entity in rows if can_read(principal, entity.acl_principals)]
    aliases = db.execute(select(EntityAlias)).scalars().all()
    alias_map: dict[str, str] = {}
    for alias in aliases:
        alias_map[alias.normalized_alias] = alias.entity_id
    normalized_query = query.lower().replace(" ", "")
    matched: list[Entity] = []
    for entity in entities:
        names = {entity.normalized_name.lower(), entity.canonical_name.lower()}
        for key, entity_id in alias_map.items():
            if entity_id == entity.id:
                names.add(key.lower())
        if any(name and name.replace(" ", "") in normalized_query for name in names):
            matched.append(entity)
    query_tokens = set(tokenize(query))
    for entity in entities:
        if entity in matched:
            continue
        name_tokens = set(tokenize(entity.canonical_name))
        if name_tokens and len(name_tokens & query_tokens) / len(name_tokens) >= 0.6:
            matched.append(entity)
    return matched[:5]


def facts_for_entities(
    db: Session,
    principal: Principal,
    entities: list[Entity],
    as_of: str | None = None,
) -> list[dict]:
    if not entities:
        return []
    entity_ids = [entity.id for entity in entities]
    facts = db.execute(
        select(Fact).where(
            Fact.tenant_id == principal.tenant_id,
            Fact.subject_id.in_(entity_ids) | Fact.object_id.in_(entity_ids),
        )
    ).scalars()
    output: list[dict] = []
    for fact in facts:
        if not can_read(principal, fact.acl_principals):
            continue
        if as_of:
            if fact.valid_from and str(fact.valid_from) > as_of:
                continue
            if fact.valid_to and str(fact.valid_to) <= as_of:
                continue
        subject = db.get(Entity, fact.subject_id)
        obj = db.get(Entity, fact.object_id) if fact.object_id else None
        output.append(
            {
                "fact_id": fact.id,
                "subject": subject.canonical_name if subject else fact.subject_id,
                "predicate": fact.predicate,
                "object": obj.canonical_name if obj else fact.object_literal,
                "valid_from": str(fact.valid_from) if fact.valid_from else None,
                "valid_to": str(fact.valid_to) if fact.valid_to else None,
                "confidence": fact.confidence,
                "status": fact.status,
                "evidence_chunk_ids": [
                    evidence.chunk_id
                    for evidence in db.execute(
                        select(FactEvidence).where(FactEvidence.fact_id == fact.id)
                    ).scalars()
                    if evidence.chunk_id
                ],
            }
        )
    return output


def retrieve(
    db: Session,
    principal: Principal,
    query: str,
    top_k: int = 8,
    doc_ids: list[str] | None = None,
    source_type: str | None = None,
    as_of: str | None = None,
    recorder: TraceRecorder | None = None,
    mode: str = "quick",
) -> RetrievalResult:
    started = time.time()
    candidates = _load_candidates(db, principal.tenant_id)
    if doc_ids:
        candidates = [pair for pair in candidates if pair[1].id in set(doc_ids)]
    if source_type:
        candidates = [pair for pair in candidates if pair[1].source_type == source_type]

    visible = [pair for pair in candidates if can_read(principal, pair[0].acl_principals)]
    rejected = len(candidates) - len(visible)
    if recorder:
        recorder.add_span(
            "acl.filter",
            params={"tenant_id": principal.tenant_id, "principals": sorted(principal.principals)},
            output={"in": len(candidates), "visible": len(visible), "rejected": rejected},
            latency_ms=1,
        )
    if not visible:
        return RetrievalResult(
            stats={"candidates": 0, "visible": 0, "rejected": rejected},
            rejected_candidates=rejected,
            query=query,
            as_of=as_of,
        )

    query_vec = embedder.embed_query(query)
    query_tokens = tokenize(query)

    t0 = time.time()
    dense_scores = [(chunk.id, cosine(query_vec.dense, chunk.dense)) for chunk, _ in visible]
    dense_scores.sort(key=lambda item: item[1], reverse=True)
    dense_ranked = [chunk_id for chunk_id, score in dense_scores[:50] if score > 0.02]
    if recorder:
        recorder.add_span(
            "recall.dense",
            params={"top": 50, "model": embedder.model},
            output={"kept": len(dense_ranked), "best": round(dense_scores[0][1], 4) if dense_scores else 0},
            latency_ms=int((time.time() - t0) * 1000),
        )

    t0 = time.time()
    sparse_scores = [
        (chunk.id, sparse_dot(query_vec.sparse, chunk.sparse)) for chunk, _ in visible
    ]
    sparse_scores.sort(key=lambda item: item[1], reverse=True)
    sparse_ranked = [chunk_id for chunk_id, score in sparse_scores[:50] if score > 0]
    if recorder:
        recorder.add_span(
            "recall.sparse",
            params={"top": 50},
            output={"kept": len(sparse_ranked), "best": round(sparse_scores[0][1], 4) if sparse_scores else 0},
            latency_ms=int((time.time() - t0) * 1000),
        )

    t0 = time.time()
    entities = link_entities(db, principal, query)
    facts = facts_for_entities(db, principal, entities, as_of=as_of)
    graph_chunk_ids: list[str] = []
    for fact in facts:
        for chunk_id in fact["evidence_chunk_ids"]:
            if chunk_id not in graph_chunk_ids:
                graph_chunk_ids.append(chunk_id)
    if recorder:
        recorder.add_span(
            "recall.graph",
            params={"entities": [entity.canonical_name for entity in entities]},
            output={"facts": len(facts), "chunks": len(graph_chunk_ids)},
            latency_ms=int((time.time() - t0) * 1000),
        )

    t0 = time.time()
    fused = _rrf([dense_ranked, sparse_ranked, graph_chunk_ids])
    if recorder:
        recorder.add_span(
            "rank.rrf",
            params={"k": RRF_K},
            output={"candidates": len(fused)},
            latency_ms=int((time.time() - t0) * 1000),
        )

    by_id = {chunk.id: (chunk, doc) for chunk, doc in visible}
    dense_map = dict(dense_scores)
    sparse_map = dict(sparse_scores)
    graph_set = set(graph_chunk_ids)
    max_sparse = max((value for _, value in sparse_scores), default=1.0) or 1.0

    t0 = time.time()
    reranked: list[Hit] = []
    for chunk_id, rrf_score in sorted(fused.items(), key=lambda item: item[1], reverse=True)[:30]:
        if chunk_id not in by_id:
            continue
        chunk, document = by_id[chunk_id]
        dense = max(0.0, dense_map.get(chunk_id, 0.0))
        sparse = max(0.0, sparse_map.get(chunk_id, 0.0))
        sparse_norm = min(1.0, sparse / max_sparse) if max_sparse else 0.0
        coverage = keyword_overlap(query_tokens, chunk.text)
        heading_hit = keyword_overlap(
            query_tokens, " ".join(chunk.heading_path) + " " + document.title
        )
        phrase_bonus = 0.08 if query.strip() and query.strip() in chunk.text else 0.0
        graph_bonus = 0.07 if chunk_id in graph_set else 0.0
        score = (
            0.40 * dense
            + 0.20 * sparse_norm
            + 0.24 * coverage
            + 0.06 * heading_hit
            + phrase_bonus
            + graph_bonus
            + min(0.05, max(0.0, chunk.weight - 1.0) * 0.05)
        )
        hit = Hit(
            chunk=chunk,
            document=document,
            dense=dense,
            sparse=sparse_norm,
            rrf=rrf_score,
            rerank=round(score, 4),
            coverage=coverage,
            source="graph" if chunk_id in graph_set else "chunk",
        )
        reranked.append(hit)
    reranked.sort(key=lambda hit: hit.rerank, reverse=True)
    if recorder:
        recorder.add_span(
            "rank.rerank",
            params={"candidates": len(reranked), "threshold": settings.rerank_threshold},
            output={
                "top": [
                    {"chunk_id": hit.chunk.id, "score": hit.rerank} for hit in reranked[:5]
                ]
            },
            latency_ms=int((time.time() - t0) * 1000),
        )

    final = reranked[:top_k]
    for hit in final:
        if hit.chunk.parent_id:
            parent = db.get(Chunk, hit.chunk.parent_id)
            if parent:
                hit.parent_text = parent.text
    stats = {
        "candidates": len(candidates),
        "visible": len(visible),
        "rejected": rejected,
        "dense": len(dense_ranked),
        "sparse": len(sparse_ranked),
        "graph_chunks": len(graph_chunk_ids),
        "fused": len(fused),
        "reranked": len(reranked),
        "top_score": final[0].rerank if final else 0.0,
        "mode": mode,
        "latency_ms": int((time.time() - started) * 1000),
    }
    return RetrievalResult(
        hits=final,
        facts=facts,
        entities=entities,
        stats=stats,
        rejected_candidates=rejected,
        query=query,
        as_of=as_of,
    )
