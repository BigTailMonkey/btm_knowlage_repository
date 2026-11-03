"""Incremental learning: extract → align → conflict detect → arbitrate → reflect."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .chunking import estimate_tokens
from .config import settings
from .embeddings import tokenize
from .harness import harness, parse_json_array
from .models import (
    Chunk,
    Document,
    DocumentVersion,
    Entity,
    EntityAlias,
    Fact,
    FactEvidence,
    MemoryItem,
    ReflectionRun,
    ReviewItem,
    new_id,
)
from .security import Principal

EXTRACT_SYSTEM = """你是 KnoWeave 的事实抽取器。只抽取原文明确陈述、可被引用验证的断言。
输出一个 JSON 数组，不要输出任何解释或 Markdown。每项字段：
subject, subject_type(product|org|person|concept|event), predicate, object,
object_type, object_literal, valid_from(YYYY-MM-DD 或 null), valid_to(YYYY-MM-DD 或 null),
confidence(0-1), quote(必须逐字来自原文，不超过120字)。
规则：谓词用简短中文动词短语；不要抽取常识、推测、代词指代；最多 12 条；
数字、日期、版本必须保留；没有明确主语时不要抽取。"""


def normalize_name(name: str) -> str:
    return re.sub(r"[\s\u3000·•\-_/]+", "", (name or "").strip().lower())


DATE_RE = re.compile(r"(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})?")


def parse_date(value) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text or text.lower() in {"null", "none", "无"}:
        return None
    match = DATE_RE.search(text)
    if not match:
        return None
    year, month, day = match.group(1), match.group(2), match.group(3) or "1"
    try:
        return date(int(year), int(month), int(day))
    except ValueError:
        return None


@dataclass
class Candidate:
    subject: str
    subject_type: str
    predicate: str
    object_name: str
    object_type: str
    object_literal: str
    valid_from: date | None
    valid_to: date | None
    confidence: float
    quote: str
    chunk_id: str | None = None


def get_or_create_entity(
    db: Session,
    tenant_id: str,
    name: str,
    entity_type: str = "concept",
    acl: list[str] | None = None,
) -> Entity:
    normalized = normalize_name(name)
    entity = db.scalar(
        select(Entity).where(
            Entity.tenant_id == tenant_id,
            Entity.normalized_name == normalized,
            Entity.status == "active",
        )
    )
    if entity:
        return entity
    alias = db.scalar(
        select(EntityAlias).join(Entity, EntityAlias.entity_id == Entity.id).where(
            Entity.tenant_id == tenant_id,
            EntityAlias.normalized_alias == normalized,
        )
    )
    if alias:
        aliased = db.get(Entity, alias.entity_id)
        if aliased:
            return aliased
    entity = Entity(
        tenant_id=tenant_id,
        type=entity_type or "concept",
        canonical_name=name.strip(),
        normalized_name=normalized,
        description="",
        status="active",
        acl_principals=list(acl or ["tenant:public"]),
    )
    db.add(entity)
    db.flush()
    db.add(
        EntityAlias(
            entity_id=entity.id,
            alias=name.strip(),
            normalized_alias=normalized,
            source="extraction",
        )
    )
    return entity


def find_chunk_for_quote(db: Session, doc_id: str, quote: str) -> Chunk | None:
    chunks = db.execute(
        select(Chunk).where(Chunk.doc_id == doc_id, Chunk.is_parent.is_(False))
    ).scalars().all()
    clean = " ".join(quote.split())
    best: Chunk | None = None
    best_score = 0.0
    quote_tokens = set(tokenize(clean))
    for chunk in chunks:
        text = " ".join(chunk.text.split())
        if clean and clean[:40] in text:
            return chunk
        if not quote_tokens:
            continue
        score = len(quote_tokens & set(tokenize(text))) / len(quote_tokens)
        if score > best_score:
            best_score = score
            best = chunk
    return best if best_score >= 0.45 else None


def extract_candidates(
    db: Session, principal: Principal, document: Document, version: DocumentVersion
) -> list[Candidate]:
    chunks = db.execute(
        select(Chunk).where(
            Chunk.doc_id == document.id, Chunk.is_parent.is_(False)
        ).order_by(Chunk.seq)
    ).scalars().all()
    if not chunks:
        return []
    text_parts: list[str] = []
    total = 0
    for chunk in chunks:
        if total > 7000:
            break
        text_parts.append(chunk.text)
        total += len(chunk.text)
    text = "\n\n".join(text_parts)
    prompt = (
        f"文档标题：{document.title}\n"
        f"来源类型：{document.source_type}\n\n原文：\n{text}\n\n"
        "请输出 JSON 数组。"
    )
    result = harness.complete(prompt, system=EXTRACT_SYSTEM, max_tokens=1600)
    candidates: list[Candidate] = []
    for item in parse_json_array(result.text):
        subject = str(item.get("subject") or "").strip()
        predicate = str(item.get("predicate") or "").strip()
        obj = str(item.get("object") or "").strip()
        literal = str(item.get("object_literal") or "").strip()
        quote = str(item.get("quote") or "").strip()
        if not subject or not predicate or not (obj or literal) or not quote:
            continue
        if subject in {"它", "他", "她", "该系统", "本系统", "这"}:
            continue
        chunk = find_chunk_for_quote(db, document.id, quote)
        candidates.append(
            Candidate(
                subject=subject[:120],
                subject_type=str(item.get("subject_type") or "concept")[:24],
                predicate=predicate[:120],
                object_name=obj[:120],
                object_type=str(item.get("object_type") or "concept")[:24],
                object_literal=literal[:200],
                valid_from=parse_date(item.get("valid_from")),
                valid_to=parse_date(item.get("valid_to")),
                confidence=max(0.2, min(0.99, float(item.get("confidence") or 0.7))),
                quote=quote[:300],
                chunk_id=chunk.id if chunk else None,
            )
        )
    if candidates:
        return candidates
    return rule_extract_candidates(text, chunks)


def rule_extract_candidates(text: str, chunks: list[Chunk]) -> list[Candidate]:
    """Deterministic fallback so ingestion still produces facts without an LLM."""
    pattern = re.compile(
        r"([\u4e00-\u9fffA-Za-z0-9·\-]{2,24})"
        r"(采用|使用|基于|依赖|支持|提供|发布|推出|属于|位于|成立于|由|的)"
        r"([^，。；：\n]{2,40})"
    )
    candidates: list[Candidate] = []
    seen: set[tuple[str, str]] = set()
    for sentence in re.split(r"[。！？!?；;\n]", text):
        sentence = sentence.strip()
        if len(sentence) < 10:
            continue
        for match in pattern.finditer(sentence):
            subject, predicate, obj = (
                match.group(1).strip(),
                match.group(2).strip(),
                match.group(3).strip(),
            )
            if subject in {"我们", "本系统", "该系统", "它"} or len(obj) < 2:
                continue
            key = (normalize_name(subject), predicate + "|" + normalize_name(obj))
            if key in seen:
                continue
            seen.add(key)
            chunk = None
            best_score = 0.0
            for candidate_chunk in chunks:
                if match.group(0) in candidate_chunk.text:
                    chunk = candidate_chunk
                    break
                score = len(set(tokenize(sentence)) & set(tokenize(candidate_chunk.text)))
                if score > best_score:
                    best_score = score
                    chunk = candidate_chunk
            candidates.append(
                Candidate(
                    subject=subject[:120],
                    subject_type="product" if re.search(r"[A-Za-z]", subject) else "concept",
                    predicate=predicate,
                    object_name=obj[:120],
                    object_type="product" if re.search(r"[A-Za-z]", obj) else "concept",
                    object_literal=obj[:200],
                    valid_from=None,
                    valid_to=None,
                    confidence=0.52,
                    quote=sentence[:180],
                    chunk_id=chunk.id if chunk else None,
                )
            )
            if len(candidates) >= 8:
                return candidates
    return candidates


def _merge_or_arbitrate(
    db: Session,
    principal: Principal,
    document: Document,
    candidate: Candidate,
) -> str:
    acl = list(document.acl_principals or ["tenant:public"])
    subject = get_or_create_entity(
        db, principal.tenant_id, candidate.subject, candidate.subject_type, acl
    )
    object_entity = None
    if candidate.object_name:
        object_entity = get_or_create_entity(
            db,
            principal.tenant_id,
            candidate.object_name,
            candidate.object_type,
            acl,
        )
    existing = db.execute(
        select(Fact).where(
            Fact.tenant_id == principal.tenant_id,
            Fact.subject_id == subject.id,
            Fact.predicate == candidate.predicate,
            Fact.status.in_(["active", "disputed"]),
        )
    ).scalars().all()

    same_object = None
    for fact in existing:
        same_target = (
            (object_entity and fact.object_id == object_entity.id)
            or (not object_entity and fact.object_literal == candidate.object_literal)
        )
        if same_target:
            same_object = fact
            break

    if same_object:
        same_object.confidence = max(same_object.confidence, candidate.confidence)
        same_object.acl_principals = _intersect_acl(same_object.acl_principals, acl)
        if candidate.chunk_id:
            duplicate = db.scalar(
                select(FactEvidence).where(
                    FactEvidence.fact_id == same_object.id,
                    FactEvidence.chunk_id == candidate.chunk_id,
                    FactEvidence.quote == candidate.quote,
                )
            )
            if not duplicate:
                db.add(
                    FactEvidence(
                        fact_id=same_object.id,
                        chunk_id=candidate.chunk_id,
                        doc_id=document.id,
                        quote=candidate.quote,
                        weight=max(0.5, document.quality_score),
                    )
                )
        return "merged"

    fact = Fact(
        id=new_id("f"),
        tenant_id=principal.tenant_id,
        subject_id=subject.id,
        predicate=candidate.predicate,
        object_id=object_entity.id if object_entity else None,
        object_literal=candidate.object_literal if not object_entity else None,
        valid_from=candidate.valid_from,
        valid_to=candidate.valid_to,
        recorded_at=datetime.now(timezone.utc),
        confidence=candidate.confidence,
        status="active",
        acl_principals=acl,
        source_doc_id=document.id,
    )
    db.add(fact)
    db.flush()
    if candidate.chunk_id:
        db.add(
            FactEvidence(
                fact_id=fact.id,
                chunk_id=candidate.chunk_id,
                doc_id=document.id,
                quote=candidate.quote,
                weight=max(0.5, document.quality_score),
            )
        )

    conflicting = []
    for old in existing:
        old_target_name = old.object_literal
        if old.object_id:
            old_object = db.get(Entity, old.object_id)
            old_target_name = old_object.canonical_name if old_object else old.object_literal
        if old_target_name == candidate.object_name and candidate.object_name:
            continue
        if not _periods_overlap(old, fact):
            continue
        conflicting.append(old)

    if not conflicting:
        return "created"

    newest = max(conflicting, key=lambda item: item.recorded_at)
    can_supersede = (
        candidate.valid_from is not None
        and newest.valid_from is not None
        and candidate.valid_from > newest.valid_from
        and candidate.confidence >= 0.7
    )
    if can_supersede:
        for old in conflicting:
            old.status = "superseded"
            old.valid_to = candidate.valid_from
            old.superseded_by = fact.id
        return "superseded"

    fact.status = "disputed"
    for old in conflicting:
        old.status = "disputed"
    db.add(
        ReviewItem(
            tenant_id=principal.tenant_id,
            kind="fact_conflict",
            title=f"{subject.canonical_name} · {candidate.predicate}",
            payload={
                "subject": subject.canonical_name,
                "predicate": candidate.predicate,
                "new_fact_id": fact.id,
                "new_object": candidate.object_name or candidate.object_literal,
                "old_fact_ids": [old.id for old in conflicting],
                "old_objects": [
                    db.get(Entity, old.object_id).canonical_name
                    if old.object_id and db.get(Entity, old.object_id)
                    else old.object_literal
                    for old in conflicting
                ],
                "quote": candidate.quote,
                "doc_id": document.id,
                "reason": "同一主语与谓词出现不同宾语，且有效期重叠；按保守策略进入人工审阅。",
            },
        )
    )
    return "disputed"


def _periods_overlap(a: Fact, b: Fact) -> bool:
    a_start = a.valid_from or date.min
    a_end = a.valid_to or date.max
    b_start = b.valid_from or date.min
    b_end = b.valid_to or date.max
    return a_start <= b_end and b_start <= a_end


def _intersect_acl(left: list, right: list) -> list:
    return sorted(set(left or []) & set(right or []))


def extract_facts_for_document(db: Session, principal: Principal, doc_id: str) -> dict:
    document = db.get(Document, doc_id)
    if not document or document.tenant_id != principal.tenant_id:
        return {"error": "文档不存在"}
    version = db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.doc_id == doc_id,
            DocumentVersion.version == document.current_version,
        )
    )
    if not version:
        return {"error": "版本不存在"}
    document.enrichment_status = "running"
    db.commit()
    started = datetime.now(timezone.utc)
    candidates = extract_candidates(db, principal, document, version)
    counts = {"created": 0, "merged": 0, "superseded": 0, "disputed": 0}
    for candidate in candidates:
        outcome = _merge_or_arbitrate(db, principal, document, candidate)
        counts[outcome] = counts.get(outcome, 0) + 1
    document.enrichment_status = "done" if candidates else "empty"
    db.commit()
    return {
        "document_id": doc_id,
        "candidates": len(candidates),
        "outcomes": counts,
        "elapsed_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    }


def resolve_review(
    db: Session, principal: Principal, review_id: str, action: str, note: str = ""
) -> dict:
    review = db.get(ReviewItem, review_id)
    if not review or review.tenant_id != principal.tenant_id:
        raise ValueError("审阅项不存在")
    if review.status != "open":
        raise ValueError("审阅项已处理")
    payload = review.payload or {}
    new_fact = db.get(Fact, payload.get("new_fact_id"))
    old_facts = [db.get(Fact, fid) for fid in payload.get("old_fact_ids", [])]
    old_facts = [fact for fact in old_facts if fact]
    if action in {"accept_new", "supersede"}:
        for old in old_facts:
            old.status = "superseded"
            old.valid_to = new_fact.valid_from if new_fact and new_fact.valid_from else date.today()
            old.superseded_by = new_fact.id if new_fact else None
        if new_fact:
            new_fact.status = "active"
    elif action == "reject_new":
        if new_fact:
            new_fact.status = "retracted"
        for old in old_facts:
            old.status = "active"
    elif action == "merge":
        if new_fact and old_facts:
            for old in old_facts:
                old.confidence = max(old.confidence, new_fact.confidence)
                for evidence in db.execute(
                    select(FactEvidence).where(FactEvidence.fact_id == new_fact.id)
                ).scalars():
                    db.add(
                        FactEvidence(
                            fact_id=old.id,
                            chunk_id=evidence.chunk_id,
                            doc_id=evidence.doc_id,
                            quote=evidence.quote,
                            weight=evidence.weight,
                        )
                    )
                old.status = "active"
            new_fact.status = "retracted"
    elif action == "dispute":
        for fact in old_facts + ([new_fact] if new_fact else []):
            fact.status = "disputed"
    else:
        raise ValueError("未知处理动作")
    review.status = "resolved"
    review.resolution = {"action": action, "note": note, "by": principal.user_id}
    review.resolved_at = datetime.now(timezone.utc)
    db.commit()
    return {"review_id": review.id, "action": action, "status": review.status}


def run_reflection(db: Session, tenant_id: str) -> dict:
    started = datetime.now(timezone.utc)
    merged_entities = 0
    entities = db.execute(
        select(Entity).where(Entity.tenant_id == tenant_id, Entity.status == "active")
    ).scalars().all()
    by_name: dict[str, list[Entity]] = {}
    for entity in entities:
        by_name.setdefault(entity.normalized_name, []).append(entity)
    for group in by_name.values():
        if len(group) < 2:
            continue
        keep = group[0]
        for duplicate in group[1:]:
            for fact in db.execute(
                select(Fact).where(Fact.subject_id == duplicate.id)
            ).scalars():
                fact.subject_id = keep.id
            for fact in db.execute(
                select(Fact).where(Fact.object_id == duplicate.id)
            ).scalars():
                fact.object_id = keep.id
            for alias in db.execute(
                select(EntityAlias).where(EntityAlias.entity_id == duplicate.id)
            ).scalars():
                alias.entity_id = keep.id
            duplicate.status = "merged"
            merged_entities += 1

    disputed = 0
    existing_reviews = {
        (item.payload or {}).get("new_fact_id")
        for item in db.execute(
            select(ReviewItem).where(
                ReviewItem.tenant_id == tenant_id, ReviewItem.status == "open"
            )
        ).scalars()
    }
    active_facts = db.execute(
        select(Fact).where(Fact.tenant_id == tenant_id, Fact.status == "active")
    ).scalars().all()
    by_key: dict[tuple[str, str], list[Fact]] = {}
    for fact in active_facts:
        by_key.setdefault((fact.subject_id, fact.predicate), []).append(fact)
    for (subject_id, predicate), group in by_key.items():
        if len(group) < 2:
            continue
        for index, left in enumerate(group):
            for right in group[index + 1 :]:
                if (left.object_id, left.object_literal) == (right.object_id, right.object_literal):
                    continue
                if not _periods_overlap(left, right):
                    continue
                left.status = "disputed"
                right.status = "disputed"
                disputed += 1
                if right.id not in existing_reviews:
                    subject = db.get(Entity, subject_id)
                    db.add(
                        ReviewItem(
                            tenant_id=tenant_id,
                            kind="fact_conflict",
                            title=f"{subject.canonical_name if subject else subject_id} · {predicate}",
                            payload={
                                "subject": subject.canonical_name if subject else subject_id,
                                "predicate": predicate,
                                "new_fact_id": right.id,
                                "old_fact_ids": [left.id],
                                "reason": "夜间反思扫描发现有效期重叠的冲突断言。",
                            },
                        )
                    )

    expired = 0
    now = datetime.now(timezone.utc)
    for memory in db.execute(
        select(MemoryItem).where(MemoryItem.tenant_id == tenant_id)
    ).scalars():
        if memory.expires_at and memory.expires_at.replace(tzinfo=timezone.utc) < now:
            db.delete(memory)
            expired += 1

    summary = {
        "entities_scanned": len(entities),
        "merged_entities": merged_entities,
        "facts_scanned": len(active_facts),
        "conflicts_marked": disputed,
        "expired_memories": expired,
        "elapsed_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    }
    db.add(ReflectionRun(tenant_id=tenant_id, summary=summary))
    db.commit()
    return summary
