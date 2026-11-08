"""Fact layer, review queue, memory, gaps, reflection and graph endpoints."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from .db import get_db
from .learning import get_or_create_entity, normalize_name, resolve_review, run_reflection
from .models import (
    Citation,
    Document,
    Entity,
    EntityAlias,
    Fact,
    FactEvidence,
    Gap,
    MemoryItem,
    ReviewItem,
    new_id,
)
from .security import (
    Principal,
    can_read,
    get_principal,
    require_admin,
    require_editor,
)
from .serializers import entity_dict, fact_dict

router = APIRouter(tags=["knowledge"])


class ReviewResolveIn(BaseModel):
    action: str
    note: str = ""


class MemoryIn(BaseModel):
    text: str = Field(min_length=1)
    kind: str = "note"
    scope: str = "personal"
    expires_at: datetime | None = None


class GapResolveIn(BaseModel):
    status: str = "resolved"
    note: str = ""


class EntityUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=300)
    type: str | None = Field(default=None, max_length=40)
    description: str | None = Field(default=None, max_length=2000)


@router.get("/entities")
def list_entities(
    q: str | None = None,
    type: str | None = None,
    limit: int = Query(default=60, ge=1, le=200),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    statement = select(Entity).where(
        Entity.tenant_id == principal.tenant_id, Entity.status == "active"
    )
    if q:
        statement = statement.where(Entity.canonical_name.contains(q))
    if type:
        statement = statement.where(Entity.type == type)
    entities = db.execute(
        statement.order_by(Entity.updated_at.desc()).limit(limit)
    ).scalars().all()
    visible = [entity for entity in entities if can_read(principal, entity.acl_principals)]
    items = []
    for entity in visible:
        fact_count = db.execute(
            select(Fact).where(
                Fact.tenant_id == principal.tenant_id,
                or_(Fact.subject_id == entity.id, Fact.object_id == entity.id),
            )
        ).scalars().all()
        items.append(
            {
                **entity_dict(entity),
                "facts": len([f for f in fact_count if can_read(principal, f.acl_principals)]),
            }
        )
    return {"items": items}


@router.get("/entities/{entity_id}")
def entity_detail(
    entity_id: str,
    as_of: str | None = None,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    entity = db.get(Entity, entity_id)
    if (
        not entity
        or entity.tenant_id != principal.tenant_id
        or not can_read(principal, entity.acl_principals)
    ):
        raise HTTPException(status_code=404, detail="实体不存在或无权访问")
    facts = db.execute(
        select(Fact)
        .where(
            Fact.tenant_id == principal.tenant_id,
            or_(Fact.subject_id == entity.id, Fact.object_id == entity.id),
        )
        .order_by(Fact.valid_from, Fact.recorded_at)
    ).scalars().all()
    items = []
    for fact in facts:
        if not can_read(principal, fact.acl_principals):
            continue
        if as_of:
            if fact.valid_from and str(fact.valid_from) > as_of:
                continue
            if fact.valid_to and str(fact.valid_to) <= as_of:
                continue
        items.append(fact_dict(db, fact))
    doc_ids = {fact["source_doc_id"] for fact in items if fact.get("source_doc_id")}
    documents = []
    for doc_id in doc_ids:
        document = db.get(Document, doc_id)
        if document and can_read(principal, document.acl_principals):
            documents.append(
                {
                    "id": document.id,
                    "title": document.title,
                    "source_type": document.source_type,
                }
            )
    return {
        "entity": entity_dict(entity),
        "facts": items,
        "documents": documents,
        "aliases": [],
    }


@router.patch("/entities/{entity_id}")
def update_entity(
    entity_id: str,
    payload: EntityUpdateIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """人工订正实体：改名、改类型、改描述。改名会把旧名留作别名，避免再次抽取时重建同一实体。"""
    require_editor(principal)
    entity = db.get(Entity, entity_id)
    if (
        not entity
        or entity.tenant_id != principal.tenant_id
        or not can_read(principal, entity.acl_principals)
    ):
        raise HTTPException(status_code=404, detail="实体不存在或无权访问")

    changed = False
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="实体名称不能为空")
        normalized = normalize_name(name)
        if normalized != entity.normalized_name:
            duplicate = db.scalar(
                select(Entity).where(
                    Entity.tenant_id == principal.tenant_id,
                    Entity.normalized_name == normalized,
                    Entity.status == "active",
                    Entity.id != entity.id,
                )
            )
            alias_hit = db.scalar(
                select(EntityAlias).where(
                    EntityAlias.normalized_alias == normalized,
                    EntityAlias.entity_id != entity.id,
                )
            )
            if duplicate or alias_hit:
                raise HTTPException(
                    status_code=409,
                    detail="已存在同名或同别名的实体，请直接编辑或删除那一个",
                )
            previous_name = entity.canonical_name
            previous_normalized = entity.normalized_name
            if previous_normalized:
                exists = db.scalar(
                    select(EntityAlias).where(
                        EntityAlias.entity_id == entity.id,
                        EntityAlias.normalized_alias == previous_normalized,
                    )
                )
                if not exists:
                    db.add(
                        EntityAlias(
                            entity_id=entity.id,
                            alias=previous_name,
                            normalized_alias=previous_normalized,
                            source="manual",
                        )
                    )
            entity.canonical_name = name
            entity.normalized_name = normalized
            changed = True

    if payload.type is not None:
        entity_type = payload.type.strip().lower()
        if not entity_type:
            raise HTTPException(status_code=400, detail="实体类型不能为空")
        if entity_type != entity.type:
            entity.type = entity_type
            changed = True

    if payload.description is not None:
        description = payload.description.strip()
        if description != (entity.description or ""):
            entity.description = description
            changed = True

    entity.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(entity)
    return {"entity": entity_dict(entity), "changed": changed}


@router.delete("/entities/{entity_id}")
def delete_entity(
    entity_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """删除实体：作为主语的事实连同证据一并删除；作为宾语的事实保留，宾语降级为字面值。"""
    require_admin(principal)
    entity = db.get(Entity, entity_id)
    if (
        not entity
        or entity.tenant_id != principal.tenant_id
        or not can_read(principal, entity.acl_principals)
    ):
        raise HTTPException(status_code=404, detail="实体不存在或无权访问")

    facts = db.execute(
        select(Fact).where(
            Fact.tenant_id == principal.tenant_id,
            or_(Fact.subject_id == entity.id, Fact.object_id == entity.id),
        )
    ).scalars().all()

    removed_fact_ids: set[str] = set()
    unlinked = 0
    for fact in facts:
        if fact.subject_id == entity.id:
            removed_fact_ids.add(fact.id)
            db.execute(delete(FactEvidence).where(FactEvidence.fact_id == fact.id))
            db.execute(delete(Citation).where(Citation.fact_id == fact.id))
            db.delete(fact)
            continue
        fact.object_id = None
        if not fact.object_literal:
            fact.object_literal = entity.canonical_name
        unlinked += 1

    aliases_removed = len(
        db.execute(
            select(EntityAlias).where(EntityAlias.entity_id == entity.id)
        ).scalars().all()
    )
    db.execute(delete(EntityAlias).where(EntityAlias.entity_id == entity.id))

    reviews_closed = 0
    if removed_fact_ids:
        open_reviews = db.execute(
            select(ReviewItem).where(
                ReviewItem.tenant_id == principal.tenant_id,
                ReviewItem.status == "open",
            )
        ).scalars().all()
        for item in open_reviews:
            review_payload = item.payload or {}
            touched = {review_payload.get("new_fact_id")}
            touched.update(review_payload.get("old_fact_ids") or [])
            if not (touched & removed_fact_ids):
                continue
            item.status = "resolved"
            item.resolution = {
                "action": "entity_deleted",
                "by": principal.user_id,
                "entity": entity.canonical_name,
            }
            item.resolved_at = datetime.now(timezone.utc)
            reviews_closed += 1
        memories = db.execute(
            select(MemoryItem).where(
                MemoryItem.tenant_id == principal.tenant_id,
                MemoryItem.promoted_fact_id.in_(removed_fact_ids),
            )
        ).scalars().all()
        for memory in memories:
            memory.promoted_fact_id = None

    canonical_name = entity.canonical_name
    db.delete(entity)
    db.commit()
    return {
        "status": "deleted",
        "entity_id": entity_id,
        "name": canonical_name,
        "facts_removed": len(removed_fact_ids),
        "facts_unlinked": unlinked,
        "aliases_removed": aliases_removed,
        "reviews_closed": reviews_closed,
    }


@router.get("/facts")
def list_facts(
    status: str | None = None,
    subject: str | None = None,
    limit: int = Query(default=60, ge=1, le=200),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    statement = select(Fact).where(Fact.tenant_id == principal.tenant_id)
    if status:
        statement = statement.where(Fact.status == status)
    if subject:
        entity = db.scalar(
            select(Entity).where(
                Entity.tenant_id == principal.tenant_id,
                Entity.canonical_name == subject,
            )
        )
        if entity:
            statement = statement.where(Fact.subject_id == entity.id)
    facts = db.execute(
        statement.order_by(Fact.recorded_at.desc()).limit(limit)
    ).scalars().all()
    return {
        "items": [
            fact_dict(db, fact)
            for fact in facts
            if can_read(principal, fact.acl_principals)
        ]
    }


@router.get("/graph")
def knowledge_graph(
    limit: int = Query(default=80, ge=10, le=300),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    facts = db.execute(
        select(Fact).where(
            Fact.tenant_id == principal.tenant_id,
            Fact.status.in_(["active", "disputed"]),
        ).order_by(Fact.confidence.desc()).limit(limit * 3)
    ).scalars().all()
    visible = [fact for fact in facts if can_read(principal, fact.acl_principals)]
    node_ids: set[str] = set()
    edges = []
    for fact in visible[:limit]:
        node_ids.add(fact.subject_id)
        node_ids.add(fact.object_id or fact.subject_id)
        subject = db.get(Entity, fact.subject_id)
        target = db.get(Entity, fact.object_id) if fact.object_id else None
        edges.append(
            {
                "id": fact.id,
                "source": fact.subject_id,
                "target": fact.object_id or f"lit_{fact.id}",
                "label": fact.predicate,
                "object_literal": fact.object_literal,
                "status": fact.status,
                "confidence": fact.confidence,
            }
        )
        if not target:
            target = {
                "id": f"lit_{fact.id}",
                "canonical_name": fact.object_literal or "",
            }
        nodes = [
            (
                fact.subject_id,
                subject.canonical_name if subject else fact.subject_id,
                subject.type if subject else "concept",
            ),
            (
                fact.object_id or f"lit_{fact.id}",
                target.get("canonical_name") if isinstance(target, dict) else target.canonical_name,
                target.get("type") if isinstance(target, dict) else target.type,
            ),
        ]
        node_ids.add(nodes[1][0])
    node_rows = []
    for node_id in node_ids:
        if node_id.startswith("lit_"):
            literal = next(
                (edge["object_literal"] for edge in edges if edge["target"] == node_id), ""
            )
            node_rows.append(
                {"id": node_id, "name": literal or node_id, "type": "literal"}
            )
        else:
            entity = db.get(Entity, node_id)
            if (
                entity
                and entity.status == "active"
                and can_read(principal, entity.acl_principals)
            ):
                node_rows.append(
                    {"id": entity.id, "name": entity.canonical_name, "type": entity.type}
                )
    return {"nodes": node_rows, "edges": edges}


@router.get("/review")
def list_review(
    status: str = Query(default="open"),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    items = db.execute(
        select(ReviewItem)
        .where(
            ReviewItem.tenant_id == principal.tenant_id,
            ReviewItem.status == status,
        )
        .order_by(ReviewItem.created_at.desc())
    ).scalars().all()
    return {
        "items": [
            {
                "id": item.id,
                "kind": item.kind,
                "title": item.title,
                "payload": item.payload,
                "status": item.status,
                "created_at": item.created_at.isoformat()
                if item.created_at
                else None,
            }
            for item in items
        ]
    }


@router.post("/review/{review_id}/resolve")
def resolve_review_endpoint(
    review_id: str,
    payload: ReviewResolveIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    review = db.get(ReviewItem, review_id)
    if not review or review.tenant_id != principal.tenant_id:
        raise HTTPException(status_code=404, detail="审阅项不存在")
    if review.kind == "memory_promotion":
        memory = db.get(MemoryItem, (review.payload or {}).get("memory_id"))
        if payload.action in {"accept_new", "merge"} and memory:
            entity = get_or_create_entity(
                db, principal.tenant_id, "团队记忆", "concept", ["tenant:public"]
            )
            fact = Fact(
                id=new_id("f"),
                tenant_id=principal.tenant_id,
                subject_id=entity.id,
                predicate="记录",
                object_literal=memory.text[:400],
                recorded_at=datetime.now(timezone.utc),
                confidence=0.7,
                status="active",
                acl_principals=["tenant:public"],
            )
            db.add(fact)
            memory.promoted_fact_id = fact.id
        review.status = "resolved"
        review.resolution = {"action": payload.action, "note": payload.note}
        review.resolved_at = datetime.now(timezone.utc)
        db.commit()
        return {"review_id": review.id, "status": "resolved"}
    try:
        return resolve_review(
            db, principal, review_id, payload.action, note=payload.note
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/memory")
def list_memory(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    items = db.execute(
        select(MemoryItem)
        .where(
            MemoryItem.tenant_id == principal.tenant_id,
            MemoryItem.user_id == principal.user_id,
        )
        .order_by(MemoryItem.created_at.desc())
    ).scalars().all()
    return {
        "items": [
            {
                "id": item.id,
                "kind": item.kind,
                "scope": item.scope,
                "text": item.text,
                "confidence": item.confidence,
                "promoted_fact_id": item.promoted_fact_id,
                "expires_at": item.expires_at.isoformat() if item.expires_at else None,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in items
        ]
    }


@router.post("/memory")
def add_memory(
    payload: MemoryIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    memory = MemoryItem(
        tenant_id=principal.tenant_id,
        user_id=principal.user_id,
        scope=payload.scope,
        kind=payload.kind,
        text=payload.text,
        confidence=0.55,
        expires_at=payload.expires_at,
    )
    db.add(memory)
    db.commit()
    return {"id": memory.id, "status": "created"}


@router.delete("/memory/{memory_id}")
def delete_memory(
    memory_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    memory = db.get(MemoryItem, memory_id)
    if (
        not memory
        or memory.tenant_id != principal.tenant_id
        or memory.user_id != principal.user_id
    ):
        raise HTTPException(status_code=404, detail="记忆不存在")
    db.delete(memory)
    db.commit()
    return {"status": "deleted"}


@router.post("/memory/{memory_id}/promote")
def promote_memory(
    memory_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    memory = db.get(MemoryItem, memory_id)
    if (
        not memory
        or memory.tenant_id != principal.tenant_id
        or memory.user_id != principal.user_id
    ):
        raise HTTPException(status_code=404, detail="记忆不存在")
    review = ReviewItem(
        tenant_id=principal.tenant_id,
        kind="memory_promotion",
        title=f"记忆晋升：{memory.text[:48]}",
        payload={
            "memory_id": memory.id,
            "text": memory.text,
            "reason": "记忆默认不污染知识层，晋升为事实需要人工审阅。",
        },
    )
    db.add(review)
    db.commit()
    return {"review_id": review.id, "status": "pending_review"}


@router.get("/gaps")
def list_gaps(
    status: str = Query(default="open"),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    gaps = db.execute(
        select(Gap)
        .where(Gap.tenant_id == principal.tenant_id, Gap.status == status)
        .order_by(Gap.count.desc(), Gap.updated_at.desc())
    ).scalars().all()
    return {
        "items": [
            {
                "id": gap.id,
                "question": gap.question,
                "count": gap.count,
                "status": gap.status,
                "suggested_sources": gap.suggested_sources,
                "updated_at": gap.updated_at.isoformat() if gap.updated_at else None,
            }
            for gap in gaps
        ]
    }


@router.post("/gaps/{gap_id}/resolve")
def resolve_gap(
    gap_id: str,
    payload: GapResolveIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    gap = db.get(Gap, gap_id)
    if not gap or gap.tenant_id != principal.tenant_id:
        raise HTTPException(status_code=404, detail="缺口不存在")
    gap.status = payload.status
    db.commit()
    return {"gap_id": gap.id, "status": gap.status}


@router.post("/reflection/run")
def reflection_run(
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    require_admin(principal)
    return run_reflection(db, principal.tenant_id)
