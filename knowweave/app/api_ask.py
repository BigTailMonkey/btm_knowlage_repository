"""Search, ask, conversation and feedback endpoints."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .answering import ask as ask_service
from .db import get_db
from .models import (
    Chunk,
    Citation,
    Conversation,
    Feedback,
    Message,
    new_id,
)
from .retrieval import retrieve
from .security import Principal, get_principal
from .tracing import TraceRecorder

router = APIRouter(tags=["query"])


class SearchIn(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=8, ge=1, le=20)
    doc_ids: list[str] | None = None
    source_type: str | None = None
    as_of: str | None = None


class AskIn(BaseModel):
    question: str = Field(min_length=1)
    mode: Literal["quick", "deep", "graph", "timeline", "compare"] = "quick"
    top_k: int = Field(default=6, ge=3, le=12)
    as_of: str | None = None
    conversation_id: str | None = None
    doc_ids: list[str] | None = None


class FeedbackIn(BaseModel):
    target_type: Literal["citation", "chunk", "message"]
    target_id: str
    value: int = Field(ge=-1, le=1)
    comment: str | None = None


@router.post("/search")
def search(
    payload: SearchIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    recorder = TraceRecorder(principal.tenant_id, principal.user_id, "search", payload.query)
    result = retrieve(
        db,
        principal,
        payload.query,
        top_k=payload.top_k,
        doc_ids=payload.doc_ids,
        source_type=payload.source_type,
        as_of=payload.as_of,
        recorder=recorder,
    )
    recorder.meta = {"stats": result.stats}
    recorder.finish(db, answer=f"hits={len(result.hits)}")
    db.commit()
    return {
        "query": payload.query,
        "hits": [hit.to_dict() for hit in result.hits],
        "facts": result.facts,
        "entities": [
            {"id": entity.id, "name": entity.canonical_name, "type": entity.type}
            for entity in result.entities
        ],
        "stats": result.stats,
        "trace_id": recorder.trace_id,
    }


@router.post("/ask")
def ask(
    payload: AskIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    try:
        return ask_service(
            db,
            principal,
            payload.question,
            mode=payload.mode,
            top_k=payload.top_k,
            as_of=payload.as_of,
            conversation_id=payload.conversation_id,
            doc_ids=payload.doc_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/conversations")
def list_conversations(
    limit: int = Query(default=30, ge=1, le=100),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    conversations = db.execute(
        select(Conversation)
        .where(
            Conversation.tenant_id == principal.tenant_id,
            Conversation.user_id == principal.user_id,
        )
        .order_by(Conversation.created_at.desc())
        .limit(limit)
    ).scalars().all()
    items = []
    for conversation in conversations:
        count = db.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == conversation.id
            )
        )
        items.append(
            {
                "id": conversation.id,
                "title": conversation.title,
                "messages": count,
                "created_at": conversation.created_at.isoformat()
                if conversation.created_at
                else None,
            }
        )
    return {"items": items}


@router.get("/conversations/{conversation_id}")
def conversation_detail(
    conversation_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    conversation = db.get(Conversation, conversation_id)
    if (
        not conversation
        or conversation.tenant_id != principal.tenant_id
        or conversation.user_id != principal.user_id
    ):
        raise HTTPException(status_code=404, detail="会话不存在")
    messages = db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
    ).scalars().all()
    items = []
    for message in messages:
        citations = db.execute(
            select(Citation)
            .where(Citation.message_id == message.id)
            .order_by(Citation.rank)
        ).scalars().all()
        items.append(
            {
                "id": message.id,
                "role": message.role,
                "content": message.content,
                "mode": message.mode,
                "trace_id": message.trace_id,
                "confidence": message.confidence,
                "created_at": message.created_at.isoformat()
                if message.created_at
                else None,
                "citations": [
                    {
                        "chunk_id": citation.chunk_id,
                        "doc_id": citation.doc_id,
                        "quote": citation.quote,
                        "page": citation.page,
                        "rank": citation.rank,
                    }
                    for citation in citations
                ],
            }
        )
    return {
        "id": conversation.id,
        "title": conversation.title,
        "messages": items,
    }


@router.post("/feedback")
def submit_feedback(
    payload: FeedbackIn,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    if payload.target_type == "chunk":
        chunk = db.get(Chunk, payload.target_id)
        if not chunk or chunk.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="chunk 不存在")
        delta = 0.12 * payload.value
        chunk.weight = max(0.5, min(1.6, chunk.weight + delta))
    db.add(
        Feedback(
            id=new_id("fb"),
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            target_type=payload.target_type,
            target_id=payload.target_id,
            value=payload.value,
            comment=payload.comment,
        )
    )
    # 反馈同时作为弱信号写回轨迹，便于后续评测与 rerank 特征迭代。
    recorder = TraceRecorder(principal.tenant_id, principal.user_id, "feedback")
    recorder.add_span(
        "feedback",
        params={"target_type": payload.target_type, "target_id": payload.target_id},
        output={"value": payload.value},
    )
    recorder.finish(db, answer=payload.comment or "")
    db.commit()
    return {"status": "ok", "message": "反馈已记录"}
